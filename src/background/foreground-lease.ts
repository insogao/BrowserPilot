import type { Command, CommandName } from "../shared/types";
import {
  loadState,
  mutateState,
  type ForegroundLeaseRecord,
  type GlobalState,
} from "./state";
import { commandClientId, resolveSpaceSelector, wantsVisible } from "./spaces";

const LEASE_TTL_MS = 90_000;
const RENEW_MS = 30_000;

// 租约模型（2026-10-28 P0 并发重构）：
//
// 1. `global`：真正改变“哪个窗口在前台”的呈现操作（ensure_visible / 显式 focus 的
//    open_space / open_tab / switch_tab）。同一时刻只能有一个前台窗口，所以这类操作
//    继续全进程串行——它们本来就会互相覆盖，并行没有意义。
// 2. `space:<spaceId>`：只影响某一个 Task Space（= 一个窗口）的操作。按目标 key 互斥，
//    不同 space 之间真实并行。run_template 整段按 space key 持有：同一 space 内两个模板
//    不会交错破坏状态，不同 space 的两个模板也不会再被进程级租约错误串行化。
// 3. 其它命令（DOM 读写、点击/输入、截图、求值、等待、CDP 透传、下载）不取任何租约。
//    它们不会改变窗口呈现状态，抢租约只会把不同窗口上的 Agent 串行化。
//
// 所有权复用 state.ts 的 ownerClientId 语义（与 SpaceState 一致），不新建 ownership 状态机。
// 模板子步骤通过 `_foregroundLeaseToken` 重入同一 key；不同 key 会正常竞争（fail fast）。

/** 继续全局串行的窗口呈现命令（其余命令按 space key 或完全无租约）。 */
const GLOBAL_PRESENTATION_COMMANDS = new Set<CommandName>([
  "ensure_visible",
  "open_space",
]);

/** 只影响单个 space/window 的命令；`open_tab`/`switch_tab` 在显式前台时升级为 global。 */
const SPACE_SCOPED_COMMANDS = new Set<CommandName>([
  "close_space", "complete_space", "handoff_space", "claim_space", "use_space",
  "open_tab", "close_tab", "switch_tab",
  "start_mask", "stop_mask",
  "run_template",
]);

export type ForegroundLeaseScope = "global" | "space";

export interface ForegroundLeaseTarget {
  scope: ForegroundLeaseScope;
  /** `global` 或 `space:<spaceId>`（未绑定 space 时为 `space:pending:<clientId>`）。 */
  key: string;
  spaceId?: string;
  /** 诊断用：为什么落到这个 key。 */
  reason: string;
}

export class ForegroundLeaseError extends Error {
  readonly code = "FOREGROUND_BUSY";
  constructor(ownerClientId: string, spaceId?: string, detail?: string, key?: string) {
    super(
      "浏览器前台/任务空间正由其他 Agent 使用: owner=" + ownerClientId
        + (key ? " key=" + key : "")
        + (spaceId ? " space=" + spaceId : "")
        + (detail ? "（" + detail + "）" : ""),
    );
    this.name = "ForegroundLeaseError";
  }
}

export interface ForegroundLeaseHandle {
  release(): Promise<void>;
}

/** 判断命令需要哪种租约；undefined = 纯后台操作，不得取任何前台租约。 */
export function foregroundLeaseScopeFor(cmd: Command): ForegroundLeaseScope | undefined {
  if (GLOBAL_PRESENTATION_COMMANDS.has(cmd.name)) return "global";
  if (cmd.name === "open_tab") {
    // 新建窗口或显式聚焦会改变当前前台窗口；普通后台标签只影响自己的 space。
    return cmd.args?.newWindow || wantsVisible(cmd.args) ? "global" : "space";
  }
  if (cmd.name === "switch_tab") {
    return wantsVisible(cmd.args) ? "global" : "space";
  }
  if (SPACE_SCOPED_COMMANDS.has(cmd.name)) return "space";
  return undefined;
}

function explicitSpaceSelector(cmd: Command): string | undefined {
  const args = cmd.args ?? {};
  if (typeof cmd.space === "string" && cmd.space.trim()) return cmd.space.trim();
  if (typeof args.spaceId === "string" && args.spaceId.trim()) return args.spaceId.trim();
  // args.name 只有对“选择已存在 space”的命令才是 space 选择器；open_space 的 name 是新窗口名。
  if (
    (cmd.name === "use_space" || cmd.name === "handoff_space" || cmd.name === "claim_space"
      || cmd.name === "complete_space" || cmd.name === "close_space")
    && typeof args.name === "string" && args.name.trim()
  ) {
    return args.name.trim();
  }
  return undefined;
}

