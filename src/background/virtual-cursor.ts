// SW 侧的「AI 虚拟鼠标」协调层（插件级，不是系统鼠标）。
//
// 职责边界（刻意很窄）：
//   1. 把光标 overlay 的显示/移动/隐藏/移除通过 content-bridge 发给页面；
//   2. 用真实元素 rect（cdp.resolveCoord → getBoundingClientRect）算出落点，轨迹交给
//      content 侧（cursor.ts / cursor-path.ts）在页面内用 rAF 播放；
//   3. 截图时默认隐藏 overlay、截完恢复；只有显式 includeCursor=true 才允许截图包含光标；
//   4. 导航 / tab 切换 / mask 启停 / 人工接管时清理光标状态。
//
// **绝不移动系统鼠标**：本模块不引用 robotjs / nut.js / ffi / user32，也不调用任何
// 系统级输入 API。真实点击与键盘输入一律复用 actions.ts 的 CDP Input.*（见 actions.ts）。
//
// 失败语义（两类，必须分开）：
//   - 光标是纯视觉装饰：show/move/pulse 失败只记录 lastError，绝不阻断真实输入（fail-open）。
//   - 「默认截图不得包含光标」是硬约束：隐藏失败必须 fail closed，宁可报错也不返回带光标的图。

import type { Command } from "../shared/types";
import { CURSOR_HOST_ID, CURSOR_MSG, type CursorStyle, type CursorWireState } from "../shared/cursor-contract";
import { durationForDistance } from "../shared/cursor-path";
import { ensureInjected, sendToTab } from "./content-bridge";
import { captureScreenshot, evalPage, resolveCoord } from "./cdp";
import { withTimeout, type ScreenshotResult } from "./screenshot-policy";
import { resolveTargetTab } from "./tab-resolver";

const CONTENT_TIMEOUT_MS = 2000;
const CAPTURE_CONTENT_TIMEOUT_MS = 1200;

export interface TabCursorState {
  tabId: number;
  /** 该 tab 上「AI 光标」当前是否已显示（enabled && visible）。 */
  enabled: boolean;
  visible: boolean;
  hiddenForCapture: boolean;
  mounted: boolean;
  x: number;
  y: number;
  style: CursorStyle;
  /** 显式关闭（`cursor action=hide`）：后续动作不再自动显示，直到显式 show。
   *  与 mask/tab 切换的「临时收起」区分：那些只隐藏，下一次动作会自动恢复。 */
  disabled?: boolean;
  /** 内容脚本不可用（chrome:// 等）：本 tab 在下次导航前不再尝试。 */
  unavailable?: boolean;
  lastError?: string;
  updatedAt: number;
}

export interface CursorStateView extends TabCursorState {
  ok: boolean;
  error?: string;
}

const states = new Map<number, TabCursorState>();

function ensureState(tabId: number): TabCursorState {
  let st = states.get(tabId);
  if (!st) {
    st = {
      tabId,
      enabled: false,
      visible: false,
      hiddenForCapture: false,
      mounted: false,
      x: 0,
      y: 0,
      style: "arrow",
      updatedAt: Date.now(),
    };
    states.set(tabId, st);
  }
  return st;
}

function view(st: TabCursorState, ok: boolean, error?: string): CursorStateView {
  return { ...st, ok, ...(error ? { error } : {}) };
}

function mergeWire(st: TabCursorState, wire?: CursorWireState | null): void {
  if (!wire) return;
  st.mounted = wire.mounted === true;
  st.visible = wire.visible === true;
  st.hiddenForCapture = wire.hiddenForCapture === true;
  st.x = Number.isFinite(wire.x) ? wire.x : st.x;
  st.y = Number.isFinite(wire.y) ? wire.y : st.y;
  if (wire.style === "arrow" || wire.style === "dot") st.style = wire.style;
  st.updatedAt = Date.now();
}

interface ContentReply {
  ok: boolean;
  state?: CursorWireState;
  error?: string;
}

