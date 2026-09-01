// native messaging 桥：SW ↔ host（`com.browserpilot.browseragent`）。
// 参考技术路径 §4.1（ChatGPT/Codex 实路）+ 本机实测 host manifest。
// 关键拓扑：native messaging 只能由扩展侧发起 → SW 调 connectNative，Chrome 拉起 host；
//          host 同时监听 127.0.0.1:<port> 供外部 AI 连入并转发。此文件只负责「扩展这一侧」的端口。
import type { NativeMessage, Command, Result, ProfileInfo } from "../shared/types";
import { patchState } from "./state";
import { dispatch } from "./commands";
import { broadcastEvent } from "./events";

const HOST_NAME = "com.browserpilot.browseragent";

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectMs = 1000;

export function isHostConnected(): boolean {
  return !!port;
}

export function getHostPort(): number | undefined {
  // 由 host 的 ready 事件写入 storage 后读取；此处直接抛给外部由调用方读 state。
  return undefined;
}

/** 主动连接 host。由 SW 启动 / 心跳触发。 */
export async function connectHost(): Promise<boolean> {
  if (port) return true;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    scheduleConnect();
    return false;
  }
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(onDisconnect);
  return true;
}

/** host 可能因 host 未注册/端口失败在启动瞬间报错，监听 disconnect 重连。 */
export function scheduleConnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = undefined;
    reconnectMs = Math.min(reconnectMs * 2, 30000);
    const ok = await connectHost();
    if (ok) reconnectMs = 1000;
  }, reconnectMs);
}

async function onPortMessage(msg: NativeMessage): Promise<void> {
  if (msg.type === "command") {
    const res = await handleCommand(msg);
    send(res);
  } else if (msg.type === "event" && msg.name === "ready") {
    const args = (msg as { args?: { port?: number; authToken?: string; profile?: ProfileInfo } }).args;
    if (args) {
      await patchState({ hostPort: args.port, hostToken: args.authToken, profile: args.profile });
      console.log("[native-bridge] host ready: port=" + args.port, "profile=" + JSON.stringify(args.profile));
    }
  }
}

async function handleCommand(cmd: Command): Promise<Result> {
  try {
    const data = await dispatch(cmd);
    return { type: "result", requestId: cmd.requestId, ok: true, data };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { type: "result", requestId: cmd.requestId, ok: false, error: message };
  }
}

function send(msg: NativeMessage): void {
  try {
    port?.postMessage(msg);
  } catch (e) {
    // Port already dead; ignore.
  }
}

function onDisconnect(): void {
  const err = (port as { error?: { message?: string } } | null)?.error?.message;
  port = null;
  if (err) console.warn("[native-bridge] disconnected:", err);
  scheduleConnect();
}

/** 供其它模块把事件推给 host（同时写入事件缓冲，见 events.ts）。 */
export function pushEvent(name: string, args: unknown): void {
  broadcastEvent(name, args, send);
}
