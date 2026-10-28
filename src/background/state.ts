// SW 唯一权威状态：storage.session 持久化（attach/层级/命名空间/host 端口/profile）。
// 参考技术路径 §4.10 / §4.11。
import type { ProfileInfo } from "../shared/types";
import type { HostCapabilities } from "./capabilities";

/** 一次性输入 grant：ASSIST 模式下放行 AI 输入的唯一凭据。
 *  - actions：可放行的输入命令次数（每条命令消耗 1 次，不是每条 CDP 事件）；
 *  - expiresAt：绝对到期时间；用尽/过期/ownership 变更即清；
 *  - token：随机串，状态里保存完整值，对外只返回截断摘要。 */
export interface AssistGrant {
  token: string;
  actions: number;
  expiresAt: number;
}

/** ASSIST 租约：只是 `ownership==="agent"` 时的从属标记，**不是**新的 ownership 取值。
 *  ownership 一变（handoff/claim/complete/close/窗口消失）必须由 patchSpace 一并清除。 */
export interface AssistLease {
  since: number;
  reason?: string;
  tabId?: number;
  /** 只允许这一次输入：grant 用完即清。 */
  grant?: AssistGrant;
}

export interface SpaceState {
  spaceId: string;
  name?: string;
  windowId?: number;
  tabId?: number;
  ownerClientId?: string;
  ownership?: "agent" | "user" | "inactive";
  /** ASSIST 派生视图的唯一来源：ownership 仍为 "agent"，人类临时在场。
   *  输入权模式由 input-ownership.ts 的 inputModeForSpace() 派生，不落第二份状态。 */
  assist?: AssistLease;
  /** true = 创建时即为后台空间：窗口可见（normal）但不抢焦点、不激活到最前；窗口内标签保持 active 以正常渲染。
   *  前台空间（显式 focus/保持可见）为 undefined。 */
  background?: boolean;
  /** 最近一次实测的窗口状态（normal/minimized/maximized/fullscreen），用于后台诊断。 */
  windowState?: string;
  createdAt?: number;
  updatedAt?: number;
  layer: "L0" | "L1";
  navVersion: number;
  attached: boolean;
  eventQueueTail: number;
}

/** 一条前台/目标租约。key 决定作用域：
 *  - `global`：真正会改变“哪个窗口在前台”的呈现操作，全进程互斥；
 *  - `space:<spaceId>`：只影响某个 Task Space（= 一个窗口）的操作，按目标互斥，不同 space 并行。
 *  所有权仍复用 SpaceState 的 ownerClientId 语义，不引入第二套 ownership。 */
export interface ForegroundLeaseRecord {
  token: string;
  /** `global` 或 `space:<spaceId>`。 */
  key: string;
  scope: "global" | "space";
  ownerClientId: string;
  spaceId?: string;
  startedAt: number;
  expiresAt: number;
}

export interface GlobalState {
  spaces: Record<string, SpaceState>;
  activeSpaceId?: string;
  activeSpaceIds?: Record<string, string>;
  /** 旧版单条进程级租约（v1）。只读兼容：新代码会把未过期记录迁移成 global keyed 租约。 */
  foregroundLease?: {
    token: string;
    ownerClientId: string;
    spaceId?: string;
    startedAt: number;
    expiresAt: number;
  };
  /** 多 Agent keyed 租约：global（窗口呈现）+ 每 space 一条。 */
  foregroundLeases?: Record<string, ForegroundLeaseRecord>;
  hostPort?: number;
  hostToken?: string;
  externalClients?: number;
  agentActive?: boolean;
  lastAgentActivity?: number;
  profile?: ProfileInfo;
  /** 宿主浏览器能力探测结果（Phase 7）。换浏览器或换启动参数都会改变它，
   *  因此每次 SW 启动重新探测，不做跨会话持久化假设。 */
  hostCapabilities?: HostCapabilities;
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

/** ownership 写入的同步监听器。
 *  用途仅限「作废与 ownership 绑定的临时态」（例如 input-ownership 里待触发的 human_presence
 *  去抖定时器）。**监听器必须是同步的、不得调用 mutateState**，否则会在 mutation 队列里自锁。 */
export type OwnershipWriteListener = (
  spaceId: string,
  ownership: SpaceState["ownership"] | undefined,
) => void;

const ownershipListeners = new Set<OwnershipWriteListener>();

export function onOwnershipChanged(listener: OwnershipWriteListener): () => void {
  ownershipListeners.add(listener);
  return () => ownershipListeners.delete(listener);
}

function notifyOwnershipWritten(spaceId: string, ownership: SpaceState["ownership"] | undefined): void {
  for (const listener of ownershipListeners) {
    try {
      listener(spaceId, ownership);
    } catch {
      /* 监听器失败不得影响状态写入 */
    }
  }
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
    // 单一真源不变量：`assist` 只可能存在于 ownership==="agent"。
    //  - ownership 被显式写入（handoff/claim/complete/close/窗口消失）→ 清空辅助租约；
    //  - 任何非 agent 状态 → 清空（防止旧数据/并发写入留下脏状态）。
    // 唯一例外：同一次 patch 显式给出了新的 assist（目前没有调用方这样做）。
    if (result.ownership !== "agent") {
      delete result.assist;
    } else if (p.ownership !== undefined && p.assist === undefined) {
      delete result.assist;
    }
    s.spaces[id] = result;
  });
  if (p.ownership !== undefined) notifyOwnershipWritten(id, p.ownership);
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
    s.foregroundLeases = {};
    delete s.humanTakeoverTabIds;
  });
}
