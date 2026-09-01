// M7 Space 浏览器级接管：list_tabs / open_tab / close_tab / switch_tab / list_spaces。
// v1.2 定案：Space = 整台浏览器（当前 profile），天然共用 cookie/登录态。
// 命令带可选 tabId 跨标签，缺省取当前激活标签（tab-resolver 处理）。
import type { Command } from "../shared/types";
import { loadState } from "./state";

interface TabBrief {
  tabId?: number;
  windowId?: number;
  title?: string;
  url?: string;
  active?: boolean;
  status?: string;
  pendingUrl?: string;
  index?: number;
}

/** 列出浏览器所有窗口/标签（扁平数组，保留 windowId/windowFocused）。 */
async function listTabs(): Promise<{ windowId: number; windowFocused: boolean; tabs: TabBrief[] }[]> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return windows.map((w) => ({
    windowId: w.id as number,
    windowFocused: !!w.focused,
    tabs: (w.tabs ?? [])
      .map((t) => ({
        tabId: t.id as number,
        windowId: w.id as number,
        title: t.title,
        url: t.url,
        active: t.active,
        status: t.status,
        pendingUrl: t.pendingUrl,
        index: t.index,
      })),
  }));
}

export async function list_tabs(_cmd: Command): Promise<{ tabs: TabBrief[]; windows: number }> {
  const windows = await listTabs();
  const tabs = windows.flatMap((w2) => w2.tabs.map((t) => ({ ...t, windowFocused: w2.windowFocused })));
  return { tabs, windows: windows.length };
}

export async function open_tab(cmd: Command): Promise<{ tabId?: number; windowId?: number }> {
  const url = (cmd.args?.url as string) ?? "about:blank";
  const newWindow = !!cmd.args?.newWindow;
  if (newWindow) {
    const win = await chrome.windows.create({ url, focused: true });
    const [t] = win.tabs ?? [];
    return { tabId: (t as chrome.tabs.Tab | undefined)?.id, windowId: win.id as number };
  }
  const tab = await chrome.tabs.create({ url, active: true });
  return { tabId: tab.id, windowId: tab.windowId };
}

export async function close_tab(cmd: Command): Promise<{ closed: true; tabId: number }> {
  const tabId = Number(cmd.args?.tabId);
  if (!Number.isFinite(tabId)) throw new Error("close_tab 需要数字 tabId");
  await chrome.tabs.remove(tabId);
  return { closed: true, tabId };
}

export async function switch_tab(_cmd: Command): Promise<{ tabId: number; windowId: number; url?: string; title?: string }> {
  const tabId = Number(_cmd.args?.tabId);
  if (!Number.isFinite(tabId)) throw new Error("switch_tab 需要数字 tabId");
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { tabId: tab.id as number, windowId: tab.windowId, url: tab.url, title: tab.title };
}

/** 兼容旧名：返回全部 space 状态。 */
export async function list_spaces(): Promise<unknown[]> {
  const s = await loadState();
  return Object.values(s.spaces);
}
