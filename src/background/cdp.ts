// CDP 辅助：页面求值 / ref->坐标 / glob 匹配 / 睡眠 / 受信输入的重用片段（M5）。
import { attach, isAttached, sendCommand } from "./debugger-bridge";

export async function ensureAttach(tabId: number): Promise<void> {
  if (!isAttached(tabId)) await attach(tabId);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "@N" -> '[data-ego-id="egl-N"]'；否则原样（当作 CSS selector）。 */
export function selFrom(refOrSelector: string): string {
  return refOrSelector.startsWith("@")
    ? '[data-ego-id="egl-' + refOrSelector.slice(1) + '"]'
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
  opts: { scroll?: boolean } = {}
): Promise<{ x: number; y: number } | null> {
  if (typeof target === "object" && target) {
    const x = Number(target.x);
    const y = Number(target.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    throw new Error("坐标参数无效");
  }
  if (typeof target !== "string") return null;
  const sel = selFrom(target);
  const scroll = opts.scroll !== false;
  const expr =
    "(()=>{const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return null;" +
    (scroll ? 'el.scrollIntoView({block:"center",inline:"center"});' : "") +
    "const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()";
  return (await evalPage(tabId, expr)) as { x: number; y: number } | null;
}

/** Page.captureScreenshot：视口截图，返回 base64（PNG）。 */
export async function captureScreenshot(tabId: number, format = "png"): Promise<string> {
  await ensureAttach(tabId);
  const res = (await sendCommand(tabId, "Page.captureScreenshot", { format })) as { data?: string };
  return res.data ?? "";
}

/**
 * 滚动拼接长截图（N 屏一屏屏滚、一屏屏拼）。
 * - 先把目标窗口带到前台：Chrome 对未聚焦窗口做合成节流，Page.captureScreenshot 会挂起，必须先聚焦。
 * - pages：要截几屏（按视口高度计）。缺省 = 3（建议上限，长图别过长）；传 0 则整页全量；传 N 截前 N 屏。
 * - gap：每次滚动后等待毫秒，留给懒加载触发；缺省 400ms。
 * - 返回一张完整长图 base64 + 尺寸 / 屏数。
 */
export async function scrollCaptureScreenshot(
  tabId: number,
  opts: { pages?: number; gap?: number; format?: string } = {}
): Promise<{ base64: string; width: number; height: number; pageCount: number; viewH: number; docH: number }> {
  await ensureAttach(tabId);
  // 聚焦窗口，避免 captureScreenshot 在未聚焦时挂起。
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* 焦点失败不致命 */
  }
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
  for (let i = 0; i < pageCount; i++) {
    await evalPage(tabId, "window.scrollTo(0," + i * viewH + ")").catch(() => {});
    await sleep(gap);
    const b64 = await captureScreenshot(tabId, format);
    if (b64) tiles.push(b64);
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
