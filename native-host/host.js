// Native Messaging Host（M2 主通道）。
// 拓扑：SW 调 connectNative → Chrome 拉起本进程 → 本进程监听 127.0.0.1:<port> 供外部 AI 连入。
// 两套通道：
//   - 与扩展：native messaging，4 字节 LE 长度前缀 + JSON（stdin/stdout，Chrome 协议硬性）。
//   - 与外部 AI：TCP loopback，换行分隔 JSON（一行一条，便于 CLI/Agent 直接收发）。
import net from "node:net";
import { detectProfile } from "./profile.js";

const DEFAULT_PORT = 47001;
let activePort = 0;
const clients = new Set();

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
    // SW 的响应/事件 → 转发给外部 AI（单客户端；多个则广播）
    for (const s of clients) {
      s.write(JSON.stringify(msg) + "\n");
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
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
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
    console.error("[host] listening on 127.0.0.1:" + port);
    // ready 上报：port + profile 一并给扩展
    sendToExtension({ type: "event", name: "ready", args: { port, profile: detectProfile() } });
  });
}

function handleFromClient(msg, socket) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type !== "command") {
    socket.write(JSON.stringify({ type: "result", requestId: msg.requestId, ok: false, error: "only command messages accepted" }) + "\n");
    return;
  }
  // 转发给扩展执行
  sendToExtension(msg);
}

// ---------- 启动 ----------
function main() {
  process.stdin.on("data", onExtensionData);
  startServer(DEFAULT_PORT);
  console.error("[host] com.egolite.browseragent up, pid=" + process.pid);
}

main();
