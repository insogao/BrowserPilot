// 截图策略：超时、降级与新鲜度标记。刻意与 chrome.debugger 分离，便于离线测试。
//
// 背景：Page.captureScreenshot 的 fromSurface=true 在静态/隐藏窗口里可能永远
// 不返回——页面没有新合成帧时 copy request 会一直挂在 viz。产品路径（cdp.ts）
// 给主路径 4s 硬超时，超时后用 Page.startScreencast 单帧兜底；两条路径都来自
// 合成器，绝不返回 fromSurface=false 的浏览器进程快照（chrome.debugger 是
// untrusted session，Chromium 对该路径返回 "Only screenshots from surface are
// allowed"）。
//
// 超时清理（P0，2026-10-28）：底层 CDP 请求无法从扩展侧取消。withTimeout 在超时后
// 会主动挂上 then/catch 消费器（late settle），保证迟到的响应被丢弃而不是变成
// unhandled rejection；同时通过 hooks 通知调用方把该次请求从 pending 表移除。
// 迟到的帧绝不会被当作后续请求的结果（每次 send 都是独立 promise，不做共享响应表）。

export interface ScreenshotMeta {
  /** true = 合成器/视频捕获取帧；false = 浏览器进程快照（可能是缓存位图）。 */
  fromSurface: boolean;
  durationMs: number;
  /** true 表示这次结果可能不是最新画面，调用方必须自行决定能否接受。 */
  possiblyStale: boolean;
  /** 实际取帧路径：surface=Page.captureScreenshot；screencast=单帧投屏。 */
  path?: "surface" | "screencast";
  /** 走到降级路径的原因（超时/空数据/第一条路径失败）。 */
  reason?: string;
}

export interface ScreenshotResult {
  base64: string;
  meta: ScreenshotMeta;
}

export type CaptureSend = (params: Record<string, unknown>) => Promise<{ data?: string }>;

export type CapturePhase = "fromSurface" | "snapshot" | "screencast";
export type CaptureAttemptOutcome = "ok" | "error" | "abandoned";

export interface CaptureTimeoutInfo {
  phase: CapturePhase;
  timeoutMs: number;
  error: Error;
}

/** 截图生命周期钩子：cdp.ts 用它维护「仍在 pending 的请求」并在超时时清理。 */
export interface CaptureHooks {
  onAttemptStart?(phase: CapturePhase): void;
  onAttemptSettle?(phase: CapturePhase, outcome: CaptureAttemptOutcome): void;
  onTimeout?(info: CaptureTimeoutInfo): void;
  /** 超时之后底层请求才返回：值必须被丢弃（这里只做诊断/计数，不影响任何结果）。 */
  onLateSettle?(phase: CapturePhase, outcome: "ok" | "error"): void;
}

/** 两条路径都失败时的统一错误：保留两段原始原因，上层 API 不得只留最后一条。 */
export class ScreenshotCaptureError extends Error {
  readonly code = "SCREENSHOT_FAILED";
  readonly firstReason: string;
  readonly secondReason?: string;
  readonly timeoutMs: number;

  constructor(message: string, details: { firstReason: string; secondReason?: string; timeoutMs: number }) {
    super(message);
    this.name = "ScreenshotCaptureError";
    this.firstReason = details.firstReason;
    this.secondReason = details.secondReason;
    this.timeoutMs = details.timeoutMs;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
}

export interface WithTimeoutOptions {
  phase?: CapturePhase;
  hooks?: CaptureHooks;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, options: WithTimeoutOptions = {}): Promise<T> {
  const phase = options.phase;
  const hooks = options.hooks;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(label + " 在 " + ms + "ms 内没有返回");
      if (phase) {
        hooks?.onTimeout?.({ phase, timeoutMs: ms, error });
        hooks?.onAttemptSettle?.(phase, "abandoned");
      }
      // 超时 = 放弃这次请求：底层 promise 可能永不 settle，也可能稍后迟到。
      // 提前挂消费器，确保迟到结果被丢弃且不会产生 unhandled rejection。
      promise.then(
        () => { if (phase) hooks?.onLateSettle?.(phase, "ok"); },
        () => { if (phase) hooks?.onLateSettle?.(phase, "error"); },
      );
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (phase) hooks?.onAttemptSettle?.(phase, "ok");
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (phase) hooks?.onAttemptSettle?.(phase, "error");
        reject(error);
      },
    );
  });
}

/**
 * 遮挡/不产帧窗口的冷却器。
 *
 * 背景（2026-10-28 内核实测）：被完全遮挡的 Windows 窗口不会产生合成帧，
 * `Page.captureScreenshot(fromSurface=true)` 会一直挂到调用方超时；更严重的是每次
 * 尝试都会在渲染进程累积一个 presentation-time 回调，累积到 60 个（
 * `cc::PresentationTimeCallbackBuffer::kMaxBufferSize`）会 DCHECK 崩溃。
 *
 * 因此对某个 tab 的合成器路径超时后进入冷却：冷却期内直接走浏览器进程快照，
 * 结果仍然标记 `possiblyStale=true`，绝不把旧帧当成功。一次成功的合成器截图会清除冷却。
 */
