// CDP 辅助：页面求值 / ref->坐标 / glob 匹配 / 睡眠 / 受信输入的重用片段（M5）。
import { attach, isAttached, sendCommand } from "./debugger-bridge";
import {
  captureWithFallback,
  SurfaceCooldown,
  type CaptureHooks,
  type CapturePhase,
  type ScreenshotResult,
} from "./screenshot-policy";

export async function ensureAttach(tabId: number): Promise<void> {
  if (!isAttached(tabId)) await attach(tabId);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 截图请求表：超时必须清理，迟到的帧必须丢弃。
//
// chrome.debugger.sendCommand 的 promise 无法取消。超时后我们只能「放弃」它：
//   1. 立即把这次 attempt 从 pending 表移除（pendingScreenshotAttempts 归零）；
//   2. 给底层 promise 挂 then/catch 消费器（withTimeout 内），迟到结果不会变成
//      unhandled rejection，也不会被当成后续请求的响应（每次 send 都是独立 promise）；
//   3. 计数/告警，便于诊断“窗口被遮挡导致合成器帧挂住”的频次。
// ---------------------------------------------------------------------------

interface ScreenshotFlight {
  id: number;
  phase: CapturePhase;
  startedAt: number;
}

const screenshotFlights = new Map<number, Set<ScreenshotFlight>>();
let screenshotSeq = 0;
let abandonedAttempts = 0;
let lateSettles = 0;

function trackFlight(tabId: number, phase: CapturePhase): ScreenshotFlight {
  const flight: ScreenshotFlight = { id: ++screenshotSeq, phase, startedAt: Date.now() };
  let set = screenshotFlights.get(tabId);
  if (!set) {
    set = new Set();
    screenshotFlights.set(tabId, set);
  }
  set.add(flight);
  return flight;
}

function settleFlight(tabId: number, flight: ScreenshotFlight): void {
  const set = screenshotFlights.get(tabId);
  if (!set) return;
  set.delete(flight);
  if (!set.size) screenshotFlights.delete(tabId);
}

/** 仍在 pending 的截图请求数（tabId 缺省 = 全部）。超时清理后必须归零。 */
export function pendingScreenshotAttempts(tabId?: number): number {
  if (tabId !== undefined) return screenshotFlights.get(tabId)?.size ?? 0;
  let total = 0;
  for (const set of screenshotFlights.values()) total += set.size;
  return total;
}

/** 诊断计数：超时被放弃的请求 / 超时后才迟到的 settle。 */
export function screenshotCleanupStats(): { abandoned: number; lateSettles: number; pending: number } {
  return { abandoned: abandonedAttempts, lateSettles, pending: pendingScreenshotAttempts() };
}

// 遮挡窗口不产帧：合成器路径超时后冷却 30s，期间直接走浏览器快照（仍标记 possiblyStale）。
// 这既避免每次截图都挂满 timeout，也避免渲染进程累积 presentation-time 回调
// （60 个即 DCHECK 崩溃，见 docs/windows-occluded-capture-2026-10-28.md §4.1）。
const SURFACE_TIMEOUT_COOLDOWN_MS = 30_000;
const surfaceCooldowns = new Map<number, SurfaceCooldown>();

function surfaceCooldownFor(tabId: number): SurfaceCooldown {
  let cooldown = surfaceCooldowns.get(tabId);
  if (!cooldown) {
    cooldown = new SurfaceCooldown({
      baseMs: SURFACE_TIMEOUT_COOLDOWN_MS,
      maxMs: 10 * 60_000,
      maxConsecutiveTimeouts: 4,
    });
    surfaceCooldowns.set(tabId, cooldown);
  }
  return cooldown;
}

export interface SurfaceCooldownStats {
  tabId: number;
  active: boolean;
  remainingMs: number;
  consecutiveTimeouts: number;
  /** true = 已触发防崩硬闸，直到 resetSurfaceCooldown() 前不再尝试合成器路径。 */
  hardStopped: boolean;
}

/** 诊断：哪些 tab 正处于“合成器路径冷却”状态。 */
export function surfaceCooldownStats(): SurfaceCooldownStats[] {
  return [...surfaceCooldowns.entries()].map(([tabId, cooldown]) => ({
    tabId,
    active: cooldown.shouldSkip(),
    remainingMs: cooldown.remainingMs,
    consecutiveTimeouts: cooldown.consecutiveTimeouts,
    hardStopped: cooldown.isHardStopped,
  }));
}

/** 明确恢复某个 tab 的合成器尝试（例如 ensure_visible 之后）。 */
export function resetSurfaceCooldown(tabId: number): void {
  surfaceCooldowns.get(tabId)?.reset();
}

/** 测试/诊断：清空所有 tab 的冷却状态（不影响真实截图）。 */
export function __resetSurfaceCooldownsForTests(): void {
  surfaceCooldowns.clear();
}

// 同一个 tab 的截图串行执行：并发调用（多 Agent / scroll + viewport）不得各自发起
// fromSurface 请求，否则一次超时窗口内会累积多个 presentation 回调。
// 不同 tab 使用各自的链，互不阻塞。
const captureQueues = new Map<number, Promise<void>>();

function withTabCaptureLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const previous = captureQueues.get(tabId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  captureQueues.set(tabId, tail);
  void tail.then(() => {
    if (captureQueues.get(tabId) === tail) captureQueues.delete(tabId);
  });
  return run;
}

/** "@N" -> '[data-bp-id="bp-N"]'；否则原样（当作 CSS selector）。 */
export function selFrom(refOrSelector: string, snapshotId?: string): string {
  return refOrSelector.startsWith("@")
    ? '[data-bp-id="bp-' + refOrSelector.slice(1) + '"]' + (snapshotId ? '[data-bp-snapshot="' + snapshotId + '"]' : "")
    : refOrSelector;
}

/** 新开标签/导航瞬间可能无执行上下文或上下文在切换，属瞬态，短重试即可。 */
const TRANSIENT_EVAL = /Cannot find default execution context|Execution context was destroyed|No frame with given id|Inspected target navigated or closed/i;

/** Runtime.evaluate（awaitPromise + returnByValue），有异常则抛错；对上下文瞬态错误做短重试。 */
export async function evalPage(tabId: number, expression: string): Promise<unknown> {
  await ensureAttach(tabId);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = (await sendCommand(tabId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (res.exceptionDetails) throw new Error("页面执行出错: " + JSON.stringify(res.exceptionDetails));
      return res.result?.value;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
      if (TRANSIENT_EVAL.test(msg) && attempt < 11) {
        lastErr = e;
        await sleep(300);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** ref/selector/坐标 -> 页面元素中心坐标（滚动到中央后再取，确保可点击）。 */
export async function resolveCoord(
  tabId: number,
  target: { x?: number; y?: number } | string | undefined,
  opts: { scroll?: boolean; snapshotId?: string } = {}
): Promise<{ x: number; y: number } | null> {
  if (typeof target === "object" && target) {
    const x = Number(target.x);
    const y = Number(target.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    throw new Error("坐标参数无效");
  }
  if (typeof target !== "string") return null;
  if (target.startsWith("@") && !opts.snapshotId) throw new Error("snapshot_id_required");
  const sel = selFrom(target, opts.snapshotId);
  const scroll = opts.scroll !== false;
  const expr =
    "(()=>{if(" + JSON.stringify(opts.snapshotId ?? "") + "&&document.documentElement.getAttribute('data-bp-current-snapshot')!==" + JSON.stringify(opts.snapshotId ?? "") + ")return {__bp_stale:true};const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return null;" +
    (scroll ? 'el.scrollIntoView({block:"center",inline:"center"});' : "") +
    "const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()";
  const out = (await evalPage(tabId, expr)) as { x?: number; y?: number; __bp_stale?: boolean } | null;
  if (out?.__bp_stale) throw new Error("page_updated");
  return out && typeof out.x === "number" && typeof out.y === "number" ? { x: out.x, y: out.y } : null;
}

/** @see screenshot-policy.ts —— 策略（超时/降级/新鲜度）与传输分离，便于离线测试。 */
export type { ScreenshotMeta, ScreenshotResult } from "./screenshot-policy";

/**
 * Page.captureScreenshot：视口截图。
 *
 * 刻意**不**调用 ensureTabVisible：截图不允许改变窗口可见状态、焦点或用户当前
 * 活动标签。隐藏/最小化窗口本身就能取帧（实测 1–4 秒）。
 *
 * 超时语义：fromSurface=true 挂住时按 timeoutMs 放弃并降级；被放弃的请求会从
 * pending 表移除，迟到的帧只记日志，绝不串到下一次截图。
 */
export function captureScreenshot(
  tabId: number,
  format = "png",
  opts: { timeoutMs?: number } = {}
): Promise<ScreenshotResult> {
  // 同一 tab 串行：第二个调用会等第一个结束（超时/降级完成）后再判断冷却，
  // 不会在同一个超时窗口里再发一个 fromSurface 请求。
  return withTabCaptureLock(tabId, () => captureScreenshotUnlocked(tabId, format, opts));
}

async function captureScreenshotUnlocked(
  tabId: number,
  format = "png",
  opts: { timeoutMs?: number } = {}
): Promise<ScreenshotResult> {
  await ensureAttach(tabId);
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 8000;
  const cooldown = surfaceCooldownFor(tabId);
  const skipSurface = cooldown.shouldSkip();
  const flights = new Map<CapturePhase, ScreenshotFlight>();
  const hooks: CaptureHooks = {
    onAttemptStart(phase) {
      flights.set(phase, trackFlight(tabId, phase));
    },
    onAttemptSettle(phase, outcome) {
      const flight = flights.get(phase);
      if (flight) {
        settleFlight(tabId, flight);
        flights.delete(phase);
      }
      if (outcome === "abandoned") abandonedAttempts += 1;
      // 合成器路径真的返回了（哪怕数据为空）：清掉冷却，下次重新尝试新帧。
      if (phase === "fromSurface" && outcome === "ok") cooldown.recordSuccess();
    },
    onTimeout(info) {
      if (info.phase === "fromSurface") cooldown.recordTimeout();
      console.warn("[cdp] 截图请求超时被放弃: tab=" + tabId + " phase=" + info.phase
        + " timeout=" + info.timeoutMs + "ms"
        + (info.phase === "fromSurface" ? " surfaceCooldown=" + cooldown.remainingMs + "ms" : ""));
    },
    onLateSettle(phase, outcome) {
      lateSettles += 1;
      console.warn("[cdp] 截图请求超时后才返回，已丢弃: tab=" + tabId + " phase=" + phase + " outcome=" + outcome);
    },
  };
  try {
    return await captureWithFallback(
      (params) => sendCommand(tabId, "Page.captureScreenshot", params) as Promise<{ data?: string }>,
      format,
      timeoutMs,
      hooks,
      {
        skipFromSurface: skipSurface,
        skipReason: skipSurface ? "fromSurface-cooldown-after-timeout" : undefined,
      },
    );
  } finally {
    // 兜底：任何未走正常 settle 的异常路径都不留下 pending 记录。
    for (const flight of flights.values()) settleFlight(tabId, flight);
    flights.clear();
  }
}

/**
 * 滚动拼接长截图（N 屏一屏屏滚、一屏屏拼）。
 * - 不改变窗口前台状态：不聚焦、不恢复、不切换活动标签（见 captureScreenshot 的说明）。
 * - pages：要截几屏（按视口高度计）。缺省 = 3（建议上限，长图别过长）；传 0 则整页全量；传 N 截前 N 屏。
 * - gap：每次滚动后等待毫秒，留给懒加载触发；缺省 400ms。
 * - 返回一张完整长图 base64 + 尺寸 / 屏数。
 */
export interface ScrollCaptureResult {
  base64: string;
  width: number;
  height: number;
  pageCount: number;
  viewH: number;
  docH: number;
  /** 任一屏走了降级快照路径即为 true：调用方不得把整图当作实时画面。 */
  possiblyStale: boolean;
  /** 走降级的屏数 / 新鲜屏数。 */
  staleTiles: number;
  freshTiles: number;
  /** 降级原因（去重）；上层 API 必须原样透传，不得把 stale 当 fresh。 */
  staleReasons: string[];
  /** 整段滚动截图耗时。 */
  durationMs: number;
}

export async function scrollCaptureScreenshot(
  tabId: number,
  opts: { pages?: number; gap?: number; format?: string } = {}
): Promise<ScrollCaptureResult> {
  const started = Date.now();
  await ensureAttach(tabId);
  const format = opts.format ?? "png";
  const gap = typeof opts.gap === "number" && opts.gap > 0 ? opts.gap : 400;
  const m = (await evalPage(
    tabId,
    "(()=>{window.scrollTo(0,0);return {docH:document.documentElement.scrollHeight,viewH:window.innerHeight};})()"
  )) as { docH?: number; viewH?: number };
  const viewH = Math.max(1, m.viewH || 800);
  const docH = Math.max(viewH, m.docH || viewH);
  await sleep(300);
  const fullPages = Math.ceil(docH / viewH);
  // 缺省 3 屏（长图别过长）；传 pages:0 表示整页全量。
  const want = opts.pages === undefined ? 3 : opts.pages === 0 ? fullPages : opts.pages;
  const pageCount = Math.max(1, Math.min(want, fullPages));
  const tiles: string[] = [];
  let staleTiles = 0;
  const staleReasons: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    await evalPage(tabId, "window.scrollTo(0," + i * viewH + ")").catch(() => {});
    await sleep(gap);
    const shot = await captureScreenshot(tabId, format);
    if (shot.base64) tiles.push(shot.base64);
    if (shot.meta.possiblyStale) {
      staleTiles += 1;
      const reason = shot.meta.reason ?? "possibly-stale";
      if (!staleReasons.includes(reason)) staleReasons.push(reason);
    }
  }
  if (!tiles.length) throw new Error("滚动截图失败：没有截到任何一屏");
  const stitched = await stitchTiles(tiles);
  return {
    base64: stitched.base64,
    width: stitched.width,
    height: stitched.height,
    pageCount,
    viewH,
    docH,
    possiblyStale: staleTiles > 0,
    staleTiles,
    freshTiles: tiles.length - staleTiles,
    staleReasons,
    durationMs: Date.now() - started,
  };
}

/** 把多张视口 PNG 竖向拼接成一张长图（SW 内完成，零依赖）。 */
async function stitchTiles(tiles: string[]): Promise<{ base64: string; width: number; height: number }> {
  const bitmaps: ImageBitmap[] = [];
  try {
    for (const b64 of tiles) {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bin], { type: "image/png" });
      bitmaps.push(await createImageBitmap(blob));
    }
    const width = bitmaps[0].width;
    const height = bitmaps.reduce((s, b) => s + b.height, 0);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    let y = 0;
    for (const b of bitmaps) {
      ctx.drawImage(b, 0, y);
      y += b.height;
      b.close();
    }
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await outBlob.arrayBuffer());
    let binStr = "";
    for (let i = 0; i < bytes.length; i++) binStr += String.fromCharCode(bytes[i]);
    return { base64: btoa(binStr), width, height };
  } finally {
    for (const b of bitmaps) {
      try { b.close(); } catch { /* ignore */ }
    }
  }
}

/** glob（含 * 通配）转正则。 */
export function wildcardToRegExp(pat: string): RegExp {
  const re = pat.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "*" ? ".*" : "\\" + m));
  return new RegExp("^" + re + "$", "i");
}
