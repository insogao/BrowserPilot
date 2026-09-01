// chrome.debugger 封装：attach/detach/sendCommand/onEvent/onDetach。
// 参考技术路径 §4.7（BrowserPilot browser-runtime.ts）。事件在此进入 events 缓冲。
import { recordEvent } from "./events";
import { patchSpace, patchState } from "./state";

const VERSION = "1.3";
const attached = new Set<number>();

type EventHandler = (tabId: number, method: string, params: unknown) => void;
let eventHandler: EventHandler | null = null;

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  recordEvent(method, { tabId, params });
  eventHandler?.(tabId, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId !== undefined) {
    attached.delete(tabId);
    void syncAttachedState(tabId, false);
  }
  recordEvent("debugger.detach", { tabId, reason });
});

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, VERSION);
  attached.add(tabId);
  await syncAttachedState(tabId, true);
  recordEvent("debugger.attach", { tabId });
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } finally {
    attached.delete(tabId);
    await syncAttachedState(tabId, false);
    recordEvent("debugger.detachManual", { tabId });
  }
}

export function listAttachedTabs(): number[] {
  return [...attached];
}

export async function detachAll(): Promise<number[]> {
  const tabs = [...attached];
  await Promise.all(tabs.map((tabId) => detach(tabId).catch(() => undefined)));
  return tabs;
}

/** 紧急停止当前页面内仍在等待的 Runtime.evaluate。 */
export async function interruptTab(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  await chrome.debugger.sendCommand({ tabId }, "Runtime.terminateExecution").catch(() => undefined);
}

async function syncAttachedState(tabId: number, value: boolean): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return;
  const id = String(tab.windowId);
  await patchSpace(id, { tabId, attached: value, layer: value ? "L1" : "L0" });
  if (value) await patchState({ activeSpaceId: id });
}

export async function sendCommand(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export function onEvent(cb: EventHandler | null): void {
  eventHandler = cb;
}
