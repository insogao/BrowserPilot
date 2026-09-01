// 人工接管遮罩（content script，main frame）：拦截用户输入 + 蓝色半透明 + 「人工接管」按钮。
// 参考 Manus ActionMask（《两个参考插件的机制分析.md》§6），精简为「一层拦截 + 一层蓝光 + 一个按钮」。
//
// 状态开关（都是 class 化，避免样式泄漏到页面）：
//   - 默认：整层 pointer-events:none（完全不打扰，形同虚设）。
//   - .ego-mask-visible      → 拦截层 pointer-events:auto（冻结用户鼠标/滚轮/触摸）。
//   - .ego-mask-allow-cdp    → 拦截层 + 操作条 pointer-events:none（AI 用 CDP Input.* 那一下临时放行）。
//
// 挂在 closed shadow root：外界拿不到内部 DOM，也不会被 L0 观测扫到（querySelectorAll 不通透 shadow）。

const HOST_ID = "ego-action-mask-host";
const VIS = "ego-mask-visible";
const ALLOW = "ego-mask-allow-cdp";
const ON = "ego-mask-on";

let host: HTMLElement | null = null;
let interaction: HTMLElement | null = null;
let blue: HTMLElement | null = null;
let bar: HTMLElement | null = null;
let showing = false;

const CSS = [
  `:host { all: initial; }`,
  `#${HOST_ID} { position: fixed; inset: 0; display: block; pointer-events: none; z-index: 2147483646; }`,
  `.ego-mask-interaction { position: absolute; inset: 0; background: transparent; pointer-events: none; opacity: 0; transition: opacity .2s ease-out; }`,
  `.ego-mask-interaction.${VIS} { pointer-events: auto; opacity: 1; }`,
  `.ego-mask-interaction.${ALLOW} { pointer-events: none !important; }`,
  `.ego-mask-blue { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .16s ease-in; }`,
  `.ego-mask-blue.${ON} { opacity: 1; animation: ego-mask-pulse 1.5s ease-in-out infinite; }`,
  `.ego-mask-blue::before { content: ''; position: absolute; inset: 0; box-shadow: inset 0 0 40px rgba(0,129,242,.16), inset 0 0 120px rgba(0,129,242,.08); }`,
  `.ego-mask-blue__edge { position: absolute; pointer-events: none; }`,
  `.ego-mask-blue__edge--top { top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(to bottom, rgba(0,129,242,.35), rgba(0,129,242,0)); }`,
  `.ego-mask-blue__edge--bottom { bottom: 0; left: 0; right: 0; height: 3px; background: linear-gradient(to top, rgba(0,129,242,.35), rgba(0,129,242,0)); }`,
  `.ego-mask-blue__edge--left { top: 0; bottom: 0; left: 0; width: 3px; background: linear-gradient(to right, rgba(0,129,242,.35), rgba(0,129,242,0)); }`,
  `.ego-mask-blue__edge--right { top: 0; bottom: 0; right: 0; width: 3px; background: linear-gradient(to left, rgba(0,129,242,.35), rgba(0,129,242,0)); }`,
  `@keyframes ego-mask-pulse { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.18); } }`,
  `.ego-mask-action-bar { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; gap: 12px; align-items: center; padding: 8px 12px; background: rgba(255,255,255,.97); border: 1px solid #d8d8d8; border-radius: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.18); z-index: 3; pointer-events: none; opacity: 0; transition: opacity .2s ease-out; user-select: none; }`,
  `.ego-mask-action-bar.${VIS} { pointer-events: auto; opacity: 1; }`,
  `.ego-mask-action-bar.${ALLOW} { pointer-events: none !important; opacity: 0 !important; }`,
  `.ego-mask-status { color: #444; font-size: 13px; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; white-space: nowrap; }`,
  `.ego-mask-action-btn { min-width: 104px; padding: 8px 16px; border: none; border-radius: 8px; background: #d93025; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }`,
  `.ego-mask-action-btn:hover { background: #b3261e; }`,
  `.ego-mask-action-btn:active { background: #a0251c; }`,
].join("\n");

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

/** 惰性创建（首次 mask_on 时页面必然已加载，documentElement 一定存在）。 */
function assureHost(): boolean {
  if (host) return true;
  const de = document.documentElement;
  if (!de) return false;

  host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483646;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  interaction = el("div", "ego-mask-interaction");
  interaction.addEventListener("click", () => {
    /* 拦截层吞掉点击，不冒泡到页面 */
  });

  blue = el("div", "ego-mask-blue");
  blue.innerHTML =
    '<div class="ego-mask-blue__edge ego-mask-blue__edge--top"></div>' +
    '<div class="ego-mask-blue__edge ego-mask-blue__edge--bottom"></div>' +
    '<div class="ego-mask-blue__edge ego-mask-blue__edge--left"></div>' +
    '<div class="ego-mask-blue__edge ego-mask-blue__edge--right"></div>';

  bar = el("div", "ego-mask-action-bar");
  const status = el("div", "ego-mask-status");
  status.textContent = "Agent 正在操作，点击下方接管";
  const btn = document.createElement("button");
  btn.className = "ego-mask-action-btn";
  btn.type = "button";
  btn.textContent = "人工接管";
  btn.addEventListener("click", () => {
    try {
      void chrome.runtime.sendMessage({ kind: "mask_user_takeover" }).catch(() => {});
    } catch {
      /* isolated world 下偶发抛错，忽略 */
    }
  });
  bar.appendChild(status);
  bar.appendChild(btn);

  shadow.appendChild(interaction);
  shadow.appendChild(blue);
  shadow.appendChild(bar);
  de.appendChild(host);
  return true;
}

export function maskOn(): boolean {
  if (!assureHost()) return false;
  interaction?.classList.remove(ALLOW);
  interaction?.classList.add(VIS);
  blue?.classList.add(ON);
  bar?.classList.remove(ALLOW);
  bar?.classList.add(VIS);
  showing = true;
  return true;
}

export function maskOff(): void {
  interaction?.classList.remove(VIS, ALLOW);
  blue?.classList.remove(ON);
  bar?.classList.remove(VIS, ALLOW);
  showing = false;
}

export function maskAllowCdp(): void {
  if (showing) {
    interaction?.classList.add(ALLOW);
    bar?.classList.add(ALLOW);
  }
}

export function maskBlockCdp(): void {
  interaction?.classList.remove(ALLOW);
  bar?.classList.remove(ALLOW);
}

export function isMaskShowing(): boolean {
  return showing;
}
