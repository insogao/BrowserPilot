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

let observer: MutationObserver | undefined;

function beginSnapshot(): string {
  if (!observer) {
    observer = new MutationObserver(() => {
      document.documentElement.removeAttribute("data-bp-current-snapshot");
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  observer.takeRecords();
  document.querySelectorAll("[data-bp-id]").forEach((el) => {
    el.removeAttribute("data-bp-id");
    el.removeAttribute("data-bp-snapshot");
  });
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  document.documentElement.setAttribute("data-bp-current-snapshot", id);
  return id;
}

export function buildL0Snapshot(): L0Snapshot {
  const snapshotId = beginSnapshot();
  const title = (document.title || location.href || "").slice(0, 120);
  const url = location.href;
  const nodes = collectClickable(120, snapshotId);

  const lines: string[] = [];
  lines.push("# " + title);
  lines.push("URL: " + url);
  lines.push("");
  for (const n of nodes) {
    lines.push("- " + (SYM[n.type] ?? "•") + " [" + n.type + "] " + (n.label || n.tag) + " " + n.ref);
  }

  const refs: Record<string, L0NodeInfo> = {};
  for (const n of nodes) refs[n.ref] = { type: n.type, tag: n.tag, label: n.label };

  return { snapshotId, title, url, content: lines.join("\n"), refs };
}
