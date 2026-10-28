// 内容脚本（isolated world, all_frames）：L0 观测 + 消息桥。
// M3 落地：snapshot_l0 生成 Markdown 树 + data-bp-id；read_text 读取元素/整页文本。
// 幂等守卫：用 window 全局标记，避免 manifest 声明 + executeScript 注入重复注册 listener。
import { buildL0Snapshot } from "./snapshot-l0";
import { maskOn, maskOff, maskAllowCdp, maskBlockCdp, isMaskShowing } from "./mask";
import {
  getCursorState,
  hideCursor,
  moveCursorTo,
  pulseCursor,
  removeCursor,
  setCursorHiddenForCapture,
  showCursor,
} from "./cursor";
import { CURSOR_MSG, type CursorStyle } from "../shared/cursor-contract";

declare global {
  interface Window {
    __BP_CONTENT__?: boolean;
  }
}

if (!(window as Window).__BP_CONTENT__) {
  (window as Window).__BP_CONTENT__ = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const kind = (msg as { kind?: string })?.kind;
    try {
      if (kind === "ping_content") {
        sendResponse({ ok: true, frame: location.href });
        return false;
      }
      if (kind === "snapshot_l0") {
        sendResponse({ ok: true, data: buildL0Snapshot() });
        return false;
      }
      if (kind === "read_text") {
        sendResponse({ ok: true, data: readTextFromPage(msg as { selector?: string; ref?: string }) });
        return false;
      }
      // 人工接管遮罩（只在 main frame，避免 iframe 各自叠一层）。
      const top = window === window.top;
      // 虚拟光标（插件级 AI 鼠标）：只在 main frame 画一层，坐标与 CDP Input.* 同一 CSS 像素系。
      // 注意：这些消息**不产生任何输入**，真实点击/输入由 SW 走 CDP。
      if (kind === CURSOR_MSG.show) {
        if (!top) return false;
        const style = (msg as { style?: CursorStyle }).style;
        const at = (msg as { at?: { x?: number; y?: number } }).at;
        sendResponse({
          ok: true,
          state: showCursor({
            ...(style === "arrow" || style === "dot" ? { style } : {}),
            ...(at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { at: { x: Number(at.x), y: Number(at.y) } } : {}),
          }),
        });
        return false;
      }
      if (kind === CURSOR_MSG.hide) {
        if (!top) return false;
        sendResponse({ ok: true, state: hideCursor() });
        return false;
      }
      if (kind === CURSOR_MSG.remove) {
        if (!top) return false;
        sendResponse({ ok: true, state: removeCursor() });
        return false;
      }
      if (kind === CURSOR_MSG.status) {
        if (!top) return false;
        sendResponse({ ok: true, state: getCursorState() });
        return false;
      }
      if (kind === CURSOR_MSG.move) {
        if (!top) return false;
        const m = msg as { x?: number; y?: number; durationMs?: number; animate?: boolean };
        void moveCursorTo(
          { x: Number(m.x), y: Number(m.y) },
          {
            ...(typeof m.durationMs === "number" ? { durationMs: m.durationMs } : {}),
            ...(m.animate === false ? { animate: false } : {}),
          }
        ).then(
          (state) => sendResponse({ ok: true, state }),
          (e) => sendResponse({ ok: false, error: (e as Error).message })
        );
        return true; // 异步响应
      }
      if (kind === CURSOR_MSG.pulse) {
        if (!top) return false;
        const p = msg as { x?: number; y?: number };
        sendResponse({
          ok: true,
          state: pulseCursor(
            Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Number(p.x), y: Number(p.y) } : undefined
          ),
        });
        return false;
      }
      if (kind === CURSOR_MSG.captureHidden) {
        if (!top) return false;
        const hidden = (msg as { hidden?: boolean }).hidden === true;
        void setCursorHiddenForCapture(hidden).then(
          (state) => sendResponse({ ok: true, state }),
          (e) => sendResponse({ ok: false, error: (e as Error).message })
        );
        return true; // 异步响应（等一帧）
      }
      if (kind === "mask_on") {
        if (!top) return false;
        const shown = maskOn();
        sendResponse({ ok: true, showing: shown });
        return false;
      }
      if (kind === "mask_off") {
        if (!top) return false;
        maskOff();
        sendResponse({ ok: true, showing: false });
        return false;
      }
      if (kind === "mask_allow_cdp") {
        if (!top) return false;
        maskAllowCdp();
        sendResponse({ ok: true });
        return false;
      }
      if (kind === "mask_block_cdp") {
        if (!top) return false;
        maskBlockCdp();
        sendResponse({ ok: true });
        return false;
      }
      if (kind === "mask_status") {
        sendResponse({ ok: true, showing: isMaskShowing() });
        return false;
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message });
      return false;
    }
    return false;
  });

  // 通知 SW 本 frame 已就绪（L0 通道可用）。
  try {
    chrome.runtime.sendMessage({ kind: "content_ready", href: location.href }).catch(() => {});
  } catch (e) {
    // isolated world 里 sendMessage 可能抛错，忽略。
  }
}

function readTextFromPage(opts: { selector?: string; ref?: string }): string {
  if (opts.selector) {
    const el = document.querySelector(opts.selector);
    if (!el) throw new Error("selector 未命中: " + opts.selector);
    return textOf(el);
  }
  if (opts.ref) {
    const idx = String(opts.ref).replace(/^@/, "");
    const el = document.querySelector('[data-bp-id="bp-' + idx + '"]');
    if (!el) throw new Error("ref 未命中: " + opts.ref);
    return textOf(el);
  }
  // 整页可见文本
  return (document.body?.innerText ?? "").replace(/[ \t]+/g, " ").slice(0, 4000);
}

function textOf(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 4000);
}
