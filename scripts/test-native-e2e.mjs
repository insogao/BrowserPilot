// 真实链路 E2E（禁止 mock）：Browser CLI 基线 Chrome + 真实 native host + 真实扩展 SW。
//
// 覆盖：
//   1) register.ps1 注册真实 HKCU 键（带 backup）→ Chrome 通过 connectNative 拉起真实 host exe；
//   2) Host TCP 协议 → SW 命令分发 → 结果返回（get_ready_state/ping/version/host_capabilities/
//      open_space/open_tab/list_tabs）；
//   3) chrome.debugger 六操作：attach/evaluate/click/type/screenshot/detach；
//   4) 浏览器级 CDP 停止扩展 SW → host 重连、能力重探测、Task Space/tab 状态恢复；
//   5) 普通 Playwright Chromium（无 browserCli API）→ generic、并发上限 1、截图可用；
//   6) 结束时按 backup 回滚 HKCU，恢复测试前的值。
//
// 安全：
//   - 只使用独立临时 --user-data-dir 与隔离 LOCALAPPDATA；不碰用户真实 Chrome profile/进程；
//   - 基线 Browser CLI 不使用 --no-sandbox；只有第三方 Playwright Chromium 使用（任务允许并在此注明）；
//   - 从不写 HKLM，从不触碰 com.egolite.browseragent。
//
// 运行：
//   node scripts/test-native-e2e.mjs                 # 全部阶段
//   node scripts/test-native-e2e.mjs --stage=chain   # 只跑某个阶段（chain/debugger/sw/generic）
//   node scripts/test-native-e2e.mjs --keep          # 保留临时目录（默认也保留，见输出路径）
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findNewestHostExe } from "./lib/host-manifest.mjs";
import { launchTestProcess, stopTestProcess, stopVerifiedPid } from "./lib/test-process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(root, "dist");
const REGISTER_PS1 = path.join(root, "native-host", "register.ps1");
const UNREGISTER_PS1 = path.join(root, "native-host", "unregister.ps1");
const HOST_NAME = "com.browserpilot.browseragent";
const EXTENSION_ID = "nnollghpaggbcdkkgoieneffnlijinio";
const AGENT_ID = "e2e-native-agent";
const BASELINE_CHROME =
  process.env.BROWSERPILOT_BASELINE_CHROME || "D:\\work\\wt\\browser-cli-baseline\\chrome.exe";

const argv = process.argv.slice(2);
const stageArg = argv.find((arg) => arg.startsWith("--stage="))?.slice("--stage=".length);
const STAGES = new Set(stageArg ? stageArg.split(",").map((s) => s.trim()) : ["chain", "debugger", "sw", "generic"]);
// 默认保留 .e2e-tmp/<runId>/artifacts 作为证据；--clean 在成功/失败后删除。
const KEEP = !argv.includes("--clean");

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log("PASS | " + name);
  } else {
    failed++;
    failures.push(name);
    console.log("FAIL | " + name + (detail ? " :: " + String(detail).slice(0, 1200) : ""));
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- run dir
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(root, ".e2e-tmp", runId);
const artifactsDir = path.join(runDir, "artifacts");
const baselineProfile = path.join(runDir, "baseline-profile");
const baselineLocalAppData = path.join(runDir, "baseline-localappdata");
const genericProfile = path.join(runDir, "generic-profile");
const genericLocalAppData = path.join(runDir, "generic-localappdata");
fs.mkdirSync(artifactsDir, { recursive: true });
const report = {
  runAt: new Date().toISOString(),
  runDir,
  baselineChrome: BASELINE_CHROME,
  stages: [...STAGES],
  registration: null,
  host: null,
  chain: null,
  debugger: null,
  swRestart: null,
  generic: null,
  checks: { passed: 0, failed: 0, failures: [] },
};

function redact(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = /token/i.test(key) ? "<redacted>" : redact(inner);
    }
    return out;
  }
  return value;
}
function saveArtifact(name, data) {
  const file = path.join(artifactsDir, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(redact(data), null, 2) + "\n", "utf8");
  return file;
}

