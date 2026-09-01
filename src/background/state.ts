// SW 唯一权威状态：storage.session 持久化（attach/层级/命名空间/host 端口/profile）。
// 参考技术路径 §4.10 / §4.11。
import type { ProfileInfo } from "../shared/types";

export interface SpaceState {
  spaceId: string; // windowId 字符串
  tabId?: number;
  layer: "L0" | "L1";
  navVersion: number;
  attached: boolean;
  eventQueueTail: number;
}

export interface GlobalState {
  spaces: Record<string, SpaceState>;
  activeSpaceId?: string;
  hostPort?: number;
  hostToken?: string;
  profile?: ProfileInfo;
  startTime: number;
}

const KEY = "browserpilot.state.v1";

export function defaultState(): GlobalState {
  return { spaces: {}, startTime: Date.now() };
}

export async function loadState(): Promise<GlobalState> {
  const raw = await chrome.storage.session.get(KEY);
  return (raw[KEY] as GlobalState) ?? defaultState();
}

export async function saveState(s: GlobalState): Promise<void> {
  await chrome.storage.session.set({ [KEY]: s });
}

export async function patchState(p: Partial<GlobalState>): Promise<GlobalState> {
  const s = await loadState();
  const next = { ...s, ...p };
  await saveState(next);
  return next;
}

export async function getSpace(id: string): Promise<SpaceState | undefined> {
  const s = await loadState();
  return s.spaces[id];
}

export async function patchSpace(id: string, p: Partial<SpaceState>): Promise<SpaceState> {
  const s = await loadState();
  const cur = s.spaces[id] ?? {
    spaceId: id,
    layer: "L0",
    navVersion: 0,
    attached: false,
    eventQueueTail: 0,
  };
  const next = { ...cur, ...p };
  s.spaces[id] = next;
  await saveState(s);
  return next;
}

export async function clearStateSpace(id: string): Promise<void> {
  const s = await loadState();
  delete s.spaces[id];
  if (s.activeSpaceId === id) delete s.activeSpaceId;
  await saveState(s);
}

/** 清理全部标签会话，但保留 host 端口/profile 等全局连接信息。 */
export async function clearAllSpaces(): Promise<void> {
  const s = await loadState();
  s.spaces = {};
  delete s.activeSpaceId;
  await saveState(s);
}
