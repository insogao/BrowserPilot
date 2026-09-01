// Native Messaging Host（M2 主通道）。
// 拓扑：SW 调 connectNative → Chrome 拉起本进程 → 本进程监听 127.0.0.1:<port> 供外部 AI 连入。
// 两套通道：
//   - 与扩展：native messaging，4 字节 LE 长度前缀 + JSON（stdin/stdout，Chrome 协议硬性）。
//   - 与外部 AI：TCP loopback，换行分隔 JSON（一行一条，便于 CLI/Agent 直接收发）。
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectProfile } from "./profile.js";

const DEFAULT_PORT = 47001;
let activePort = 0;
const clients = new Set();
const authToken = typeof __BP_BUILD_TOKEN__ !== "undefined"
  ? __BP_BUILD_TOKEN__
  : crypto.randomBytes(24).toString("hex");
const pending = new Map();
let clientSeq = 0;
let requestSeq = 0;
let sessionFile = "";

// ---------- native messaging 分帧（与扩展） ----------
let inBuf = Buffer.alloc(0);

function sendToExtension(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

function onExtensionData(chunk) {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const json = inBuf.slice(4, 4 + len).toString("utf8");
    inBuf = inBuf.slice(4 + len);
    try {
      handleFromExtension(JSON.parse(json));
    } catch (e) {
      console.error("[host] bad frame:", e.message);
    }
  }
}

function handleFromExtension(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "result" || msg.type === "event") {
    if (msg.type === "result") {
      const route = pending.get(msg.requestId);
      if (!route) return;
      pending.delete(msg.requestId);
      if (!route.socket.destroyed) {
        route.socket.write(JSON.stringify({ ...msg, requestId: route.requestId }) + "\n");
      }
      return;
    }
    // 事件只广播给已认证客户端；普通 result 绝不跨客户端泄漏。
    for (const s of clients) {
      if (s.bpAuthenticated) s.write(JSON.stringify(msg) + "\n");
    }
  } else if (msg.type === "command") {
    // 扩展主动问 host（如 get_profile 由扩展侧触发时不常见；此处兜底回 profile）
    if (msg.name === "get_profile") {
      sendToExtension({ type: "result", requestId: msg.requestId, ok: true, data: detectProfile() });
    }
  }
}

// ---------- 外部 AI TCP 接入 ----------
function startServer(port) {
  const server = net.createServer((socket) => {
    socket.bpClientId = ++clientSeq;
    socket.bpAuthenticated = false;
    clients.add(socket);
    let b = "";
    socket.on("data", (chunk) => {
      b += chunk.toString("utf8");
      let nl;
      while ((nl = b.indexOf("\n")) >= 0) {
        const line = b.slice(0, nl).trim();
        b = b.slice(nl + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          handleFromClient(m, socket);
        } catch (e) {
          socket.write(JSON.stringify({ type: "error", error: "bad json: " + e.message }) + "\n");
        }
      }
    });
    const cleanup = () => {
      clients.delete(socket);
      for (const [id, route] of pending) if (route.socket === socket) pending.delete(id);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < DEFAULT_PORT + 50) {
      startServer(port + 1);
    } else {
      console.error("[host] server error:", err.message);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    activePort = port;
    writeSessionFile(port);
    console.error("[host] listening on 127.0.0.1:" + port);
    // ready 上报：port + profile 一并给扩展
    sendToExtension({ type: "event", name: "ready", args: { port, authToken, profile: detectProfile() } });
  });
}

function handleFromClient(msg, socket) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type !== "command") {
    socket.write(JSON.stringify({ type: "result", requestId: msg.requestId, ok: false, error: "only command messages accepted" }) + "\n");
    return;
  }
  // ping/reload 仅用于本机发现与开发热更新；所有浏览器数据/操作命令必须持有 capability token。
  const publicCommand = msg.name === "ping" || msg.name === "reload";
  const supplied = typeof msg.authToken === "string" ? msg.authToken : "";
  if (!publicCommand && !socket.bpAuthenticated && supplied !== authToken) {
    socket.write(JSON.stringify({ type: "result", requestId: msg.requestId, ok: false, error: "authentication_required" }) + "\n");
    return;
  }
  if (supplied === authToken) socket.bpAuthenticated = true;
  // 转发给扩展执行
  const externalRequestId = String(msg.requestId ?? "");
  const internalRequestId = "bp:" + socket.bpClientId + ":" + (++requestSeq);
  pending.set(internalRequestId, { socket, requestId: externalRequestId });
  const { authToken: _ignored, ...forward } = msg;
  sendToExtension({ ...forward, requestId: internalRequestId });
}

function writeSessionFile(port) {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "BrowserPilot", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    sessionFile = path.join(dir, String(port) + ".json");
    fs.writeFileSync(sessionFile, JSON.stringify({ port, authToken, pid: process.pid, updatedAt: Date.now() }), { mode: 0o600 });
  } catch (e) {
    console.error("[host] session file error:", e.message);
  }
}

function cleanupSessionFile() {
  if (!sessionFile) return;
  try { fs.unlinkSync(sessionFile); } catch {}
}

// ---------- 启动 ----------
function main() {
  process.stdin.on("data", onExtensionData);
  startServer(DEFAULT_PORT);
  console.error("[host] com.browserpilot.browseragent up, pid=" + process.pid);
}

process.on("exit", cleanupSessionFile);
process.on("SIGTERM", () => { cleanupSessionFile(); process.exit(0); });
process.on("SIGINT", () => { cleanupSessionFile(); process.exit(0); });

main();