// ---------------------------------------------------------------- process helpers
// 清理只走两条路：
//   1) launchTestProcess 的 record（核验 PID + 创建时间 + marker + exe 路径后按 PID 清理）；
//   2) stopVerifiedPid（对 native host 这类非本进程 spawn 的目标，核验 exe 路径后按 PID 清理）。
// 严禁按镜像名清理，也没有“查不到就全局杀”的回退。
const chromeRecords = new Set();
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function processExecutablePath(pid) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(pid) + "').ExecutablePath"],
    { encoding: "utf8", windowsHide: true },
  );
  return (result.stdout || "").trim();
}
function runPowerShellFile(file, args) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  const lastLine = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  let json;
  try {
    json = lastLine ? JSON.parse(lastLine) : undefined;
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}
function registryDefault(keyPath) {
  const script =
    "$k='" + keyPath.replace(/'/g, "''") + "';" +
    "if (Test-Path -LiteralPath $k) { $i=Get-Item -LiteralPath $k; if (@($i.GetValueNames()) -contains '') { $v=$i.GetValue('', $null); if ($null -eq $v) { '' } else { [string]$v } } else { '<no-default>' } } else { '<missing>' }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  return (result.stdout || "").trim();
}

// ---------------------------------------------------------------- fixture
async function startFixture() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>BrowserPilot E2E Fixture</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#eef;color:#123}
main{padding:32px;min-height:1400px}
button{font-size:20px;padding:12px 24px}
input{font-size:20px;padding:10px;width:320px;display:block;margin:24px 0}
#out{font-size:22px;color:#064}</style></head>
<body><main>
<h1 id="h">BrowserPilot E2E Fixture</h1>
<button id="btn" onclick="document.getElementById('out').textContent='clicked';document.body.dataset.clicked='1'">Click me</button>
<input id="name" aria-label="name" />
<div id="out">initial</div>
</main></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return { server, port, url: "http://127.0.0.1:" + port + "/" };
}

// ---------------------------------------------------------------- browser launch / CDP
async function waitForDevToolsPort(profileDir, child, logFile, timeoutMs = 30000) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("browser exited early (code " + child.exitCode + "); log: " + logFile);
    }
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await sleep(120);
  }
  throw new Error("timed out waiting for DevToolsActivePort: " + file);
}

async function launchChrome({ exe, profileDir, localAppData, label, noSandbox = false, extraArgs = [], initialUrl = "about:blank" }) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const logFile = path.join(artifactsDir, label + "-chrome.log");
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--in-process-gpu",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--user-data-dir=" + profileDir,
    "--load-extension=" + DIST,
    "--disable-extensions-except=" + DIST,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    ...(noSandbox ? ["--no-sandbox"] : []),
    ...extraArgs,
    initialUrl,
  ];
  const env = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    BROWSERPILOT_HOST_BASE_PORT: String(48600 + Math.floor(Math.random() * 120)),
  };
  const record = launchTestProcess({
    exe,
    args,
    env,
    marker: profileDir,
    label: label + "-chrome",
    stdio: ["ignore", "pipe", "pipe"],
  });
  chromeRecords.add(record);
  const child = record.child;
  let stdout = "";
  let stderr = "";
  const log = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.on("data", (d) => {
    stdout += d;
    log.write(d);
  });
  child.stderr.on("data", (d) => {
    stderr += d;
    log.write(d);
  });
  child.on("exit", (code) => {
    chromeRecords.delete(record);
    log.write("\n[exit] code=" + code + "\n");
    log.end();
  });
  const port = await waitForDevToolsPort(profileDir, child, logFile);
  return {
    child,
    record,
    port,
    logFile,
    stderrTail: () => stderr.split(/\r?\n/).slice(-12).join("\n"),
    stdoutTail: () => stdout.split(/\r?\n/).slice(-8).join("\n"),
    stop: () => stopTestProcess(record, { reason: "test-native-e2e.stop" }),
  };
}

async function httpJson(port, route) {
  try {
    const response = await fetch("http://127.0.0.1:" + port + route);
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}
async function listTargets(port) {
  return (await httpJson(port, "/json/list")) || [];
}
async function waitForSwTarget(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    const sw = targets.find((target) => target.type === "service_worker" && target.url.includes(EXTENSION_ID));
    if (sw) return sw;
    await sleep(150);
  }
  throw new Error("timed out waiting for extension service worker target (port " + port + ")");
}
async function waitForSwTargetGone(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    if (!targets.some((target) => target.type === "service_worker" && target.url.includes(EXTENSION_ID))) return true;
    await sleep(150);
  }
  return false;
}

