// 插件级 AI 虚拟鼠标 overlay（content script，只在 main frame）。
//
// 目标：AI 操作时在页面内显示一个虚拟光标，沿真实元素坐标的拟人轨迹移动，
// 给人类一个「谁在操作、操作到哪」的可视信号。**它只画，不点**：
// 真实点击/输入仍由 SW 通过 CDP Input.dispatchMouseEvent / dispatchKeyEvent
// 发到同一套 CSS 像素坐标（见 background/actions.ts），因此本模块绝不移动系统鼠标，
// 也不产生任何 DOM 事件或焦点变化。
//
// 复用 content/mask.ts 的 overlay 生命周期模式：
//   - 惰性创建（首次使用时页面必然已加载）；
//   - 挂在 closed shadow root 上（页面 querySelectorAll / L0 观测都扫不到内部）；
//   - 单独一层 fixed 容器，pointer-events:none，不参与布局、不拦截命中测试。
//
// 与 mask 的关键差异：
//   - z-index 比 mask 高一层（2147483647），人工接管遮罩出现时光标依然可见；
//   - 隐藏/截图排他都用 inline !important，页面 CSS 无法用 !important 把它藏掉或让它拦截点击。

import { CURSOR_HOST_ID, type CursorRect, type CursorStyle, type CursorWireState } from "../shared/cursor-contract";
import { buildHumanPath, clamp, samplePath, type PathPoint, type Pt } from "../shared/cursor-path";

export { CURSOR_HOST_ID };

const GLYPH_CLASS = "bp-vcursor-glyph";
const RIPPLE_CLASS = "bp-vcursor-ripple";
const RIPPLE_RING_CLASS = "bp-vcursor-ripple__ring";

let host: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let glyph: HTMLElement | null = null;
let pos: Pt = { x: 0, y: 0 };
let hasPos = false;
let visible = false;
let hiddenForCapture = false;
let cursorStyle: CursorStyle = "arrow";

// 动画代际：新移动/隐藏/移除会让旧动画立刻收尾，避免两个 rAF 循环抢同一个 transform。
let moveToken = 0;
let rafHandle: number | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let cancelCurrentMove: (() => void) | null = null;
let lastMove: CursorWireState["lastMove"];

const ARROW_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">' +
  '<path d="M2 1.6 L2 19.2 L6.9 14.6 L10.3 22 L13.4 20.5 L10.2 13.3 L16.7 13.3 Z" ' +
  'fill="#ffffff" stroke="#111827" stroke-width="1.4" stroke-linejoin="round"/></svg>';

const DOT_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">' +
  '<circle cx="4" cy="4" r="3.2" fill="rgba(0,129,242,.95)" stroke="#ffffff" stroke-width="1.4"/></svg>';

const CSS = [
  `.${GLYPH_CLASS} { position: absolute; left: 0; top: 0; width: 24px; height: 24px; pointer-events: none !important; user-select: none; transform: translate3d(0px, 0px, 0); will-change: transform; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .38)); }`,
  `.${GLYPH_CLASS} svg { display: block; width: 24px; height: 24px; pointer-events: none !important; }`,
  `.${RIPPLE_CLASS} { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none !important; }`,
  `.${RIPPLE_RING_CLASS} { position: absolute; left: -18px; top: -18px; width: 36px; height: 36px; border-radius: 50%; border: 2px solid rgba(0, 129, 242, .9); background: rgba(0, 129, 242, .22); pointer-events: none !important; animation: bp-vcursor-ripple .45s ease-out forwards; }`,
  `@keyframes bp-vcursor-ripple { 0% { transform: scale(.25); opacity: .95; } 100% { transform: scale(1.15); opacity: 0; } }`,
].join("\n");

function applyHostChrome(): void {
  if (!host) return;
  // 全部 inline !important：页面作者样式（含 !important）既不能把它藏掉，也不能让它变回可命中。
  const s = host.style;
  s.setProperty("position", "fixed", "important");
  s.setProperty("top", "0", "important");
  s.setProperty("left", "0", "important");
  s.setProperty("width", "100%", "important");
  s.setProperty("height", "100%", "important");
  s.setProperty("margin", "0", "important");
  s.setProperty("padding", "0", "important");
  s.setProperty("border", "0", "important");
  s.setProperty("background", "transparent", "important");
  s.setProperty("pointer-events", "none", "important");
  s.setProperty("z-index", "2147483647", "important");
  s.setProperty("display", visible && !hiddenForCapture ? "block" : "none", "important");
  s.setProperty("overflow", "visible", "important");
}

