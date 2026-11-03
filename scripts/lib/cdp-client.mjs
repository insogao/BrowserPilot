// 极简 CDP 客户端（Node 22+ 内置 WebSocket），只覆盖测试需要的能力。
// 不引入 puppeteer/ws 依赖，避免给仓库增加运行时体积。
import fs from "node:fs";
import path from "node:path";
import { launchTestProcess, stopTestProcess, waitForExit } from "./test-process.mjs";

export class CdpError extends Error {}

export class CdpConnection {
  constructor(ws, label = "cdp") {
    this.ws = ws;
    this.label = label;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new CdpError(msg.error.message + (msg.error.data ? " (" + msg.error.data + ")" : "")));
        else entry.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) {
        try { fn(msg); } catch { /* ignore listener errors */ }
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(new CdpError("CDP 连接已关闭"));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new CdpError("CDP 连接已关闭"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CdpError("CDP 超时: " + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitFor(method, sessionId, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError("等待事件超时: " + method));
      }, timeoutMs);
      const off = this.on((msg) => {
        if (msg.method !== method) return;
        if (sessionId && msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(msg.params);
      });
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export async function connectWebSocket(url, timeoutMs = 15000) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpError("WebSocket 连接超时: " + url)), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new CdpError("WebSocket 连接失败: " + url)); }, { once: true });
  });
  return ws;
}

async function waitForFile(file, timeoutMs = 25000) {
  const started = Date.now();
  for (;;) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return text;
    }
    if (Date.now() - started > timeoutMs) throw new Error("等待 " + file + " 超时");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * 启动一个隔离的 headless Chromium：
 * - 独立临时 --user-data-dir（绝不碰用户真实 profile）；
 * - --headless=new --disable-gpu --in-process-gpu（项目基线要求）；
 * - 不使用 --no-sandbox。
 */
export async function launchHeadlessChrome({ chromeExe, userDataDir, extraArgs = [], viewport = { width: 900, height: 700 } }) {
  if (!chromeExe || !fs.existsSync(chromeExe)) throw new Error("找不到 Chromium: " + chromeExe);
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--in-process-gpu",
    "--user-data-dir=" + userDataDir,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--mute-audio",
    "--force-device-scale-factor=1",
    "--window-size=" + viewport.width + "," + viewport.height,
    // AGENTS.md §1：macOS 上的自动化测试必须用 mock keychain（绝不触碰真实钥匙串）。
    // Windows/Linux 无此开关；生产构建不得使用（本文件只在测试脚本里被引用）。
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ...extraArgs,
    "about:blank",
  ];
  const record = launchTestProcess({
    exe: chromeExe,
    args,
    marker: userDataDir,
    label: "headless-chrome",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = record.child;
  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += String(d); });
  const activePortFile = path.join(userDataDir, "DevToolsActivePort");
  let text;
  try {
    text = await waitForFile(activePortFile);
  } catch (e) {
    try {
      const stopped = stopTestProcess(record, { reason: "cdp-client.startup-failure" });
      if (!stopped.stopped) child.kill(); // 句柄级兜底：只作用于本进程 spawn 的直接子进程
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
    throw new Error((e instanceof Error ? e.message : String(e)) + "\nchrome stderr:\n" + stderr.slice(-4000));
  }
  const [port, wsPath] = text.split(/\r?\n/);
  const wsUrl = "ws://127.0.0.1:" + port + (wsPath ?? "");
  const ws = await connectWebSocket(wsUrl);
  return {
    child,
    record,
    wsUrl,
    port: Number(port),
    connection: new CdpConnection(ws),
    stderr: () => stderr,
    async kill() {
      try { ws.close(); } catch { /* ignore */ }
      // 核验 PID + 创建时间 + marker + 可执行路径后才清理；拒绝时抛错，不静默。
      const result = stopTestProcess(record, { reason: "cdp-client.kill" });
      if (result.refused) {
        throw new Error("拒绝清理 Chromium: " + result.reason + " " + JSON.stringify(result.detail));
      }
      if (!result.stopped && result.reason !== "already-exited") {
        throw new Error("清理 Chromium 失败: " + result.reason + " " + (result.error ?? ""));
      }
      waitForExit(record, 15000);
    },
  };
}
