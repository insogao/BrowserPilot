// SW 入口：初始化和消息路由。
// 对齐技术路径 M1（骨架/三入口/保活）+ M2（host 连接）。
import { connectHost } from "./native-bridge";
import { loadState, patchState } from "./state";
import { buildGuideFromCmd } from "./commands";
import { registerMaskHandlers, requestTakeover } from "./mask";
import type { PopupGuide, PopupRequest, PopupStatus } from "../shared/types";

const HEARTBEAT = "egolite.heartbeat";
const CONTEXT_ITEM = "egolite.takeover";

async function init(): Promise<void> {
  await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 }); // ~30s
  await connectHost();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_ITEM,
    title: "在本页使用 Agent",
    contexts: ["page"],
  });
  void init();
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
  void handlePopup(msg).then(sendResponse);
  return true; // 异步响应
});

async function handlePopup(msg: PopupRequest): Promise<PopupStatus | PopupGuide> {
  switch (msg.kind) {
    case "get_status": {
      const s = await loadState();
      const active = s.activeSpaceId ? s.spaces[s.activeSpaceId] : undefined;
      return {
        attached: active?.attached ?? false,
        tabId: active?.tabId,
        layer: active?.layer,
        profile: s.profile,
        hostPort: s.hostPort,
      };
    }
    case "take_over": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { attached: false };
      await patchState({ activeSpaceId: String(tab.windowId) });
      // 用户点「接管」= 用户接管控制：取消蓝色遮罩 + 暂停 AI（与遮罩上「人工接管」按钮一致的通用路径）。
      // 不是弹遮罩——遮罩是「AI 在操作」时显示；用户点「接管」时应取消。
      requestTakeover(tab.id);
      return { attached: true, tabId: tab.id };
    }
    case "get_guide": {
      const s = await loadState();
      const guide = buildGuideFromCmd(s.profile, s.hostPort);
      return { guide };
    }
    case "stop": {
      return { attached: false };
    }
    default:
      return { attached: false };
  }
}

registerMaskHandlers();
void init();