class CdpConnection {
  static async connect(url, timeoutMs = 15000) {
    if (typeof WebSocket === "undefined") throw new Error("Node.js global WebSocket is required for CDP");
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("CDP connect timeout: " + url));
      }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP connect error: " + url)); };
    });
    return new CdpConnection(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.id !== "number") return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    ws.onclose = () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    };
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function browserCdp(port) {
  const version = await httpJson(port, "/json/version");
  if (!version?.webSocketDebuggerUrl) throw new Error("browser CDP websocket not available");
  return CdpConnection.connect(version.webSocketDebuggerUrl);
}

async function evalInServiceWorker(port, expression, timeoutMs = 30000) {
  const sw = await waitForSwTarget(port, timeoutMs);
  const cdp = await CdpConnection.connect(sw.webSocketDebuggerUrl);
  try {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
      timeoutMs,
    );
    if (result?.exceptionDetails) {
      throw new Error("SW evaluate error: " + JSON.stringify(result.exceptionDetails).slice(0, 800));
    }
    return result?.result?.value;
  } finally {
    cdp.close();
  }
}

// ---------------------------------------------------------------- host discovery / TCP
function sessionsDirFor(localAppData) {
  return path.join(localAppData, "BrowserPilot", "sessions");
}
function readSessions(localAppData) {
  const dir = sessionsDirFor(localAppData);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (Number.isInteger(parsed.port) && typeof parsed.authToken === "string" && Number.isInteger(parsed.pid)) {
        out.push({ ...parsed, file: path.join(dir, file) });
      }
    } catch {
      // ignore partial files
    }
  }
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
async function waitForHostSession(localAppData, { timeoutMs = 45000, excludePid, predicate } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = readSessions(localAppData).filter(
      (session) =>
        session.pid !== excludePid &&
        pidAlive(session.pid) &&
        Date.now() - Number(session.updatedAt || 0) < 120000 &&
        (!predicate || predicate(session)),
    );
    if (candidates.length) return candidates[0];
    await sleep(150);
  }
  throw new Error("timed out waiting for a live native host session in " + sessionsDirFor(localAppData));
}

let requestSeq = 0;
function tcpRequest(port, authToken, name, args = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const requestId = "e2e-" + ++requestSeq;
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(name + " timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    const finish = (fn, value) => {
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "command", name, args, requestId, agentId: AGENT_ID, authToken }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === "result" && message.requestId === requestId) {
          finish(resolve, message);
          return;
        }
        if (message.type === "error") {
          finish(reject, new Error("host error: " + message.error));
          return;
        }
      }
    });
    socket.on("error", (error) => finish(reject, error));
  });
}

class HostClient {
  constructor(session) {
    this.session = session;
    this.port = session.port;
    this.authToken = session.authToken;
  }
  async request(name, args = {}, timeoutMs) {
    const result = await tcpRequest(this.port, this.authToken, name, args, timeoutMs);
    if (result.ok !== true) {
      const error = new Error(name + " failed: " + (result.error || "unknown"));
      error.code = result.errorCode;
      throw error;
    }
    return result.data;
  }
}

// ---------------------------------------------------------------- registration
function hostExePath() {
  const exe = process.env.BROWSERPILOT_HOST_EXE || findNewestHostExe(root);
  if (!exe || !fs.existsSync(exe)) {
    throw new Error("native host exe not found; run: node scripts/build-host.mjs");
  }
  return exe;
}

function registerHost(exe, backupDir) {
  const result = runPowerShellFile(REGISTER_PS1, ["-HostPath", exe, "-BackupDir", backupDir]);
  if (result.status !== 0 || !result.json?.ok) {
    throw new Error("register.ps1 failed: " + (result.stderr || result.stdout));
  }
  return result.json;
}
function rollbackHost(backupFile) {
  if (!backupFile) return undefined;
  const result = runPowerShellFile(UNREGISTER_PS1, ["-BackupFile", backupFile]);
  if (result.status !== 0 || !result.json?.ok) {
    throw new Error("unregister.ps1 failed: " + (result.stderr || result.stdout));
  }
  return result.json;
}

