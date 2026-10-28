// 截图策略：超时、降级与新鲜度标记。刻意与 chrome.debugger 分离，便于离线测试。
//
// 背景：Page.captureScreenshot 的 fromSurface=true 在"窗口可见但被其它窗口完全
// 遮挡"时不会返回新帧（Chromium 的 DelegatedFrameHost 对 HiddenCause::kOccluded
// 提前返回，保留了表面），请求会一直挂住。这里给它一个硬超时，超时后退回浏览器
// 进程快照（fromSurface=false），并明确标记 this frame may be stale —— 绝不把
// 旧帧当成实时画面返回。
//
// 超时清理（P0，2026-10-28）：底层 CDP 请求无法从扩展侧取消。withTimeout 在超时后
// 会主动挂上 then/catch 消费器（late settle），保证迟到的响应被丢弃而不是变成
// unhandled rejection；同时通过 hooks 通知调用方把该次请求从 pending 表移除。
// 迟到的帧绝不会被当作后续请求的结果（每次 send 都是独立 promise，不做共享响应表）。

export interface ScreenshotMeta {
  /** true = 合成器取帧；false = 浏览器进程快照（可能是缓存位图）。 */
  fromSurface: boolean;
  durationMs: number;
  /** true 表示这次结果可能不是最新画面，调用方必须自行决定能否接受。 */
  possiblyStale: boolean;
  /** 走到降级路径的原因（超时/空数据/第一条路径失败）。 */
  reason?: string;
}

export interface ScreenshotResult {
  base64: string;
  meta: ScreenshotMeta;
}

export type CaptureSend = (params: Record<string, unknown>) => Promise<{ data?: string }>;

export type CapturePhase = "fromSurface" | "snapshot";
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
): Promise<ScreenshotResult> {
  const started = Date.now();
  hooks.onAttemptStart?.("fromSurface");
  let firstReason: string;
  try {
    const res = await withTimeout(
      send({ format, fromSurface: true }),
      timeoutMs,
      "Page.captureScreenshot(fromSurface=true)",
      { phase: "fromSurface", hooks },
    );
    const base64 = res?.data ?? "";
    if (!base64) throw new Error("Page.captureScreenshot 返回空数据");
    return { base64, meta: { fromSurface: true, durationMs: Date.now() - started, possiblyStale: false } };
  } catch (error) {
    firstReason = errorMessage(error);
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
      meta: { fromSurface: false, durationMs: Date.now() - started, possiblyStale: true, reason: firstReason },
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
