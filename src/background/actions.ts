// M5 动作全集：CDP Input.* 受信输入（click/type/fill/press/hover/dblclick/wheel/down/up/drag/selectOption/check/uncheck/setChecked）。
// 目标定位：优先 ref("@N") 或 selector；也可传 {x,y} 坐标。
import { sendCommand } from "./debugger-bridge";
import { ensureAttach, evalPage, resolveCoord, selFrom, sleep } from "./cdp";
import { withCdpAllow } from "./mask";

type Args = Record<string, unknown>;

/** 焦点元素快照：供 press/type 返回"操作是否真的生效"的后置条件（如 Enter 后输入框是否清空）。 */
const FOCUS_SNAPSHOT_EXPR = "(()=>{const el=document.activeElement;if(!el)return null;return {tag:el.tagName.toLowerCase(),valueLen:(typeof el.value==='string')?el.value.length:null,textLen:el.isContentEditable?(el.innerText||'').length:null};})()";
const send = (tabId: number, method: string, params: Record<string, unknown>) =>
  sendCommand(tabId, method, params);

const snapshotOpts = (a: Args) => ({ snapshotId: typeof a.snapshotId === "string" ? a.snapshotId : undefined });

function pickTarget(a: Args): { x?: number; y?: number } | string | undefined {
  if (typeof a.ref === "string") return a.ref;
  if (typeof a.selector === "string") return a.selector;
  if (typeof a.x === "number" && typeof a.y === "number") return { x: a.x, y: a.y };
  return undefined;
}

async function mouseEvent(
  tabId: number,
  type: string,
  x: number,
  y: number,
  button: string,
  clickCount: number,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", { type, x, y, button, clickCount, ...extra });
}

export async function click(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a);
    const coord = await resolveCoord(tabId, target, snapshotOpts(a));
    if (!coord) throw new Error("click 无法定位目标（需 ref/selector/x,y）");
    const button = (a.button as string) ?? "left";
    await mouseEvent(tabId, "mousePressed", coord.x, coord.y, button, 1);
    await sleep(30);
    await mouseEvent(tabId, "mouseReleased", coord.x, coord.y, button, 1);
    return { clicked: true, x: coord.x, y: coord.y, button };
  });
}

export async function dblclick(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a);
    const coord = await resolveCoord(tabId, target, snapshotOpts(a));
    if (!coord) throw new Error("dblclick 无法定位目标");
    const button = (a.button as string) ?? "left";
    for (let i = 1; i <= 2; i++) {
      await mouseEvent(tabId, "mousePressed", coord.x, coord.y, button, i);
      await sleep(25);
      await mouseEvent(tabId, "mouseReleased", coord.x, coord.y, button, i);
      await sleep(25);
    }
    return { dblClicked: true, x: coord.x, y: coord.y };
  });
}

export async function hover(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a);
    const coord = await resolveCoord(tabId, target, snapshotOpts(a));
    if (!coord) throw new Error("hover 无法定位目标");
    await mouseEvent(tabId, "mouseMoved", coord.x, coord.y, "none", 0);
    return { hovered: true, x: coord.x, y: coord.y };
  });
}

export async function wheel(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a) ?? { x: 100, y: 100 };
    const coord = await resolveCoord(tabId, target, { scroll: false, ...snapshotOpts(a) });
    const x = coord?.x ?? 100;
    const y = coord?.y ?? 100;
    const deltaY = Number(a.deltaY ?? a.amount ?? -300);
    const deltaX = Number(a.deltaX ?? 0);
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
    return { wheeled: true, x, y, deltaY };
  });
}

export async function down(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a);
    const coord = await resolveCoord(tabId, target, snapshotOpts(a));
    if (!coord) throw new Error("down 无法定位目标");
    const button = (a.button as string) ?? "left";
    await mouseEvent(tabId, "mousePressed", coord.x, coord.y, button, 1);
    return { pressed: true, x: coord.x, y: coord.y, button };
  });
}

export async function up(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a);
    const coord = await resolveCoord(tabId, target, snapshotOpts(a));
    if (!coord) throw new Error("up 无法定位目标");
    const button = (a.button as string) ?? "left";
    await mouseEvent(tabId, "mouseReleased", coord.x, coord.y, button, 1);
    return { released: true, x: coord.x, y: coord.y, button };
  });
}

export async function drag(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const from = (a.from as { x?: number; y?: number } | string | undefined) ?? pickTarget(a);
    const to = (a.to as { x?: number; y?: number } | string | undefined) ?? undefined;
    const fromC = await resolveCoord(tabId, from, snapshotOpts(a));
    const toC = await resolveCoord(tabId, to, snapshotOpts(a));
    if (!fromC || !toC) throw new Error("drag 需要 from/to 或 ref/x,y");
    const button = (a.button as string) ?? "left";
    await mouseEvent(tabId, "mousePressed", fromC.x, fromC.y, button, 1);
    await sleep(40);
    await mouseEvent(tabId, "mouseMoved", toC.x, toC.y, "none", 0);
    await sleep(40);
    await mouseEvent(tabId, "mouseReleased", toC.x, toC.y, button, 1);
    return { dragged: true, from: { x: fromC.x, y: fromC.y }, to: { x: toC.x, y: toC.y } };
  });
}

const KEY_MAP: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Tab: { code: "Tab", vk: 9, text: "\t" },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Space: { code: "Space", vk: 32, text: " " },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
};