// ---------------------------------------------------------------- stage: chain
async function runChain(client, fixture) {
  const out = {};
  out.readyState = await client.request("get_ready_state");
  out.ping = await client.request("ping");
  out.version = await client.request("version");
  out.capabilities = await client.request("host_capabilities");
  out.profile = await client.request("get_profile");
  out.space = await client.request("open_space", { name: "E2E native", url: fixture.url });
  out.openedTab = await client.request("open_tab", { url: fixture.url + "?tab=2" });
  await client.request("waitForSelector", { selector: "#h", tabId: out.openedTab.tabId, visible: true });
  out.tabs = await client.request("list_tabs");
  out.snapshot = await client.request("snapshot", { level: "L0", tabId: out.openedTab.tabId });
  out.readText = await client.request("readText", { selector: "#h", tabId: out.openedTab.tabId });

  check("get_ready_state 返回真实 host 端口/token/profile", out.readyState?.port === client.port && typeof out.readyState?.authToken === "string" && out.readyState?.profile?.ok === true, JSON.stringify(redact(out.readyState)));
  check("ping 返回 pong", out.ping?.pong === true, JSON.stringify(out.ping));
  check("version 返回 BrowserPilot", out.version?.name === "BrowserPilot", JSON.stringify(out.version));
  check(
    "host_capabilities 返回合法能力对象（真实探测，不是 not-probed）",
    out.capabilities &&
      (out.capabilities.mode === "generic" || out.capabilities.mode === "enhanced") &&
      out.capabilities.degradeReason !== "not-probed" &&
      out.capabilities.maxConcurrentWindows >= 1,
    JSON.stringify(out.capabilities),
  );
  check("get_profile 返回 profile", out.profile?.ok === true, JSON.stringify(out.profile));
  check("open_space 创建真实窗口/空间", typeof out.space?.spaceId === "string" && Number.isFinite(out.space?.windowId) && Number.isFinite(out.space?.tabId), JSON.stringify(out.space));
  check("open_tab 在同一空间打开新标签", Number.isFinite(out.openedTab?.tabId) && out.openedTab.tabId !== out.space.tabId && out.openedTab.windowId === out.space.windowId && out.openedTab.spaceId === out.space.spaceId, JSON.stringify(out.openedTab));
  const tabIds = (out.tabs?.tabs || []).map((tab) => tab.tabId);
  check("list_tabs 返回两个真实标签", tabIds.length === 2 && tabIds.includes(out.space.tabId) && tabIds.includes(out.openedTab.tabId) && out.tabs.spaceId === out.space.spaceId, JSON.stringify(out.tabs));
  check("snapshot L0 命中 fixture 标题", String(out.snapshot?.content || "").includes("BrowserPilot E2E Fixture"), String(out.snapshot?.content || "").slice(0, 300));
  check("readText 读到 fixture 标题", String(out.readText?.text || "").includes("BrowserPilot E2E Fixture"), JSON.stringify(out.readText));
  out.fixtureUrl = fixture.url;
  return out;
}

