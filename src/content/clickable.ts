// L0 观测的可交互元素启发式（对齐 Manus ClickableHelper / BrowserPilot 定位）。
// 只在 content script 的 isolated world 里运行，生成 Markdown 树 + data-bp-id。
// 返回的 ref 形如 "@1"；对应 data-bp-id="bp-1"，供动作/后续 CDP 定位使用。

export type L0Type = "link" | "click" | "edit" | "select" | "check";

export interface L0Node {
  ref: string; // "@N"
  type: L0Type;
  tag: string;
  label: string;
}

const INTERACTIVE_SELECTORS = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  'input[role="button"]',
  'input[role="checkbox"]',
  'input[role="radio"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(",");

const EDIT_INPUT_TYPES = new Set([
  "text", "search", "email", "url", "tel", "password", "number",
  "date", "datetime-local", "month", "time", "week",
]);
const CHECK_INPUT_TYPES = new Set(["checkbox", "radio"]);
const CLICK_INPUT_TYPES = new Set(["submit", "button", "reset", "image"]);

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  return true;
}

function labelOf(el: Element): string {
  const attr = ["aria-label", "title", "placeholder", "name", "alt", "value", "data-bp-label"];
  for (const a of attr) {
    const v = el.getAttribute(a);
    if (v && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 60);
  }
  const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
  return txt.slice(0, 60);
}

function classify(el: Element): L0Type {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const role = el.getAttribute("role");

  if (tag === "select") return "select";
  if (tag === "textarea") return "edit";

  if (tag === "input") {
    if (CLICK_INPUT_TYPES.has(type) || role === "button") return "click";
    if (CHECK_INPUT_TYPES.has(type)) return "check";
    if (EDIT_INPUT_TYPES.has(type) || role === "textbox") return "edit";
    return "click"; // 其它 input（如 hidden 之外的杂类）保守按 click
  }

  if (tag === "a" || role === "link") return "link";
  if (role === "checkbox" || role === "radio") return "check";
  if (tag === "button" || role === "button" || role === "tab" || role === "menuitem") return "click";
  if (el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return "edit";
  return "click";
}

/** 遍历页面，返回可交互节点列表 + 给它们贴上 data-bp-id。 */
export function collectClickable(max = 120, snapshotId = ""): L0Node[] {
  const seen = new Set<Element>();
  const nodes: L0Node[] = [];
  const candidates = document.querySelectorAll(INTERACTIVE_SELECTORS);

  for (const el of Array.from(candidates)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    if (el.closest("#bp-action-mask-host")) continue; // 排除自家遮罩（防 L0 污染）
    if (nodes.length >= max) break;

    const idx = nodes.length + 1;
    el.setAttribute("data-bp-id", "bp-" + idx);
    if (snapshotId) el.setAttribute("data-bp-snapshot", snapshotId);
    nodes.push({
      ref: "@" + idx,
      type: classify(el),
      tag: el.tagName.toLowerCase(),
      label: labelOf(el),
    });
  }
  return nodes;
}
