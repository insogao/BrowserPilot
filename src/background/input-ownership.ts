// 输入权仲裁（P3，扩展侧）：HUMAN / ASSIST / AI **不是**新的所有权状态。
//
// 唯一真源是 `state.ts` 的 `SpaceState.ownership` + `ownerClientId`：
//   HUMAN  = ownership === "user"
//   AI     = ownership === "agent" 且没有 assist 租约
//   ASSIST = ownership === "agent" 且有 assist 租约（人类临时在场，AI 默认不得输入）
//
// 本模块只做三件事：
//   1. 把 ownership(+assist) 派生成输入模式（纯函数，不存第二份状态）；
//   2. 在命令分派前统一守卫输入类命令（HUMAN 拒绝 / ASSIST 需 grant / AI 放行）；
//   3. 维护 assist 租约与一次性 grant（含去抖与审计事件）。
//
// 明确不做：
//   - 不写 ownership（任何迁移仍走 claim_space / handoff_space / complete_space / close_space）；
//   - 不引入 tab 级所有权（tab 级 mask/takeover 仍由 mask.ts 负责，只影响投递）；
//   - 不调用 CDP（真正注入仍在 actions.ts / debugger-bridge.ts）。
//
// 设计文档：D:\work\BrowserPilot\docs\input-ownership-design-2026-10-28.md §11（已批准决定）。
import type { Command } from "../shared/types";
import {
  loadState,
  mutateState,
  onOwnershipChanged,
  type AssistGrant,
  type SpaceState,
} from "./state";
import {
  INTERNAL_CLIENT_ID,
  UNTRUSTED_CLIENT_ID,
  commandClientId,
  TaskSpaceError,
} from "./spaces";
import { recordEvent } from "./events";

// INTERNAL_CLIENT_ID 定义在 spaces.ts（身份唯一入口）；这里 re-export 仅为兼容既有调用方/文档。
export { INTERNAL_CLIENT_ID };

export type InputMode = "human" | "assist" | "ai";

export type InputOwnershipErrorCode =
  | "INPUT_HUMAN_OWNED"
  | "INPUT_ASSIST_REQUIRES_GRANT"
  | "INPUT_GRANT_INVALID"
  | "INPUT_GRANT_NOT_IN_ASSIST"
  | "INPUT_GRANT_FORBIDDEN"
  | "INPUT_PRESENCE_FORBIDDEN"
  | "INPUT_IDENTITY_UNTRUSTED";

export class InputOwnershipError extends Error {
  constructor(
    public readonly code: InputOwnershipErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InputOwnershipError";
  }
}

/** 人类输入去抖：pause 策略下人类输入照常投递，500ms 后转 ASSIST（设计 §11 决定 2）。 */
export const ASSIST_DEBOUNCE_MS = 500;
export const DEFAULT_GRANT_TTL_MS = 60_000;
/** 硬上限：禁止“一个 grant 管一整天”的滥用（grant 只是一次协助的通行证）。 */
export const MAX_GRANT_TTL_MS = 10 * 60_000;
export const MAX_GRANT_ACTIONS = 10_000;

/** 需要输入权守卫的命令：凡是会向页面注入输入或可代页面执行任意逻辑的命令。
 *  `js` / `tab_cdp_call` 与既有 ACTION_NAMES 一致地纳入：它们能 `el.click()`、能直接
 *  `Input.dispatch*`，若放行就等于给 HUMAN/ASSIST 开了绕过通道。
 *  `download_image` / `download_resource` 不注入输入（只读页面/下载），仍由既有 mask/takeover 检查覆盖。 */
export const INPUT_COMMANDS: ReadonlySet<string> = new Set<string>([
  "click", "dblclick", "hover", "drag", "wheel", "down", "up",
  "press", "type", "fill", "selectOption", "check", "uncheck", "setChecked",
  "js", "tab_cdp_call",
]);

// ---------------------------------------------------------------------------
// 模式派生（纯函数：唯一派生入口，不落状态）
// ---------------------------------------------------------------------------

