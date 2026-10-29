// SW 入口：初始化和消息路由。
// 对齐技术路径 M1（骨架/三入口/保活）+ M2（host 连接）。
import { connectHost, isHostConnected } from "./native-bridge";
import { loadState, patchState, type SpaceState } from "./state";
import { buildGuideFromCmd, buildSkillBootstrap, dispatch } from "./commands";
import { registerMaskHandlers, requestTakeover, isHumanTakeover, maskOff } from "./mask";
import { registerVirtualCursorHandlers } from "./virtual-cursor";
import { isAttached } from "./debugger-bridge";
import type {
  PopupErrorInfo,
  PopupInputView,
  PopupRequest,
  PopupSpaceOption,
  PopupStatus,
} from "../shared/types";
import { claimSpaceForTab, markInternalCommand, registerSpaceLifecycleHandlers } from "./spaces";
import { detectHostCapabilities } from "./capabilities";
import { heartbeatKernelInputOwnership, initKernelInputOwnership, kernelInputOwnershipStatusForWindow } from "./input-ownership-api";
import { inputModeForSpace, inputStatusCommand } from "./input-ownership";
import { buildPopupInputCommand, buildPopupStatusCommand } from "./popup-entry";

const HEARTBEAT = "browserpilot.heartbeat";

// 宿主能力探测只做一次：普通 Chrome 上 chrome.browserCli 不存在（generic），
// Browser CLI 上返回增强能力。探测本身永不抛异常，失败即降级。
let capabilitiesProbe: Promise<void> | undefined;

function ensureCapabilitiesProbed(): Promise<void> {
  capabilitiesProbe ??= detectHostCapabilities().then(async (caps) => {
    await patchState({ hostCapabilities: caps });
    console.info(
      `[capabilities] mode=${caps.mode} protocol=${caps.protocolVersion}` +
        (caps.degradeReason ? ` reason=${caps.degradeReason}` : ""),
    );
  });
  return capabilitiesProbe;
}

async function init(): Promise<void> {
  await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 }); // ~30s
  await ensureCapabilitiesProbed();
  // 内核输入权（P3）：只有 enhanced host 才探测/同步；generic 下是零行为变化的 no-op。
  // 必须在 capability 探测之后调用：探测结果决定是否允许调用 chrome.browserCli。
  await initKernelInputOwnership();
  await connectHost();
}

chrome.runtime.onInstalled.addListener(() => {
  void init();
  // Do not open a tab on install. In a managed/background browser the first
  // window may be created later, unexpectedly surfacing this onboarding page.
  // The user can open it explicitly from the popup's Manage button.
});

chrome.runtime.onStartup.addListener(() => {
  void init();
});

// alarms 保活：让 SW 周期醒来，维持 host 连接（技术路径 §4.11）。
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT) {
    await connectHost();
    // 30s alarm 是 10s 心跳定时器被 SW 回收后的兜底：重新确认内核快照并降级失联目标。
    await heartbeatKernelInputOwnership("alarm");
    const s = await loadState();
    await patchState({ startTime: s.startTime }); // 触碰存储以保持活跃
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "open-popup") {
    // 命令处理器携带用户手势，可安全 openPopup（Chrome 127+；低版本静默降级为触达 action）
    try {
      await chrome.action.openPopup();
    } catch (e) {
      console.warn("[index] openPopup 不可用（需 Chrome 127+）:", (e as Error).message);
    }
  }
});

// popup ↔ SW
chrome.runtime.onMessage.addListener((msg: PopupRequest, sender, sendResponse) => {
  void handlePopup(msg, sender).then(sendResponse, (e) => sendResponse(toPopupError(e)));
  return true; // 异步响应
});

// ---------------------------------------------------------------------------
// popup 用户入口（P3）：身份 = SW 进程内 markInternalCommand()，不是消息字段
// ---------------------------------------------------------------------------

/** popup 入口自己的稳定错误（与 InputOwnershipError / TaskSpaceError 并列展示）。 */
class PopupEntryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PopupEntryError";
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "INTERNAL_ERROR";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPopupError(error: unknown): {
  __bpError: string;
  __bpErrorCode: string;
  __bpErrorDetail?: Record<string, unknown>;
} {
  const detail = (error as { detail?: unknown } | null)?.detail;
  return {
    __bpError: errorMessageOf(error),
    __bpErrorCode: errorCodeOf(error),
    ...(detail && typeof detail === "object" ? { __bpErrorDetail: detail as Record<string, unknown> } : {}),
  };
}

