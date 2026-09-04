// Chrome 扩展版 Task Space：一个 space 对应一个普通 Chrome 窗口。
// 这是逻辑隔离，不是假装拥有 Chromium 内核级 BrowserContext；cookie 仍由当前 profile 共享。
import type { Command } from "../shared/types";
import { loadState, mutateState, patchSpace, type SpaceState } from "./state";

export type TaskSpaceErrorCode =
  | "SPACE_NOT_FOUND"
  | "SPACE_NOT_OWNED"
  | "SPACE_USER_IN_CONTROL"
  | "SPACE_INACTIVE"
  | "TAB_OUTSIDE_SPACE";

export class TaskSpaceError extends Error {
  constructor(public readonly code: TaskSpaceErrorCode, message: string) {
    super(message);
    this.name = "TaskSpaceError";
  }
}

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

export function commandClientId(cmd: Command): string {
  return cmd._clientId?.trim() || "browserpilot-internal";
}

function selector(cmd: Command): string | undefined {
  const args = cmd.args ?? {};
  const value = cmd.space ?? args.spaceId ?? args.name;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findSpace(spaces: Record<string, SpaceState>, value: string): SpaceState | undefined {
  return spaces[value] ?? Object.values(spaces).find((space) => space.name === value);
}

function assertOwnership(space: SpaceState, clientId: string, allowUser = false): void {
  if (space.ownership === "inactive") {
    throw new TaskSpaceError("SPACE_INACTIVE", "Task Space 已结束: " + space.spaceId);
  }
  if (space.ownerClientId && space.ownerClientId !== clientId) {
    throw new TaskSpaceError("SPACE_NOT_OWNED", "Task Space 属于其他 Agent: " + space.spaceId);
  }
  if (!allowUser && space.ownership === "user") {
    throw new TaskSpaceError("SPACE_USER_IN_CONTROL", "用户正在控制 Task Space: " + space.spaceId);
  }
}

async function activate(clientId: string, spaceId: string): Promise<void> {
  await mutateState((state) => {
    state.activeSpaceIds ??= {};
    state.activeSpaceIds[clientId] = spaceId;
    state.activeSpaceId = spaceId;
  });
}

async function bindFocusedWindow(clientId: string): Promise<SpaceState> {
  const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  if (focused.id === undefined) throw new TaskSpaceError("SPACE_NOT_FOUND", "没有可绑定的普通浏览器窗口");

  let bound!: SpaceState;
  await mutateState((state) => {
    const occupied = Object.values(state.spaces).find(
      (space) => space.windowId === focused.id && space.ownership !== "inactive",
    );
    if (occupied) {
      assertOwnership(occupied, clientId);
      bound = occupied;
    } else {
      const legacy = state.spaces[String(focused.id)];
      const spaceId = legacy?.ownerClientId ? "space-" + crypto.randomUUID() : (legacy?.spaceId ?? "space-" + crypto.randomUUID());
      bound = {
        ...(legacy ?? {}),
        spaceId,
        name: legacy?.name ?? "Default",
        windowId: focused.id,
        ownerClientId: clientId,
        ownership: "agent",
        layer: legacy?.layer ?? "L0",
        navVersion: legacy?.navVersion ?? 0,
        attached: legacy?.attached ?? false,
        eventQueueTail: legacy?.eventQueueTail ?? 0,
        createdAt: legacy?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      if (legacy && legacy.spaceId !== spaceId) delete state.spaces[legacy.spaceId];
      state.spaces[spaceId] = bound;
    }
    state.activeSpaceIds ??= {};
    state.activeSpaceIds[clientId] = bound.spaceId;
    state.activeSpaceId = bound.spaceId;
  });
  return bound;
}

/** Resolve and validate the caller's current Task Space; first use adopts the focused window. */
export async function ensureCommandSpace(cmd: Command): Promise<SpaceState> {
  const clientId = commandClientId(cmd);
  const state = await loadState();
  const requested = selector(cmd);
  const activeId = state.activeSpaceIds?.[clientId];
  const space = requested ? findSpace(state.spaces, requested) : activeId ? state.spaces[activeId] : undefined;
  if (space) {
    assertOwnership(space, clientId);
    cmd.space = space.spaceId;
    if (activeId !== space.spaceId) await activate(clientId, space.spaceId);
    return space;
  }
  if (requested) throw new TaskSpaceError("SPACE_NOT_FOUND", "Task Space 不存在: " + requested);
  const adopted = await bindFocusedWindow(clientId);
  cmd.space = adopted.spaceId;
  return adopted;
}

export async function assertTabInCommandSpace(cmd: Command, tabId: number): Promise<SpaceState> {
  const space = await ensureCommandSpace(cmd);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || tab.windowId !== space.windowId) {
    throw new TaskSpaceError("TAB_OUTSIDE_SPACE", "tabId 不属于当前 Task Space: " + tabId);
  }
  return space;
}

export async function ensureTabVisible(tabId: number, requestedState?: "normal" | "maximized"): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== undefined) {
    const win = await chrome.windows.get(tab.windowId).catch(() => undefined);
    const state = requestedState ?? (win?.state === "minimized" ? "normal" : undefined);
    await chrome.windows.update(tab.windowId, state ? { state, focused: true } : { focused: true }).catch(() => {});
  }
  if (!tab.active) return chrome.tabs.update(tabId, { active: true });
  return tab;
}

