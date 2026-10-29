// P3 生产 API 客户端（扩展侧）：`chrome.browserCli.inputOwnership`。
//
// 分工（设计文档：docs/input-ownership-api-2026-10-29.md）：
//   1. 所有权唯一真源仍是 `state.ts` 的 `SpaceState.ownership` + `assist`；
//      本模块只把 `inputModeForSpace()` 派生出的模式按**单调 version** 同步给内核；
//   2. 每条 ASSIST 输入命令用一个内核命令 scope（grant + begin/end）把
//      「一条扩展命令」对齐成「一次内核 grant」，异常/超时由内核绝对截止兜底；
//   3. 普通 Chrome（generic）或内核 Feature 关闭（API 不存在）时**零行为变化**：
//      不注册定时器、不发任何调用，命令层守卫继续由 input-ownership.ts 负责。
//
// 明确不做：
//   - 不写 ownership / assist（只读 SpaceState 并派生模式）；
//   - 不直接发 CDP 输入（actions.ts 的职责），不 import cdp/mask/actions；
//   - 不把内核返回的 mode 当成所有权（只在版本冲突时对齐账本，且绝不回退版本）。
import type { Command } from "../shared/types";
import {
  InputOwnershipError,
  humanPresenceCommand,
  inputModeForSpace,
  onInputModeChanged,
  resolveSpaceForCommand,
  type InputGuardResult,
  type InputMode,
} from "./input-ownership";
import {
  loadState,
  mutateState,
  onOwnershipChanged,
  type KernelInputOwnershipRecord,
  type SpaceState,
} from "./state";
import { markInternalCommand } from "./spaces";
import { recordEvent } from "./events";

// ---------------------------------------------------------------------------
// 常量（与设计文档 §3 / §5 一致）
// ---------------------------------------------------------------------------

/** 扩展 → 内核心跳周期。MV3 的 alarms 最小周期是 30s，因此用 setInterval 做到 10s；
 *  SW 被回收时定时器消失，内核按 30s 失联降级 ASSIST，下一次命令会先重新同步。 */
export const KERNEL_HEARTBEAT_INTERVAL_MS = 10_000;
/** 内核侧失联阈值：超过它没有任何确认，内核按 ASSIST 处理并清 grant。 */
export const KERNEL_STALE_MS = 30_000;
/** 每条 ASSIST 命令向内核申请的一次性 grant 的默认绝对 TTL（鼠标类命令）。 */
export const KERNEL_COMMAND_TTL_MS = 10_000;
/** 文本类命令可能逐字输入很久（`type` 默认 8ms/字），给更长的绝对窗口。 */
export const KERNEL_COMMAND_TEXT_TTL_MS = 60_000;
/** `js` / `tab_cdp_call` 可能等待网络/长任务；仍然有绝对上限。 */
export const KERNEL_COMMAND_EVAL_TTL_MS = 120_000;
/** 内核 `onHumanPresence` 已做 300ms 去抖，扩展侧再做 500ms trailing 去抖（设计 §11 决定 2）。 */
export const KERNEL_PRESENCE_DEBOUNCE_MS = 500;
/** 单次内核调用的硬超时：内核 API 在浏览器进程内，正常应在毫秒级返回；
 *  超时按失败处理（fail closed），避免一个挂死的宿主阻塞 SW 初始化/命令。 */
export const KERNEL_API_TIMEOUT_MS = 2_000;

export type KernelBridgeState = "unknown" | "unsupported" | "ready";

export interface KernelTarget {
  tabId?: number;
  windowId?: number;
}

export interface KernelSetOwnershipResult {
  accepted?: boolean;
  mode?: InputMode;
  version?: number;
  reason?: string;
}

export interface KernelHeartbeatResult {
  ok?: boolean;
  accepted?: boolean;
  mode?: InputMode;
  version?: number;
  stale?: boolean;
  reason?: string;
}

export interface KernelOwnershipSnapshot {
  mode?: InputMode;
  version?: number;
  stale?: boolean;
  reason?: string;
}

export interface KernelGrantResult {
  granted?: boolean;
  ok?: boolean;
  actions?: number;
  expiresAt?: number;
  /** 不透明 session 标识，仅用于审计/诊断；扩展默认不回传（内核按调用方 + tab 解析）。 */
  sessionToken?: string;
  reason?: string;
}

export interface KernelBeginCommandResult {
  ok?: boolean;
  scopeId?: string;
  deadline?: number;
  grantRemaining?: number;
  reason?: string;
}

export interface KernelEndCommandResult {
  ok?: boolean;
  closed?: boolean;
  reason?: string;
}

export interface KernelHumanPresenceEvent {
  tabId?: number;
  windowId?: number;
  kind?: string;
  at?: number;
}

type PresenceListener = (event: KernelHumanPresenceEvent) => void;
type PresenceEvent = {
  addListener(listener: PresenceListener): void;
  removeListener?(listener: PresenceListener): void;
};

/** 宿主 API 的最小形状。`setOwnership` / `heartbeat` / `getOwnership` 是核心；
 *  `grantInput` + `beginInputCommand` + `endInputCommand` 是 ASSIST 命令 scope 的三件套。 */