export interface SurfaceCooldownOptions {
  /** 第一次超时后的冷却时长；连续超时按 2 倍退避。 */
  baseMs?: number;
  /** 退避上限。 */
  maxMs?: number;
  /**
   * 连续超时达到该次数后彻底停止尝试合成器路径，直到 reset()。
   * 这是防崩硬闸：每次 fromSurface 都会在渲染进程累积 presentation 回调，
   * 而渲染进程的缓冲上限是 60（cc::PresentationTimeCallbackBuffer::kMaxBufferSize）。
   */
  maxConsecutiveTimeouts?: number;
}

export class SurfaceCooldown {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxConsecutiveTimeouts: number;
  private until = 0;
  private currentMs: number;
  private timeouts = 0;
  private hardStopped = false;

  constructor(
    options: SurfaceCooldownOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.baseMs = options.baseMs ?? 30_000;
    this.maxMs = options.maxMs ?? 10 * 60_000;
    this.maxConsecutiveTimeouts = options.maxConsecutiveTimeouts ?? 4;
    this.currentMs = this.baseMs;
  }

  shouldSkip(): boolean {
    return this.hardStopped || this.now() < this.until;
  }

  recordTimeout(): void {
    this.timeouts += 1;
    if (this.timeouts >= this.maxConsecutiveTimeouts) {
      // 硬闸：不再向渲染进程发新的 fromSurface 请求，避免回调继续累积到 60。
      this.hardStopped = true;
      this.until = 0;
      return;
    }
    this.until = this.now() + this.currentMs;
    this.currentMs = Math.min(this.currentMs * 2, this.maxMs);
  }

  recordSuccess(): void {
    this.reset();
  }

  reset(): void {
    this.until = 0;
    this.currentMs = this.baseMs;
    this.timeouts = 0;
    this.hardStopped = false;
  }

  get consecutiveTimeouts(): number {
    return this.timeouts;
  }

  get remainingMs(): number {
    if (this.hardStopped) return 0;
    return Math.max(0, this.until - this.now());
  }

  get isHardStopped(): boolean {
    return this.hardStopped;
  }
}

export interface CaptureFallbackOptions {
  /** 跳过合成器路径，直接取浏览器进程快照（冷却期内的安全路径）。 */
  skipFromSurface?: boolean;
  /** 跳过原因，写进 meta.reason，调用方据此判断这是降级帧。 */
  skipReason?: string;
}

/**
 * 只取一次合成器帧（Page.captureScreenshot fromSurface=true）。
 *
 * 失败时抛出原始错误；调用方决定是否走 screencast 兜底。不在这里返回旧图，
 * 也不把 fromSurface=false 当作通用降级——chrome.debugger 是 untrusted session，
 * Chromium 会以 "Only screenshots from surface are allowed" 拒绝它。
 */
export async function captureFromSurface(
  send: CaptureSend,
  format: string,
  timeoutMs: number,
  hooks: CaptureHooks = {},
): Promise<ScreenshotResult> {
  const started = Date.now();
  hooks.onAttemptStart?.("fromSurface");
  const res = await withTimeout(
    send({ format, fromSurface: true }),
    timeoutMs,
    "Page.captureScreenshot(fromSurface=true)",
    { phase: "fromSurface", hooks },
  );
  const base64 = res?.data ?? "";
  if (!base64) throw new Error("Page.captureScreenshot 返回空数据");
  return {
    base64,
    meta: { fromSurface: true, path: "surface", durationMs: Date.now() - started, possiblyStale: false },
  };
}

/**
 * @deprecated 产品路径已改用 captureFromSurface + Page.startScreencast 单帧兜底；
 * 此函数保留给离线策略测试/旧调用方，fromSurface=false 在 chrome.debugger
 * (untrusted session) 下会被 Chromium 拒绝，不得作为产品降级路径。
 *
 * 先取合成器帧，超时/失败后退回浏览器进程快照。
 *
 * 两条路径都拿不到数据时抛 ScreenshotCaptureError（带两段原始原因），不返回空图。
 * `timeoutMs` 对每一次尝试独立生效。走降级路径时 `meta.possiblyStale=true` 且
 * `meta.reason` 记录第一条路径失败/超时的真实原因。
 */
export async function captureWithFallback(
  send: CaptureSend,
  format: string,
  timeoutMs: number,
  hooks: CaptureHooks = {},
  options: CaptureFallbackOptions = {},
): Promise<ScreenshotResult> {
  const started = Date.now();
  let firstReason: string;
  if (options.skipFromSurface === true) {
    firstReason = options.skipReason ?? "fromSurface-skipped";
  } else {
    try {
      return await captureFromSurface(send, format, timeoutMs, hooks);
    } catch (error) {
      firstReason = errorMessage(error);
    }
  }

  hooks.onAttemptStart?.("snapshot");
  try {
    const res = await withTimeout(
      send({ format, fromSurface: false }),
      timeoutMs,
      "Page.captureScreenshot(fromSurface=false)",
      { phase: "snapshot", hooks },
    );
    const base64 = res?.data ?? "";
    if (!base64) throw new Error("Page.captureScreenshot 返回空数据");
    return {
      base64,
      meta: { fromSurface: false, path: "surface", durationMs: Date.now() - started, possiblyStale: true, reason: firstReason },
    };
  } catch (error) {
    const secondReason = errorMessage(error);
    throw new ScreenshotCaptureError(
      "截图失败：两种路径（合成器帧 fromSurface=true / 浏览器进程快照 fromSurface=false）都没有返回可用数据。"
        + "合成器: " + firstReason + "；浏览器快照: " + secondReason,
      { firstReason, secondReason, timeoutMs },
    );
  }
}