// ---------------------------------------------------------------- stage: debugger
function pngInfo(buffer) {
  const signatureOk =
    buffer.length > 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  if (!signatureOk) return { signatureOk: false, width: 0, height: 0 };
  return { signatureOk: true, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function runDebugger(client, chain, chromePort) {
  const out = {};
  const tabId = chain.openedTab.tabId;

  // attach + evaluate 均由 js 命令触发（evalPage -> ensureAttach -> chrome.debugger.attach）。
  out.evaluate = await client.request("js", { expression: "document.title", tabId });
  out.attachEvents = await client.request("drainEvents", { methods: ["debugger.attach"], after_sequence: 0, limit: 200 });
  const attachEvent = (out.attachEvents.events || []).find((event) => event.args?.tabId === tabId);
  check("attach：js 触发 chrome.debugger.attach 并记录事件", Boolean(attachEvent), JSON.stringify(out.attachEvents).slice(0, 500));
  check("evaluate：js 返回真实页面标题", out.evaluate?.value === "BrowserPilot E2E Fixture", JSON.stringify(out.evaluate));

  // click
  out.click = await client.request("click", { selector: "#btn", tabId });
  out.afterClick = await client.request("js", {
    expression: "({ text: document.getElementById('out').textContent, clicked: document.body.dataset.clicked, h: document.getElementById('h').textContent })",
    tabId,
  });
  check("click：CDP 鼠标事件触发 DOM 变化", out.afterClick?.value?.text === "clicked" && out.afterClick?.value?.clicked === "1", JSON.stringify(out.afterClick));

  // type
  out.focusInput = await client.request("click", { selector: "#name", tabId });
  out.type = await client.request("type", { text: "hello-browserpilot", tabId });
  out.inputValue = await client.request("js", { expression: "document.getElementById('name').value", tabId });
  check("type：受信输入写入输入框", out.inputValue?.value === "hello-browserpilot" && out.type?.typed === 18, JSON.stringify({ type: out.type, inputValue: out.inputValue }));

  // screenshot
  out.screenshot = await client.request("screenshot", { tabId, format: "png" });
  const shot = Buffer.from(out.screenshot?.base64 || "", "base64");
  const info = pngInfo(shot);
  const screenshotFile = saveArtifact("debugger-screenshot.png", shot);
  check(
    "screenshot：返回合法非空 PNG",
    info.signatureOk && info.width > 0 && info.height > 0 && shot.length > 1000 && out.screenshot?.screenshot?.possiblyStale === false,
    JSON.stringify({ bytes: shot.length, ...info, meta: out.screenshot?.screenshot, file: screenshotFile }),
  );

  // detach：释放后 chrome.debugger.sendCommand 必须失败；下一次命令自动重新 attach。
  out.detach = await client.request("detach", { tabId });
  out.detachEvents = await client.request("drainEvents", { methods: ["debugger.detachManual"], after_sequence: 0, limit: 200 });
  const detachEvent = (out.detachEvents.events || []).find((event) => event.args?.tabId === tabId);
  check("detach：命令释放 debugger 并记录事件", out.detach?.detached === true && out.detach?.wasAttached === true && Boolean(detachEvent), JSON.stringify({ detach: out.detach, events: out.detachEvents.events }));

  out.postDetachRaw = await evalInServiceWorker(
    chromePort,
    `(async()=>{try{await chrome.debugger.sendCommand({tabId:${tabId}},"Runtime.evaluate",{expression:"1"});return "unexpected-success";}catch(e){return "error:"+((e&&e.message)||e);}})()`,
  );
  check(
    "detach 后操作失败：chrome.debugger.sendCommand 报未 attach",
    typeof out.postDetachRaw === "string" && out.postDetachRaw.startsWith("error:") && /not attached/i.test(out.postDetachRaw),
    out.postDetachRaw,
  );

  out.reattach = await client.request("js", { expression: "1", tabId });
  check("detach 后下一次命令自动重新 attach", out.reattach?.value === 1, JSON.stringify(out.reattach));
  return out;
}

// ---------------------------------------------------------------- stage: SW restart
async function stopServiceWorkers(chromePort) {
  const cdp = await browserCdp(chromePort);
  try {
    try {
      await cdp.send("ServiceWorker.stopAllWorkers", {}, 15000);
      return { method: "ServiceWorker.stopAllWorkers" };
    } catch (error) {
      const targets = await cdp.send("Target.getTargets", {}, 15000);
      const sw = (targets?.targetInfos || []).find(
        (target) => target.type === "service_worker" && String(target.url).includes(EXTENSION_ID),
      );
      if (!sw) throw new Error("stopAllWorkers failed and no SW target to close: " + error.message);
      await cdp.send("Target.closeTarget", { targetId: sw.targetId }, 15000);
      return { method: "Target.closeTarget(fallback)", targetId: sw.targetId, stopError: error.message };
    }
  } finally {
    cdp.close();
  }
}

async function runSwRestart(client, fixture, chromePort) {
  const out = {};
  out.beforeSession = { port: client.port, pid: client.session.pid, updatedAt: client.session.updatedAt };
  out.beforeTabs = await client.request("list_tabs");
  out.beforeCapabilities = await client.request("host_capabilities");
  out.beforeEvents = await client.request("drainEvents", { after_sequence: 0, limit: 1 });

  out.stop = await stopServiceWorkers(chromePort);
  const gone = await waitForSwTargetGone(chromePort, 15000).catch(() => false);
  check("SW 已停止（target 消失）", gone, JSON.stringify(out.stop));

  // host 应在 native port 断开后退出（stdin EOF）。
  const deadDeadline = Date.now() + 30000;
  while (Date.now() < deadDeadline && pidAlive(out.beforeSession.pid)) await sleep(200);
  out.oldHostPidAlive = pidAlive(out.beforeSession.pid);
  check("SW 停止后旧 host 进程退出", !out.oldHostPidAlive, "pid " + out.beforeSession.pid);

  // 让 SW 起来：优先等 alarm（30s）；若太久，打开 popup 页面触发 runtime.sendMessage。
  // 关键：popup 必须开在独立窗口（newWindow），否则它会作为普通标签混进被测 Task Space，
  // 让“tab 列表恢复”断言出现假失败；唤醒后立即关闭它。
  let wokeBy = "alarm";
  let wakeTargetId;
  const wakeDeadline = Date.now() + 10000;
  let hasSw = false;
  while (Date.now() < wakeDeadline) {
    const targets = await listTargets(chromePort);
    if (targets.some((target) => target.type === "service_worker" && target.url.includes(EXTENSION_ID))) {
      hasSw = true;
      break;
    }
    await sleep(200);
  }
  if (!hasSw) {
    const cdp = await browserCdp(chromePort);
    try {
      const created = await cdp.send(
        "Target.createTarget",
        { url: "chrome-extension://" + EXTENSION_ID + "/popup/index.html", newWindow: true, background: true },
        15000,
      );
      wakeTargetId = created?.targetId;
      wokeBy = "popup";
    } finally {
      cdp.close();
    }
  }
  await waitForSwTarget(chromePort, 45000);
  out.wokeBy = wokeBy;
  if (wakeTargetId) {
    const cdp = await browserCdp(chromePort);
    try {
      await cdp.send("Target.closeTarget", { targetId: wakeTargetId }, 15000).catch(() => undefined);
    } finally {
      cdp.close();
    }
    await sleep(300);
  }

  const newSession = await waitForHostSession(baselineLocalAppData, { excludePid: out.beforeSession.pid, timeoutMs: 60000 });
  const newClient = new HostClient(newSession);
  out.afterSession = { port: newClient.port, pid: newSession.pid, updatedAt: newSession.updatedAt };
  out.readyAfter = await newClient.request("get_ready_state");
  out.pingAfter = await newClient.request("ping");
  out.capabilitiesAfter = await newClient.request("host_capabilities");
  out.tabsAfter = await newClient.request("list_tabs");

  check("host 重连：出现新的 host 进程/端口", newSession.pid !== out.beforeSession.pid && out.pingAfter?.pong === true, JSON.stringify(out.afterSession));
  check("重连后 get_ready_state 正常", out.readyAfter?.port === newClient.port && typeof out.readyAfter?.authToken === "string", JSON.stringify(redact(out.readyAfter)));
  check("能力重新探测（不是 not-probed）", out.capabilitiesAfter?.degradeReason !== "not-probed" && out.capabilitiesAfter?.mode === out.beforeCapabilities?.mode, JSON.stringify({ before: out.beforeCapabilities, after: out.capabilitiesAfter }));
  const beforeIds = (out.beforeTabs.tabs || []).map((tab) => tab.tabId).sort((a, b) => a - b);
  const afterIds = (out.tabsAfter.tabs || []).map((tab) => tab.tabId).sort((a, b) => a - b);
  check(
    "状态恢复：Task Space 与 tab 列表保持一致",
    out.tabsAfter.spaceId === out.beforeTabs.spaceId && JSON.stringify(beforeIds) === JSON.stringify(afterIds) && afterIds.length > 0,
    JSON.stringify({ before: { spaceId: out.beforeTabs.spaceId, ids: beforeIds }, after: { spaceId: out.tabsAfter.spaceId, ids: afterIds } }),
  );
  out.client = newClient;
  return out;
}

// ---------------------------------------------------------------- stage: generic
function findPlaywrightChromium() {
  if (process.env.BROWSERPILOT_PLAYWRIGHT_CHROMIUM) {
    return fs.existsSync(process.env.BROWSERPILOT_PLAYWRIGHT_CHROMIUM) ? process.env.BROWSERPILOT_PLAYWRIGHT_CHROMIUM : undefined;
  }
  const base = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs
    .readdirSync(base)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const dir of dirs) {
    for (const sub of ["chrome-win64", "chrome-win", "chrome-win32"]) {
      const exe = path.join(base, dir, sub, "chrome.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

async function runGeneric(fixture) {
  const out = {};
  const exe = findPlaywrightChromium();
  out.exe = exe;
  if (!exe) {
    out.skipped = "Playwright Chromium not found under %LOCALAPPDATA%\\ms-playwright";
    skipped++;
    console.log("SKIP | generic：Playwright Chromium 不可用（" + out.skipped + "），未执行；未伪造结果");
    return out;
  }
  const browser = await launchChrome({
    exe,
    profileDir: genericProfile,
    localAppData: genericLocalAppData,
    label: "generic",
    noSandbox: true, // 任务允许：第三方对照浏览器使用 --no-sandbox，已在 docs 标注
    initialUrl: fixture.url,  });
  out.chromePort = browser.port;
  out.logFile = browser.logFile;
  try {
    await waitForSwTarget(browser.port, 45000);
    let caps;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await evalInServiceWorker(
        browser.port,
        `(async()=>{const raw=await chrome.storage.session.get("browserpilot.state.v1");const s=raw["browserpilot.state.v1"]||{};return {caps:s.hostCapabilities||null,hostPort:s.hostPort||null};})()`,
      );
      if (state?.caps) {
        caps = state.caps;
        break;
      }
      await sleep(300);
    }
    out.capabilities = caps;
    check(
      "generic：能力探测 api-absent → generic、并发上限 1",
      caps?.mode === "generic" && caps?.degradeReason === "api-absent" && caps?.protocolVersion === 0 && caps?.maxConcurrentWindows === 1,
      JSON.stringify(caps),
    );
    const sessions = readSessions(genericLocalAppData).filter((session) => pidAlive(session.pid));
    check("generic：未连接 native host（隔离 LOCALAPPDATA 无 session）", sessions.length === 0, JSON.stringify(sessions.map((s) => ({ port: s.port, pid: s.pid }))));

    // 无崩溃：SW 仍能响应。
    out.alive = await evalInServiceWorker(browser.port, "1+1");
    check("generic：扩展 SW 未崩溃", out.alive === 2, String(out.alive));

    // 截图在 generic 下仍可用（直接经 SW 的 chrome.debugger，与增强模式共用同一内核能力）。
    out.screenshot = await evalInServiceWorker(
      browser.port,
      `(async()=>{
        const tabs=await chrome.tabs.query({});
        const tab=tabs.find(t=>t.url&&t.url.indexOf("http://127.0.0.1:")===0);
        if(!tab)return {error:"no fixture tab",tabs:tabs.map(t=>t.url)};
        await chrome.debugger.attach({tabId:tab.id},"1.3");
        try{
          const shot=await chrome.debugger.sendCommand({tabId:tab.id},"Page.captureScreenshot",{format:"png"});
          const data=(shot&&shot.data)||"";
          return {tabId:tab.id,len:data.length,head:data.slice(0,16)};
        } finally { await chrome.debugger.detach({tabId:tab.id}).catch(()=>{}); }
      })()`,
      60000,
    );
    check(
      "generic：截图仍可用（合法 PNG base64）",
      out.screenshot?.len > 1000 && String(out.screenshot?.head || "").startsWith("iVBORw0KGgo"),
      JSON.stringify(out.screenshot),
    );
    const targets = await listTargets(browser.port);
    check("generic：截图后 SW target 仍在", targets.some((target) => target.type === "service_worker" && target.url.includes(EXTENSION_ID)));
  } finally {
    browser.stop();
    await sleep(500);
  }
  return out;
}

// ---------------------------------------------------------------- main
const fixture = await startFixture();
const needsHost = STAGES.has("chain") || STAGES.has("debugger") || STAGES.has("sw");
const backupDir = path.join(runDir, "backup");
let hostExe;
let registration;
let baseline;
let baselineClient;
let chain;
let debuggerResult;
let swResult;

try {
  check("扩展 dist/ 已构建", fs.existsSync(path.join(DIST, "manifest.json")), DIST);

  if (needsHost) {
    try {
      hostExe = hostExePath();
    } catch {
      hostExe = undefined;
    }
    check("native host exe 存在", !!hostExe && fs.existsSync(hostExe), hostExe || "missing; run node scripts/build-host.mjs");
    if (!hostExe) throw new Error("native host exe missing; run node scripts/build-host.mjs");
    report.host = { exe: hostExe };

    const beforeValue = registryDefault("HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME);
    registration = registerHost(hostExe, backupDir);
    report.registration = {
      beforeValue,
      afterValue: registryDefault("HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME),
      backupFile: registration.backupFile,
      extensionId: registration.extensionId,
      manifestPath: registration.manifestPath,
      hostPath: registration.hostPath,
    };
    check("注册后 Chrome 键指向本次生成的 manifest", report.registration.afterValue === registration.manifestPath, JSON.stringify(report.registration));
    {
      const backup = JSON.parse(fs.readFileSync(registration.backupFile, "utf8"));
      const recorded = backup.targets?.[0];
      const expectedOld = beforeValue === "<missing>" ? null : beforeValue;
      check(
        "注册备份记录了旧值与键是否存在",
        recorded?.previousDefault === expectedOld && recorded?.keyExisted === (beforeValue !== "<missing>"),
        JSON.stringify(recorded),
      );
    }

    baseline = await launchChrome({
      exe: BASELINE_CHROME,
      profileDir: baselineProfile,
      localAppData: baselineLocalAppData,
      label: "baseline",
      noSandbox: false, // 基线 Browser CLI：不使用 --no-sandbox
    });
    check("基线 Chrome 已启动（独立 profile）", baseline.port > 0, JSON.stringify({ port: baseline.port, log: baseline.logFile }));
    await waitForSwTarget(baseline.port, 60000);
    check("扩展 SW 已加载（固定 ID）", true);

    const session = await waitForHostSession(baselineLocalAppData, { timeoutMs: 60000 });
    const exePath = processExecutablePath(session.pid);
    report.host.session = { port: session.port, pid: session.pid, file: session.file };
    report.host.processExecutablePath = exePath;
    check(
      "connectNative 拉起真实 host 进程（exe 路径匹配）",
      exePath && path.resolve(exePath).toLowerCase() === path.resolve(hostExe).toLowerCase(),
      JSON.stringify({ pid: session.pid, exePath, expected: hostExe }),
    );
    baselineClient = new HostClient(session);

    if (STAGES.has("chain")) {
      chain = await runChain(baselineClient, fixture);
      report.chain = chain;
      saveArtifact("chain.json", chain);
    }

    if (STAGES.has("debugger")) {
      const chainData = chain || (await runChain(baselineClient, fixture));
      debuggerResult = await runDebugger(baselineClient, chainData, baseline.port);
      report.debugger = debuggerResult;
      saveArtifact("debugger.json", debuggerResult);
    }

    if (STAGES.has("sw")) {
      swResult = await runSwRestart(baselineClient, fixture, baseline.port);
      report.swRestart = swResult;
      saveArtifact("sw-restart.json", swResult);
    }
  }

  if (STAGES.has("generic")) {
    report.generic = await runGeneric(fixture);
    saveArtifact("generic.json", report.generic);
  }
} catch (error) {
  failed++;
  failures.push("unexpected exception");
  console.error("FAIL | unexpected exception :: " + (error instanceof Error ? error.stack : String(error)));
} finally {
  try {
    if (baseline) {
      const stopped = baseline.stop();
      if (stopped && stopped.refused) {
        console.error("[e2e] baseline cleanup refused: " + JSON.stringify(stopped.detail));
      }
    }
  } catch (error) {
    console.error("[e2e] baseline cleanup error: " + (error instanceof Error ? error.message : String(error)));
  }
  await sleep(800);
  // 确保测试 host 进程已随 Chrome 退出。只清理 exe 路径等于本次构建产物的 PID；
  // 路径不匹配就拒绝，绝不按镜像名或裸 PID 清理。
  if (hostExe) {
    const ownSessions = readSessions(baselineLocalAppData);
    for (const session of ownSessions) {
      if (!pidAlive(session.pid)) continue;
      const stopped = stopVerifiedPid({
        pid: session.pid,
        expectedExePath: hostExe,
        reason: "test-native-e2e.host-session",
      });
      if (!stopped.stopped && stopped.reason !== "already-exited") {
        console.error("[e2e] host session cleanup not stopped: " + JSON.stringify(stopped));
      }
    }
  }
  try {
    if (registration) {
      const rollback = rollbackHost(registration.backupFile);
      const afterRollback = registryDefault("HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME);
      report.registration.rollback = {
        result: rollback,
        afterRollback,
        expected: report.registration.beforeValue,
      };
      check("回滚后 Chrome 键恢复测试前值", afterRollback === report.registration.beforeValue, JSON.stringify({ afterRollback, expected: report.registration.beforeValue }));
    }
  } catch (error) {
    failed++;
    failures.push("rollback failed");
    console.error("FAIL | rollback failed :: " + (error instanceof Error ? error.message : String(error)));
  }
  try {
    fixture.server.close();
  } catch {}
  for (const record of chromeRecords) {
    const stopped = stopTestProcess(record, { reason: "test-native-e2e.finally" });
    if (!stopped.stopped && stopped.reason !== "already-exited") {
      console.error("[e2e] chrome cleanup not stopped: " + JSON.stringify(stopped));
    }
  }
  report.checks = { passed, failed, skipped, failures: [...failures] };
  saveArtifact("report.json", report);
  console.log("\nartifacts -> " + artifactsDir);
  console.log(`\n${passed}/${passed + failed} passed${skipped ? ", " + skipped + " skipped" : ""}`);
  if (failures.length) console.log("failed: " + failures.join("; "));
  if (!KEEP) {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(failed ? 1 : 0);
}