function tabBrief(tab: chrome.tabs.Tab): TabBrief {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    status: tab.status,
    pendingUrl: tab.pendingUrl,
    index: tab.index,
  };
}

export async function list_tabs(cmd: Command): Promise<{ spaceId: string; tabs: TabBrief[]; windows: number }> {
  const space = await ensureCommandSpace(cmd);
  if (space.windowId === undefined) throw new TaskSpaceError("SPACE_INACTIVE", "Task Space 没有活动窗口");
  const tabs = await chrome.tabs.query({ windowId: space.windowId });
  return { spaceId: space.spaceId, tabs: tabs.map(tabBrief), windows: 1 };
}

export async function open_space(cmd: Command): Promise<SpaceState> {
  const clientId = commandClientId(cmd);
  const args = cmd.args ?? {};
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "Task " + new Date().toLocaleTimeString();
  const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : "about:blank";
  const requestedState = args.state === "normal" ? "normal" : "maximized";
  const win = await chrome.windows.create({ url, focused: true, state: requestedState });
  if (win.id === undefined) throw new Error("创建 Task Space 窗口失败");
  const spaceId = "space-" + crypto.randomUUID();
  const tab = win.tabs?.[0];
  const now = Date.now();
  const space = await patchSpace(spaceId, {
    name,
    windowId: win.id,
    tabId: tab?.id,
    ownerClientId: clientId,
    ownership: "agent",
    createdAt: now,
    updatedAt: now,
  });
  await activate(clientId, spaceId);
  return space;
}

export async function use_space(cmd: Command): Promise<SpaceState> {
  const requested = selector(cmd);
  if (!requested) throw new TaskSpaceError("SPACE_NOT_FOUND", "use_space 需要 spaceId 或 name");
  const state = await loadState();
  const space = findSpace(state.spaces, requested);
  if (!space) throw new TaskSpaceError("SPACE_NOT_FOUND", "Task Space 不存在: " + requested);
  const clientId = commandClientId(cmd);
  assertOwnership(space, clientId);
  await activate(clientId, space.spaceId);
  return space;
}

export async function claim_space(cmd: Command): Promise<SpaceState> {
  const clientId = commandClientId(cmd);
  const state = await loadState();
  const requested = selector(cmd) ?? state.activeSpaceIds?.[clientId];
  const space = requested ? findSpace(state.spaces, requested) : undefined;
  if (!space) throw new TaskSpaceError("SPACE_NOT_FOUND", "没有可恢复的 Task Space");
  assertOwnership(space, clientId, true);
  const next = await patchSpace(space.spaceId, { ownership: "agent" });
  await activate(clientId, space.spaceId);
  return next;
}

export async function handoff_space(cmd: Command): Promise<SpaceState> {
  const space = await ensureCommandSpace(cmd);
  return patchSpace(space.spaceId, { ownership: "user" });
}

export async function complete_space(cmd: Command): Promise<{ done: true; kept: boolean; spaceId: string }> {
  const clientId = commandClientId(cmd);
  const state = await loadState();
  const requested = selector(cmd) ?? state.activeSpaceIds?.[clientId];
  const space = requested ? findSpace(state.spaces, requested) : undefined;
  if (!space) throw new TaskSpaceError("SPACE_NOT_FOUND", "没有可结束的 Task Space");
  assertOwnership(space, clientId, true);
  const keep = (cmd.args?.keep as boolean | undefined) ?? false;
  if (keep) {
    await patchSpace(space.spaceId, { ownership: "user" });
  } else {
    if (space.windowId !== undefined) await chrome.windows.remove(space.windowId).catch(() => {});
    await patchSpace(space.spaceId, { ownership: "inactive", windowId: undefined, tabId: undefined, attached: false });
    await mutateState((next) => {
      if (next.activeSpaceIds?.[clientId] === space.spaceId) delete next.activeSpaceIds[clientId];
      if (next.activeSpaceId === space.spaceId) delete next.activeSpaceId;
    });
  }
  return { done: true, kept: keep, spaceId: space.spaceId };
}

