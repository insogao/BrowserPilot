// Native Messaging Host（M2 主通道）。
// 拓扑：SW 调 connectNative → Chrome 拉起本进程 → 本进程监听 127.0.0.1:<port> 供外部 AI 连入。
// 两套通道：
//   - 与扩展：native messaging，4 字节 LE 长度前缀 + JSON（stdin/stdout，Chrome 协议硬性）。
//   - 与外部 AI：TCP loopback，换行分隔 JSON（一行一条，便于 CLI/Agent 直接收发）。
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectProfile } from "./profile.js";
import { sessionDir } from "./paths.js";

const configuredBasePort = Number(process.env.BROWSERPILOT_HOST_BASE_PORT);
const DEFAULT_PORT = Number.isInteger(configuredBasePort) && configuredBasePort >= 1024 && configuredBasePort <= 65480
  ? configuredBasePort
  : 47001;
const MAX_PORT = Math.min(DEFAULT_PORT + 50, 65535);
let activePort = 0;
const clients = new Set();

// SEA 构建产物（Windows）用编译期注入的 token；直跑（node host.js / mac wrapper）与 client
// 共用 auth.json，否则直跑进程每次随机生成 token，客户端永远认证失败。
function resolveAuthToken() {
  if (typeof __BP_BUILD_TOKEN__ !== "undefined") return __BP_BUILD_TOKEN__;
  const authFile = path.join(nativeHostRoot(), "auth.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (typeof parsed.authToken === "string" && parsed.authToken) return parsed.authToken;
  } catch {}
  const token = crypto.randomBytes(24).toString("hex");
  try {
    fs.writeFileSync(authFile, JSON.stringify({ authToken: token, builtAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error("[host] auth.json write error:", e.message);
  }
  return token;
}
const authToken = resolveAuthToken();
const pending = new Map();
let clientSeq = 0;
let requestSeq = 0;
let sessionFile = "";
const AGENT_ACTIVE_TTL_MS = 30_000;
const PROFILE_CACHE_FILE = "profile-cache.json";
let lastAgentActivity = 0;
let agentActivityTimer;

function authenticatedClientCount() {
  let count = 0;
  for (const socket of clients) if (socket.bpAuthenticated) count++;
  return count;
}

function emitClientState(active = authenticatedClientCount() > 0 || Date.now() - lastAgentActivity < AGENT_ACTIVE_TTL_MS) {
  sendToExtension({
    type: "event",
    name: "client_state",
    args: { active, connectedClients: authenticatedClientCount(), lastActivity: lastAgentActivity || undefined, ttlMs: AGENT_ACTIVE_TTL_MS },
  });
}

function markAgentActivity() {
  lastAgentActivity = Date.now();
  if (agentActivityTimer) clearTimeout(agentActivityTimer);
  emitClientState(true);
  agentActivityTimer = setTimeout(() => {
    if (authenticatedClientCount() > 0) return emitClientState(true);
    emitClientState(false);
  }, AGENT_ACTIVE_TTL_MS);
}

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
      markAgentActivity();
      return;
    }
    // 事件只广播给已认证客户端；普通 result 绝不跨客户端泄漏。
    for (const s of clients) {
      if (s.bpAuthenticated) s.write(JSON.stringify(msg) + "\n");
    }
  } else if (msg.type === "command") {
    // 扩展主动问 host（如 get_profile 由扩展侧触发时不常见；此处兜底回 profile）
    if (msg.name === "get_profile" || msg.name === "get_ready_state") {
      const profile = detectProfile();
      writeProfileCache(profile);
      const data = msg.name === "get_ready_state"
        ? { port: activePort, authToken, profile }
        : profile;
      sendToExtension({ type: "result", requestId: msg.requestId, ok: true, data });
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
      const wasAuthenticated = socket.bpAuthenticated;
      clients.delete(socket);
      for (const [id, route] of pending) if (route.socket === socket) pending.delete(id);
      if (wasAuthenticated) emitClientState();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < MAX_PORT) {
      startServer(port + 1);
    } else {
      console.error("[host] server error:", err.message);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    activePort = port;
    const profile = detectProfile();
    writeProfileCache(profile);
    writeSessionFile(port);
    console.error("[host] listening on 127.0.0.1:" + port);
    // ready 上报：port + profile 一并给扩展
    sendToExtension({ type: "event", name: "ready", args: { port, authToken, profile } });
    emitClientState(false);
  });
}

