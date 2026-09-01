// SW 入口：初始化和消息路由。
// 对齐技术路径 M1（骨架/三入口/保活）+ M2（host 连接）。
import { connectHost } from "./native-bridge";
import { loadState, patchState } from "./state";
import { buildGuideFromCmd, dispatch } from "./commands";
import { registerMaskHandlers, requestTakeover, isHumanTakeover, isMaskActive } from "./mask";
import { bindActiveTab } from "./tab-resolver";
import { isAttached } from "./debugger-bridge";
import type { PopupGuide, PopupRequest, PopupStatus } from "../shared/types";

const HEARTBEAT = "browserpilot.heartbeat";
const CONTEXT_ITEM = "browserpilot.takeover";

async function init(): Promise<void> {
  await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 }); // ~30s
  await connectHost();
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({
    id: CONTEXT_ITEM,
    title: "在本页使用 Agent",
    contexts: ["page"],
  });
  void init();
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void init();
});

// alarms 保活：让 SW 周期醒来，维持 host 连接（技术路径 §4.11）。
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT) {
    await connectHost();
    const s = await loadState();
    await patchState({ startTime: s.startTime }); // 触碰存储以保持活跃
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONTEXT_ITEM && tab?.id !== undefined) {
    await patchState({ activeSpaceId: String(tab.windowId) });
    await bindActiveTab(String(tab.windowId));
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
chrome.runtime.onMessage.addListener((msg: PopupRequest, _sender, sendResponse) => {
  void handlePopup(msg).then(sendResponse, (e) => sendResponse({ __bpError: e instanceof Error ? e.message : String(e) }));
  return true; // 异步响应
});

async function handlePopup(msg: PopupRequest): Promise<unknown> {
  switch (msg.kind) {
    case "get_status": {
      const s = await loadState();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      const attached = tabId !== undefined && isAttached(tabId);
      const human = tabId !== undefined && isHumanTakeover(tabId);
      const ready = tabId !== undefined && s.spaces[String(tab.windowId)]?.tabId === tabId;
      return {
        attached,
        mode: human ? "human" : attached || (tabId !== undefined && isMaskActive(tabId)) ? "agent" : ready ? "ready" : "idle",
        tabId,
        layer: attached ? "L1" : ready ? "L0" : undefined,
        profile: s.profile,
        hostPort: s.hostPort,
      };
    }
    case "use_current_tab": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) return { attached: false, mode: "idle" };
      await patchState({ activeSpaceId: String(tab.windowId) });
      await bindActiveTab(String(tab.windowId));
      return { attached: isAttached(tab.id), mode: isAttached(tab.id) ? "agent" : "ready", tabId: tab.id, layer: isAttached(tab.id) ? "L1" : "L0" };
    }
    case "take_over": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { attached: false };
      await patchState({ activeSpaceId: String(tab.windowId) });
      // 用户点「接管」= 用户接管控制：取消蓝色遮罩 + 暂停 AI（与遮罩上「人工接管」按钮一致的通用路径）。
      // 不是弹遮罩——遮罩是「AI 在操作」时显示；用户点「接管」时应取消。
      requestTakeover(tab.id);
      return { attached: isAttached(tab.id), mode: "human", tabId: tab.id, layer: isAttached(tab.id) ? "L1" : undefined };
    }
    case "get_guide": {
      const s = await loadState();
      const guide = buildGuideFromCmd(s.profile, s.hostPort, s.hostToken);
      return { guide };
    }
    case "template_command": {
      const allowed = new Set([
        "install_template", "list_templates", "export_template", "uninstall_template",
        "set_template_enabled", "check_template_update", "list_template_catalog", "update_template", "rollback_template",
      ]);
      if (!msg.name || !allowed.has(msg.name)) throw new Error("不允许的模板管理命令");
      return dispatch({ type: "command", name: msg.name, args: msg.args ?? {}, requestId: "options-" + Date.now() });
    }
    case "stop": {
      await dispatch({ type: "command", name: "stop", args: {}, requestId: "popup-stop-" + Date.now() });
      return { attached: false, mode: "idle" };
    }
    default:
      return { attached: false };
  }
}

registerMaskHandlers();
void init();