/** content 消息（带超时 + 一次性注入兜底）。失败抛错，由调用方决定 fail-open / fail-closed。 */
async function callContent(
  tabId: number,
  msg: Record<string, unknown>,
  timeoutMs = CONTENT_TIMEOUT_MS,
): Promise<ContentReply> {
  const once = async (): Promise<ContentReply> =>
    (await withTimeout(
      sendToTab<{ state?: CursorWireState; error?: string }>(tabId, msg, 0),
      timeoutMs,
      String(msg.kind),
    )) as unknown as ContentReply;
  let res: ContentReply;
  try {
    res = await once();
  } catch (first) {
    // 安装前已打开的标签 / SW 重启后用 executeScript 兜底注入一次（幂等）。
    try {
      await ensureInjected(tabId);
    } catch (injectError) {
      // 页面根本不允许注入（chrome://、扩展页…）：本 tab 在下次导航前不再尝试，避免每条动作都白跑一次 IPC。
      const st = ensureState(tabId);
      st.unavailable = true;
      st.lastError = (injectError as Error)?.message ?? String(injectError ?? first);
      throw new Error("content 不可用: " + st.lastError);
    }
    res = await once();
  }
  if (!res || res.ok !== true) throw new Error(res?.error ?? "content 未确认");
  const st = ensureState(tabId);
  mergeWire(st, res.state);
  return res;
}

export function isCursorEnabled(tabId: number): boolean {
  return states.get(tabId)?.enabled === true;
}

export function getCursorStates(): TabCursorState[] {
  return [...states.values()].map((st) => ({ ...st }));
}

export function forgetCursor(tabId: number): void {
  states.delete(tabId);
}

/** 显示光标（不移动）。返回本地状态视图；内容脚本不可用时 ok:false。 */
export async function showCursor(
  tabId: number,
  opts: { style?: CursorStyle; at?: { x: number; y: number } } = {},
): Promise<CursorStateView> {
  const st = ensureState(tabId);
  if (st.unavailable) return view(st, false, st.lastError ?? "content 不可用");
  const msg: Record<string, unknown> = { kind: CURSOR_MSG.show };
  if (opts.style === "arrow" || opts.style === "dot") msg.style = opts.style;
  if (opts.at && Number.isFinite(opts.at.x) && Number.isFinite(opts.at.y)) msg.at = opts.at;
  try {
    await callContent(tabId, msg);
    st.enabled = true;
    st.disabled = false;
    st.lastError = undefined;
    return view(st, true);
  } catch (e) {
    st.enabled = false;
    st.lastError = (e as Error).message;
    return view(st, false, st.lastError);
  }
}

/** 隐藏（默认同时「显式关闭」该 tab 的光标；disable:false = 只临时收起，下次动作自动恢复）。 */
export async function hideCursor(
  tabId: number,
  opts: { disable?: boolean } = {},
): Promise<CursorStateView> {
  const st = states.get(tabId);
  const disable = opts.disable !== false;
  if (!st) {
    return view(
      {
        tabId, enabled: false, visible: false, hiddenForCapture: false, mounted: false,
        x: 0, y: 0, style: "arrow", ...(disable ? { disabled: true } : {}), updatedAt: Date.now(),
      },
      true,
    );
  }
  try {
    await callContent(tabId, { kind: CURSOR_MSG.hide }, CAPTURE_CONTENT_TIMEOUT_MS);
    st.visible = false;
    st.lastError = undefined;
  } catch (e) {
    st.visible = false;
    st.lastError = (e as Error).message;
  }
  st.enabled = false;
  if (disable) st.disabled = true;
  st.updatedAt = Date.now();
  return view(st, st.lastError === undefined, st.lastError);
}