// 常数时间比较，避免逐字节短路泄露 token 前缀信息。
function tokenMatches(supplied) {
  const a = Buffer.from(String(supplied ?? ""), "utf8");
  const b = Buffer.from(authToken, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function handleFromClient(msg, socket) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type !== "command") {
    socket.write(JSON.stringify({ type: "result", requestId: msg.requestId ?? null, ok: false, error: "only command messages accepted" }) + "\n");
    return;
  }
  // ping/reload 仅用于本机发现与开发热更新；所有浏览器数据/操作命令必须持有 capability token。
  const publicCommand = msg.name === "ping" || msg.name === "reload";
  const supplied = typeof msg.authToken === "string" ? msg.authToken : "";
  if (!publicCommand && !socket.bpAuthenticated && !tokenMatches(supplied)) {
    socket.write(JSON.stringify({ type: "result", requestId: msg.requestId ?? null, ok: false, error: "authentication_required" }) + "\n");
    return;
  }
  if (tokenMatches(supplied)) socket.bpAuthenticated = true;
  if (socket.bpAuthenticated && !publicCommand) markAgentActivity();
  // 未应答请求设上限：异常客户端不能无限膨胀 pending 表。
  if (pending.size >= 512) {
    socket.write(JSON.stringify({ type: "result", requestId: msg.requestId ?? null, ok: false, error: "too_many_pending_requests" }) + "\n");
    return;
  }
  // 转发给扩展执行
  // requestId 原样保存/回传（不强制 String 化）：对象型 requestId 之间不会互相串扰。
  const externalRequestId = msg.requestId ?? null;
  const internalRequestId = "bp:" + socket.bpClientId + ":" + (++requestSeq);
  pending.set(internalRequestId, { socket, requestId: externalRequestId });
  const declaredAgentId = typeof msg.agentId === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(msg.agentId)
    ? msg.agentId
    : "socket-" + socket.bpClientId;
  // 身份与内部租约字段只允许 Host 注入，外部消息中的同名字段一律覆盖/丢弃。
  const {
    authToken: _ignored,
    agentId: _agentId,
    _clientId: _spoofedClientId,
    _foregroundLeaseToken: _spoofedLease,
    ...forward
  } = msg;
  sendToExtension({ ...forward, requestId: internalRequestId, _clientId: "agent:" + declaredAgentId });
}

function writeSessionFile(port) {
  try {
    const dir = sessionDir();
    fs.mkdirSync(dir, { recursive: true });
    sessionFile = path.join(dir, String(port) + ".json");
    fs.writeFileSync(sessionFile, JSON.stringify({ port, authToken, pid: process.pid, updatedAt: Date.now() }), { mode: 0o600 });
  } catch (e) {
    console.error("[host] session file error:", e.message);
  }
}

function nativeHostRoot() {
  const scriptPath = process.argv[1] || "";
  if (scriptPath.endsWith("host.js")) return path.dirname(path.resolve(scriptPath));
  return path.resolve(path.dirname(process.execPath), "..");
}

function extensionIdFromManifest() {
  try {
    const manifestPath = path.join(nativeHostRoot(), "host.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const origin = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins[0] : "";
    const m = String(origin).match(/^chrome-extension:\/\/([^/]+)\//);
    return m?.[1];
  } catch {
    return undefined;
  }
}

function writeProfileCache(profile) {
  if (!profile?.ok) return;
  if (!profile.chromeExe && !profile.userDataDir && !profile.profileDir) return;
  try {
    const file = path.join(nativeHostRoot(), PROFILE_CACHE_FILE);
    fs.writeFileSync(file, JSON.stringify({ ...profile, extensionId: extensionIdFromManifest(), savedAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error("[host] profile cache error:", e.message);
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