/** 惰性创建 overlay。documentElement 不存在时返回 false（极早期文档）。 */
function assureHost(): boolean {
  if (host && host.isConnected) return true;
  const de = document.documentElement;
  if (!de) return false;

  // 旧 host 被页面脚本拔掉 / 文档被替换：重新建一份，状态保留。
  host = document.createElement("div");
  host.id = CURSOR_HOST_ID;
  host.setAttribute("data-bp-overlay", "virtual-cursor");
  shadowRoot = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = CSS;
  shadowRoot.appendChild(style);

  glyph = document.createElement("div");
  glyph.className = GLYPH_CLASS;
  glyph.innerHTML = cursorStyle === "dot" ? DOT_SVG : ARROW_SVG;
  shadowRoot.appendChild(glyph);

  applyHostChrome();
  de.appendChild(host);
  renderPos();
  return true;
}

function renderPos(): void {
  if (glyph) glyph.style.transform = "translate3d(" + pos.x + "px, " + pos.y + "px, 0)";
}

function setPos(p: Pt): void {
  pos = { x: p.x, y: p.y };
  hasPos = true;
  renderPos();
}

function syncVisibility(): void {
  applyHostChrome();
}

function cancelMove(): void {
  moveToken += 1;
  if (rafHandle !== null) {
    try { cancelAnimationFrame(rafHandle); } catch { /* ignore */ }
    rafHandle = null;
  }
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  const cancel = cancelCurrentMove;
  cancelCurrentMove = null;
  if (cancel) cancel();
}

function rectOf(el: Element | null): CursorRect {
  if (!el) return { x: 0, y: 0, width: 0, height: 0 };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function describe(el: Element | null): string | null {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const id = el.id ? "#" + el.id : "";
  const cls = typeof el.className === "string" && el.className.trim()
    ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
    : "";
  return tag + id + cls;
}

/** 当前 overlay 的真实状态（closed shadow root 内部才可读，所以必须由这里汇报）。 */
export function getCursorState(): CursorWireState {
  const mounted = !!host && host.isConnected;
  let pointerEvents = "none";
  let glyphPointerEvents = "none";
  let hostDisplay = "none";
  if (mounted && host) {
    try {
      const cs = getComputedStyle(host);
      pointerEvents = cs.pointerEvents;
      hostDisplay = cs.display;
    } catch { /* 极端情况下 getComputedStyle 可能抛错 */ }
  }
  if (glyph) {
    try { glyphPointerEvents = getComputedStyle(glyph).pointerEvents; } catch { /* ignore */ }
  }
  const x = hasPos ? Math.round(pos.x * 100) / 100 : 0;
  const y = hasPos ? Math.round(pos.y * 100) / 100 : 0;
  let elementAtPoint: string | null = null;
  const elementsAtPoint: string[] = [];
  if (hasPos && typeof document.elementsFromPoint === "function") {
    try {
      const hit = document.elementsFromPoint(x, y);
      for (const el of hit.slice(0, 6)) elementsAtPoint.push(describe(el) ?? "");
      elementAtPoint = elementsAtPoint[0] ?? null;
    } catch { /* ignore */ }
  }
  return {
    mounted,
    visible: visible && !hiddenForCapture && mounted,
    hiddenForCapture,
    style: cursorStyle,
    x,
    y,
    pointerEvents,
    glyphPointerEvents,
    hostDisplay,
    hostRect: rectOf(host),
    glyphRect: rectOf(glyph),
    elementAtPoint,
    elementsAtPoint,
    viewport: {
      width: typeof window !== "undefined" ? window.innerWidth : 0,
      height: typeof window !== "undefined" ? window.innerHeight : 0,
    },
    lastMove,
  };
}

export function isCursorVisible(): boolean {
  return visible && !hiddenForCapture && !!host && host.isConnected;
}

export function isCursorMounted(): boolean {
  return !!host && host.isConnected;
}

export function getCursorPos(): Pt {
  return { x: pos.x, y: pos.y };
}

/** 显示光标。`at` 可给初始位置；否则停在当前位置（首次为视口中心）。 */
export function showCursor(opts: { at?: Pt; style?: CursorStyle } = {}): CursorWireState {
  if (!assureHost()) return getCursorState();
  if (opts.style === "arrow" || opts.style === "dot") setCursorStyle(opts.style);
  if (!hasPos && !opts.at) {
    setPos({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) });
  } else if (opts.at) {
    setPos(opts.at);
  }
  visible = true;
  syncVisibility();
  return getCursorState();
}

export function setCursorStyle(style: CursorStyle): void {
  cursorStyle = style;
  if (glyph) glyph.innerHTML = style === "dot" ? DOT_SVG : ARROW_SVG;
}

/** 隐藏（保留 host 与位置状态，可再次 show）。 */
export function hideCursor(): CursorWireState {
  cancelMove();
  visible = false;
  clearRipples();
  syncVisibility();
  return getCursorState();
}

/** 彻底移除 overlay 与全部状态（导航/关闭/显式清理用）。 */
export function removeCursor(): CursorWireState {
  cancelMove();
  clearRipples();
  try { host?.remove(); } catch { /* ignore */ }
  host = null;
  shadowRoot = null;
  glyph = null;
  visible = false;
  hiddenForCapture = false;
  hasPos = false;
  pos = { x: 0, y: 0 };
  lastMove = undefined;
  return getCursorState();
}