export interface InputOwnershipKernelApi {
  setOwnership(request: { target: KernelTarget; mode: InputMode; version: number }): Promise<KernelSetOwnershipResult>;
  heartbeat(request: { target: KernelTarget; version: number }): Promise<KernelHeartbeatResult>;
  getOwnership(request: { target: KernelTarget }): Promise<KernelOwnershipSnapshot>;
  grantInput?(request: {
    target: KernelTarget;
    actions: number;
    ttlMs: number;
    session?: string;
  }): Promise<KernelGrantResult>;
  beginInputCommand?(request: {
    target: KernelTarget;
    commandId: string;
    kind: string;
    session?: string;
  }): Promise<KernelBeginCommandResult>;
  endInputCommand?(request: {
    target: KernelTarget;
    commandId: string;
    outcome?: "ok" | "failed" | "cancelled";
    session?: string;
  }): Promise<KernelEndCommandResult>;
  /** chrome 事件风格（addListener）或订阅函数风格都接受；实现按 shape 适配。 */
  onHumanPresence?: PresenceEvent | ((listener: PresenceListener) => void | (() => void));
}

// ---------------------------------------------------------------------------
// 探测（唯一入口；普通 Chrome 上命名空间不存在）
// ---------------------------------------------------------------------------

function getInputOwnershipNamespace(): unknown {
  // 必须走 globalThis：MV3 SW 里扩展 API 挂在 globalThis 上（与 capabilities.ts 一致）。
  const g = globalThis as unknown as { chrome?: Record<string, unknown> };
  const browserCli = g.chrome?.["browserCli"];
  if (!browserCli || typeof browserCli !== "object") return undefined;
  return (browserCli as Record<string, unknown>)["inputOwnership"];
}

/**
 * 探测内核输入权 API。API 的**存在性**是唯一信号（与 Phase 7 的 capability 探测一致）：
 * 普通 Chrome / Feature 关闭时命名空间不存在，扩展自动退化为只有命令层守卫。
 *
 * 只要求核心三方法存在；grant/begin/end 缺失时仍视为“核心可用”，但 ASSIST 会
 * fail closed（INPUT_OWNERSHIP_API_INCOMPLETE），不会假装命令 scope 可用。
 */
export function getInputOwnershipApi(): InputOwnershipKernelApi | undefined {
  const ns = getInputOwnershipNamespace();
  if (!ns || typeof ns !== "object") return undefined;
  const api = ns as Record<string, unknown>;
  for (const method of ["setOwnership", "heartbeat", "getOwnership"]) {
    if (typeof api[method] !== "function") return undefined;
  }
  return ns as unknown as InputOwnershipKernelApi;
}