/** 归一化到 `space:<spaceId>`；解析不到（首次使用/尚未绑定）时退化为 per-client key。 */
export async function resolveForegroundLeaseTarget(
  cmd: Command,
  clientId = commandClientId(cmd),
): Promise<ForegroundLeaseTarget | undefined> {
  const scope = foregroundLeaseScopeFor(cmd);
  if (!scope) return undefined;
  if (scope === "global") return { scope, key: "global", reason: cmd.name };

  const selector = explicitSpaceSelector(cmd);
  const state = await loadState();
  if (selector) {
    const space = resolveSpaceSelector(state.spaces, selector);
    if (space && space.ownership !== "inactive") {
      return { scope, key: "space:" + space.spaceId, spaceId: space.spaceId, reason: cmd.name };
    }
    // 选择器存在但还没解析成实体（或已退休）：按调用方给出的字符串归一，保证同一目标仍互斥。
    return { scope, key: "space:" + selector, reason: cmd.name + ":unresolved-selector" };
  }
  const activeId = state.activeSpaceIds?.[clientId];
  if (activeId && state.spaces[activeId]) {
    return { scope, key: "space:" + activeId, spaceId: activeId, reason: cmd.name + ":active-space" };
  }
  // 还没有 space：命令内部会绑定当前聚焦窗口（不改前台）。同 client 串行，不同 client 各自绑定。
  return { scope, key: "space:pending:" + clientId, reason: cmd.name + ":pending-space" };
}

/** 把旧版单条租约迁移到 keyed 表，并清理过期项。调用方必须处于 mutateState 内。 */
export function normalizeForegroundLeases(state: GlobalState): Record<string, ForegroundLeaseRecord> {
  const leases = (state.foregroundLeases ??= {});
  const now = Date.now();
  for (const [key, lease] of Object.entries(leases)) {
    if (!lease || lease.expiresAt <= now) delete leases[key];
  }
  const legacy = state.foregroundLease;
  if (legacy) {
    if (legacy.expiresAt > now) {
      // 旧租约是进程级前台，等价于 global；迁移后仍会挡住新的前台操作，直到过期/释放。
      leases.global ??= {
        token: legacy.token,
        key: "global",
        scope: "global",
        ownerClientId: legacy.ownerClientId,
        spaceId: legacy.spaceId,
        startedAt: legacy.startedAt,
        expiresAt: legacy.expiresAt,
      };
    }
    delete state.foregroundLease;
  }
  return leases;
}

/** 当前有效租约（已做过期清理/旧版迁移）。 */
export function activeForegroundLeases(state: GlobalState): ForegroundLeaseRecord[] {
  return Object.values(normalizeForegroundLeases(state));
}

/** 删除某 Agent 的全部租约（stop 用）；返回被删除的 key。 */
export function deleteForegroundLeasesFor(state: GlobalState, clientId: string): string[] {
  const leases = normalizeForegroundLeases(state);
  const removed: string[] = [];
  for (const [key, lease] of Object.entries(leases)) {
    if (lease.ownerClientId === clientId) {
      delete leases[key];
      removed.push(key);
    }
  }
  return removed;
}

async function refresh(token: string): Promise<void> {
  await mutateState((state) => {
    const leases = normalizeForegroundLeases(state);
    for (const lease of Object.values(leases)) {
      if (lease.token === token) lease.expiresAt = Date.now() + LEASE_TTL_MS;
    }
  });
}

export async function acquireForegroundLease(cmd: Command): Promise<ForegroundLeaseHandle | undefined> {
  const clientId = commandClientId(cmd);
  const target = await resolveForegroundLeaseTarget(cmd, clientId);
  if (!target) return undefined;

  const inherited = cmd._foregroundLeaseToken;
  let token: string | undefined;
  let ownsLease = false;

  await mutateState((state) => {
    const leases = normalizeForegroundLeases(state);

    // 模板子步骤重入：只承认「同 token + 同 owner + 同 key」。不同 key 是合法的升级
    // （例如模板持有 space 租约，内部 ensure_visible 再取 global），会单独竞争。
    if (inherited) {
      const held = Object.values(leases).find((lease) => lease.token === inherited);
      if (held && held.ownerClientId === clientId && held.key === target.key) {
        held.expiresAt = Date.now() + LEASE_TTL_MS;
        token = inherited;
        return;
      }
    }

    const current = leases[target.key];
    if (current) {
      const self = current.ownerClientId === clientId;
      throw new ForegroundLeaseError(
        current.ownerClientId,
        current.spaceId,
        self
          ? "同一 Agent 有命令正在使用该目标；模板子步骤应继承 _foregroundLeaseToken，不要并发派发同一目标命令"
          : undefined,
        target.key,
      );
    }

    token = crypto.randomUUID();
    ownsLease = true;
    leases[target.key] = {
      token,
      key: target.key,
      scope: target.scope,
      ownerClientId: clientId,
      spaceId: target.spaceId,
      startedAt: Date.now(),
      expiresAt: Date.now() + LEASE_TTL_MS,
    };
  });

  if (!token) throw new Error("前台/目标租约创建失败");
  cmd._foregroundLeaseToken = token;
  if (!ownsLease) return { release: async () => {} };

  const leaseToken = token;
  const timer = setInterval(() => { void refresh(leaseToken); }, RENEW_MS);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await mutateState((state) => {
        const leases = normalizeForegroundLeases(state);
        if (leases[target.key]?.token === leaseToken) delete leases[target.key];
      });
    },
  };
}