/** ownership(+assist) → 输入模式。未知/退休空间按 HUMAN 处理（fail closed：AI 输入绝不静默放行）。 */
export function inputModeForSpace(
  space: Pick<SpaceState, "ownership" | "assist"> | undefined | null,
): InputMode {
  if (space?.ownership === "agent") return space.assist ? "assist" : "ai";
  return "human";
}

/** grant 是否仍然可用（计数 > 0 且未过期）。过期 grant 不会被任何路径放行。 */
export function isGrantUsable(grant: AssistGrant | undefined, now = Date.now()): boolean {
  return !!grant && Number.isFinite(grant.actions) && grant.actions > 0
    && Number.isFinite(grant.expiresAt) && grant.expiresAt > now;
}

function truncateToken(token: string): string {
  return token.length <= 10 ? token : token.slice(0, 8) + "…";
}

function audit(name: string, args: Record<string, unknown>): void {
  try {
    recordEvent(name, { ...args, at: Date.now() });
  } catch {
    /* 审计失败绝不阻断输入路径 */
  }
}

// ---------------------------------------------------------------------------
// space 解析（只读；不触发 ensureCommandSpace 的 ownership 断言）
// ---------------------------------------------------------------------------

async function readTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  const tabs = (globalThis as unknown as { chrome?: { tabs?: { get?: (id: number) => Promise<chrome.tabs.Tab> } } })
    .chrome?.tabs;
  if (!tabs || typeof tabs.get !== "function") return undefined;
  try {
    return await tabs.get(tabId);
  } catch {
    return undefined;
  }
}

function numericTabId(cmd: Command): number | undefined {
  const raw = cmd.args?.tabId;
  const tabId = Number(raw);
  return raw !== undefined && raw !== null && Number.isFinite(tabId) ? tabId : undefined;
}

/**
 * 只读解析命令对应的 Task Space（用于守卫与输入权状态查询）。
 *
 * 优先级与 `ensureCommandSpace` 保持一致：显式 space 选择器 > args.tabId 所在窗口 >
 * 调用方活动 space。**不**回退到全局 activeSpaceId：那会把“别的 Agent 的 space”误当目标。
 * 找不到时返回 undefined，交回既有路径（它会按自己的语义报 SPACE_* / 绑定新窗口）。
 */
export async function resolveSpaceForCommand(cmd: Command): Promise<SpaceState | undefined> {
  const state = await loadState();
  const clientId = commandClientId(cmd);
  const args = cmd.args ?? {};
  const raw = cmd.space ?? args.spaceId ?? args.space ?? args.name;
  const selection = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  if (selection) {
    return state.spaces[selection] ?? Object.values(state.spaces).find((space) => space.name === selection);
  }
  const tabId = numericTabId(cmd);
  if (tabId !== undefined) {
    const tab = await readTab(tabId);
    if (tab && typeof tab.windowId === "number") {
      const byWindow = Object.values(state.spaces).find((space) => space.windowId === tab.windowId);
      if (byWindow) return byWindow;
    }
  }
  const activeId = state.activeSpaceIds?.[clientId];
  return activeId ? state.spaces[activeId] : undefined;
}

async function requireSpace(cmd: Command): Promise<SpaceState> {
  const space = await resolveSpaceForCommand(cmd);
  if (!space) throw new TaskSpaceError("SPACE_NOT_FOUND", "没有可操作的 Task Space（先 open_space / use_space）");
  if (space.ownership === "inactive") {
    throw new TaskSpaceError("SPACE_INACTIVE", "Task Space 已结束: " + space.spaceId);
  }
  return space;
}

/** 只有 space 的 owner 或用户入口（internal）可以发放/查询敏感输入权凭据。
 *  身份不可信（缺 host 身份且非内部入口）一律 fail closed，绝不按“无主空间”放行。 */