/** 彻底移除 overlay（页面内 DOM 一并删除），并忘掉本地状态。 */
export async function removeCursor(tabId: number): Promise<{ removed: boolean; tabId: number; error?: string }> {
  try {
    await callContent(tabId, { kind: CURSOR_MSG.remove }, CAPTURE_CONTENT_TIMEOUT_MS);
  } catch (e) {
    states.delete(tabId);
    return { removed: false, tabId, error: (e as Error).message };
  }
  states.delete(tabId);
  return { removed: true, tabId };
}

/** 查询光标状态：默认向页面核实真实 overlay（SW 重启后本地缓存可能为空）。 */
export async function getCursorState(
  tabId: number,
  opts: { verify?: boolean } = {},
): Promise<CursorStateView> {
  const st = ensureState(tabId);
  const verify = opts.verify !== false && !st.unavailable;
  if (!verify) return view(st, true);
  try {
    await callContent(tabId, { kind: CURSOR_MSG.status }, CAPTURE_CONTENT_TIMEOUT_MS);
    // 页面里存在 overlay 但本地没有 enabled 记录 = SW 重启遗留：以页面为准接管。
    if (st.mounted && st.visible && !st.enabled) {
      st.enabled = true;
      st.disabled = false;
    }
    return view(st, true);
  } catch (e) {
    st.lastError = (e as Error).message;
    return view(st, false, st.lastError);
  }
}

/** 移动到真实 CSS 坐标（不点击）。enabled 为 false 时自动 show。 */
export async function moveCursor(
  tabId: number,
  at: { x: number; y: number },
  opts: { durationMs?: number; style?: CursorStyle } = {},
): Promise<CursorStateView> {
  const st = ensureState(tabId);
  // 显式关闭（cursor action=hide）后不再自动显示：这是「用户意图」，必须先显式 show。
  if (st.disabled || st.unavailable) return view(st, false, st.disabled ? "cursor disabled" : st.lastError ?? "content 不可用");
  if (!st.enabled) {
    const shown = await showCursor(tabId, opts.style ? { style: opts.style } : {});
    if (!shown.ok) return shown;
  }
  try {
    // 时长由 SW 决定（content 只负责播放）：这样「这次移动花了多久」出现在消息里，可观测、可测试。
    const known = st.enabled && (st.x !== 0 || st.y !== 0) ? { x: st.x, y: st.y } : null;
    const distance = known ? Math.hypot(at.x - known.x, at.y - known.y) : 420;
    const durationMs = typeof opts.durationMs === "number"
      ? Math.max(0, Math.round(opts.durationMs))
      : durationForDistance(distance);
    const msg: Record<string, unknown> = { kind: CURSOR_MSG.move, x: at.x, y: at.y, durationMs };
    await callContent(tabId, msg, Math.max(CONTENT_TIMEOUT_MS, durationMs + 1200));
    st.visible = true;
    return view(st, true);
  } catch (e) {
    st.lastError = (e as Error).message;
    return view(st, false, st.lastError);
  }
}

/**
 * 鼠标类动作（actions.ts）在发 CDP 输入前调用：把光标移到动作落点。
 * 短时长（默认 240ms）控制动作延迟；任何失败都静默（fail-open），绝不阻断真实输入。
 */
export async function moveCursorForAction(
  tabId: number,
  at: { x: number; y: number },
  opts: { durationMs?: number } = {},
): Promise<void> {
  const st = states.get(tabId);
  if (st?.unavailable || st?.disabled) return;
  try {
    await moveCursor(tabId, at, { durationMs: opts.durationMs ?? 240 });
  } catch {
    /* 纯视觉：不阻断 */
  }
}

/** 在落点播一次涟漪（纯视觉，fire-and-forget）。 */export async function pulseClick(tabId: number, at?: { x: number; y: number }): Promise<void> {
  const st = states.get(tabId);
  if (!st?.enabled || st.unavailable) return;
  try {
    const msg: Record<string, unknown> = { kind: CURSOR_MSG.pulse };
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      msg.x = at.x;
      msg.y = at.y;
    }
    await callContent(tabId, msg, CAPTURE_CONTENT_TIMEOUT_MS);
  } catch {
    /* 纯视觉：丢弃 */
  }
}

