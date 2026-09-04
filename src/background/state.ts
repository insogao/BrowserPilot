// SW 唯一权威状态：storage.session 持久化（attach/层级/命名空间/host 端口/profile）。
// 参考技术路径 §4.10 / §4.11。
import type { ProfileInfo } from "../shared/types";

export interface SpaceState {
  spaceId: string;
  name?: string;
  windowId?: number;
  tabId?: number;
  ownerClientId?: string;
  ownership?: "agent" | "user" | "inactive";
  createdAt?: number;
  updatedAt?: number;
  layer: "L0" | "L1";
  navVersion: number;
  attached: boolean;
  eventQueueTail: number;
}

export interface GlobalState {
  spaces: Record<string, SpaceState>;
  activeSpaceId?: string;
  activeSpaceIds?: Record<string, string>;
  foregroundLease?: {
    token: string;
    ownerClientId: string;
    spaceId?: string;
    startedAt: number;
    expiresAt: number;
  };
  hostPort?: number;
  hostToken?: string;
  externalClients?: number;
  agentActive?: boolean;
  lastAgentActivity?: number;
  profile?: ProfileInfo;
  /** 人工接管中的 tabId：takeover Set 的持久层，SW 重启后由 mask.restoreMaskState 恢复。 */
  humanTakeoverTabIds?: number[];
  startTime: number;
}

const KEY = "browserpilot.state.v1";
let mutationTail: Promise<void> = Promise.resolve();

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
  return mutateState((s) => ({ ...s, ...p }));
}

export async function mutateState(fn: (state: GlobalState) => GlobalState | void | Promise<GlobalState | void>): Promise<GlobalState> {
  let release!: () => void;
  const previous = mutationTail;
  mutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const current = await loadState();
    const changed = await fn(current);
    const next = changed ?? current;
    await saveState(next);
    return next;
  } finally {
    release();
  }
}

export async function getSpace(id: string): Promise<SpaceState | undefined> {
  const s = await loadState();
  return s.spaces[id];
}

export async function patchSpace(id: string, p: Partial<SpaceState>): Promise<SpaceState> {
  let result!: SpaceState;
  await mutateState((s) => {
    const cur = s.spaces[id] ?? {
      spaceId: id,
      layer: "L0",
      navVersion: 0,
      attached: false,
      eventQueueTail: 0,
    };
    result = { ...cur, ...p, updatedAt: Date.now() };
    s.spaces[id] = result;
  });
  return result;
}

export async function clearStateSpace(id: string): Promise<void> {
  await mutateState((s) => {
    delete s.spaces[id];
    if (s.activeSpaceId === id) delete s.activeSpaceId;
    for (const [clientId, activeId] of Object.entries(s.activeSpaceIds ?? {})) {
      if (activeId === id) delete s.activeSpaceIds?.[clientId];
    }
  });
}

/** 清理全部标签会话，但保留 host 端口/profile 等全局连接信息。 */
export async function clearAllSpaces(): Promise<void> {
  await mutateState((s) => {
    s.spaces = {};
    s.activeSpaceIds = {};
    delete s.activeSpaceId;
    delete s.foregroundLease;
    delete s.humanTakeoverTabIds;
  });
}