function assertCallerMayAdminister(space: SpaceState, clientId: string): void {
  if (clientId === UNTRUSTED_CLIENT_ID) {
    audit("input_command_rejected", {
      spaceId: space.spaceId, clientId, command: "input_admin", code: "INPUT_IDENTITY_UNTRUSTED", reason: "no-verified-identity",
    });
    throw new InputOwnershipError(
      "INPUT_IDENTITY_UNTRUSTED",
      "调用方身份不可信：缺少 host 分配的 agent 身份，且不是扩展内部入口（space=" + space.spaceId + "）",
      { spaceId: space.spaceId, clientId },
    );
  }
  if (clientId === INTERNAL_CLIENT_ID) return;
  if (space.ownerClientId && space.ownerClientId !== clientId) {
    throw new TaskSpaceError("SPACE_NOT_OWNED", "Task Space 属于其他 Agent: " + space.spaceId);
  }
}

/** 目标 tab 必须属于该 space 的窗口（显式传 tabId 时校验；不传则由 space 绑定/活动标签决定）。 */
async function assertTabMatchesSpace(space: SpaceState, tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  const tab = await readTab(tabId);
  if (!tab || (space.windowId !== undefined && tab.windowId !== space.windowId)) {
    throw new TaskSpaceError("TAB_OUTSIDE_SPACE", "tabId 不属于当前 Task Space: " + tabId);
  }
}

// ---------------------------------------------------------------------------
// 统一守卫
// ---------------------------------------------------------------------------

export interface InputGuardResult {
  mode: InputMode;
  spaceId: string;
  tabId?: number;
  /** ASSIST 放行时本次消耗后剩余的 grant 次数（0 = 本次用尽）。 */
  grantRemaining?: number;
}

type ConsumeResult =
  | { ok: true; remaining: number; expiresAt: number; token: string }
  | { ok: false; reason: "no-assist" | "no-grant" | "expired" | "exhausted" };

/**
 * 消耗一次 grant（原子读改写，mutateState 串行化；并发命令不会重复使用同一次 grant）。
 * 用尽/过期即清；assist 租约保留（人类仍在场时 AI 只是需要重新申请）。
 */
async function consumeAssistGrant(
  spaceId: string,
  ctx: { clientId: string; command: string; tabId?: number },
): Promise<ConsumeResult> {
  // 用 holder 而不是直接给 `outcome` 赋值：闭包里的赋值不会被 TS 的控制流分析跟踪。
  const holder: { value: ConsumeResult } = { value: { ok: false, reason: "no-assist" } };
  await mutateState((state) => {
    const space = state.spaces[spaceId];
    if (!space || space.ownership !== "agent" || !space.assist) {
      holder.value = { ok: false, reason: "no-assist" };
      return;
    }
    const grant = space.assist.grant;
    if (!grant) {
      holder.value = { ok: false, reason: "no-grant" };
      return;
    }
    const now = Date.now();
    if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) {
      delete space.assist.grant;
      holder.value = { ok: false, reason: "expired" };
      return;
    }
    if (!Number.isFinite(grant.actions) || grant.actions <= 0) {
      delete space.assist.grant;
      holder.value = { ok: false, reason: "exhausted" };
      return;
    }
    grant.actions -= 1;
    const remaining = grant.actions;
    const expiresAt = grant.expiresAt;
    const token = grant.token;
    if (remaining <= 0) delete space.assist.grant;
    space.updatedAt = now;
    holder.value = { ok: true, remaining, expiresAt, token };
  });
  const outcome = holder.value;
  if (outcome.ok) {
    audit("input_grant_consumed", {
      spaceId,
      tabId: ctx.tabId,
      clientId: ctx.clientId,
      command: ctx.command,
      remaining: outcome.remaining,
      expiresAt: outcome.expiresAt,
      token: truncateToken(outcome.token),
      mode: "assist",
    });
  }
  return outcome;
}

/**
 * 输入类命令的统一守卫（dispatch 在调用具体 handler 之前调用）。
 *
 * - HUMAN  → 抛 INPUT_HUMAN_OWNED（fail fast，不排队、不降级、不消耗任何 grant）
 * - ASSIST → 无可用 grant 抛 INPUT_ASSIST_REQUIRES_GRANT；有则消耗 1 次后放行
 * - AI     → 放行
 * - space 不存在 / inactive / 未绑定 → 返回 undefined，交回既有路径给出精确的 SPACE_* 错误。
 */