/** 从动作参数里解析落点（ref/@N、selector、x/y）。解析失败返回 null。 */
async function resolveActionPoint(
  tabId: number,
  args: Record<string, unknown> | undefined,
  opts: { scroll?: boolean },
): Promise<{ x: number; y: number } | null> {
  const a = args ?? {};
  const x = Number(a.x);
  const y = Number(a.y);
  if (a.x !== undefined && a.y !== undefined && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  const target = typeof a.ref === "string" ? a.ref : typeof a.selector === "string" ? a.selector : undefined;
  if (!target) return null;
  const coord = await resolveCoord(tabId, target, {
    scroll: opts.scroll !== false,
    snapshotId: typeof a.snapshotId === "string" ? a.snapshotId : undefined,
  });
  return coord ?? null;
}

export interface CursorActionOptions {
  /** false = 不滚动到目标（wheel 等不需要滚动的动作）。 */
  scroll?: boolean;
  /** 动作成功后在同一落点播一次点击涟漪。 */
  pulse?: boolean;
  /** 调用方已经算好的落点（省一次求值）。 */
  at?: { x: number; y: number };
  durationMs?: number;
}

/**
 * 动作包装器：先把光标沿真实坐标轨迹移到目标，再执行真正的动作。
 *
 * - `args.cursor === false` 可对该次动作关闭光标；
 * - 光标失败绝不阻断动作（fail-open）：真实输入必须照常发生；
 * - 只是视觉层，不改变任何 Input.* 参数。
 */
export async function withCursorAction<T>(
  tabId: number,
  args: Record<string, unknown> | undefined,
  run: () => Promise<T>,
  opts: CursorActionOptions = {},
): Promise<T> {
  const a = args ?? {};
  const wantsCursor = a.cursor !== false && a.showCursor !== false;
  const cached = states.get(tabId);
  if (!wantsCursor || cached?.unavailable || cached?.disabled) return run();

  let at: { x: number; y: number } | null | undefined = opts.at;
  if (!at) {
    try {
      at = await resolveActionPoint(tabId, a, { scroll: opts.scroll });
    } catch {
      at = null;
    }
  }
  if (at) {
    try {
      await moveCursor(tabId, at, { durationMs: opts.durationMs });
    } catch {
      /* 纯视觉：不阻断 */
    }
  }
  const result = await run();
  if (opts.pulse && at) void pulseClick(tabId, at);
  return result;
}

// ---------- 截图：默认排除光标 ----------

const DOM_HIDE_EXPR =
  "(()=>{const h=document.getElementById(" + JSON.stringify(CURSOR_HOST_ID) + ");" +
  "if(!h)return 'absent';" +
  "h.setAttribute('data-bp-prev-display',h.style.getPropertyValue('display')||'');" +
  "h.setAttribute('data-bp-cursor-capture-hidden','1');" +
  "h.style.setProperty('display','none','important');return 'hidden';})()";

const DOM_RESTORE_EXPR =
  "(()=>{const h=document.getElementById(" + JSON.stringify(CURSOR_HOST_ID) + ");" +
  "if(!h)return 'absent';" +
  "const prev=h.getAttribute('data-bp-prev-display')||'';" +
  "h.removeAttribute('data-bp-cursor-capture-hidden');" +
  "if(prev)h.style.setProperty('display',prev,'important');else h.style.removeProperty('display');" +
  "h.removeAttribute('data-bp-prev-display');return 'restored';})()";

export class CursorCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorCaptureError";
  }
}

type HideToken = "content" | "dom" | "absent";