/** 带 deadline 的探测：内核在 SW 创建后注入 API，存在约 0.5s 窗口期（见 capabilities.ts）。 */
export async function probeInputOwnershipApi(
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<InputOwnershipKernelApi | undefined> {
  const timeoutMs = options.timeoutMs ?? 0;
  const pollMs = options.pollMs ?? 100;
  const deadline = nowFn() + Math.max(0, timeoutMs);
  for (;;) {
    const api = getInputOwnershipApi();
    if (api) return api;
    if (nowFn() >= deadline) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

// ---------------------------------------------------------------------------
// 内部状态（内存 + 持久账本）
// ---------------------------------------------------------------------------

interface KernelTargetRuntime extends KernelInputOwnershipRecord {
  key: string;
  target: KernelTarget;
  /** 第一次尝试同步的时间（不随重试刷新，用于「从未成功过」的 30s 判定）。 */
  firstAttemptAt: number;
  lastAttemptAt: number;
  degraded: boolean;
  lastError?: string;
  kernelVersion?: number;
  kernelMode?: InputMode;
  stale?: boolean;
}

let nowFn: () => number = Date.now;
let heartbeatIntervalMs = KERNEL_HEARTBEAT_INTERVAL_MS;
let apiTimeoutMs = KERNEL_API_TIMEOUT_MS;
let presenceDebounceMs = KERNEL_PRESENCE_DEBOUNCE_MS;
let bridgeState: KernelBridgeState = "unknown";
let unsupportedReason: string | undefined;
let apiRef: InputOwnershipKernelApi | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let presenceUnsubscribe: (() => void) | undefined;
let initPromise: Promise<void> | undefined;
let autoSyncEnabled = true;

const runtime = new Map<string, KernelTargetRuntime>();
const pendingSyncs = new Set<string>();
const auditOnceKeys = new Set<string>();

function now(): number {
  return nowFn();
}

function audit(name: string, args: Record<string, unknown>): void {
  try {
    recordEvent(name, { ...args, at: now() });
  } catch {
    /* 审计失败绝不阻断输入路径 */
  }
}

function auditOnce(key: string, name: string, args: Record<string, unknown>): void {
  if (auditOnceKeys.has(key)) return;
  auditOnceKeys.add(key);
  audit(name, args);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 给内核调用加硬超时；超时 reject 后延迟返回的 promise 结果会被 race 忽略（不会 unhandled）。 */
function withKernelTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    // 注意：这里不能 unref。超时是「挂死调用」的唯一出口；unref 会让 Node
    // 在只有这个定时器时直接退出（离线单测），浏览器里也不会按预期触发。
    timer = setTimeout(() => reject(new Error(label + " timeout after " + apiTimeoutMs + "ms")), apiTimeoutMs);
  });
  return Promise.race([
    promise.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    timeout,
  ]);
}

function asVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asMode(value: unknown): InputMode | undefined {
  return value === "ai" || value === "assist" || value === "human" ? value : undefined;
}

/** 命令 kind → 内核 grant/scope 的绝对 TTL。未知命令按鼠标类的 10s 保守处理。 */
export function commandTtlFor(kind: string): number {
  if (kind === "type" || kind === "fill") return KERNEL_COMMAND_TEXT_TTL_MS;
  if (kind === "js" || kind === "tab_cdp_call") return KERNEL_COMMAND_EVAL_TTL_MS;
  return KERNEL_COMMAND_TTL_MS;
}

/**
 * 目标键。`tabId` 与 `windowId` 必须且只能有一个：
 *  - 窗口级 ownership 用 `win:<windowId>`（内核展开到该窗口的 WebContents）；
 *  - 命令级 grant / session 绑定用 `tab:<tabId>`。
 */
export function targetKey(target: KernelTarget): string {
  const hasTab = Number.isInteger(target.tabId);
  const hasWindow = Number.isInteger(target.windowId);
  if (hasTab === hasWindow) {
    throw new Error("inputOwnership target 必须且只能包含 tabId 或 windowId");
  }
  return hasTab ? "tab:" + target.tabId : "win:" + target.windowId;
}

function sanitizeTarget(target: KernelTarget): KernelTarget {
  if (Number.isInteger(target.tabId)) return { tabId: target.tabId };
  return { windowId: target.windowId };
}

async function readTabWindowId(tabId: number): Promise<number | undefined> {
  const tabs = (globalThis as unknown as {
    chrome?: { tabs?: { get?: (id: number) => Promise<{ windowId?: number }> } };
  }).chrome?.tabs;
  if (!tabs || typeof tabs.get !== "function") return undefined;
  try {
    const tab = await tabs.get(tabId);
    return typeof tab?.windowId === "number" ? tab.windowId : undefined;
  } catch {
    return undefined;
  }
}

async function persistRecord(record: KernelTargetRuntime): Promise<void> {
  await mutateState((state) => {
    const ledger = state.kernelInputOwnership ?? { targets: {} };
    ledger.targets[record.key] = {
      version: record.version,
      mode: record.mode,
      lastAckAt: record.lastAckAt,
      lastAttemptAt: record.lastAttemptAt,
    };
    ledger.updatedAt = now();
    state.kernelInputOwnership = ledger;
  });
}

async function prunePersistedRecord(key: string): Promise<void> {
  await mutateState((state) => {
    const ledger = state.kernelInputOwnership;
    if (!ledger || !ledger.targets[key]) return;
    delete ledger.targets[key];
    ledger.updatedAt = now();
  });
}

async function hydrateRuntime(
  key: string,
  target: KernelTarget,
  desired: InputMode,
): Promise<KernelTargetRuntime> {
  const existing = runtime.get(key);
  if (existing) return existing;
  const state = await loadState();
  const ledger = state.kernelInputOwnership?.targets?.[key];
  const record: KernelTargetRuntime = {
    key,
    target: sanitizeTarget(target),
    // version 0 表示“从未同步”，第一次 setOwnership 会用 1。
    version: asVersion(ledger?.version) ?? 0,
    mode: asMode(ledger?.mode) ?? desired,
    lastAckAt: typeof ledger?.lastAckAt === "number" && Number.isFinite(ledger.lastAckAt) ? ledger.lastAckAt : 0,
    firstAttemptAt: 0,
    lastAttemptAt: 0,
    degraded: false,
  };
  runtime.set(key, record);
  return record;
}

// ---------------------------------------------------------------------------
// API 解析（enhanced 模式门禁）
// ---------------------------------------------------------------------------

async function resolveApi(): Promise<InputOwnershipKernelApi | undefined> {
  if (bridgeState === "ready" && apiRef) return apiRef;
  const state = await loadState();
  const caps = state.hostCapabilities;
  if (caps && caps.mode !== "enhanced") {
    bridgeState = "unsupported";
    unsupportedReason = "generic-host";
    auditOnce("unsupported:generic-host", "input_ownership_api_unavailable", { reason: unsupportedReason });
    return undefined;
  }
  const api = getInputOwnershipApi();
  if (api) {
    apiRef = api;
    bridgeState = "ready";
    unsupportedReason = undefined;
    return api;
  }
  if (!caps) {
    // capability 探测尚未完成：保持 unknown，后续命令/心跳会重试。
    bridgeState = "unknown";
    unsupportedReason = "capabilities-not-ready";
    return undefined;
  }
  bridgeState = "unsupported";
  unsupportedReason = "api-absent";
  auditOnce("unsupported:api-absent", "input_ownership_api_unavailable", { reason: unsupportedReason });
  return undefined;
}

// ---------------------------------------------------------------------------
// 同步：setOwnership / heartbeat（单调 version + 版本冲突）
// ---------------------------------------------------------------------------

export interface SyncSpaceOptions {
  /** 强制走 setOwnership（即使模式没变），用于 SW 重启后重新登记。 */
  forceSet?: boolean;
  /** 与 forceSet 搭配：模式和 version 都没变时用**相同 version** 重放，
   *  而不是 +1。用于 SW 重启后的幂等重新登记（内核状态可能还在）。 */
  replay?: boolean;
}

/**
 * 同步一个 space 的派生模式到内核。
 *
 * 规则：
 *  - 模式没变且已有 version → heartbeat（不 bump）；
 *  - 模式变化 / 首次 / forceSet → setOwnership(version + 1)；
 *  - 内核拒绝旧版本时采纳内核更高的 version 并**只重试一次**，绝不回退版本；
 *  - 失败只记录 error，不在这里进入 degraded（由 heartbeatTick 按 30s 判定），
 *    这样 init 阶段一次瞬时失败不会把整个扩展锁死。
 */
export async function syncSpace(
  space: SpaceState,
  reason = "manual",
  options: SyncSpaceOptions = {},
): Promise<KernelTargetRuntime | undefined> {
  if (space.ownership === "inactive" || space.windowId === undefined) return undefined;
  const api = await resolveApi();
  if (!api) return undefined;

  const target: KernelTarget = { windowId: space.windowId };
  const key = targetKey(target);
  const desired = inputModeForSpace(space);
  const record = await hydrateRuntime(key, target, desired);
  if (record.firstAttemptAt === 0) record.firstAttemptAt = now();
  record.lastAttemptAt = now();

  const needSet =
    options.forceSet === true ||
    record.version === 0 ||
    record.mode !== desired ||
    record.kernelVersion === undefined;

  try {
    if (needSet) {
      const replay =
        options.replay === true && record.version > 0 && record.mode === desired;
      await setOwnershipWithConflictRetry(api, record, desired, reason, replay);
    } else {
      await heartbeatRecord(api, record, desired, reason);
    }
    record.lastAckAt = now();
    record.degraded = false;
    record.lastError = undefined;
    record.stale = false;
    record.kernelVersion = record.version;
    record.kernelMode = record.mode;
    await persistRecord(record);
    audit("input_ownership_synced", {
      target: record.key,
      mode: desired,
      version: record.version,
      reason,
      ledgerMode: record.mode,
    });
    return record;
  } catch (error) {
    record.lastError = errorMessage(error);
    audit("input_ownership_sync_failed", {
      target: record.key,
      mode: desired,
      version: record.version,
      reason,
      error: record.lastError,
    });
    throw error;
  }
}

async function setOwnershipWithConflictRetry(
  api: InputOwnershipKernelApi,
  record: KernelTargetRuntime,
  desired: InputMode,
  reason: string,
  replay = false,
): Promise<void> {
  // replay：SW 重启后模式没变，用已有 version 幂等重放（内核若还在，同 version/同 mode 幂等；
  // 内核若已重启、version 归零，则更高 version 仍被接受）。
  let version = replay ? record.version : record.version + 1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await withKernelTimeout(
      api.setOwnership({ target: record.target, mode: desired, version }),
      "setOwnership",
    );
    const kernelVersion = asVersion(result?.version);
    if (result?.accepted === true) {
      const acceptedMode = asMode(result.mode) ?? desired;
      // 只接受不回退的 version：内核若返回更小的值，保持我们已发送的 version。
      record.version = kernelVersion !== undefined && kernelVersion >= version ? kernelVersion : version;
      record.mode = acceptedMode;
      if (acceptedMode !== desired) {
        // 内核接受了但模式不一致：下一次同步必须再发一次 setOwnership。
        audit("input_ownership_mode_mismatch", {
          target: record.key,
          desired,
          kernelMode: acceptedMode,
          version: record.version,
        });
      }
      return;
    }
    if (attempt === 0 && kernelVersion !== undefined && kernelVersion >= version) {
      // 内核已有更高版本（例如 SW 重启前残留 / 另一个标签页先同步过）：
      // 采纳它，再用 +1 重试一次。绝不把 version 降回去。
      record.version = Math.max(record.version, kernelVersion);
      const kernelMode = asMode(result?.mode);
      if (kernelMode) record.mode = kernelMode;
      version = record.version + 1;
      audit("input_ownership_version_conflict", {
        target: record.key,
        desired,
        kernelVersion,
        retryVersion: version,
        reason: result?.reason,
      });
      continue;
    }
    throw new Error("setOwnership rejected: " + (result?.reason ?? "unknown"));
  }
  throw new Error("setOwnership rejected after version retry");
}