export async function guardInputCommand(cmd: Command): Promise<InputGuardResult | undefined> {
  const space = await resolveSpaceForCommand(cmd);
  if (!space || space.ownership === "inactive") return undefined;
  // 先做归属校验（与 ensureCommandSpace 的顺序一致）：外部 Agent 显式指定别人的 space 时
  // 直接 SPACE_NOT_OWNED，既不会消耗 owner 的 grant，也不会泄露该 space 的输入模式。
  assertCallerMayAdminister(space, commandClientId(cmd));
  const mode = inputModeForSpace(space);
  const clientId = commandClientId(cmd);
  const tabId = numericTabId(cmd) ?? space.tabId;

  if (mode === "human") {
    const reason = space.ownership === "user" ? "ownership-user" : "ownership-unknown";
    audit("input_command_rejected", {
      spaceId: space.spaceId,
      tabId,
      clientId,
      command: cmd.name,
      mode,
      code: "INPUT_HUMAN_OWNED",
      reason,
    });
    throw new InputOwnershipError(
      "INPUT_HUMAN_OWNED",
      "用户正在控制 Task Space（ownership=user），已拒绝 AI 输入命令: " + cmd.name + "（space=" + space.spaceId + "）",
      { spaceId: space.spaceId, tabId, mode, command: cmd.name, clientId, reason },
    );
  }

  if (mode === "ai") return { mode, spaceId: space.spaceId, tabId };

  const consumed = await consumeAssistGrant(space.spaceId, { clientId, command: cmd.name, tabId });
  if (!consumed.ok) {
    audit("input_command_rejected", {
      spaceId: space.spaceId,
      tabId,
      clientId,
      command: cmd.name,
      mode,
      code: "INPUT_ASSIST_REQUIRES_GRANT",
      reason: consumed.reason,
    });
    throw new InputOwnershipError(
      "INPUT_ASSIST_REQUIRES_GRANT",
      "ASSIST 模式下需要 grant 才能放行 AI 输入: " + cmd.name + "（reason=" + consumed.reason + "，space=" + space.spaceId + "）",
      { spaceId: space.spaceId, tabId, mode, command: cmd.name, clientId, reason: consumed.reason },
    );
  }
  return { mode, spaceId: space.spaceId, tabId, grantRemaining: consumed.remaining };
}

// ---------------------------------------------------------------------------
// ASSIST 租约（enter/exit + 去抖；不新增状态机，只写 SpaceState.assist）
// ---------------------------------------------------------------------------

const presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 取消某个 space 待触发的 human_presence 去抖（ownership 写入时由 state.ts 回调）。 */
export function cancelPendingPresence(spaceId: string): boolean {
  const timer = presenceTimers.get(spaceId);
  if (timer === undefined) return false;
  clearTimeout(timer);
  presenceTimers.delete(spaceId);
  return true;
}

// ownership 一经写入（claim/handoff/complete/close/窗口消失），待触发的 presence 立即作废：
// 否则 claim_space 之后迟到的定时器会把空间重新拉回 ASSIST。
onOwnershipChanged((spaceId) => {
  cancelPendingPresence(spaceId);
});

export interface EnterAssistOptions {
  reason?: string;
  tabId?: number;
  source?: string;
}

/**
 * 进入 ASSIST：只写 `assist`，**不改 ownership**。
 * - ownership 不是 "agent"（用户已接管 / 空间退休）时是无操作；
 * - 新的“人类在场”会清掉上一条未用完的 grant（人类优先，AI 必须重新申请）。
 */
export async function enterAssist(spaceId: string, opts: EnterAssistOptions = {}): Promise<boolean> {
  const since = Date.now();
  const reason = opts.reason ?? opts.source ?? "human_presence";
  let changed = false;
  await mutateState((state) => {
    const space = state.spaces[spaceId];
    if (!space || space.ownership !== "agent") return;
    space.assist = {
      since,
      reason,
      ...(opts.tabId !== undefined ? { tabId: opts.tabId } : {}),
    };
    space.updatedAt = since;
    changed = true;
  });
  if (changed) {
    audit("input_assist_entered", {
      spaceId,
      tabId: opts.tabId,
      source: opts.source ?? "human_presence",
      reason,
    });
  }
  return changed;
}