export async function close_space(cmd: Command): Promise<{ done: true; kept: boolean; spaceId: string }> {
  cmd.args = { ...(cmd.args ?? {}), keep: false };
  return complete_space(cmd);
}

export async function open_tab(cmd: Command): Promise<{ tabId?: number; windowId?: number; spaceId?: string }> {
  if (cmd.args?.newWindow) {
    const space = await open_space({ ...cmd, args: { ...cmd.args, name: cmd.args?.name, url: cmd.args?.url } });
    return { tabId: space.tabId, windowId: space.windowId, spaceId: space.spaceId };
  }
  const space = await ensureCommandSpace(cmd);
  if (space.windowId === undefined) throw new TaskSpaceError("SPACE_INACTIVE", "Task Space 没有活动窗口");
  const url = (cmd.args?.url as string) ?? "about:blank";
  const tab = await chrome.tabs.create({ windowId: space.windowId, url, active: true });
  await patchSpace(space.spaceId, { tabId: tab.id });
  await ensureTabVisible(tab.id as number).catch(() => {});
  return { tabId: tab.id, windowId: tab.windowId, spaceId: space.spaceId };
}

export async function close_tab(cmd: Command): Promise<{ closed: true; tabId: number }> {
  const tabId = Number(cmd.args?.tabId);
  if (!Number.isFinite(tabId)) throw new Error("close_tab 需要数字 tabId");
  await assertTabInCommandSpace(cmd, tabId);
  await chrome.tabs.remove(tabId);
  return { closed: true, tabId };
}

export async function switch_tab(cmd: Command): Promise<{ tabId: number; windowId: number; url?: string; title?: string }> {
  const tabId = Number(cmd.args?.tabId);
  if (!Number.isFinite(tabId)) throw new Error("switch_tab 需要数字 tabId");
  const space = await assertTabInCommandSpace(cmd, tabId);
  const tab = await ensureTabVisible(tabId);
  await patchSpace(space.spaceId, { tabId });
  return { tabId: tab.id as number, windowId: tab.windowId, url: tab.url, title: tab.title };
}

export async function ensure_visible(cmd: Command): Promise<{ tabId: number; windowId: number; state?: string; focused?: boolean }> {
  const space = await ensureCommandSpace(cmd);
  let tabId = Number(cmd.args?.tabId ?? space.tabId);
  if (!Number.isFinite(tabId) && space.windowId !== undefined) {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: space.windowId });
    tabId = Number(activeTab?.id);
  }
  if (!Number.isFinite(tabId)) throw new Error("ensure_visible 未找到当前 Task Space 的活动 tab");
  await assertTabInCommandSpace(cmd, tabId);
  const requestedState = cmd.args?.state === "maximized" ? "maximized" : cmd.args?.state === "normal" ? "normal" : undefined;
  const tab = await ensureTabVisible(tabId, requestedState);
  const win = await chrome.windows.get(tab.windowId);
  return { tabId: tab.id as number, windowId: tab.windowId, state: win.state, focused: win.focused };
}

export async function list_spaces(cmd: Command): Promise<SpaceState[]> {
  const clientId = commandClientId(cmd);
  const state = await loadState();
  return Object.values(state.spaces).filter((space) => space.ownerClientId === clientId);
}

export async function handoffSpaceForTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return;
  const state = await loadState();
  const space = Object.values(state.spaces).find((item) => item.windowId === tab.windowId && item.ownership !== "inactive");
  if (space) await patchSpace(space.spaceId, { ownership: "user" });
}

export async function claimSpaceForTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return;
  const state = await loadState();
  const space = Object.values(state.spaces).find((item) => item.windowId === tab.windowId && item.ownership === "user");
  if (space) await patchSpace(space.spaceId, { ownership: "agent" });
}

export async function syncSpaceForTab(tabId: number, patch: Partial<SpaceState>): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return;
  const state = await loadState();
  const space = Object.values(state.spaces).find((item) => item.windowId === tab.windowId && item.ownership !== "inactive");
  if (space) await patchSpace(space.spaceId, { ...patch, tabId });
}

export function registerSpaceLifecycleHandlers(): void {
  chrome.windows.onRemoved.addListener((windowId) => {
    void (async () => {
      const state = await loadState();
      const space = Object.values(state.spaces).find((item) => item.windowId === windowId && item.ownership !== "inactive");
      if (space) await patchSpace(space.spaceId, { ownership: "inactive", windowId: undefined, tabId: undefined, attached: false });
    })();
  });
}