/** 只有扩展自己的 popup 页面可以触发三个输入权用户动作。
 *  sender 由 Chrome 填写，消息里的任何字段都无法伪造它；外部 host/TCP 根本不走
 *  chrome.runtime.onMessage，content script/options 的转发也会在这里被拒绝。 */
function isPopupSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  const url = sender?.url ?? sender?.tab?.url ?? "";
  return url.startsWith(chrome.runtime.getURL("popup/"));
}

/** 本扩展自己的页面（popup 被自动化 harness 作为普通标签页打开时，不能把它当成目标页面）。 */
const EXTENSION_BASE_URL = chrome.runtime.getURL("");
function isOwnExtensionPage(tab: chrome.tabs.Tab | undefined): boolean {
  return typeof tab?.url === "string" && tab.url.startsWith(EXTENSION_BASE_URL);
}

/** 窗口仍存在且未退休的 Task Space。 */
async function listLiveSpaces(): Promise<SpaceState[]> {
  const state = await loadState();
  const live: SpaceState[] = [];
  for (const space of Object.values(state.spaces)) {
    if (space.ownership === "inactive" || space.windowId === undefined) continue;
    const win = await chrome.windows.get(space.windowId).catch(() => undefined);
    if (win) live.push(space);
  }
  return live.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** 选定 space 的目标 tab：优先绑定 tab，其次窗口内活动标签；跳过本扩展页面。 */
async function targetTabForSpace(space: SpaceState): Promise<number | undefined> {
  const bound = Number(space.tabId);
  if (Number.isFinite(bound)) {
    const tab = await chrome.tabs.get(bound).catch(() => undefined);
    if (tab && tab.windowId === space.windowId && !isOwnExtensionPage(tab)) return tab.id;
  }
  if (space.windowId === undefined) return undefined;
  const tabs = await chrome.tabs.query({ windowId: space.windowId }).catch(() => []);
  const active = tabs.find((tab) => tab.active && !isOwnExtensionPage(tab));
  if (active?.id !== undefined) return active.id;
  return tabs.find((tab) => !isOwnExtensionPage(tab))?.id;
}

interface ResolvedPopupTarget {
  space: SpaceState;
  target: { spaceId: string; tabId?: number };
}

/**
 * 解析 popup 的目标 space/tab。
 *
 * 优先级：显式选择（下拉框）> 当前窗口活动 tab 所属 space > 最近聚焦普通窗口的
 * 活动 tab 所属 space。绝不自动创建窗口；解析不到时返回 undefined，由 popup 显示
 * “先 open_space / 选择标签”。自动化把 popup 当普通标签页打开时，活动 tab 是扩展
 * 页面本身，因此第二级会跳过它并回退到该 space 的绑定/活动页面标签。
 */
async function resolvePopupTarget(
  requestedSpaceId?: string,
  liveSpaces?: SpaceState[],
): Promise<ResolvedPopupTarget | undefined> {
  const live = liveSpaces ?? (await listLiveSpaces());
  if (requestedSpaceId) {
    const space = live.find((item) => item.spaceId === requestedSpaceId);
    if (!space) return undefined;
    return { space, target: { spaceId: space.spaceId, tabId: await targetTabForSpace(space) } };
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (active && !isOwnExtensionPage(active) && active.windowId !== undefined) {
    const space = live.find((item) => item.windowId === active.windowId);
    if (space) return { space, target: { spaceId: space.spaceId, tabId: active.id } };
  }
  const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  if (focused?.id !== undefined) {
    const space = live.find((item) => item.windowId === focused.id);
    if (space) {
      const tabId = await targetTabForSpace(space);
      if (tabId !== undefined) return { space, target: { spaceId: space.spaceId, tabId } };
      // popup 被自动化 harness 作为普通标签页打开时，它自己可能独占一个 Task Space
      // （只有扩展页面）。此时按最近更新时间找另一个有真实页面标签的 live space，
      // 让“点按钮”无需额外选择即可工作；下拉框仍可显式覆盖。
      for (const candidate of live) {
        if (candidate.spaceId === space.spaceId) continue;
        const candidateTab = await targetTabForSpace(candidate);
        if (candidateTab !== undefined) {
          return { space: candidate, target: { spaceId: candidate.spaceId, tabId: candidateTab } };
        }
      }
      return { space, target: { spaceId: space.spaceId } };
    }
  }
  return undefined;
}

interface EnsureVisibleResult {
  tabId: number;
  windowId: number;
  state?: string;
  focused?: boolean;
  updateError?: string;
}

/**
 * 用户点“显示窗口”后的后置校验。
 *
 * chrome.windows.update 成功不等于窗口真的上了桌面：托管模式
 * （--browser-cli-background-presentation）把 extension-origin 的呈现请求判为
 * automation，对未拥有窗口直接拒绝；Windows 侧在 HWND 层静默剥离 SWP_SHOWWINDOW。
 * 因此这里 fail explicit：
 *   - windows.update 抛错 → PERMISSION_DENIED；
 *   - 仍是 minimized → WINDOW_NOT_RESTORED；
 *   - managed 模式下窗口未获得焦点（隐藏窗口不可能 focused）→ PERMISSION_DENIED，
 *     并提示需要用户显式 show（--browser-cli-user-explicit-show）。
 */
async function assertPopupWindowPresented(
  result: unknown,
  space: SpaceState,
): Promise<EnsureVisibleResult & { presented: true; managedMode: boolean }> {
  const r = result as EnsureVisibleResult;
  const base = { tabId: r.tabId, windowId: r.windowId, spaceId: space.spaceId, state: r.state, focused: r.focused };
  if (r.updateError) {
    throw new PopupEntryError(
      "PERMISSION_DENIED",
      "浏览器拒绝显示窗口（chrome.windows.update 失败）: " + r.updateError,
      { ...base, reason: "window-update-rejected" },
    );
  }
  if (r.state === "minimized") {
    throw new PopupEntryError("WINDOW_NOT_RESTORED", "窗口仍处于最小化状态，显示失败", base);
  }
  // 能力探测只在尚未完成时等待（普通 Chrome 首次探测最多 5s，不能卡住用户点击）。
  let caps = (await loadState()).hostCapabilities;
  if (!caps) {
    await ensureCapabilitiesProbed();
    caps = (await loadState()).hostCapabilities;
  }
  const managedMode = caps?.mode === "enhanced" && caps.managedMode === true;
  if (managedMode && r.focused !== true) {
    throw new PopupEntryError(
      "PERMISSION_DENIED",
      "托管模式（managed presentation）禁止 extension-origin 把后台窗口显示到桌面；" +
        "内核策略会拒绝/静默剥离窗口显示。K4/真实 IME 需要用户显式 show" +
        "（--browser-cli-user-explicit-show）后的可见窗口。",
      { ...base, reason: "managed-presentation-policy", requires: "user-explicit-show" },
    );
  }
  return { ...r, presented: true, managedMode };
}

/** popup 状态卡：host/agent 状态 + 可选 space 列表 + 当前/选中 space 的 input_status。 */
async function buildPopupStatus(requestedSpaceId?: string): Promise<PopupStatus> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = active?.id;
  const attached = tabId !== undefined && isAttached(tabId);
  const human = tabId !== undefined && isHumanTakeover(tabId);
  const state = await loadState();
  const hostReady = isHostConnected() && typeof state.hostPort === "number" && Number.isFinite(state.hostPort);
  const connected = !!state.agentActive;
  const live = await listLiveSpaces();
  const spaces: PopupSpaceOption[] = live.map((space) => ({
    spaceId: space.spaceId,
    name: space.name,
    windowId: space.windowId,
    tabId: space.tabId,
    ownership: space.ownership,
    mode: inputModeForSpace(space),
    updatedAt: space.updatedAt,
  }));
  const resolved = await resolvePopupTarget(requestedSpaceId, live);
  let input: PopupInputView | null = null;
  let inputError: PopupErrorInfo | undefined;
  if (resolved) {
    try {
      // input_status 是只读视图；直接调用（不 dispatch）避免 popup 每秒轮询时
      // touchMaskActivity 反复续期遮罩自动释放计时。身份仍走进程内标记。
      const status = await inputStatusCommand(buildPopupStatusCommand(resolved.target));
      input = {
        ...status,
        ownership: status.ownership ?? "unknown",
        kernel: kernelInputOwnershipStatusForWindow(status.windowId, status.mode),
      };
    } catch (e) {
      inputError = { code: errorCodeOf(e), message: errorMessageOf(e) };
    }
  }
  return {
    attached,
    hostReady,
    connected,
    clientCount: state.externalClients ?? 0,
    mode: human ? "human" : connected ? "agent" : "idle",
    tabId,
    layer: attached ? "L1" : undefined,
    profile: state.profile,
    hostPort: state.hostPort,
    input,
    spaces,
    ...(resolved ? { target: resolved.target } : {}),
    ...(inputError ? { inputError } : {}),
  };
}

async function handlePopup(msg: PopupRequest, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.kind) {
    case "get_status":
      return buildPopupStatus(msg.spaceId);
    case "input_status":
      return buildPopupStatus(msg.spaceId);
    case "take_over": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const s = await loadState();
      if (!tab?.id || !s.agentActive) {
        return { attached: false, hostReady: isHostConnected() && typeof s.hostPort === "number", connected: false, mode: "idle", profile: s.profile, hostPort: s.hostPort };
      }
      // 用户点「接管」= 用户接管控制：取消蓝色遮罩 + 暂停 AI（与遮罩上「人工接管」按钮一致的通用路径）。
      // 不是弹遮罩——遮罩是「AI 在操作」时显示；用户点「接管」时应取消。
      requestTakeover(tab.id);
      return { attached: isAttached(tab.id), connected: true, mode: "human", tabId: tab.id, layer: isAttached(tab.id) ? "L1" : undefined };
    }
    case "resume_agent": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { attached: false, connected: false, mode: "idle" };
      await maskOff(tab.id);
      await claimSpaceForTab(tab.id);
      const s = await loadState();
      return {
        attached: isAttached(tab.id),
        hostReady: isHostConnected() && typeof s.hostPort === "number",
        connected: !!s.agentActive,
        mode: s.agentActive ? "agent" : "idle",
        tabId: tab.id,
        layer: isAttached(tab.id) ? "L1" : undefined,
        profile: s.profile,
        hostPort: s.hostPort,
      };
    }
    case "get_guide": {
      const s = await loadState();
      const guide = buildGuideFromCmd(s.profile, s.hostPort, s.hostToken);
      return { guide };
    }
    case "get_skill": {
      const s = await loadState();
      return { skill: buildSkillBootstrap(s.profile, s.hostPort, s.hostToken) };
    }
    case "template_command": {
      const allowed = new Set([
        "install_template", "list_templates", "export_template", "uninstall_template",
        "set_template_enabled", "check_template_update", "check_registry_updates", "list_template_catalog", "sync_registry", "search_templates",
        "get_template_detail", "compare_templates", "update_template", "rollback_template",
      ]);
      if (!msg.name || !allowed.has(msg.name)) throw new Error("不允许的模板管理命令");
      // 用户入口：命令对象在这里（SW 进程内）构造并打上不可伪造的内部标记。
      return dispatch(markInternalCommand({
        type: "command", name: msg.name, args: msg.args ?? {}, requestId: "options-" + Date.now(),
      }));
    }
    case "grant_input":
    case "human_presence":
    case "ensure_visible": {
      // 三个用户动作只接受 popup 页面：sender 由 Chrome 填写，消息字段不可伪造。
      if (!isPopupSender(sender)) {
        throw new PopupEntryError("PERMISSION_DENIED", "输入权用户入口只接受 popup 页面发起的请求");
      }
      const resolved = await resolvePopupTarget(msg.spaceId);
      if (!resolved) {
        throw new PopupEntryError(
          "SPACE_NOT_FOUND",
          "没有可用的 Task Space：先 open_space，或在 popup 里选择一个 Task Space",
        );
      }
      // 身份不是消息字段：buildPopupInputCommand 在 SW 进程内构造命令并 markInternalCommand()。
      const result = await dispatch(buildPopupInputCommand(msg.kind, resolved.target));
      return msg.kind === "ensure_visible"
        ? assertPopupWindowPresented(result, resolved.space)
        : result;
    }
    case "stop": {
      await dispatch(markInternalCommand({ type: "command", name: "stop", args: {}, requestId: "popup-stop-" + Date.now() }));
      return { attached: false, mode: "idle" };
    }
    default:
      return { attached: false };
  }
}

registerMaskHandlers();
registerSpaceLifecycleHandlers();
registerVirtualCursorHandlers();
void init();
