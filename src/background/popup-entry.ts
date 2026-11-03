// popup 用户入口的命令构造（P3）。
//
// 信任边界（设计 §12.11）：
//   - popup 只发 `chrome.runtime.sendMessage({kind, spaceId})`，消息里没有身份字段；
//   - 本模块在 **SW 进程内** 构造 Command 对象并立即 `markInternalCommand()`；
//   - JSON / native messaging 反序列化的对象不可能带上这个 WeakSet 标记，因此外部
//     Agent 即使伪造 `_clientId` / `internal` / `source` 也拿不到用户身份。
//
// 这里刻意不接受任何“命令名 / args / 身份”透传：popup 只能从三个固定动作里选一个，
// 目标 space 由 SW 解析/校验后写入 args。这样 popup 消息无法扩展成任意内部命令。
import type { Command, PopupRequest } from "../shared/types";
import { markInternalCommand } from "./spaces";

/** popup 的三个输入权动作（与 PopupRequest.kind 一一对应）。 */
export type PopupInputAction = "grant_input" | "human_presence" | "ensure_visible";

export const POPUP_INPUT_ACTIONS: readonly PopupInputAction[] = [
  "grant_input",
  "human_presence",
  "ensure_visible",
];

export function isPopupInputAction(kind: PopupRequest["kind"]): kind is PopupInputAction {
  return (POPUP_INPUT_ACTIONS as readonly string[]).includes(kind);
}

export interface PopupTarget {
  spaceId: string;
  tabId?: number;
}

let popupRequestSeq = 0;

function nextRequestId(kind: string): string {
  popupRequestSeq += 1;
  return "popup-" + kind + "-" + Date.now() + "-" + popupRequestSeq;
}

/** 目标字段只从已校验的 target 生成；调用方传入的多余字段永远不会进入命令。 */
function targetArgs(target: PopupTarget): Record<string, unknown> {
  const args: Record<string, unknown> = { spaceId: target.spaceId };
  if (target.tabId !== undefined) args.tabId = target.tabId;
  return args;
}

/**
 * 构造用户入口输入权命令。**唯一**会为 popup 输入动作创建 Command 的地方。
 *
 * - grant_input：固定 actions=1（TTL 走命令层默认 60s，popup 不能放大授权）；
 * - human_presence：固定 source="popup:user" + immediate=true；
 * - ensure_visible：固定 focus=false（只恢复呈现，不抢用户焦点）。
 */
export function buildPopupInputCommand(action: PopupInputAction, target: PopupTarget): Command {
  const base = targetArgs(target);
  let args: Record<string, unknown>;
  switch (action) {
    case "grant_input":
      args = { ...base, actions: 1 };
      break;
    case "human_presence":
      args = { ...base, source: "popup:user", immediate: true };
      break;
    case "ensure_visible":
      args = { ...base, focus: false };
      break;
  }
  return markInternalCommand({
    type: "command",
    name: action,
    args,
    requestId: nextRequestId(action),
  });
}

/** 只读 input_status（用户入口身份，用于 popup 状态卡）。不进入 dispatch，不取前台租约。 */
export function buildPopupStatusCommand(target: PopupTarget): Command {
  return markInternalCommand({
    type: "command",
    name: "input_status",
    args: targetArgs(target),
    requestId: nextRequestId("input_status"),
  });
}
