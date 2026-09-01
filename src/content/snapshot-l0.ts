// L0 观测：生成 Markdown 可点击树（最省 token，无 debugger，无「正在调试」横幅）。
// 在 content script isolated world 运行。
import { collectClickable } from "./clickable";
import type { L0NodeInfo, L0Snapshot } from "../shared/types";

const SYM: Record<string, string> = {
  link: "→",
  edit: "✎",
  select: "▾",
  check: "☑",
  click: "•",
};

export function buildL0Snapshot(): L0Snapshot {
  const title = (document.title || location.href || "").slice(0, 120);
  const url = location.href;
  const nodes = collectClickable();

  const lines: string[] = [];
  lines.push("# " + title);
  lines.push("URL: " + url);
  lines.push("");
  for (const n of nodes) {
    lines.push("- " + (SYM[n.type] ?? "•") + " [" + n.type + "] " + (n.label || n.tag) + " " + n.ref);
  }

  const refs: Record<string, L0NodeInfo> = {};
  for (const n of nodes) refs[n.ref] = { type: n.type, tag: n.tag, label: n.label };

  return { title, url, content: lines.join("\n"), refs };
}