/** 退出 ASSIST（恢复 AI）。等价于“人类离开”，不改 ownership。 */
export async function exitAssist(spaceId: string, reason = "explicit"): Promise<boolean> {
  cancelPendingPresence(spaceId);
  let removed = false;
  await mutateState((state) => {
    const space = state.spaces[spaceId];
    if (!space?.assist) return;
    delete space.assist;
    space.updatedAt = Date.now();
    removed = true;
  });
  if (removed) audit("input_assist_exited", { spaceId, reason });
  return removed;
}

/**
 * 人类输入去抖入口（未来内核 `human_presence` 事件的落点）：连续事件只保留最后一次，
 * 静默 debounceMs 后才真正进入 ASSIST（pause 策略）。
 */
export function noteHumanPresence(
  spaceId: string,
  opts: EnterAssistOptions & { debounceMs?: number } = {},
): { debounceMs: number; applyAt: number } {
  const debounceMs = opts.debounceMs ?? ASSIST_DEBOUNCE_MS;
  cancelPendingPresence(spaceId);
  const applyAt = Date.now() + debounceMs;
  const timer = setTimeout(() => {
    presenceTimers.delete(spaceId);
    void enterAssist(spaceId, opts).catch(() => {
      /* 空间可能在去抖期间被关闭；enterAssist 自身已做 ownership 检查 */
    });
  }, debounceMs);
  // Node 测试里允许进程正常退出；浏览器 setTimeout 返回 number，可选链安全。
  (timer as unknown as { unref?: () => void }).unref?.();
  presenceTimers.set(spaceId, timer);
  return { debounceMs, applyAt };
}

// ---------------------------------------------------------------------------
// 新命令实现：grant_input / input_status / human_presence
// ---------------------------------------------------------------------------

export interface GrantInputResult {
  spaceId: string;
  mode: InputMode;
  tabId?: number;
  grant: { token: string; actions: number; expiresAt: number };
}

function parseGrantArgs(args: Record<string, unknown>): { actions: number; ttlMs: number } {
  const rawActions = args.actions;
  if (typeof rawActions !== "number" || !Number.isInteger(rawActions) || rawActions <= 0) {
    throw new InputOwnershipError(
      "INPUT_GRANT_INVALID",
      "grant_input.actions 必须是正整数（拒绝 0 / 负数 / 小数），实际: " + String(rawActions),
    );
  }
  if (rawActions > MAX_GRANT_ACTIONS) {
    throw new InputOwnershipError(
      "INPUT_GRANT_INVALID",
      "grant_input.actions 超过上限 " + MAX_GRANT_ACTIONS + "，实际: " + rawActions,
    );
  }
  const rawTtl = args.ttlMs;
  const ttlMs = rawTtl === undefined ? DEFAULT_GRANT_TTL_MS : rawTtl;
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new InputOwnershipError(
      "INPUT_GRANT_INVALID",
      "grant_input.ttlMs 必须是正整数毫秒（拒绝 0 / 负数 / 小数），实际: " + String(rawTtl),
    );
  }
  if (ttlMs > MAX_GRANT_TTL_MS) {
    throw new InputOwnershipError(
      "INPUT_GRANT_INVALID",
      "grant_input.ttlMs 超过上限 " + MAX_GRANT_TTL_MS + "ms，实际: " + ttlMs,
    );
  }
  return { actions: rawActions, ttlMs };
}

/**
 * grant_input：在 ASSIST 下发放一次性 grant。
 * 仅用户入口可发；HUMAN 下不能发放（grant 不能绕过 ownership，必须先 claim_space）；
 * AI 下无意义（返回 INPUT_GRANT_NOT_IN_ASSIST）。
 *
 * 不能让 owner Agent 自己发放：grant 是“人类允许 AI 这一次输入”的凭据，
 * 若 AI 能自证，ASSIST 就失去意义。
 */