function keyParamsFor(key: string): { key: string; code: string; windowsVirtualKeyCode: number; text?: string } {
  const k = KEY_MAP[key];
  if (k) return { key, code: k.code, windowsVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}) };
  if (key.length === 1) {
    return { key, code: "Key" + key.toUpperCase(), windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key };
  }
  return { key, code: key, windowsVirtualKeyCode: 0 };
}

export async function press(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const key = (a.key as string) ?? "Enter";
    const target = pickTarget(a);
    if (typeof target === "string") {
      if (target.startsWith("@") && typeof a.snapshotId !== "string") throw new Error("snapshot_id_required");
      const selector = selFrom(target, a.snapshotId as string | undefined);
      const focused = await evalPage(tabId, "(()=>{const el=document.querySelector(" + JSON.stringify(selector) + ");if(!el)return false;el.focus();return document.activeElement===el||el.contains(document.activeElement);})()");
      if (!focused) throw new Error("press 目标未命中或无法聚焦: " + target);
    }
    const p = keyParamsFor(key);
    const before = await evalPage(tabId, FOCUS_SNAPSHOT_EXPR).catch(() => null) as { valueLen?: number; textLen?: number } | null;
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: p.key, code: p.code, windowsVirtualKeyCode: p.windowsVirtualKeyCode, ...(p.text ? { text: p.text } : {}) });
    await sleep(20);
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: p.key, code: p.code, windowsVirtualKeyCode: p.windowsVirtualKeyCode });
    await sleep(250);
    const after = await evalPage(tabId, FOCUS_SNAPSHOT_EXPR).catch(() => null) as { valueLen?: number; textLen?: number } | null;
    const cleared = before && after && typeof before.valueLen === "number" && typeof after.valueLen === "number"
      ? after.valueLen === 0 && before.valueLen > 0
      : null;
    return { pressed: key, ...(typeof target === "string" ? { target } : {}), focus: { before: before, after: after }, valueCleared: cleared };
  });
}

/** type：对当前焦点逐字输入（受信）。 */
export async function typeText(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const text = String(a.text ?? a.value ?? "");
    for (const ch of text) {
      await send(tabId, "Input.insertText", { text: ch });
      await sleep(Number(a.typingDelayMs ?? 8));
    }
    const after = await evalPage(tabId, FOCUS_SNAPSHOT_EXPR).catch(() => null) as { valueLen?: number } | null;
    return { typed: text.length, valueLenAfter: after && typeof after.valueLen === "number" ? after.valueLen : null };
  });
}

/** fill：聚焦目标元素、全选清空，再整体插入值（受信）。 */
export async function fill(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a);
    if (typeof target !== "string") throw new Error("fill 需要 ref 或 selector");
    if (target.startsWith("@") && typeof a.snapshotId !== "string") throw new Error("snapshot_id_required");
    const sel = selFrom(target, a.snapshotId as string | undefined);
    const guard = target.startsWith("@") ? "if(document.documentElement.getAttribute('data-bp-current-snapshot')!==" + JSON.stringify(a.snapshotId) + ")return '__BP_STALE__';" : "";
    const ok = await evalPage(tabId, "(()=>{" + guard + "const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return false;el.focus();if(typeof el.select==='function')el.select();else if(el.isContentEditable){const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);}return true;})()");
    if (ok === "__BP_STALE__") throw new Error("page_updated");
    if (!ok) throw new Error("fill 目标未命中: " + target);
    await send(tabId, "Input.insertText", { text: String(a.value ?? "") });
    return { filled: true, target };
  });
}

export async function selectOption(tabId: number, a: Args): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a);
    if (typeof target !== "string") throw new Error("selectOption 需要 ref 或 selector");
    if (target.startsWith("@") && typeof a.snapshotId !== "string") throw new Error("snapshot_id_required");
    const sel = selFrom(target, a.snapshotId as string | undefined);
    const value = a.value ?? a.label;
    const guard = target.startsWith("@") ? "if(document.documentElement.getAttribute('data-bp-current-snapshot')!==" + JSON.stringify(a.snapshotId) + ")return '__BP_STALE__';" : "";
    const ok = await evalPage(tabId, "(()=>{" + guard + "const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return false;const v=" + JSON.stringify(String(value)) + ";el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}));return el.value===v;})()");
    if (ok === "__BP_STALE__") throw new Error("page_updated");
    if (!ok) throw new Error("selectOption 未命中或选项无效: " + target);
    return { selected: value };
  });
}

export async function setChecked(tabId: number, a: Args, want: boolean): Promise<unknown> {
  return withCdpAllow(tabId, async () => {
    await ensureAttach(tabId);
    const target = pickTarget(a);
    if (typeof target !== "string") throw new Error("check/uncheck 需要 ref 或 selector");
    if (target.startsWith("@") && typeof a.snapshotId !== "string") throw new Error("snapshot_id_required");
    const sel = selFrom(target, a.snapshotId as string | undefined);
    const guard = target.startsWith("@") ? "if(document.documentElement.getAttribute('data-bp-current-snapshot')!==" + JSON.stringify(a.snapshotId) + ")return '__BP_STALE__';" : "";
    const ok = await evalPage(tabId, "(()=>{" + guard + "const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return false;el.checked=" + want + ";el.dispatchEvent(new Event('change',{bubbles:true}));return el.checked===" + want + ";})()");
    if (ok === "__BP_STALE__") throw new Error("page_updated");
    if (!ok) throw new Error("check/uncheck 未命中: " + target);
    return { checked: want };
  });
}

export const check = (tabId: number, a: Args) => setChecked(tabId, a, true);
export const uncheck = (tabId: number, a: Args) => setChecked(tabId, a, false);
