// 目标标签解析：命令的 tabId 缺省规则（v1.2 定案：Space=整台浏览器，缺省当前激活标签）。
// 优先级：args.tabId > space 绑定标签（若仍有效）> 当前窗口激活标签。
import type { Command } from "../shared/types";
import { loadState } from "./state";

export async function resolveTargetTab(cmd: Command): Promise<number> {
  const explicit = (cmd.args?.tabId as number | undefined) ?? undefined;
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;

  const s = await loadState();
  const spaceId = cmd.space ?? s.activeSpaceId;
  const sp = spaceId ? s.spaces[spaceId] : undefined;
  if (sp?.tabId !== undefined) {
    const t = await chrome.tabs.get(sp.tabId).catch(() => undefined);
    if (t) return sp.tabId;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("没有可操作的活动标签（no active tab）");
  return tab.id;
}

/** 绑定当前激活标签到某个 space（take_over 时用）。 */
export async function bindActiveTab(spaceId: string): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("没有活动标签");
  const { patchSpace } = await import("./state");
  await patchSpace(spaceId, { tabId: tab.id, attached: true });
  return tab.id;
}