export async function grantInputCommand(cmd: Command): Promise<GrantInputResult> {
  const space = await requireSpace(cmd);
  const clientId = commandClientId(cmd);
  assertCallerMayAdminister(space, clientId);
  if (clientId !== INTERNAL_CLIENT_ID) {
    audit("input_command_rejected", {
      spaceId: space.spaceId, clientId, command: "grant_input", code: "INPUT_GRANT_FORBIDDEN", reason: "agent-self-grant",
    });
    throw new InputOwnershipError(
      "INPUT_GRANT_FORBIDDEN",
      "grant_input 只能由用户入口（" + INTERNAL_CLIENT_ID + "）发放；Agent 不能自行授权覆盖人类的 ASSIST 输入权",
      { spaceId: space.spaceId, clientId },
    );
  }
  if (space.ownership === "user") {
    audit("input_command_rejected", {
      spaceId: space.spaceId, clientId, command: "grant_input", mode: "human", code: "INPUT_HUMAN_OWNED", reason: "ownership-user",
    });
    throw new InputOwnershipError(
      "INPUT_HUMAN_OWNED",
      "用户拥有该 Task Space（ownership=user）时不能发放 grant；先由用户 claim_space 恢复 Agent 控制",
      { spaceId: space.spaceId, mode: "human", command: "grant_input", clientId },
    );
  }
  if (inputModeForSpace(space) !== "assist") {
    throw new InputOwnershipError(
      "INPUT_GRANT_NOT_IN_ASSIST",
      "grant_input 只在 ASSIST 模式下有意义（当前 mode=" + inputModeForSpace(space) + "，space=" + space.spaceId + "）",
      { spaceId: space.spaceId, mode: inputModeForSpace(space) },
    );
  }
  const tabId = numericTabId(cmd) ?? space.tabId;
  await assertTabMatchesSpace(space, numericTabId(cmd));
  const { actions, ttlMs } = parseGrantArgs(cmd.args ?? {});

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + ttlMs;
  let issued = false;
  await mutateState((state) => {
    const current = state.spaces[space.spaceId];
    if (!current || current.ownership !== "agent" || !current.assist) return;
    current.assist.grant = { token, actions, expiresAt };
    if (tabId !== undefined) current.assist.tabId = tabId;
    current.updatedAt = Date.now();
    issued = true;
  });
  if (!issued) {
    // 读取与写入之间 ownership 变了（例如用户刚接管）：fail closed。
    throw new InputOwnershipError(
      "INPUT_GRANT_NOT_IN_ASSIST",
      "发放 grant 期间 Task Space 的模式已变化（不再处于 ASSIST），未发放",
      { spaceId: space.spaceId },
    );
  }
  audit("input_grant_issued", {
    spaceId: space.spaceId, tabId, clientId, actions, ttlMs, expiresAt, token: truncateToken(token),
  });
  return {
    spaceId: space.spaceId,
    mode: "assist",
    tabId,
    grant: { token: truncateToken(token), actions, expiresAt },
  };
}

export interface InputStatus {
  spaceId: string;
  windowId?: number;
  tabId?: number;
  mode: InputMode;
  ownership: SpaceState["ownership"] | "unknown";
  ownerClientId?: string;
  assistSince?: number;
  assistReason?: string;
  /** grant 的绝对到期时间（没有可用 grant 时为 null）。 */
  assistExpiresAt: number | null;
  /** 剩余可放行的输入命令次数（没有可用 grant 时为 null）。 */
  grantActionsRemaining: number | null;
  grant: { token: string; actions: number; expiresAt: number; expiresInMs: number } | null;
}

