// 目标标签解析：所有 tabId 必须属于调用 Agent 当前 Task Space 的窗口。
// 优先级：args.tabId > space 绑定标签（若仍有效）> space 窗口内的活动标签。
import type { Command } from "../shared/types";
import { assertTabInCommandSpace, ensureCommandSpace } from "./spaces";

export async function resolveTargetTab(cmd: Command): Promise<number> {
  const space = await ensureCommandSpace(cmd);
  const explicit = (cmd.args?.tabId as number | undefined) ?? undefined;
  if (explicit !== undefined && Number.isFinite(explicit)) {
    await assertTabInCommandSpace(cmd, explicit);
    return explicit;
  }

  if (space.tabId !== undefined) {
    const tab = await chrome.tabs.get(space.tabId).catch(() => undefined);
    if (tab && tab.windowId === space.windowId) return space.tabId;
  }

  const [tab] = await chrome.tabs.query({ active: true, windowId: space.windowId });
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