async function hideForCapture(tabId: number): Promise<HideToken> {
  const reasons: string[] = [];
  try {
    await callContent(tabId, { kind: CURSOR_MSG.captureHidden, hidden: true }, CAPTURE_CONTENT_TIMEOUT_MS);
    const st = states.get(tabId);
    if (st) st.hiddenForCapture = true;
    return "content";
  } catch (e) {
    reasons.push("content: " + (e as Error).message);
  }
  // DOM 兜底：直接对 host 下手（closed shadow root 内部不影响隐藏整个 host）。
  try {
    const out = await evalPage(tabId, DOM_HIDE_EXPR);
    if (out === "hidden" || out === "absent") {
      const st = states.get(tabId);
      if (st) st.hiddenForCapture = true;
      return out === "hidden" ? "dom" : "absent";
    }
    reasons.push("dom: 未预期返回值 " + String(out));
  } catch (e) {
    reasons.push("dom: " + (e as Error).message);
  }
  // fail closed：宁可让截图失败，也不返回可能带光标的画面。
  // 例外：内容脚本不可注入且本地从未记录过光标（chrome:// 等页面）——该文档里不可能
  // 存在 overlay，按 absent 处理，避免把“无光标的页面”误判成隐藏失败。
  const st = states.get(tabId);
  if (st?.unavailable && !st.mounted && !st.enabled && !st.visible) return "absent";
  throw new CursorCaptureError("无法隐藏虚拟光标，拒绝返回可能包含光标的截图（" + reasons.join("; ") + "）");
}

async function restoreAfterCapture(tabId: number, token: HideToken): Promise<void> {
  const st = states.get(tabId);
  if (st) st.hiddenForCapture = false;
  try {
    if (token === "content") {
      await callContent(tabId, { kind: CURSOR_MSG.captureHidden, hidden: false }, CAPTURE_CONTENT_TIMEOUT_MS);
    } else if (token === "dom") {
      await evalPage(tabId, DOM_RESTORE_EXPR);
    }
  } catch {
    /* 页面可能已导航：overlay 随之消失，无需恢复 */
  }
}

/**
 * 在「光标不可见」的前提下执行 fn（默认路径）。includeCursor=true 时直接执行 fn。
 * 隐藏失败会抛 CursorCaptureError（fail closed）。
 */
export async function withCursorHiddenForCapture<T>(
  tabId: number,
  includeCursor: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (includeCursor === true) return fn();
  const token = await hideForCapture(tabId);
  try {
    return await fn();
  } finally {
    await restoreAfterCapture(tabId, token);
  }
}

export interface CursorScreenshotResult extends ScreenshotResult {
  /** true = 这张图确实带了虚拟光标（只有显式 includeCursor 才可能为 true）。 */
  cursorIncluded: boolean;
}

/**
 * 截图（视口）。默认隐藏虚拟光标；`includeCursor: true` 才显式包含。
 * 两种路径都保持「用户只看得到结果，不会看到光标闪烁」的语义：
 * 默认路径先隐藏、截完恢复。
 */
export async function captureScreenshotWithCursorPolicy(
  tabId: number,
  format = "png",
  opts: { includeCursor?: boolean; timeoutMs?: number } = {},
): Promise<CursorScreenshotResult> {
  const include = opts.includeCursor === true;
  if (include) {
    // 显式要求「截图含光标」：如果本地记录是启用的但当前隐藏，先恢复显示。
    const st = states.get(tabId);
    if (st?.enabled && !st.visible && !st.unavailable) {
      await showCursor(tabId).catch(() => undefined);
    }
    const shot = await captureScreenshot(tabId, format, { timeoutMs: opts.timeoutMs });
    return { ...shot, cursorIncluded: states.get(tabId)?.visible === true };
  }
  return withCursorHiddenForCapture(tabId, false, async () => {
    const shot = await captureScreenshot(tabId, format, { timeoutMs: opts.timeoutMs });
    return { ...shot, cursorIncluded: false };
  });
}

// ---------- 清理钩子 ----------

/** mask 启停 / 人工接管时调用：立刻收起该 tab 的光标（只隐藏，不永久关闭——AI 恢复后自动再显示）。 */
export function onMaskStateChange(tabId: number): void {
  void hideCursor(tabId, { disable: false }).catch(() => undefined);
}