/** input_status：只读视图。过期 grant 不会被计为可用（但不会在这里写状态）。 */
export async function inputStatusCommand(cmd: Command): Promise<InputStatus> {
  const space = await requireSpace(cmd);
  assertCallerMayAdminister(space, commandClientId(cmd));
  const grant = space.assist?.grant;
  const now = Date.now();
  const usable = isGrantUsable(grant, now) ? grant : undefined;
  return {
    spaceId: space.spaceId,
    windowId: space.windowId,
    tabId: numericTabId(cmd) ?? space.tabId,
    mode: inputModeForSpace(space),
    ownership: space.ownership ?? "unknown",
    ownerClientId: space.ownerClientId,
    ...(space.assist ? { assistSince: space.assist.since, assistReason: space.assist.reason } : {}),
    assistExpiresAt: usable ? usable!.expiresAt : null,
    grantActionsRemaining: usable ? usable!.actions : null,
    grant: usable
      ? {
          token: truncateToken(usable!.token),
          actions: usable!.actions,
          expiresAt: usable!.expiresAt,
          expiresInMs: Math.max(0, usable!.expiresAt - now),
        }
      : null,
  };
}

export interface HumanPresenceResult {
  spaceId: string;
  tabId?: number;
  mode: InputMode;
  ownership: SpaceState["ownership"] | "unknown";
  changed: boolean;
  scheduled: boolean;
  source: string;
  debounceMs: number;
  applyAt?: number;
  reason?: string;
}

/**
 * human_presence：内核事件 / 用户入口 / 测试入口，进入 ASSIST。
 *
 * 防滥用（身份不可由消息字段伪造）：
 *  - 只接受扩展内部入口（popup/内核事件桥用 `markInternalCommand()` 打标）；
 *    `args.internal === true`、`_clientId: "browserpilot-internal"`、`_channel` 等字段一律无效；
 *  - 非 owner 的 Agent 一律 SPACE_NOT_OWNED（不能替别人进 ASSIST）；
 *  - HUMAN 空间是无操作（用户已经在控制，不需要也不允许“再接管”）。
 */
export async function humanPresenceCommand(cmd: Command): Promise<HumanPresenceResult> {
  const space = await requireSpace(cmd);
  const clientId = commandClientId(cmd);
  assertCallerMayAdminister(space, clientId);
  const args = cmd.args ?? {};
  if (clientId !== INTERNAL_CLIENT_ID) {
    throw new InputOwnershipError(
      "INPUT_PRESENCE_FORBIDDEN",
      "human_presence 只接受用户入口（" + INTERNAL_CLIENT_ID + "）或内核桥；Agent 不能伪造人类在场",
      { spaceId: space.spaceId, clientId },
    );
  }
  const source = typeof args.source === "string" && args.source.trim() ? args.source.trim() : "unknown";
  const tabId = numericTabId(cmd) ?? space.tabId;
  await assertTabMatchesSpace(space, numericTabId(cmd));
  const mode = inputModeForSpace(space);
  if (mode === "human") {
    audit("input_presence_ignored", { spaceId: space.spaceId, tabId, clientId, source, reason: "already-human" });
    return {
      spaceId: space.spaceId, tabId, mode, ownership: space.ownership ?? "unknown",
      changed: false, scheduled: false, source, debounceMs: 0, reason: "already-human",
    };
  }

  const rawDebounce = args.debounceMs;
  const debounceMs = typeof rawDebounce === "number" && Number.isFinite(rawDebounce) && rawDebounce >= 0 && rawDebounce <= 5000
    ? Math.floor(rawDebounce)
    : ASSIST_DEBOUNCE_MS;

  if (args.immediate === true) {
    const changed = await enterAssist(space.spaceId, { reason: source, source, tabId });
    return {
      spaceId: space.spaceId, tabId, mode: changed ? "assist" : mode,
      ownership: space.ownership ?? "unknown", changed, scheduled: false, source, debounceMs,
    };
  }

  const { applyAt } = noteHumanPresence(space.spaceId, { reason: source, source, tabId, debounceMs });
  audit("input_presence_scheduled", { spaceId: space.spaceId, tabId, clientId, source, applyAt, debounceMs });
  return {
    spaceId: space.spaceId, tabId, mode, ownership: space.ownership ?? "unknown",
    changed: false, scheduled: true, source, debounceMs, applyAt,
  };
}