async function heartbeatRecord(
  api: InputOwnershipKernelApi,
  record: KernelTargetRuntime,
  desired: InputMode,
  reason: string,
): Promise<void> {
  const result = await withKernelTimeout(
    api.heartbeat({ target: record.target, version: record.version }),
    "heartbeat",
  );
  const kernelVersion = asVersion(result?.version);
  const accepted = result?.ok === true || result?.accepted === true;
  if (!accepted) {
    if (kernelVersion !== undefined && kernelVersion > record.version) record.version = kernelVersion;
    throw new Error("heartbeat rejected: " + (result?.reason ?? "unknown"));
  }
  if (kernelVersion !== undefined && kernelVersion > record.version) record.version = kernelVersion;
  record.stale = result?.stale === true;
  const kernelMode = asMode(result?.mode);
  if (kernelMode && kernelMode !== desired) {
    // 内核模式与我们派生值不一致：记录内核值，下一次同步会走 setOwnership 修正。
    record.mode = kernelMode;
    audit("input_ownership_mode_mismatch", {
      target: record.key,
      desired,
      kernelMode,
      version: record.version,
      reason: "heartbeat:" + reason,
    });
    await setOwnershipWithConflictRetry(api, record, desired, reason + ":repair");
  }
}

// ---------------------------------------------------------------------------
// 启动 / 心跳 / 卸载
// ---------------------------------------------------------------------------