/** 截图排他：隐藏/恢复 overlay。会等到下一帧，确保合成器看到新状态。 */
export async function setCursorHiddenForCapture(hidden: boolean): Promise<CursorWireState> {
  hiddenForCapture = !!hidden;
  // 没有 overlay（从未显示 / 已 remove）时绝不再造一个，避免「截图顺手把 DOM 装回去」。
  if (!host || !host.isConnected) return getCursorState();
  cancelMove();
  syncVisibility();
  await nextFrame();
  return getCursorState();
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } catch {
      finish();
      return;
    }
    // 后台标签页 rAF 不触发：给硬上限，绝不让 SW 等挂。
    setTimeout(finish, 60);
  });
}

export interface MoveOptions {
  /** 总时长（ms）。缺省按距离推算（160–700ms）。 */
  durationMs?: number;
  /** false = 直接落位（不播动画）。 */
  animate?: boolean;
  /** 采样点数（默认 12）。 */
  samples?: number;
  /** 覆盖当前位置（一般不用；测试与「从某处开始」场景）。 */
  from?: Pt;
}

/**
 * 移动到目标 CSS 坐标。目标必须是真实元素 rect 的中心（由 SW 用 resolveCoord 算好）。
 * 返回移动结束后的 overlay 状态（含 lastMove 轨迹摘要）。
 */
export async function moveCursorTo(target: Pt, opts: MoveOptions = {}): Promise<CursorWireState> {
  const x = Number(target?.x);
  const y = Number(target?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return getCursorState();
  }
  if (!assureHost()) return getCursorState();

  cancelMove();
  const token = moveToken;

  if (opts.from) setPos(opts.from);
  const from: Pt = hasPos ? { ...pos } : { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
  if (!hasPos) setPos(from);
  if (!visible) {
    visible = true;
    syncVisibility();
  } else {
    syncVisibility();
  }

  const path = buildHumanPath(from, { x, y }, {
    durationMs: opts.durationMs,
    samples: opts.samples,
  });
  const animate = opts.animate !== false && path.durationMs > 0 && !documentHidden();

  lastMove = {
    from: { x: from.x, y: from.y },
    to: { x, y },
    steps: path.points.length,
    durationMs: path.durationMs,
    cancelled: false,
  };

  if (!animate) {
    setPos({ x, y });
    return getCursorState();
  }

  await animateAlong(path.points, path.durationMs, token);
  if (token !== moveToken) {
    if (lastMove) lastMove.cancelled = true;
  } else {
    setPos({ x, y });
  }
  return getCursorState();
}

function documentHidden(): boolean {
  try {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  } catch {
    return false;
  }
}

function animateAlong(points: PathPoint[], durationMs: number, token: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (rafHandle !== null) {
        try { cancelAnimationFrame(rafHandle); } catch { /* ignore */ }
        rafHandle = null;
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      cancelCurrentMove = null;
      resolve();
    };
    cancelCurrentMove = finish;

    const started = now();
    const step = (): void => {
      rafHandle = null;
      if (token !== moveToken) {
        finish();
        return;
      }
      const u = durationMs <= 0 ? 1 : clamp((now() - started) / durationMs, 0, 1);
      setPos(samplePath(points, u));
      if (u >= 1) {
        setPos(points[points.length - 1]);
        finish();
        return;
      }
      rafHandle = requestAnimationFrame(step);
    };
    rafHandle = requestAnimationFrame(step);
    // 后台标签页 rAF 被节流甚至不触发：到点强制落位（保证 SW 侧调用不挂）。
    fallbackTimer = setTimeout(() => {
      if (token === moveToken) setPos(points[points.length - 1]);
      finish();
    }, Math.max(60, durationMs + 140));
  });
}

function now(): number {
  try {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

/** 点击涟漪（纯视觉反馈）。不产生任何事件，失败也不影响真实点击。 */
export function pulseCursor(at?: Pt): CursorWireState {
  if (!assureHost() || !shadowRoot) return getCursorState();
  const p = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : pos;
  if (!hasPos) setPos(p);
  const wrap = document.createElement("div");
  wrap.className = RIPPLE_CLASS;
  wrap.style.transform = "translate3d(" + p.x + "px, " + p.y + "px, 0)";
  const ring = document.createElement("div");
  ring.className = RIPPLE_RING_CLASS;
  wrap.appendChild(ring);
  shadowRoot.appendChild(wrap);
  const cleanup = (): void => {
    try { wrap.remove(); } catch { /* ignore */ }
  };
  wrap.addEventListener("animationend", cleanup, { once: true });
  // 后台标签页可能不跑动画：兜底移除，防止 DOM 泄漏。
  setTimeout(cleanup, 800);
  return getCursorState();
}

function clearRipples(): void {
  if (!shadowRoot) return;
  for (const el of Array.from(shadowRoot.querySelectorAll("." + RIPPLE_CLASS))) {
    try { el.remove(); } catch { /* ignore */ }
  }
}