/** 全局清理（stop 命令用）。 */
export async function clearAllCursors(): Promise<number[]> {
  const tabs = [...states.keys()];
  await Promise.all(tabs.map((tabId) => hideCursor(tabId, { disable: true }).catch(() => undefined)));
  states.clear();
  return tabs;
}

/** 只清理给定 tab（Agent 级 stop 用）。 */
export async function clearCursorsForTabs(tabIds: number[]): Promise<number[]> {
  const hits = [...new Set(tabIds)].filter((tabId) => states.has(tabId));
  await Promise.all(hits.map((tabId) => hideCursor(tabId, { disable: true }).catch(() => undefined)));
  for (const tabId of hits) states.delete(tabId);
  return hits;
}

/**
 * SW 顶层注册：导航 / tab 切换 / 关闭时清掉光标状态。
 * （index.ts 属于集成方，接线片段见交付报告。）
 */
export function registerVirtualCursorHandlers(): void {
  try {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === "loading") {
        // 文档被替换：overlay 随旧文档销毁，本地状态一并作废（含 unavailable 标记）。
        states.delete(tabId);
      }
    });
  } catch {
    /* 老版本/测试环境无 tabs.onUpdated */
  }
  try {
    chrome.tabs.onActivated?.addListener((info) => {
      // 只收起同一窗口里被切走的 tab：不同窗口的 Agent 各自保留自己的光标，
      // 否则用户在一个窗口切 tab 会把另一个窗口 AI 的光标一起藏掉。
      void chrome.tabs.query({ windowId: info.windowId }).then((tabs) => {
        const sameWindow = new Set(
          tabs.map((tab) => tab.id).filter((id): id is number => typeof id === "number"),
        );
        for (const [tabId, st] of states) {
          if (tabId !== info.tabId && sameWindow.has(tabId) && (st.visible || st.enabled)) {
            // 只临时收起：切回该 tab 后下一次动作会自动恢复（不是用户意图关闭）。
            void hideCursor(tabId, { disable: false }).catch(() => undefined);
          }
        }
      }).catch(() => undefined);
    });
  } catch {
    /* ignore */
  }
  try {
    chrome.tabs.onRemoved?.addListener((tabId) => {
      states.delete(tabId);
    });
  } catch {
    /* ignore */
  }
}

/** `cursor` 命令实现（commands.ts 接线：`cursor: (cmd) => handleCursorCommand(cmd)`）。 */
export async function handleCursorCommand(cmd: Command): Promise<unknown> {
  const tabId = await resolveTargetTab(cmd);
  const a = (cmd.args ?? {}) as Record<string, unknown>;
  const action = String(a.action ?? "state");
  switch (action) {
    case "show": {
      const style = a.style === "dot" ? "dot" : a.style === "arrow" ? "arrow" : undefined;
      const at = a.at as { x?: number; y?: number } | undefined;
      const atPoint = at && Number.isFinite(at.x) && Number.isFinite(at.y)
        ? { x: Number(at.x), y: Number(at.y) }
        : undefined;
      const state = await showCursor(tabId, { ...(style ? { style } : {}), ...(atPoint ? { at: atPoint } : {}) });
      return { action, ...state };
    }
    case "hide":
      return { action, ...(await hideCursor(tabId, { disable: a.keepEnabled !== true })) };
    case "remove":
      return { action, ...(await removeCursor(tabId)) };
    case "move": {
      const at = await resolveActionPoint(tabId, a, { scroll: a.scroll !== false });
      if (!at) throw new Error("cursor move 需要 ref/selector 或 x,y");
      const state = await moveCursor(tabId, at, {
        durationMs: typeof a.durationMs === "number" ? a.durationMs : undefined,
      });
      return { action, ...state };
    }
    case "state":
    default:
      return { action: "state", ...(await getCursorState(tabId, { verify: a.verify !== false })) };
  }
}

/** 测试与诊断用：清空内存状态（不触发页面消息）。 */
export function __resetCursorStateForTests(): void {
  states.clear();
}