async function syncAllSpaces(reason: string, options: SyncSpaceOptions = {}): Promise<void> {
  const state = await loadState();
  for (const space of Object.values(state.spaces)) {
    if (space.ownership === "inactive" || space.windowId === undefined) continue;
    try {
      await syncSpace(space, reason, options);
    } catch {
      /* 单个 space 失败不阻断其它 space；30s 后按目标降级 */
    }
  }
}

/**
 * SW 启动入口（index.ts 在 capability 探测之后调用）。
 *
 * - generic / API 不存在：保持 unsupported，零调用、零定时器；
 * - enhanced + API 存在：恢复账本里的 version（不重置），对所有活动 space 重新
 *   setOwnership（同 version 幂等），注册 human presence 事件桥，启动 10s 心跳。
 */
export async function initKernelInputOwnership(options: { force?: boolean } = {}): Promise<void> {
  if (initPromise && options.force !== true) return initPromise;
  initPromise = (async () => {
    try {
      await resolveApi();
    } catch (error) {
      // 存储不可用等极端情况：保持 unknown，不影响 SW 其它初始化。
      bridgeState = "unknown";
      unsupportedReason = "probe-failed";
      audit("input_ownership_probe_failed", { error: errorMessage(error) });
      return;
    }
    if (bridgeState !== "ready") return;
    registerPresenceListener();
    // SW 重启：按账本里的 version/mode 幂等重放（同模式同 version，模式变化才 +1）。
    await syncAllSpaces("init", { forceSet: true, replay: true });
    startHeartbeat();
  })();
  try {
    await initPromise;
  } finally {
    if (bridgeState !== "ready") initPromise = undefined;
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer !== undefined) return;
  heartbeatTimer = setInterval(() => {
    void heartbeatKernelInputOwnership("interval");
  }, Math.max(10, heartbeatIntervalMs));
  (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
}

function stopHeartbeat(): void {
  if (heartbeatTimer === undefined) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

/**
 * 心跳 tick（10s setInterval + index.ts 的 30s alarm 兜底）。
 *
 * 对每个活动 space：
 *  - 模式变化 / 首次 → setOwnership(version+1)；
 *  - 模式相同 → heartbeat(version)；
 *  - 目标消失 → 删除内存与持久账本；
 *  - 超过 30s 没有任何确认且最后一次失败 → degraded（输入命令 fail closed，
 *    但**不**写 assist 租约：恢复后自动回到原模式，避免 SW 正常休眠造成假 ASSIST）。
 */
export async function heartbeatKernelInputOwnership(reason = "timer"): Promise<void> {
  try {
    await runHeartbeat(reason);
  } catch (error) {
    // 心跳失败绝不能让 alarm/SW 起来时抛未处理 rejection；stale 判定仍由账本时间完成。
    audit("input_ownership_heartbeat_failed", { reason, error: errorMessage(error) });
  }
}

async function runHeartbeat(reason: string): Promise<void> {
  const api = apiRef ?? (await resolveApi());
  if (!api) return;
  // 迟到的 API 注入：一次 alarm/命令触发即可让周期心跳重新跑起来。
  if (heartbeatTimer === undefined) startHeartbeat();
  const state = await loadState();
  const live = new Set<string>();
  for (const space of Object.values(state.spaces)) {
    if (space.ownership === "inactive" || space.windowId === undefined) continue;
    const key = "win:" + space.windowId;
    live.add(key);
    const desired = inputModeForSpace(space);
    const record = runtime.get(key);
    if (!record) {
      try {
        await syncSpace(space, "tick-new:" + reason);
      } catch {
        /* 已记录 */
      }
      continue;
    }
    if (record.version === 0 || record.mode !== desired) {
      try {
        await syncSpace(space, "tick-mode:" + reason);
      } catch {
        /* 已记录 */
      }
    } else {
      try {
        await syncSpace(space, "heartbeat:" + reason);
      } catch {
        /* 已记录 */
      }
    }
  }
  for (const [key, record] of [...runtime.entries()]) {
    if (!live.has(key)) {
      runtime.delete(key);
      await prunePersistedRecord(key);
      continue;
    }
    if (record.degraded) continue;
    const base = record.lastAckAt > 0 ? record.lastAckAt : record.firstAttemptAt;
    if (base > 0 && now() - base > KERNEL_STALE_MS && record.lastError) {
      record.degraded = true;
      audit("input_ownership_sync_lost", {
        target: key,
        lastAckAt: record.lastAckAt,
        lastAttemptAt: record.lastAttemptAt,
        staleMs: now() - base,
        error: record.lastError,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 命令 scope：一条扩展命令 = 一次内核 grant（仅 ASSIST）
// ---------------------------------------------------------------------------

export interface KernelInputScopeHooks {
  /** 建立 chrome.debugger 会话（内核 grant 必须绑定到调用方的 session）。 */
  attach?: (tabId: number) => Promise<void>;
}

/** 供外部（input_status / 诊断）读取的内核同步视图；**不是**所有权真源。 */
export interface KernelInputOwnershipStatus {
  state: KernelBridgeState;
  supported: boolean;
  reason?: string;
  degraded: boolean;
  effectiveMode?: InputMode;
  version?: number;
  kernelVersion?: number;
  kernelMode?: InputMode;
  stale?: boolean;
  lastAckAt?: number;
  lastError?: string;
}

export function kernelInputOwnershipStatusForWindow(
  windowId: number | undefined,
  currentMode?: InputMode,
): KernelInputOwnershipStatus {
  const base: KernelInputOwnershipStatus = {
    state: bridgeState,
    supported: bridgeState === "ready",
    ...(unsupportedReason ? { reason: unsupportedReason } : {}),
    degraded: false,
  };
  if (windowId === undefined) return base;
  const record = runtime.get("win:" + windowId);
  if (!record) return base;
  const mode = currentMode ?? record.mode;
  return {
    ...base,
    degraded: record.degraded,
    effectiveMode: record.degraded ? "assist" : mode,
    version: record.version,
    ...(record.kernelVersion !== undefined ? { kernelVersion: record.kernelVersion } : {}),
    ...(record.kernelMode !== undefined ? { kernelMode: record.kernelMode } : {}),
    ...(record.stale !== undefined ? { stale: record.stale } : {}),
    ...(record.lastAckAt ? { lastAckAt: record.lastAckAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

function kernelSyncLost(command: Command, detail: Record<string, unknown>): InputOwnershipError {
  return new InputOwnershipError(
    "INPUT_KERNEL_SYNC_LOST",
    "内核输入权快照不可确认（同步失败/失联），已按 ASSIST 语义拒绝 AI 输入: " + command.name,
    detail,
  );
}

/**
 * 在一条输入命令执行前后维护内核侧的一致性：
 *
 *  - **AI**：只确认快照新鲜（10s 内有确认 / 命令前重新同步）。确认失败 → 拒绝
 *    （INPUT_KERNEL_SYNC_LOST），绝不静默继续 AI；
 *  - **ASSIST**：额外要求内核 grant + begin/end scope。grant/begin 失败同样 fail closed；
 *    end 失败只审计（内核有绝对截止 + TTL 兜底）。
 *  - **generic / API 不存在 / guard 为 undefined**：原样执行，零行为变化。
 *
 * `run()` 是真正的 handler（actions.ts / eval.ts），本函数不碰 CDP 细节。
 */
export async function withKernelInputScope<T>(
  command: Command,
  guard: InputGuardResult | undefined,
  run: () => Promise<T>,
  hooks: KernelInputScopeHooks = {},
): Promise<T> {
  if (!guard) return run();
  if (bridgeState === "unknown") await resolveApi();
  if (bridgeState !== "ready" || !apiRef) {
    // 普通 Chrome / 内核 Feature 关闭：命令层守卫（guardInputCommand）已经是全部语义。
    return run();
  }
  // API 可能在 SW 启动后才注入（capabilities.ts 记录的 ~0.5s 窗口期）：懒激活心跳与事件桥。
  registerPresenceListener();
  if (heartbeatTimer === undefined) startHeartbeat();
  const api = apiRef;
  const space = await resolveSpaceForCommand(command).catch(() => undefined);
  const record = await ensureFreshRecord(space, guard);
  if (!record) {
    audit("input_command_rejected", {
      spaceId: guard.spaceId,
      tabId: guard.tabId,
      mode: guard.mode,
      command: command.name,
      code: "INPUT_KERNEL_SYNC_LOST",
      reason: "sync-unavailable",
    });
    throw kernelSyncLost(command, {
      spaceId: guard.spaceId,
      tabId: guard.tabId,
      mode: guard.mode,
      reason: "sync-unavailable",
    });
  }
  if (guard.mode !== "assist") return run();

  const missing = ["grantInput", "beginInputCommand", "endInputCommand"].filter(
    (method) => typeof (api as unknown as Record<string, unknown>)[method] !== "function",
  );
  if (missing.length) {
    throw new InputOwnershipError(
      "INPUT_OWNERSHIP_API_INCOMPLETE",
      "内核 inputOwnership API 缺少 ASSIST 命令 scope 所需方法: " + missing.join(", "),
      { spaceId: guard.spaceId, tabId: guard.tabId, mode: guard.mode, missing },
    );
  }
  if (typeof guard.tabId !== "number" || !Number.isFinite(guard.tabId)) {
    throw kernelSyncLost(command, {
      spaceId: guard.spaceId,
      mode: guard.mode,
      reason: "no-tab-target",
    });
  }

  const target: KernelTarget = { tabId: guard.tabId };
  if (hooks.attach) {
    try {
      await hooks.attach(guard.tabId);
    } catch (error) {
      audit("input_command_rejected", {
        spaceId: guard.spaceId,
        tabId: guard.tabId,
        mode: guard.mode,
        command: command.name,
        code: "INPUT_KERNEL_SYNC_LOST",
        reason: "attach-failed",
        error: errorMessage(error),
      });
      throw kernelSyncLost(command, {
        spaceId: guard.spaceId,
        tabId: guard.tabId,
        mode: guard.mode,
        reason: "attach-failed",
      });
    }
  }

  // 一次性 grant：与扩展侧「一条输入命令消耗 1 次」严格对齐。TTL 是绝对截止，
  // 即使 endInputCommand 丢失也不会留下长期有效的授权。
  try {
    const granted = await withKernelTimeout(
      api.grantInput!({
        target,
        actions: 1,
        ttlMs: commandTtlFor(command.name),
      }),
      "grantInput",
    );
    if (granted?.granted !== true && granted?.ok !== true) {
      throw new Error(granted?.reason ?? "kernel grant rejected");
    }
    if (typeof granted?.actions === "number" && granted.actions < 1) {
      throw new Error(granted.reason ?? "kernel grant has no actions");
    }
  } catch (error) {
    audit("input_command_rejected", {
      spaceId: guard.spaceId,
      tabId: guard.tabId,
      mode: guard.mode,
      command: command.name,
      code: "INPUT_ASSIST_REQUIRES_GRANT",
      reason: "kernel-grant-failed",
      error: errorMessage(error),
    });
    throw new InputOwnershipError(
      "INPUT_ASSIST_REQUIRES_GRANT",
      "ASSIST 下内核未能确认一次性 grant，已拒绝输入: " + command.name,
      {
        spaceId: guard.spaceId,
        tabId: guard.tabId,
        mode: guard.mode,
        command: command.name,
        reason: "kernel-grant-failed",
      },
    );
  }

  const commandId = "cmd-" + crypto.randomUUID();
  try {
    const scope = await withKernelTimeout(
      api.beginInputCommand!({
        target,
        commandId,
        kind: command.name,
      }),
      "beginInputCommand",
    );
    if (scope?.ok !== true && typeof scope?.scopeId !== "string") {
      throw new Error(scope?.reason ?? "begin rejected");
    }
  } catch (error) {
    audit("input_command_rejected", {
      spaceId: guard.spaceId,
      tabId: guard.tabId,
      mode: guard.mode,
      command: command.name,
      code: "INPUT_KERNEL_SYNC_LOST",
      reason: "begin-failed",
      error: errorMessage(error),
    });
    throw kernelSyncLost(command, {
      spaceId: guard.spaceId,
      tabId: guard.tabId,
      mode: guard.mode,
      reason: "begin-failed",
    });
  }

  let outcome: "ok" | "failed" = "ok";
  try {
    return await run();
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    try {
      await withKernelTimeout(
        api.endInputCommand!({ target, commandId, outcome }),
        "endInputCommand",
      );
    } catch (error) {
      // 内核 scope 有绝对截止；end 失败只影响审计，不改变已经发生的输入结果。
      audit("input_kernel_scope_end_failed", {
        spaceId: guard.spaceId,
        tabId: guard.tabId,
        command: command.name,
        commandId,
        outcome,
        error: errorMessage(error),
      });
    }
  }
}

/**
 * 命令执行前确认快照新鲜：10s 内有确认且模式没变 → 直接用；否则先同步一次。
 * 同步失败返回 undefined（调用方 fail closed）。模式不一致时强制 setOwnership。
 */
async function ensureFreshRecord(
  space: SpaceState | undefined,
  guard: InputGuardResult,
): Promise<KernelTargetRuntime | undefined> {
  const windowId = space?.windowId ?? guard.windowId;
  const target: KernelTarget | undefined =
    windowId !== undefined ? { windowId } : guard.tabId !== undefined ? { tabId: guard.tabId } : undefined;
  if (!target) return undefined;
  const key = targetKey(target);
  const desired = space ? inputModeForSpace(space) : guard.mode;
  const record = await hydrateRuntime(key, target, desired);
  const age = record.lastAckAt > 0 ? now() - record.lastAckAt : Number.POSITIVE_INFINITY;
  const modeMatches = record.mode === desired;
  if (record.lastAckAt > 0 && age <= KERNEL_HEARTBEAT_INTERVAL_MS && modeMatches && !record.degraded) {
    return record;
  }
  if (!space) {
    // 没有可解析的 space（inactive/已关闭）：无法重新 setOwnership。
    return record.degraded || age > KERNEL_STALE_MS ? undefined : record;
  }
  try {
    return await syncSpace(space, "pre-command", {
      forceSet: record.version === 0 || !modeMatches,
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 内核 human_presence 事件桥（设计 §13.6）
// ---------------------------------------------------------------------------

function registerPresenceListener(): void {
  if (presenceUnsubscribe) return;
  const event = apiRef?.onHumanPresence;
  if (!event) return;
  try {
    if (typeof event === "function") {
      const returned = event((payload) => handleKernelHumanPresence(payload));
      if (typeof returned === "function") presenceUnsubscribe = returned;
      else presenceUnsubscribe = () => undefined;
      return;
    }
    if (typeof (event as PresenceEvent).addListener === "function") {
      const listener: PresenceListener = (payload) => handleKernelHumanPresence(payload);
      (event as PresenceEvent).addListener(listener);
      presenceUnsubscribe = () => (event as PresenceEvent).removeListener?.(listener);
      return;
    }
    audit("input_ownership_presence_listener_failed", { reason: "unsupported-event-shape" });
  } catch (error) {
    audit("input_ownership_presence_listener_failed", { error: errorMessage(error) });
  }
}

/**
 * 内核 `onHumanPresence` 的唯一落点。
 *
 * 身份：这是 SW 进程内的内核事件桥，命令对象在这里构造并 `markInternalCommand()`，
 * 与 popup 入口等价；外部 Agent 无法产生同样的调用（设计 §12.11 / §13.11）。
 * 事件只表达“人类在场”，不携带/不接受任何“请把 mode 改成 X”的指令。
 */
export function handleKernelHumanPresence(event: KernelHumanPresenceEvent | undefined): void {
  void (async () => {
    try {
      const tabId = typeof event?.tabId === "number" && Number.isInteger(event.tabId) ? event.tabId : undefined;
      if (tabId === undefined) {
        audit("input_kernel_presence_ignored", { reason: "no-tab-id" });
        return;
      }
      const state = await loadState();
      const live = Object.values(state.spaces).filter((space) => space.ownership !== "inactive");
      let space = live.find((candidate) => candidate.tabId === tabId);
      if (!space) {
        const windowId =
          typeof event?.windowId === "number" && Number.isInteger(event.windowId)
            ? event.windowId
            : await readTabWindowId(tabId);
        if (windowId !== undefined) {
          space = live.find((candidate) => candidate.windowId === windowId);
        }
      }
      if (!space) {
        audit("input_kernel_presence_ignored", { tabId, reason: "space-not-found" });
        return;
      }
      const kind = typeof event?.kind === "string" && event.kind.trim() ? event.kind.trim() : "input";
      const command: Command = markInternalCommand({
        type: "command",
        name: "human_presence",
        args: {
          spaceId: space.spaceId,
          tabId,
          source: "kernel:" + kind,
          debounceMs: presenceDebounceMs,
        },
        requestId: "kernel-presence-" + crypto.randomUUID(),
      });
      const result = await humanPresenceCommand(command);
      audit("input_kernel_presence_received", {
        spaceId: space.spaceId,
        tabId,
        kind,
        at: event?.at,
        mode: result.mode,
        scheduled: result.scheduled,
        changed: result.changed,
      });
    } catch (error) {
      audit("input_kernel_presence_ignored", {
        tabId: event?.tabId,
        error: errorMessage(error),
      });
    }
  })();
}

// ---------------------------------------------------------------------------
// 状态变化 → 排队同步（唯一接线；不新建所有权状态机）
// ---------------------------------------------------------------------------

function scheduleSync(spaceId: string, reason: string): void {
  if (!autoSyncEnabled) return;
  if (pendingSyncs.has(spaceId)) return;
  pendingSyncs.add(spaceId);
  queueMicrotask(() => {
    pendingSyncs.delete(spaceId);
    void (async () => {
      try {
        const state = await loadState();
        const space = state.spaces[spaceId];
        if (!space || space.ownership === "inactive" || space.windowId === undefined) return;
        await syncSpace(space, reason);
      } catch {
        /* 同步失败由账本/心跳记录；不向状态写入路径反向抛错 */
      }
    })();
  });
}

// ownership 写入（claim/handoff/complete/close/窗口消失）走 state.ts 的同步通知；
// assist 租约的增删走 input-ownership.ts 的 onInputModeChanged。两处都只排队，不阻塞。
onOwnershipChanged((spaceId) => scheduleSync(spaceId, "ownership-changed"));
onInputModeChanged((spaceId, reason) => scheduleSync(spaceId, "input-mode:" + reason));

// ---------------------------------------------------------------------------
// 测试钩子（生产代码永不调用）
// ---------------------------------------------------------------------------

export function __resetKernelInputOwnershipForTests(): void {
  stopHeartbeat();
  presenceUnsubscribe?.();
  presenceUnsubscribe = undefined;
  runtime.clear();
  pendingSyncs.clear();
  auditOnceKeys.clear();
  apiRef = undefined;
  bridgeState = "unknown";
  unsupportedReason = undefined;
  initPromise = undefined;
  autoSyncEnabled = true;
  apiTimeoutMs = KERNEL_API_TIMEOUT_MS;
}

export function __setKernelInputOwnershipClockForTests(clock: (() => number) | undefined): void {
  nowFn = clock ?? Date.now;
}

export function __setKernelInputHeartbeatIntervalForTests(intervalMs: number): void {
  heartbeatIntervalMs = Math.max(10, Math.floor(intervalMs));
}

export function __setKernelPresenceDebounceForTests(debounceMs: number): void {
  presenceDebounceMs = Math.max(0, Math.floor(debounceMs));
}

export function __setKernelApiTimeoutForTests(timeoutMs: number): void {
  apiTimeoutMs = Math.max(5, Math.floor(timeoutMs));
}

export function __setKernelAutoSyncForTests(enabled: boolean): void {
  autoSyncEnabled = enabled;
}

/** 模拟 SW 回收：内存态清空，持久账本保留；下一次 init 必须恢复 version。 */
export function __simulateServiceWorkerRestartForTests(): void {
  __resetKernelInputOwnershipForTests();
  apiRef = undefined;
  bridgeState = "unknown";
  initPromise = undefined;
}
