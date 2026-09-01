// SW 侧：把命令路由给 content script（L0 观测 / readText）。
// 对安装前已打开、未注入 content script 的标签页，用 chrome.scripting.executeScript 注入兜底。
import type { L0Snapshot } from "../shared/types";

interface ContentReply<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function sendToTab<T>(
  tabId: number,
  msg: Record<string, unknown>,
  frameId?: number
): Promise<ContentReply<T>> {
  const res = frameId === undefined
    ? await chrome.tabs.sendMessage(tabId, msg)
    : await chrome.tabs.sendMessage(tabId, msg, { frameId });
  return res as ContentReply<T>;
}

/** 确保 content script 已注入（幂等，bridge.ts 内部用 window 全局守卫）。 */
export async function ensureInjected(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/bridge.js"] });
  } catch (e) {
    // 某些页面（如 chrome://、扩展页）无法注入，交给后续报错。
    throw new Error("无法注入内容脚本到该页面: " + ((e as Error).message ?? ""));
  }
}

export async function getL0Snapshot(tabId: number): Promise<L0Snapshot> {
  let res: ContentReply<L0Snapshot>;
  try {
    res = await sendToTab(tabId, { kind: "snapshot_l0" }, 0);
  } catch {
    await ensureInjected(tabId);
    res = await sendToTab(tabId, { kind: "snapshot_l0" }, 0);
  }
  if (!res || res.ok !== true) throw new Error(res?.error ?? "L0 snapshot 失败");
  return res.data as L0Snapshot;
}

export async function readTextFromTab(
  tabId: number,
  opts: { ref?: string; selector?: string }
): Promise<string> {
  let res: ContentReply<string>;
  try {
    res = await sendToTab(tabId, { kind: "read_text", ...opts }, 0);
  } catch {
    await ensureInjected(tabId);
    res = await sendToTab(tabId, { kind: "read_text", ...opts }, 0);
  }
  if (!res || res.ok !== true) throw new Error(res?.error ?? "readText 失败");
  return res.data as string;
}
