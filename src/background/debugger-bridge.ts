// chrome.debugger 封装：attach/detach/sendCommand/onEvent/onDetach。
// 参考技术路径 §4.7（ego browser-runtime.ts）。事件在此进入 events 缓冲。
import { recordEvent } from "./events";

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
  if (tabId !== undefined) attached.delete(tabId);
  recordEvent("debugger.detach", { tabId, reason });
});

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, VERSION);
  attached.add(tabId);
  recordEvent("debugger.attach", { tabId });
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } finally {
    attached.delete(tabId);
    recordEvent("debugger.detachManual", { tabId });
  }
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
