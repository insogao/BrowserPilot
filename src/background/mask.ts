// SW 侧：人工接管遮罩的状态与协调（M11）。
// - activeMasks：当前已开遮罩的 tab（withCdpAllow 用它决定是否临时放行 CDP）。
// - takeover：已被人类点「人工接管」暂停的 tab（阻止动作命令，防止 AI 在人类操作时继续乱动）。
// - 按钮点击由 content script 上报（kind: mask_user_takeover）→ 这里设接管态 + 发 mask_takeover 事件给外部 AI。
import { sendToTab, ensureInjected } from "./content-bridge";
import { pushEvent } from "./native-bridge";

const activeMasks = new Set<number>();
const takeover = new Set<number>();

// 「AI 停手 60s 自动解除遮罩」兜底：防止 AI 忘了 stop_mask 时页面被冻住。
// - 任何命令（dispatch）都会 touchMaskActivity()：busy++ 并重置各 tab 的 60s 计时。
// - 命令执行期间 busy>0，计时到点后不解除而是重新计时（长任务如 run_template 等待回复时不会误放）。
// - 彻底无人操作（busy===0 且 60s 无新命令）→ 自动 maskOff + 发 mask_auto_release 事件。
const MASK_IDLE_MS = 60_000;
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
let busy = 0;

function armIdle(tabId: number): void {
  const t = idleTimers.get(tabId);
  if (t !== undefined) clearTimeout(t);
  idleTimers.set(
    tabId,
    setTimeout(() => {
      if (busy > 0) {
        armIdle(tabId);
        return;
      }
      if (!activeMasks.has(tabId)) return;
      void maskOff(tabId);
      pushEvent("mask_auto_release", { tabId });
    }, MASK_IDLE_MS)
  );
}

function clearIdle(tabId: number): void {
  const t = idleTimers.get(tabId);
  if (t !== undefined) clearTimeout(t);
  idleTimers.delete(tabId);
}

/** 任一开始执行命令即上报活动：busy++ 并重置所有遮罩的停手计时。 */
export function touchMaskActivity(): void {
  busy++;
  for (const tabId of activeMasks) armIdle(tabId);
}

/** 命令执行结束。 */
export function endMaskActivity(): void {
  if (busy > 0) busy--;
}

/** 开启遮罩（冻结用户 + 蓝光 + 按钮）。会清掉该 tab 的接管态（视为新一轮操作开始），并启动 60s 停手计时。 */
export async function maskOn(tabId: number): Promise<boolean> {
  await ensureInjected(tabId);
  const res = await sendToTab(tabId, { kind: "mask_on" }, 0);
  if (res && res.ok === true) {
    activeMasks.add(tabId);
    takeover.delete(tabId);
    armIdle(tabId);
    return true;
  }
  return false;
}

/** 关闭遮罩 / 清除接管态（人类解决验证码后 AI 继续）。 */
export async function maskOff(tabId: number): Promise<void> {
  clearIdle(tabId);
  activeMasks.delete(tabId);
  takeover.delete(tabId);
  try {
    await sendToTab(tabId, { kind: "mask_off" }, 0);
  } catch {
    /* 页面可能已导航/关闭，忽略 */
  }
}

/** 在 CDP 动作期间对遮罩做「临时放行→恢复」包裹（有遮罩时才需要，否则零开销直接执行）。 */
export async function withCdpAllow<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  if (!activeMasks.has(tabId)) return fn();
  await sendToTab(tabId, { kind: "mask_allow_cdp" }, 0).catch(() => {});
  try {
    return await fn();
  } finally {
    await sendToTab(tabId, { kind: "mask_block_cdp" }, 0).catch(() => {});
  }
}

/** [多人-接管通用路径] 用户（点遮罩上的「人工接管」或 popup「接管」）接管：设接管态、通知外部 AI、取消遮罩。
 *  已在接管态则不重复。AI 想续跑可用 stop_mask/start_mask 清掉接管态。 */
export function requestTakeover(tabId: number): void {
  if (tabId === undefined || takeover.has(tabId)) return;
  takeover.add(tabId);
  pushEvent("mask_takeover", { tabId });
  void maskOff(tabId); // 释放遮罩，让人类接管
}

export function isHumanTakeover(tabId: number): boolean {
  return takeover.has(tabId);
}

export function hasTakeover(): boolean {
  return takeover.size > 0;
}

/** 注册 content → SW 的「人工接管」上报 + 页面导航后清理遮罩状态。 */
export function registerMaskHandlers(): void {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if ((msg as { kind?: string })?.kind !== "mask_user_takeover") return undefined;
    const tabId = sender?.tab?.id;
    if (tabId !== undefined) requestTakeover(tabId);
    return undefined; // 不占用 sendResponse 通道（popup 等 handler 已处理响应）
  });

  // 页面导航后，旧帧的遮罩/接管态随之失效，及时清除，避免误拦后续动作。
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      activeMasks.delete(tabId);
      takeover.delete(tabId);
    }
  });
}
