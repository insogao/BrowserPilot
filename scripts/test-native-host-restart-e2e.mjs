// Real BrowserPilot Native Messaging Host restart E2E (Windows).
//
// Scope (RC host lifecycle):
//   - normal host exit (native-port EOF after the extension SW stops);
//   - unexpected host termination (verified PID taskkill; SW stays alive);
//   - host/SW restart interleaving;
//   - in-flight requests when the connection dies (explicit HOST_DISCONNECTED, never hang);
//   - reconnect handshake (new host instance id + fresh per-connection authorization);
//   - old TCP connections and old per-connection authorizations are dead after restart;
//   - stale results from the previous host instance can never be routed to a new request
//     (host-instance id in internal request ids);
//   - reconnect does not resurrect user-owned spaces, expired ASSIST grants, or stale
//     agent activity;
//   - no duplicate host processes, no leaked TCP connections, bounded host handles;
//   - both normal and agent/managed Browser CLI sessions resume product commands after
//     a host restart.
//
// Requirements from AGENTS.md:
//   - isolated --user-data-dir per browser, isolated LOCALAPPDATA for host sessions;
//   - no --no-sandbox / --headless; never touch the real Chrome profile;
//   - only verified PID + creation time/exe path + marker cleanup; no image-name kill;
//   - HKCU native-host registration is backed up and restored in finally.
//
// Usage:
//   node scripts/test-native-host-restart-e2e.mjs
//   node scripts/test-native-host-restart-e2e.mjs --mode=normal
//   node scripts/test-native-host-restart-e2e.mjs --mode=agent --no-build
//   node scripts/test-native-host-restart-e2e.mjs --skip-expired-grant
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extensionIdFromRepo, findNewestHostExe } from "./lib/host-manifest.mjs";
import { launchTestProcess, stopTestProcess, stopVerifiedPid, queryProcess } from "./lib/test-process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(root, "dist");
const REGISTER_PS1 = path.join(root, "native-host", "register.ps1");
const UNREGISTER_PS1 = path.join(root, "native-host", "unregister.ps1");
const HOST_NAME = "com.browserpilot.browseragent";
const REGISTRY_KEY = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME;
// Chromium-branded Browser CLI builds read HKCU\Software\Chromium\NativeMessagingHosts
// first (launch_context_win.cc) and only fall back to the Google Chrome key. WinRelease
// is Chromium-branded, so a Chrome-only registration is not enough and can be shadowed
// by another test's Chromium-key manifest with a different extension id.
const CHROMIUM_REGISTRY_KEY = "HKCU:\\Software\\Chromium\\NativeMessagingHosts\\" + HOST_NAME;
const REGISTRY_KEYS = [REGISTRY_KEY, CHROMIUM_REGISTRY_KEY];
const CHROME = process.env.BROWSERPILOT_PATCHED_CHROME || "D:\\c\\src\\out\\WinRelease\\chrome.exe";
const EXTENSION_ID = extensionIdFromRepo(root);
const FEATURE = "InputOwnershipEnforcement";
const AGENT_ID = "host-restart-agent";
const OTHER_AGENT_ID = "host-restart-other";

const argv = process.argv.slice(2);
const NO_BUILD = argv.includes("--no-build");
const SKIP_EXPIRED_GRANT = argv.includes("--skip-expired-grant");
const LONGRUN = argv.includes("--longrun");
const MODE_ARG = (argv.find((a) => a.startsWith("--mode=")) || "").slice("--mode=".length).trim();
const MODES = (MODE_ARG || "normal,agent").split(",").map((s) => s.trim()).filter(Boolean);
const GRANT_WAIT_MS = Math.max(2000, Number((argv.find((a) => a.startsWith("--grant-wait-ms=")) || "").slice("--grant-wait-ms=".length) || 62000));
const DURATION_SEC = Math.max(60, Number((argv.find((a) => a.startsWith("--duration=")) || "").slice("--duration=".length) || 1200));
const RESTART_AT_SEC = Math.max(30, Math.min(DURATION_SEC - 60, Number((argv.find((a) => a.startsWith("--restart-at=")) || "").slice("--restart-at=".length) || 600)));
const SAMPLE_INTERVAL_SEC = Math.max(5, Number((argv.find((a) => a.startsWith("--sample-interval=")) || "").slice("--sample-interval=".length) || 15));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- report
let passed = 0;
let failed = 0;
const failures = [];
const checkLog = [];
function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  if (ok) passed++;
  else {
    failed++;
    failures.push(name);
  }
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  checkLog.push({ name, ok, detail: String(text).slice(0, 6000) });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (ok || !text ? "" : " :: " + String(text).slice(0, 2000)));
  return ok;
}

const runId = nowIso().replace(/[:.]/g, "-");
const runStartedMs = Date.now();
const runDir = path.join(root, ".e2e-tmp", "host-restart-" + runId);
const artifactsDir = path.join(runDir, "artifacts");
const backupDir = path.join(runDir, "registry-backup");
fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
const report = {
  test: "browserpilot-native-host-restart-e2e",
  startedAt: nowIso(),
  finishedAt: null,
  verdict: "BLOCKED",
  runDir,
  chrome: CHROME,
  extensionId: EXTENSION_ID,
  hostExe: null,
  modes: MODES,
  registration: null,
  sessions: [],
  scenarios: [],
  checks: null,
  cleanup: null,
};
function saveArtifact(name, data) {
  const file = path.join(artifactsDir, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", "utf8");
  return file;
}

// ---------------------------------------------------------------- powershell helpers
function runPowerShell(script, timeoutMs = 30000) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}
function runPowerShellFile(file, args) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
  });
  const lastLine = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  let json;
  try { json = lastLine ? JSON.parse(lastLine) : undefined; } catch { json = undefined; }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}
function registryDefault(keyPath) {
  const script =
    "$k='" + keyPath.replace(/'/g, "''") + "';" +
    "if (Test-Path -LiteralPath $k) { $i=Get-Item -LiteralPath $k; if (@($i.GetValueNames()) -contains '') { $v=$i.GetValue('', $null); if ($null -eq $v) { '' } else { [string]$v } } else { '<no-default>' } } else { '<missing>' }";
  return runPowerShell(script).stdout;
}
function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
function processExecutablePath(pid) {
  return runPowerShell("(Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(pid) + "').ExecutablePath").stdout;
}
function processStats(pid) {
  const text = runPowerShell(
    "$p=Get-Process -Id " + Number(pid) + " -ErrorAction SilentlyContinue; if ($p) { $p | Select-Object Id,HandleCount,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress }",
  ).stdout;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text.split(/\r?\n/).pop());
    return { pid: Number(parsed.Id), handleCount: Number(parsed.HandleCount), workingSet: Number(parsed.WorkingSet64), privateBytes: Number(parsed.PrivateMemorySize64) };
  } catch {
    return undefined;
  }
}
function tcpEstablishedCount(pid) {
  const text = runPowerShell(
    "$c=@(Get-NetTCPConnection -OwningProcess " + Number(pid) + " -State Established -ErrorAction SilentlyContinue); $c.Count",
  ).stdout;
  const n = Number(text.split(/\r?\n/).filter(Boolean).pop());
  return Number.isFinite(n) ? n : -1;
}
/**
 * Host processes started by this test run. Identity is the exact absolute exe path
 * (unique to this worktree/build) plus a creation time no older than the run start.
 * This never uses an image-name query and never touches user Chrome/ZCode processes.
 */
function wmiDateMs(value) {
  const match = String(value || "").match(/\/Date\((\d+)\)\//);
  if (match) return Number(match[1]);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}
function listHostProcesses(hostExe) {
  const exe = String(hostExe).replace(/'/g, "''");
  const script =
    "$exe='" + exe + "';" +
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const text = runPowerShell(script).stdout;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        pid: Number(row.ProcessId),
        parentPid: Number(row.ParentProcessId),
        creationTime: String(row.CreationDate || ""),
        creationMs: wmiDateMs(row.CreationDate),
        exePath: String(row.ExecutablePath || ""),
        commandLine: String(row.CommandLine || ""),
      }))
      .filter((row) => path.resolve(row.exePath).toLowerCase() === path.resolve(hostExe).toLowerCase())
      .filter((row) => row.creationMs === undefined || row.creationMs >= runStartedMs - 60000);
  } catch {
    return [];
  }
}
function childProcesses(parentPid) {
  const text = runPowerShell(
    "Get-CimInstance Win32_Process -Filter 'ParentProcessId = " + Number(parentPid) + "' | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
  ).stdout;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- fixture / CDP
function startFixture() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>BrowserPilot Host Restart Fixture</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#eef;color:#123}main{padding:32px}
#out{font-size:22px;color:#064}</style></head>
<body><main><h1 id="h">BrowserPilot Host Restart Fixture</h1>
<button id="btn" onclick="document.getElementById('out').textContent='clicked';document.body.dataset.clicked='1'">Click me</button>
<input id="name" aria-label="name" />
<div id="out">initial</div></main></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, url: "http://127.0.0.1:" + server.address().port + "/" }));
  });
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
async function waitForSwTarget(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    const sw = targets.find((target) => target.type === "service_worker" && target.url.includes(EXTENSION_ID));
    if (sw) return sw;
    await sleep(150);
  }
  throw new Error("timed out waiting for extension service worker (port " + port + ")");
}
async function waitForDevToolsPort(profileDir, child, timeoutMs = 60000) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("browser exited early (code " + child.exitCode + ")");
    if (fs.existsSync(file)) {
      const port = Number(fs.readFileSync(file, "utf8").trim().split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await sleep(120);
  }
  throw new Error("timed out waiting for DevToolsActivePort: " + file);
}

class CdpConnection {
  static async connect(url, timeoutMs = 15000) {
    if (typeof WebSocket === "undefined") throw new Error("Node.js global WebSocket is required");
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
async function evalInServiceWorker(chromePort, expression, timeoutMs = 30000) {
  const sw = await waitForSwTarget(chromePort, timeoutMs);
  const cdp = await CdpConnection.connect(sw.webSocketDebuggerUrl);
  try {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, timeoutMs);
    if (result?.exceptionDetails) throw new Error("SW evaluate error: " + JSON.stringify(result.exceptionDetails).slice(0, 800));
    return result?.result?.value;
  } finally {
    cdp.close();
  }
}
function stateFromSw(chromePort) {
  return evalInServiceWorker(
    chromePort,
    `(async()=>{const raw=await chrome.storage.session.get("browserpilot.state.v1");return raw["browserpilot.state.v1"]||{};})()`,
  );
}
async function stopServiceWorkers(chromePort) {
  const cdp = await browserCdp(chromePort);
  try {
    try {
      await cdp.send("ServiceWorker.stopAllWorkers", {}, 15000);
      return { method: "ServiceWorker.stopAllWorkers" };
    } catch (error) {
      const targets = await cdp.send("Target.getTargets", {}, 15000);
      const sw = (targets?.targetInfos || []).find((target) => target.type === "service_worker" && String(target.url).includes(EXTENSION_ID));
      if (!sw) throw new Error("stopAllWorkers failed and no SW target: " + error.message);
      await cdp.send("Target.closeTarget", { targetId: sw.targetId }, 15000);
      return { method: "Target.closeTarget(fallback)", targetId: sw.targetId, stopError: error.message };
    }
  } finally {
    cdp.close();
  }
}
async function waitForSwGone(chromePort, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(chromePort);
    if (!targets.some((target) => target.type === "service_worker" && target.url.includes(EXTENSION_ID))) return true;
    await sleep(150);
  }
  return false;
}
/**
 * Wake a stopped MV3 worker through a real extension page (popup). The popup is opened
 * in its own background window and closed after the worker/host are back.
 */
async function wakeServiceWorker(chromePort) {
  let targetId;
  const cdp = await browserCdp(chromePort);
  try {
    const created = await cdp.send("Target.createTarget", {
      url: "chrome-extension://" + EXTENSION_ID + "/popup/index.html",
      newWindow: true,
      background: true,
    }, 20000);
    targetId = created?.targetId;
  } finally {
    cdp.close();
  }
  await waitForSwTarget(chromePort, 60000);
  if (targetId) {
    const closeCdp = await browserCdp(chromePort);
    try {
      await closeCdp.send("Target.closeTarget", { targetId }, 15000).catch(() => undefined);
    } finally {
      closeCdp.close();
    }
    await sleep(300);
  }
  return { targetId };
}

// ---------------------------------------------------------------- host discovery / clients
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
      // ignore partial writes
    }
  }
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
async function waitForHostSession(localAppData, { timeoutMs = 90000, excludePid, instanceIdNot } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = readSessions(localAppData).filter((session) =>
      pidAlive(session.pid) &&
      Date.now() - Number(session.updatedAt || 0) < 120000 &&
      (excludePid === undefined || session.pid !== excludePid) &&
      (!instanceIdNot || session.instanceId !== instanceIdNot));
    if (candidates.length) return candidates[0];
    await sleep(120);
  }
  throw new Error("timed out waiting for a live native host session in " + sessionsDirFor(localAppData));
}

function sessionBrief(session) {
  if (!session) return session;
  return {
    pid: session.pid,
    port: session.port,
    instanceId: session.instanceId,
    updatedAt: session.updatedAt,
    file: session.file,
  };
}
class HostDisconnectedError extends Error {
  constructor(detail) {
    super("host_disconnected: " + detail);
    this.name = "HostDisconnectedError";
    this.code = "HOST_DISCONNECTED";
    this.detail = detail;
  }
}

/**
 * Persistent external-AI client. Every pending request settles on socket error/close
 * with an explicit HOST_DISCONNECTED error (the desktop client must never hang).
 */
class HostClient {
  constructor(port, authToken, agentId = AGENT_ID) {
    this.port = port;
    this.authToken = authToken;
    this.agentId = agentId;
    this.socket = net.createConnection({ host: "127.0.0.1", port });
    this.buf = "";
    this.pending = new Map();
    this.events = [];
    this.closed = false;
    this.closeInfo = null;
    this.connected = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === "result" && this.pending.has(message.requestId)) {
          const entry = this.pending.get(message.requestId);
          this.pending.delete(message.requestId);
          clearTimeout(entry.timer);
          entry.resolve(message);
        } else if (message.type === "event") {
          this.events.push(message);
        }
      }
    });
    const fail = (reason) => {
      if (this.closed) return;
      this.closed = true;
      this.closedAt = Date.now();
      this.closeInfo = reason;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new HostDisconnectedError(reason));
      }
      this.pending.clear();
    };
    this.socket.on("end", () => fail("socket end"));
    this.socket.on("close", () => fail("socket close"));
    this.socket.on("error", (error) => fail("socket error: " + error.message));
  }
  async request(name, args = {}, { requestId, timeoutMs = 60000, authenticate = true, space } = {}) {
    await this.connected;
    const id = requestId || "hr-" + Math.random().toString(36).slice(2, 10);
    if (this.closed) throw new HostDisconnectedError(this.closeInfo || "already closed");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(name + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { type: "command", name, args, requestId: id, agentId: this.agentId };
      if (typeof space === "string" && space) payload.space = space;
      if (authenticate) payload.authToken = this.authToken;
      try {
        this.socket.write(JSON.stringify(payload) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HostDisconnectedError("write failed: " + error.message));
      }
    });
  }
  async requestOk(name, args = {}, options = {}) {
    const result = await this.request(name, args, options);
    if (result.ok !== true) {
      const error = new Error(name + " failed: " + (result.error || "unknown"));
      error.code = result.errorCode;
      throw error;
    }
    return result.data;
  }
  close() {
    try { this.socket.destroy(); } catch {}
  }
}

function oneShot(port, authToken, name, args = {}, { agentId = AGENT_ID, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const requestId = "oneshot-" + Math.random().toString(36).slice(2, 10);
    let buf = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "one_shot_timeout" }), timeoutMs);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "command", name, args, requestId, agentId, ...(authToken ? { authToken } : {}) }) + "\n");
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === "result" && message.requestId === requestId) {
          clearTimeout(timer);
          finish(message);
          return;
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: "host_disconnected", errorCode: "HOST_DISCONNECTED", detail: error.message });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      finish({ ok: false, error: "host_disconnected", errorCode: "HOST_DISCONNECTED", detail: "socket closed" });
    });
  });
}

// ---------------------------------------------------------------- registration
function manifestPathForRepo() {
  return path.join(root, "native-host", "host.manifest.json");
}
function looksLikeOurManifest(value) {
  if (!value || value.startsWith("<")) return false;
  try {
    return path.resolve(String(value)).toLowerCase() === path.resolve(manifestPathForRepo()).toLowerCase();
  } catch {
    return false;
  }
}
/** Find the newest backup that recorded a non-our previous default for a registry key. */
function findOriginalRegistryValue(registryKey) {
  const candidates = [];
  const roots = [path.join(root, ".e2e-tmp"), path.join(root, "native-host", "backup")];
  const visit = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
        const target = (parsed.targets || []).find((item) => item.registryPath === registryKey);
        const previous = target?.previousDefault;
        if (typeof previous === "string" && previous && !looksLikeOurManifest(previous)) {
          candidates.push({ value: previous, createdAt: String(parsed.createdAt || ""), file: full });
        }
      } catch {
        // ignore partial/non-backup json
      }
    }
  };
  for (const base of roots) visit(base, 0);
  // Earliest backup is the closest to the user's pre-test value.
  return candidates.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
}
function setRegistryDefault(value, registryKey = REGISTRY_KEY) {
  const escaped = String(value).replace(/'/g, "''");
  const keyPath = String(registryKey).replace(/^HKCU:\\/i, "").replace(/'/g, "''");
  const script =
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('" + keyPath + "',$true);" +
    "if (-not $k) { throw 'registry key missing' };" +
    "try { $k.SetValue('','" + escaped + "',[Microsoft.Win32.RegistryValueKind]::String) } finally { $k.Close() }";
  const result = runPowerShell(script);
  if (result.status !== 0) throw new Error("failed to restore registry default: " + (result.stderr || result.stdout));
}
function registerHost(hostExe) {
  const observedBeforeValues = {};
  const restoreValues = {};
  const recoveredFrom = {};
  for (const key of REGISTRY_KEYS) {
    const observed = registryDefault(key);
    observedBeforeValues[key] = observed;
    restoreValues[key] = observed;
    if (looksLikeOurManifest(observed)) {
      const original = findOriginalRegistryValue(key);
      check(
        "检测到 " + key + " 上残留的本仓库 manifest，并从历史备份恢复用户原值",
        !!original,
        JSON.stringify({ key, observed, original }),
      );
      if (!original) {
        throw new Error(key + " is stuck on this repo's host.manifest.json and no original backup was found; refusing to run");
      }
      restoreValues[key] = original.value;
      recoveredFrom[key] = original.file;
      setRegistryDefault(original.value, key);
      check("残留修复后 " + key + " 指向用户原值", registryDefault(key) === original.value, JSON.stringify({ key, restoreTarget: original.value, recoveredFrom: original.file }));
    }
  }
  const result = runPowerShellFile(REGISTER_PS1, ["-HostPath", hostExe, "-BackupDir", backupDir, "-IncludeChromium"]);
  if (result.status !== 0 || !result.json?.ok) {
    throw new Error("register.ps1 failed: " + (result.stderr || result.stdout));
  }
  const afterValues = {};
  for (const key of REGISTRY_KEYS) afterValues[key] = registryDefault(key);
  report.registration = {
    registryKeys: REGISTRY_KEYS,
    observedBeforeValues,
    recoveredFrom,
    beforeValues: restoreValues,
    beforeValue: restoreValues[REGISTRY_KEY],
    afterValues,
    afterValue: afterValues[REGISTRY_KEY],
    manifestPath: result.json.manifestPath,
    hostPath: result.json.hostPath,
    extensionId: result.json.extensionId,
    backupFile: result.json.backupFile,
  };
  check("register.ps1 注册成功（Chrome + Chromium 键都指向本次 manifest）", REGISTRY_KEYS.every((key) => afterValues[key] === result.json.manifestPath), JSON.stringify(report.registration));
  check("注册扩展 ID 与仓库 manifest key 推导一致", result.json.extensionId === EXTENSION_ID, JSON.stringify({ registered: result.json.extensionId, derived: EXTENSION_ID }));
  if (!REGISTRY_KEYS.every((key) => afterValues[key] === result.json.manifestPath)) throw new Error("registry does not point at the generated manifest");
  return result.json;
}
function rollbackHost(backupFile, expectedValues) {
  if (!backupFile) return undefined;
  const result = runPowerShellFile(UNREGISTER_PS1, ["-BackupFile", backupFile]);
  const after = {};
  for (const key of REGISTRY_KEYS) after[key] = registryDefault(key);
  const expected = typeof expectedValues === "string" ? { [REGISTRY_KEY]: expectedValues } : expectedValues;
  const restored = REGISTRY_KEYS.every((key) => !(key in expected) || after[key] === expected[key]);
  check("unregister.ps1 恢复测试前 HKCU 值（Chrome + Chromium）", result.status === 0 && result.json?.ok === true && restored, JSON.stringify({ result: result.json, after, expected }));
  return { result, after, expected };
}

// ---------------------------------------------------------------- browser launch
const browserRecords = new Set();
async function launchBrowser(mode, fixture) {
  const profileDir = path.join(runDir, "profile-" + mode + "-" + Math.random().toString(36).slice(2, 8));
  const localAppData = path.join(runDir, "localappdata-" + mode + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const logFile = path.join(artifactsDir, "chrome-" + mode + ".log");
  const common = [
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
    "--enable-logging=stderr",
    "--v=0",
  ];
  const args = mode === "agent"
    ? [...common, "--enable-features=" + FEATURE + ",NetworkServiceSandbox", "--browser-cli-background-presentation", "about:blank"]
    : [...common, "--enable-features=NetworkServiceSandbox", "about:blank"];
  const basePort = 49000 + Math.floor(Math.random() * 500);
  const record = launchTestProcess({
    exe: CHROME,
    args,
    env: { ...process.env, LOCALAPPDATA: localAppData, BROWSERPILOT_HOST_BASE_PORT: String(basePort) },
    marker: profileDir,
    label: "host-restart-" + mode,
    stdio: ["ignore", "pipe", "pipe"],
  });
  browserRecords.add(record);
  const child = record.child;
  let stderr = "";
  const log = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.on("data", (data) => log.write(data));
  child.stderr.on("data", (data) => {
    stderr += data;
    if (stderr.length > 500000) stderr = stderr.slice(-500000);
    log.write(data);
  });
  child.on("exit", (code) => {
    browserRecords.delete(record);
    log.write("\n[exit] code=" + code + "\n");
    log.end();
  });
  const devtoolsPort = await waitForDevToolsPort(profileDir, child);
  const browser = {
    mode,
    record,
    child,
    browserPid: record.pid,
    port: devtoolsPort,
    profileDir,
    localAppData,
    basePort,
    logFile,
    args,
    stderrTail: () => stderr.split(/\r?\n/).slice(-20).join("\n"),
    stop: () => stopTestProcess(record, { reason: "host-restart-e2e.browser" }),
  };
  check("[" + mode + "] WinRelease 浏览器已启动（隔离 profile）", child.pid > 0 && devtoolsPort > 0, JSON.stringify({ pid: child.pid, devtoolsPort, profileDir }));
  check("[" + mode + "] 启动参数无 --no-sandbox / --headless", !args.some((a) => /^--no-sandbox$/i.test(a) || /^--headless/i.test(a)), JSON.stringify(args));
  await waitForSwTarget(devtoolsPort, 90000);
  check("[" + mode + "] 扩展 SW 已加载", true);
  return browser;
}

function browserPidsFor(browser) {
  return [browser.browserPid];
}

function hostEvidence(ctx, label) {
  const session = ctx.session;
  const stats = processStats(session.pid);
  const hosts = listHostProcesses(ctx.hostExe);
  const hostRow = hosts.find((row) => row.pid === session.pid);
  return {
    label,
    pid: session.pid,
    port: session.port,
    instanceId: session.instanceId,
    sessionFile: session.file,
    exePath: processExecutablePath(session.pid),
    parentPid: hostRow?.parentPid,
    hostCount: hosts.length,
    allHostPids: hosts.map((row) => row.pid),
    handleCount: stats?.handleCount,
    workingSet: stats?.workingSet,
    privateBytes: stats?.privateBytes,
    tcpEstablished: tcpEstablishedCount(session.pid),
    liveSessions: readSessions(ctx.browser.localAppData).filter((s) => pidAlive(s.pid)).map((s) => ({ pid: s.pid, port: s.port, instanceId: s.instanceId })),
  };
}

function assertSingleHost(ctx, label, expectedPid) {
  const hosts = listHostProcesses(ctx.hostExe);
  const liveSessions = readSessions(ctx.browser.localAppData).filter((s) => pidAlive(s.pid)).map(sessionBrief);
  check("[" + ctx.mode + "] " + label + "：唯一 host 进程", hosts.length === 1 && hosts[0].pid === expectedPid, JSON.stringify({ hosts, expectedPid }));
  check("[" + ctx.mode + "] " + label + "：唯一存活 host session", liveSessions.length === 1 && liveSessions[0].pid === expectedPid, JSON.stringify(liveSessions));
  const parentExe = hosts[0]?.parentPid ? processExecutablePath(hosts[0].parentPid) : "";
  // Chrome may launch native hosts through an intermediate console host, so the
  // immediate parent is evidence, not identity. Identity is the exact exe path +
  // creation time + the native-messaging command line for this extension.
  check(
    "[" + ctx.mode + "] " + label + "：host 命令行是本扩展的 native messaging host",
    typeof hosts[0]?.commandLine === "string" &&
      hosts[0].commandLine.includes("chrome-extension://" + EXTENSION_ID + "/") &&
      /--parent-window=/.test(hosts[0].commandLine),
    JSON.stringify({ hosts, parentExe, browserPid: ctx.browser.browserPid }),
  );
  return { hosts, liveSessions, parentExe };
}

async function waitForPidGone(pid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

function killHostVerified(ctx, label, session = ctx.session) {
  const old = session;
  const startedAt = Date.now();
  const stop = stopVerifiedPid({ pid: old.pid, expectedExePath: ctx.hostExe, reason: "host-restart-e2e." + label });
  const finishedAt = Date.now();
  check("[" + ctx.mode + "] " + label + "：验证式终止 host PID " + old.pid, stop.stopped === true && stop.refused !== true, JSON.stringify(stop));
  if (!stop.stopped && stop.reason !== "already-exited") throw new Error("verified host kill failed: " + JSON.stringify(stop));
  return { ...stop, startedAt, finishedAt, killMs: finishedAt - startedAt };
}

async function waitForNextHost(ctx, oldSession, label) {
  const started = Date.now();
  const next = await waitForHostSession(ctx.browser.localAppData, {
    excludePid: oldSession.pid,
    instanceIdNot: oldSession.instanceId,
    timeoutMs: 90000,
  });
  const exePath = processExecutablePath(next.pid);
  check("[" + ctx.mode + "] " + label + "：新 host 使用本轮构建的 exe", path.resolve(exePath).toLowerCase() === path.resolve(ctx.hostExe).toLowerCase(), JSON.stringify({ pid: next.pid, exePath, expected: ctx.hostExe }));
  check("[" + ctx.mode + "] " + label + "：新 host instanceId 与旧实例不同", typeof next.instanceId === "string" && next.instanceId !== oldSession.instanceId, JSON.stringify({ old: oldSession.instanceId, next: next.instanceId }));
  await sleep(250);
  assertSingleHost(ctx, label, next.pid);
  return { ...next, reconnectMs: Date.now() - started };
}

async function attachClient(ctx, session, agentId = AGENT_ID) {
  const client = new HostClient(session.port, session.authToken, agentId);
  await client.connected;
  return client;
}

async function hardRestart(ctx, label) {
  const old = ctx.session;
  const oldClient = ctx.client;
  const before = hostEvidence(ctx, label + "-before");
  const stop = killHostVerified(ctx, label);
  const gone = await waitForPidGone(old.pid, 30000);
  check("[" + ctx.mode + "] " + label + "：旧 host PID 已退出", gone, JSON.stringify({ pid: old.pid }));
  check("[" + ctx.mode + "] " + label + "：旧 TCP 连接已关闭", oldClient.closed === true, JSON.stringify({ closeInfo: oldClient.closeInfo }));
  const next = await waitForNextHost(ctx, old, label);
  const client = await attachClient(ctx, next);
  ctx.session = next;
  ctx.client = client;
  const after = hostEvidence(ctx, label + "-after");
  return { before, after, stop, next, client, oldClient };
}

// ---------------------------------------------------------------- popup control (real user entry)
async function waitForTarget(chromePort, targetId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = (await listTargets(chromePort)).find((item) => item.id === targetId);
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(120);
  }
  throw new Error("timed out waiting for target " + targetId);
}
async function openPopup(ctx) {
  if (ctx.popup?.cdp) return ctx.popup;
  const browser = await browserCdp(ctx.browser.port);
  let created;
  try {
    created = await browser.send("Target.createTarget", {
      url: "chrome-extension://" + EXTENSION_ID + "/popup/index.html",
      newWindow: true,
      background: true,
    }, 20000);
  } finally {
    browser.close();
  }
  const target = await waitForTarget(ctx.browser.port, created.targetId);
  const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ready = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, 10000);
    if (ready?.result?.value === "complete") break;
    await sleep(150);
  }
  ctx.popup = { targetId: created.targetId, cdp };
  return ctx.popup;
}
async function popupSend(ctx, kind, spaceId) {
  const popup = await openPopup(ctx);
  const expression = "chrome.runtime.sendMessage(" + JSON.stringify({ kind, spaceId }) + ")";
  const result = await popup.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30000);
  if (result?.exceptionDetails) {
    throw new Error("popup " + kind + " exception: " + JSON.stringify(result.exceptionDetails).slice(0, 800));
  }
  return result?.result?.value;
}
async function closePopup(ctx) {
  if (!ctx.popup) return;
  const { targetId, cdp } = ctx.popup;
  ctx.popup = undefined;
  try { cdp.close(); } catch {}
  const browser = await browserCdp(ctx.browser.port);
  try { await browser.send("Target.closeTarget", { targetId }, 15000).catch(() => undefined); } finally { browser.close(); }
}

async function waitUntil(fn, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return Boolean(fn());
}
async function waitForState(chromePort, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await stateFromSw(chromePort); } catch { last = undefined; }
    if (last && predicate(last)) return last;
    await sleep(200);
  }
  return last;
}
function inputErrorCode(result) {
  return result?.errorCode || result?.error_code || (typeof result?.error === "string" && /INPUT_[A-Z_]+/.test(result.error) ? (result.error.match(/INPUT_[A-Z_]+/) || [])[0] : undefined);
}

// ---------------------------------------------------------------- scenario 1: unexpected kill + reconnect
async function scenarioUnexpectedKill(ctx, modeReport) {
  const scenario = { name: "unexpected-host-kill", startedAt: nowIso(), checks: {}, evidence: {} };
  modeReport.scenarios.push(scenario);
  const oldSession = ctx.session;
  const oldReady = ctx.ready;
  const oldClient = ctx.client;

  await ctx.client.requestOk("claim_space", {}, { space: ctx.space.spaceId });
  const statusAgent = await ctx.client.requestOk("input_status", {}, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] 基线 input_status 为 AI/agent", statusAgent.mode === "ai" && statusAgent.ownership === "agent", JSON.stringify(statusAgent));

  // Start the in-flight command while the space is still AI-owned: waitForTimeout
  // resolves its target at dispatch time and then sleeps, so the subsequent handoff
  // does not abort it. This keeps a genuinely pending host request when we kill the host.
  const t0 = Date.now();
  const inflight = ctx.client.request("waitForTimeout", { ms: 30000, tabId: ctx.space.tabId }, {
    requestId: "unexpected-inflight",
    timeoutMs: 45000,
    space: ctx.space.spaceId,
  }).then((result) => ({ result, at: Date.now() })).catch((error) => ({ error, at: Date.now() }));
  await sleep(700);

  // A human-owned space must stay human across the host restart.
  await ctx.client.requestOk("handoff_space", {}, { space: ctx.space.spaceId });
  const statusHuman = await ctx.client.requestOk("input_status", {}, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] handoff 后 ownership=user（HUMAN）", statusHuman.mode === "human" && statusHuman.ownership === "user", JSON.stringify(statusHuman));

  const before = hostEvidence(ctx, "unexpected-before");
  scenario.evidence.before = before;
  await sleep(300);
  const stop = killHostVerified(ctx, "unexpected-kill");
  const gone = await waitForPidGone(oldSession.pid, 30000);
  check("[" + ctx.mode + "] 硬杀后旧 host PID 已退出", gone, JSON.stringify({ pid: oldSession.pid }));
  const inflightOutcome = await inflight;
  const inflightMs = Date.now() - t0;
  const explicit = inflightOutcome.result
    ? inflightOutcome.result.ok === false && inflightOutcome.result.errorCode === "HOST_DISCONNECTED"
    : inflightOutcome.error?.code === "HOST_DISCONNECTED";
  check("[" + ctx.mode + "] 硬杀时 in-flight 请求返回显式 HOST_DISCONNECTED（不挂起到 2 分钟）", explicit && inflightMs < 20000, JSON.stringify({ inflightMs, inflightAt: inflightOutcome.at ? inflightOutcome.at - t0 : undefined, killMs: stop.killMs, outcome: inflightOutcome.result || { code: inflightOutcome.error?.code, message: inflightOutcome.error?.message } }));
  const closed = await waitUntil(() => oldClient.closed === true, 5000);
  check("[" + ctx.mode + "] 旧 TCP 连接已失效", closed, JSON.stringify({ closeInfo: oldClient.closeInfo }));

  // The SW must not retain stale agent activity while the host is gone.
  const inactive = await waitForState(ctx.browser.port, (s) => s.agentActive === false && (s.externalClients ?? 0) === 0, 10000);
  check("[" + ctx.mode + "] host 断开后 SW agentActive=false、externalClients=0", inactive?.agentActive === false && (inactive?.externalClients ?? 0) === 0, JSON.stringify({ agentActive: inactive?.agentActive, externalClients: inactive?.externalClients }));

  const next = await waitForNextHost(ctx, oldSession, "unexpected-reconnect");
  const stateAfterReady = await stateFromSw(ctx.browser.port);
  check("[" + ctx.mode + "] 新 host ready 不会复活旧 agent 活动（连接前 agentActive=false）", stateAfterReady.agentActive === false && (stateAfterReady.externalClients ?? 0) === 0, JSON.stringify({ agentActive: stateAfterReady.agentActive, externalClients: stateAfterReady.externalClients }));

  ctx.session = next;
  ctx.client = await attachClient(ctx, next);
  const ready2 = await ctx.client.requestOk("get_ready_state");
  ctx.ready = ready2;
  check("[" + ctx.mode + "] 重连握手返回新实例 port/token/profile", ready2?.port === next.port && ready2?.instanceId === next.instanceId && typeof ready2?.authToken === "string" && ready2?.profile?.ok === true, JSON.stringify({ port: ready2?.port, instanceId: ready2?.instanceId, profile: ready2?.profile?.ok }));
  check("[" + ctx.mode + "] 新 host instanceId 与旧实例不同", ready2.instanceId !== oldReady.instanceId, JSON.stringify({ old: oldReady.instanceId, next: ready2.instanceId }));

  // Fresh per-connection authorization: public ping is allowed, private commands are not.
  const noAuthReady = await oneShot(next.port, undefined, "get_ready_state");
  check("[" + ctx.mode + "] 新连接不带 token 的 get_ready_state 被拒绝", noAuthReady.ok === false && noAuthReady.error === "authentication_required", JSON.stringify(noAuthReady));
  const publicPing = await oneShot(next.port, undefined, "ping");
  check("[" + ctx.mode + "] 公开 ping 仍可用于发现（不带 token）", publicPing.ok === true && publicPing.data?.pong === true, JSON.stringify(publicPing));
  const noAuthVersion = await oneShot(next.port, undefined, "version");
  check("[" + ctx.mode + "] ping 不等同于授权：无 token 的 version 仍被拒绝", noAuthVersion.ok === false && noAuthVersion.error === "authentication_required", JSON.stringify(noAuthVersion));
  const withAuth = await oneShot(next.port, next.authToken, "version");
  check("[" + ctx.mode + "] 带 token 的新连接可以授权", withAuth.ok === true && withAuth.data?.name === "BrowserPilot", JSON.stringify(withAuth));

  // Old ownership/authorization must not come back as AI.
  const statusAfter = await ctx.client.requestOk("input_status", {}, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] 重连后 HUMAN ownership 未被复活为 AI", statusAfter.mode === "human" && statusAfter.ownership === "user", JSON.stringify(statusAfter));
  const jsRejected = await ctx.client.request("js", { expression: "1+1", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] HUMAN 空间在重连后仍拒绝 AI 输入", jsRejected.ok === false && inputErrorCode(jsRejected) === "INPUT_HUMAN_OWNED", JSON.stringify(jsRejected));

  await ctx.client.requestOk("claim_space", {}, { space: ctx.space.spaceId });
  const jsAfterClaim = await ctx.client.requestOk("js", { expression: "6*7", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] claim_space 后产品命令恢复", jsAfterClaim?.value === 42, JSON.stringify(jsAfterClaim));

  const other = await attachClient(ctx, next, OTHER_AGENT_ID);
  const otherResult = await other.request("js", { expression: "1", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] 旧 space 的 agent 所有权没有被另一个 agent 继承", otherResult.ok === false && (otherResult.errorCode === "SPACE_NOT_OWNED" || /其他 Agent|SPACE_NOT_OWNED/.test(otherResult.error || "")), JSON.stringify(otherResult));
  other.close();

  const activeAfterCommand = await waitForState(ctx.browser.port, (s) => s.agentActive === true, 5000);
  check("[" + ctx.mode + "] 新连接真实命令后 agentActive 才变为 true", activeAfterCommand?.agentActive === true, JSON.stringify({ agentActive: activeAfterCommand?.agentActive }));

  const after = hostEvidence(ctx, "unexpected-after");
  scenario.evidence.after = after;
  scenario.evidence.kill = stop;
  scenario.evidence.killMs = stop.killMs;
  scenario.evidence.inflightMs = inflightMs;
  scenario.evidence.inflightAtMs = inflightOutcome.at ? inflightOutcome.at - t0 : undefined;
  scenario.evidence.inflight = inflightOutcome.result || { error: inflightOutcome.error?.code, message: inflightOutcome.error?.message };
  scenario.evidence.oldClient = { closed: oldClient.closed, closeInfo: oldClient.closeInfo, closedAtMs: oldClient.closedAt ? oldClient.closedAt - t0 : undefined };
  scenario.evidence.reconnectMs = next.reconnectMs;
  check("[" + ctx.mode + "] 重启后唯一 host、无重复进程", after.hostCount === 1 && after.allHostPids[0] === next.pid, JSON.stringify(after));
  check("[" + ctx.mode + "] 重启后 host TCP 连接数有界（无连接泄漏）", after.tcpEstablished >= 0 && after.tcpEstablished <= 2, JSON.stringify({ tcpEstablished: after.tcpEstablished }));
  check("[" + ctx.mode + "] 重启后 host handle 数有界", Number.isFinite(after.handleCount) && after.handleCount > 0 && after.handleCount < 2000, JSON.stringify({ handleCount: after.handleCount, privateBytes: after.privateBytes }));
  scenario.checks = { inflightMs, reconnectMs: next.reconnectMs, oldPid: oldSession.pid, newPid: next.pid, oldInstance: oldReady.instanceId, newInstance: next.instanceId };
  scenario.finishedAt = nowIso();
  return scenario;
}

// ---------------------------------------------------------------- scenario 2: stale result isolation
async function scenarioStaleResultIsolation(ctx, modeReport) {
  const scenario = { name: "stale-result-isolation", startedAt: nowIso(), checks: {}, evidence: {} };
  modeReport.scenarios.push(scenario);
  await closePopup(ctx);
  ctx.client.close();

  // Kill the current host, then open a brand-new host with exactly one TCP client.
  const base = ctx.session;
  killHostVerified(ctx, "stale-base-kill");
  await waitForPidGone(base.pid, 30000);
  const h1 = await waitForHostSession(ctx.browser.localAppData, { excludePid: base.pid, timeoutMs: 90000 });
  check("[" + ctx.mode + "] stale-result：旧 host 已替换（H1）", h1.pid !== base.pid && pidAlive(h1.pid), JSON.stringify({ oldPid: base.pid, h1: h1.pid }));

  const oldClient = await attachClient(ctx, h1);
  const oldStarted = Date.now();
  const oldPromise = oldClient.request("waitForTimeout", { ms: 6000, tabId: ctx.space.tabId }, {
    requestId: "stale-old",
    timeoutMs: 15000,
    space: ctx.space.spaceId,
  }).then((result) => ({ result })).catch((error) => ({ error }));
  await sleep(500);
  killHostVerified(ctx, "stale-h1-kill", h1);
  await waitForPidGone(h1.pid, 30000);
  const h2 = await waitForHostSession(ctx.browser.localAppData, { excludePid: h1.pid, timeoutMs: 90000 });
  const h2ReadyMs = Date.now() - oldStarted;
  check("[" + ctx.mode + "] stale-result：H2 在旧命令返回前完成重连", h2ReadyMs < 5000, JSON.stringify({ h2ReadyMs, h1: h1.pid, h2: h2.pid }));

  const newClient = await attachClient(ctx, h2);
  const newStarted = Date.now();
  // This is the first forwarded command on H2: internal id is bp:<h2>:1:1, the same
  // client/sequence pair the old host used. Without the host-instance id it would
  // receive the old 6s result and resolve early with waitedMs=6000.
  const newResult = await newClient.request("waitForTimeout", { ms: 12000, tabId: ctx.space.tabId }, {
    requestId: "stale-new",
    timeoutMs: 25000,
    space: ctx.space.spaceId,
  });
  const newMs = Date.now() - newStarted;
  check("[" + ctx.mode + "] 旧 host 的迟到结果没有被路由到新请求", newResult.ok === true && newResult.data?.waitedMs === 12000 && newMs >= 10000, JSON.stringify({ newMs, result: newResult }));
  const oldOutcome = await oldPromise;
  check("[" + ctx.mode + "] stale-result：旧 in-flight 请求显式失败", oldOutcome.result ? oldOutcome.result.ok === false && oldOutcome.result.errorCode === "HOST_DISCONNECTED" : oldOutcome.error?.code === "HOST_DISCONNECTED", JSON.stringify(oldOutcome.result || { code: oldOutcome.error?.code, message: oldOutcome.error?.message }));
  await waitUntil(() => oldClient.closed === true, 5000);
  check("[" + ctx.mode + "] stale-result：旧连接关闭", oldClient.closed === true, JSON.stringify({ closeInfo: oldClient.closeInfo }));

  ctx.session = h2;
  ctx.client = newClient;
  const js = await newClient.requestOk("js", { expression: "40+2", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] stale-result：H2 上产品命令正常", js?.value === 42, JSON.stringify(js));
  assertSingleHost(ctx, "stale-result", h2.pid);
  scenario.evidence = { basePid: base.pid, h1Pid: h1.pid, h2Pid: h2.pid, h2ReadyMs, newMs, newResult, oldOutcome: oldOutcome.result || { code: oldOutcome.error?.code } };
  scenario.finishedAt = nowIso();
  return scenario;
}

// ---------------------------------------------------------------- scenario 3: normal host exit (native-port EOF)
async function scenarioNormalExit(ctx, modeReport) {
  const scenario = { name: "normal-host-exit", startedAt: nowIso(), checks: {}, evidence: {} };
  modeReport.scenarios.push(scenario);
  const oldSession = ctx.session;
  const oldClient = ctx.client;
  await ctx.client.requestOk("claim_space", {}, { space: ctx.space.spaceId });
  const before = hostEvidence(ctx, "normal-exit-before");
  const t0 = Date.now();
  const inflight = oldClient.request("waitForTimeout", { ms: 6000, tabId: ctx.space.tabId }, {
    requestId: "normal-exit-inflight",
    timeoutMs: 15000,
    space: ctx.space.spaceId,
  }).then((result) => ({ result })).catch((error) => ({ error }));
  await sleep(350);
  const swStop = await stopServiceWorkers(ctx.browser.port);
  const swGone = await waitForSwGone(ctx.browser.port, 15000);
  check("[" + ctx.mode + "] normal-exit：SW target 已停止", swGone, JSON.stringify(swStop));
  const hostGone = await waitForPidGone(oldSession.pid, 30000);
  check("[" + ctx.mode + "] normal-exit：native port EOF 后 host 自行退出", hostGone, JSON.stringify({ pid: oldSession.pid }));
  const inflightOutcome = await inflight;
  const inflightMs = Date.now() - t0;
  const explicit = inflightOutcome.result
    ? inflightOutcome.result.ok === false && inflightOutcome.result.errorCode === "HOST_DISCONNECTED"
    : inflightOutcome.error?.code === "HOST_DISCONNECTED";
  check("[" + ctx.mode + "] normal-exit：in-flight 请求返回显式 HOST_DISCONNECTED", explicit && inflightMs < 10000, JSON.stringify({ inflightMs, outcome: inflightOutcome.result || { code: inflightOutcome.error?.code, message: inflightOutcome.error?.message } }));
  const sessionGone = !fs.existsSync(oldSession.file);
  check("[" + ctx.mode + "] normal-exit：旧 host session 文件已清理", sessionGone, JSON.stringify({ file: oldSession.file, exists: fs.existsSync(oldSession.file), live: readSessions(ctx.browser.localAppData).filter((s) => pidAlive(s.pid)).map(sessionBrief) }));
  const closed = await waitUntil(() => oldClient.closed === true, 5000);
  check("[" + ctx.mode + "] normal-exit：旧 TCP 连接已失效", closed, JSON.stringify({ closeInfo: oldClient.closeInfo }));

  const wake = await wakeServiceWorker(ctx.browser.port);
  const started = Date.now();
  const next = await waitForHostSession(ctx.browser.localAppData, { excludePid: oldSession.pid, instanceIdNot: oldSession.instanceId, timeoutMs: 90000 });
  const reconnectMs = Date.now() - started;
  check("[" + ctx.mode + "] normal-exit：SW 唤醒后 Chrome 拉起新 host", next.pid !== oldSession.pid && pidAlive(next.pid), JSON.stringify({ oldPid: oldSession.pid, newPid: next.pid, reconnectMs, wake }));
  await sleep(250);
  assertSingleHost(ctx, "normal-exit", next.pid);
  ctx.session = next;
  ctx.client = await attachClient(ctx, next);
  const ready = await ctx.client.requestOk("get_ready_state");
  ctx.ready = ready;
  check("[" + ctx.mode + "] normal-exit：重连握手 instanceId 更新", ready?.instanceId === next.instanceId && ready.instanceId !== oldSession.instanceId, JSON.stringify({ old: oldSession.instanceId, next: ready?.instanceId }));
  const ping = await ctx.client.requestOk("ping");
  check("[" + ctx.mode + "] normal-exit：新 host ping=pong", ping?.pong === true, JSON.stringify(ping));
  const js = await ctx.client.requestOk("js", { expression: "21*2", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] normal-exit：产品命令恢复", js?.value === 42, JSON.stringify(js));
  const after = hostEvidence(ctx, "normal-exit-after");
  check("[" + ctx.mode + "] normal-exit：重启后唯一 host、无重复进程", after.hostCount === 1 && after.allHostPids[0] === next.pid, JSON.stringify(after));
  check("[" + ctx.mode + "] normal-exit：无残留长期 TCP 连接", after.tcpEstablished >= 0 && after.tcpEstablished <= 2, JSON.stringify({ tcpEstablished: after.tcpEstablished }));
  scenario.evidence = { before, after, swStop, hostGone, sessionGone, inflightMs, reconnectMs, oldPid: oldSession.pid, newPid: next.pid, inflight: inflightOutcome.result || { error: inflightOutcome.error?.code, message: inflightOutcome.error?.message }, oldClient: { closed: oldClient.closed, closeInfo: oldClient.closeInfo } };
  scenario.finishedAt = nowIso();
  return scenario;
}

// ---------------------------------------------------------------- scenario 4: host/SW restart interleaving
async function scenarioInterleave(ctx, modeReport) {
  const scenario = { name: "host-sw-interleave", startedAt: nowIso(), checks: {}, evidence: {} };
  modeReport.scenarios.push(scenario);
  const oldSession = ctx.session;
  const oldClient = ctx.client;
  await ctx.client.requestOk("claim_space", {}, { space: ctx.space.spaceId });
  const before = hostEvidence(ctx, "interleave-before");
  // Start the SW stop first (it is an async CDP round-trip), then kill the host while
  // that stop is still in flight. This is a real interleaving, not "stop then kill".
  const swPromise = stopServiceWorkers(ctx.browser.port).then((value) => ({ value })).catch((error) => ({ error }));
  const killSettled = (() => {
    try { return { status: "fulfilled", value: killHostVerified(ctx, "interleave-kill") }; }
    catch (error) { return { status: "rejected", reason: error }; }
  })();
  const swSettled = await swPromise;
  check("[" + ctx.mode + "] interleave：host 终止已执行", killSettled.status === "fulfilled", JSON.stringify(killSettled.reason?.message || killSettled.value));
  check("[" + ctx.mode + "] interleave：SW 停止已执行", !swSettled.error, JSON.stringify(swSettled.error?.message || swSettled.value));
  const hostGone = await waitForPidGone(oldSession.pid, 30000);
  const swGone = await waitForSwGone(ctx.browser.port, 15000);
  check("[" + ctx.mode + "] interleave：host 与 SW 都已停止", hostGone && swGone, JSON.stringify({ hostGone, swGone, pid: oldSession.pid }));

  await wakeServiceWorker(ctx.browser.port);
  const started = Date.now();
  const next = await waitForHostSession(ctx.browser.localAppData, { excludePid: oldSession.pid, instanceIdNot: oldSession.instanceId, timeoutMs: 90000 });
  const reconnectMs = Date.now() - started;
  await sleep(3000);
  const { hosts, liveSessions } = assertSingleHost(ctx, "interleave", next.pid);
  check("[" + ctx.mode + "] interleave：没有重复 host 进程（等待 3s 后）", hosts.length === 1 && liveSessions.length === 1, JSON.stringify({ hosts, liveSessions }));
  check("[" + ctx.mode + "] interleave：旧 pid 不在任何存活 session", !liveSessions.some((s) => s.pid === oldSession.pid), JSON.stringify(liveSessions));
  const closed = await waitUntil(() => oldClient.closed === true, 5000);
  check("[" + ctx.mode + "] interleave：旧连接失效", closed, JSON.stringify({ closeInfo: oldClient.closeInfo }));
  ctx.session = next;
  ctx.client = await attachClient(ctx, next);
  const ready = await ctx.client.requestOk("get_ready_state");
  ctx.ready = ready;
  const js = await ctx.client.requestOk("js", { expression: "7*6", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] interleave：重连后产品命令恢复", ready?.instanceId === next.instanceId && js?.value === 42, JSON.stringify({ ready: { port: ready?.port, instanceId: ready?.instanceId }, js }));
  const after = hostEvidence(ctx, "interleave-after");
  check("[" + ctx.mode + "] interleave：host handle/TCP 有界", Number.isFinite(after.handleCount) && after.handleCount < 2000 && after.tcpEstablished >= 0 && after.tcpEstablished <= 2, JSON.stringify(after));
  scenario.evidence = { before, after, hostGone, swGone, reconnectMs, oldPid: oldSession.pid, newPid: next.pid, hosts, liveSessions };
  scenario.finishedAt = nowIso();
  return scenario;
}

// ---------------------------------------------------------------- scenario 5: expired ASSIST grant / stale input ownership
async function scenarioExpiredGrant(ctx, modeReport) {
  const scenario = { name: "expired-grant-not-resurrected", startedAt: nowIso(), checks: {}, evidence: {} };
  modeReport.scenarios.push(scenario);
  if (SKIP_EXPIRED_GRANT) {
    scenario.skipped = true;
    scenario.reason = "--skip-expired-grant";
    return scenario;
  }
  await ctx.client.requestOk("claim_space", {}, { space: ctx.space.spaceId });
  const presence = await popupSend(ctx, "human_presence", ctx.space.spaceId);
  check("[" + ctx.mode + "] 用户入口 human_presence 进入 ASSIST", !presence?.__bpError && presence?.mode === "assist", JSON.stringify(presence));
  const grant = await popupSend(ctx, "grant_input", ctx.space.spaceId);
  check("[" + ctx.mode + "] 用户入口 grant_input 发放 1 次 grant", !grant?.__bpError && grant?.grant?.actions === 1, JSON.stringify(grant));
  const status1 = await ctx.client.requestOk("input_status", {}, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] grant 发放后 input_status 可确认", status1.mode === "assist" && status1.grantActionsRemaining === 1 && status1.grant, JSON.stringify(status1));

  await sleep(GRANT_WAIT_MS);
  const status2 = await ctx.client.requestOk("input_status", {}, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] grant 过期后 input_status 不再报告可用 grant", status2.mode === "assist" && status2.grant === null && status2.grantActionsRemaining === null, JSON.stringify(status2));
  const rejectedBefore = await ctx.client.request("js", { expression: "1+1", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] 过期 grant 在 host 重启前已被拒绝", rejectedBefore.ok === false && inputErrorCode(rejectedBefore) === "INPUT_ASSIST_REQUIRES_GRANT", JSON.stringify(rejectedBefore));

  const oldSession = ctx.session;
  const stop = killHostVerified(ctx, "expired-grant-kill");
  const gone = await waitForPidGone(oldSession.pid, 30000);
  check("[" + ctx.mode + "] 过期 grant 场景：旧 host 已退出", gone, JSON.stringify({ pid: oldSession.pid }));
  const next = await waitForNextHost(ctx, oldSession, "expired-grant-reconnect");
  ctx.session = next;
  ctx.client = await attachClient(ctx, next);
  const ready = await ctx.client.requestOk("get_ready_state");
  ctx.ready = ready;
  check("[" + ctx.mode + "] 过期 grant 场景：重连到新实例", ready?.instanceId === next.instanceId && ready.instanceId !== oldSession.instanceId, JSON.stringify({ old: oldSession.instanceId, next: ready?.instanceId }));
  const status3 = await ctx.client.requestOk("input_status", {}, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] 重连不复活过期 grant", status3.mode === "assist" && status3.grant === null && status3.grantActionsRemaining === null, JSON.stringify(status3));
  const rejectedAfter = await ctx.client.request("js", { expression: "1+1", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] 重连后 ASSIST 输入仍然 fail closed", rejectedAfter.ok === false && inputErrorCode(rejectedAfter) === "INPUT_ASSIST_REQUIRES_GRANT", JSON.stringify(rejectedAfter));

  await ctx.client.requestOk("handoff_space", {}, { space: ctx.space.spaceId });
  await ctx.client.requestOk("claim_space", {}, { space: ctx.space.spaceId });
  const js = await ctx.client.requestOk("js", { expression: "42", tabId: ctx.space.tabId }, { space: ctx.space.spaceId });
  check("[" + ctx.mode + "] 清理 ASSIST 后产品命令恢复", js?.value === 42, JSON.stringify(js));
  await closePopup(ctx);
  scenario.evidence = { stop, oldPid: oldSession.pid, newPid: next.pid, status1, status2, status3, rejectedBefore, rejectedAfter, grantWaitMs: GRANT_WAIT_MS };
  scenario.finishedAt = nowIso();
  return scenario;
}

// ---------------------------------------------------------------- per-mode driver
async function runMode(mode, fixture) {
  const modeReport = { mode, startedAt: nowIso(), finishedAt: null, browser: null, capabilities: null, initial: null, scenarios: [], final: null, cleanup: null, error: null };
  report.sessions.push(modeReport);
  let browser;
  let ctx;
  try {
    browser = await launchBrowser(mode, fixture);
    modeReport.browser = {
      pid: browser.browserPid,
      devtoolsPort: browser.port,
      profileDir: browser.profileDir,
      localAppData: browser.localAppData,
      basePort: browser.basePort,
      args: browser.args,
      logFile: browser.logFile,
    };
    ctx = { mode, browser, hostExe: report.hostExe, session: null, client: null, space: null, ready: null, popup: undefined };
    const session = await waitForHostSession(browser.localAppData, { timeoutMs: 90000 });
    const exePath = processExecutablePath(session.pid);
    check("[" + mode + "] connectNative 拉起本轮构建的 host exe", path.resolve(exePath).toLowerCase() === path.resolve(report.hostExe).toLowerCase(), JSON.stringify({ pid: session.pid, exePath, expected: report.hostExe }));
    check("[" + mode + "] host session instanceId 存在", typeof session.instanceId === "string" && /^[0-9a-f]{16}$/.test(session.instanceId), JSON.stringify({ pid: session.pid, instanceId: session.instanceId }));
    ctx.session = session;
    assertSingleHost(ctx, "initial", session.pid);
    ctx.client = await attachClient(ctx, session);
    const ready = await ctx.client.requestOk("get_ready_state");
    ctx.ready = ready;
    check("[" + mode + "] 初始 get_ready_state 与 session 一致", ready?.port === session.port && ready?.instanceId === session.instanceId && ready?.profile?.ok === true, JSON.stringify({ port: ready?.port, instanceId: ready?.instanceId, profile: ready?.profile?.ok }));
    const ping = await ctx.client.requestOk("ping");
    check("[" + mode + "] 初始 ping=pong", ping?.pong === true, JSON.stringify(ping));
    const caps = await ctx.client.requestOk("host_capabilities");
    modeReport.capabilities = caps;
    check("[" + mode + "] host_capabilities 已真实探测（不是 not-probed）", caps && (caps.mode === "generic" || caps.mode === "enhanced") && caps.degradeReason !== "not-probed" && caps.maxConcurrentWindows >= 1, JSON.stringify(caps));
    if (mode === "agent") {
      check("[agent] WinRelease agent 模式为 enhanced + managedMode", caps?.mode === "enhanced" && caps?.managedMode === true, JSON.stringify(caps));
    }
    const space = await ctx.client.requestOk("open_space", { name: "host-restart-" + mode, url: fixture.url + "?mode=" + mode });
    check("[" + mode + "] open_space 创建真实窗口/空间", typeof space?.spaceId === "string" && Number.isFinite(space?.windowId) && Number.isFinite(space?.tabId), JSON.stringify(space));
    ctx.space = space;
    await ctx.client.requestOk("waitForSelector", { selector: "#h", tabId: space.tabId }, { space: space.spaceId, timeoutMs: 60000 });
    const title = await ctx.client.requestOk("js", { expression: "document.title", tabId: space.tabId }, { space: space.spaceId });
    check("[" + mode + "] 产品 js 命中 fixture 标题", title?.value === "BrowserPilot Host Restart Fixture", JSON.stringify(title));
    modeReport.initial = { session: { pid: session.pid, port: session.port, instanceId: session.instanceId }, ready: { port: ready?.port, instanceId: ready?.instanceId, profile: ready?.profile?.ok }, capabilities: caps, space, title };

    await scenarioUnexpectedKill(ctx, modeReport);
    await scenarioStaleResultIsolation(ctx, modeReport);
    await scenarioNormalExit(ctx, modeReport);
    await scenarioInterleave(ctx, modeReport);
    if (SKIP_EXPIRED_GRANT) {
      const skipped = { name: "expired-grant-not-resurrected", skipped: true, reason: "--skip-expired-grant" };
      modeReport.scenarios.push(skipped);
      console.log("SKIP | [" + mode + "] expired ASSIST grant (--skip-expired-grant)");
    } else {
      await scenarioExpiredGrant(ctx, modeReport);
    }
    modeReport.final = hostEvidence(ctx, "final");
    const finalHosts = listHostProcesses(report.hostExe);
    check(
      "[" + mode + "] 最终 host 唯一且为本扩展 native messaging host",
      modeReport.final.hostCount === 1 &&
        finalHosts[0]?.pid === modeReport.final.pid &&
        String(finalHosts[0]?.commandLine || "").includes("chrome-extension://" + EXTENSION_ID + "/"),
      JSON.stringify(modeReport.final),
    );
  } catch (error) {
    failed++;
    failures.push("[" + mode + "] unexpected exception");
    modeReport.error = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
    check("[" + mode + "] 未发生未捕获异常", false, JSON.stringify(modeReport.error));
  } finally {
    try { if (ctx) await closePopup(ctx); } catch {}
    try { ctx?.client?.close(); } catch {}
    if (browser) {
      const stopped = browser.stop();
      if (stopped && stopped.refused) console.error("[cleanup] browser stop refused: " + JSON.stringify(stopped.detail));
      await sleep(1200);
      let hosts = listHostProcesses(report.hostExe);
      for (const host of hosts) {
        if (!pidAlive(host.pid)) continue;
        const kill = stopVerifiedPid({ pid: host.pid, expectedExePath: report.hostExe, reason: "host-restart-e2e.cleanup" });
        console.error("[cleanup] host stop: " + JSON.stringify(kill));
      }
      await sleep(500);
      hosts = listHostProcesses(report.hostExe);
      const liveSessions = readSessions(browser.localAppData).filter((s) => pidAlive(s.pid)).map(sessionBrief);
      modeReport.cleanup = { browserStop: stopped, remainingHosts: hosts, liveSessions };
      check("[" + mode + "] 清理后无残留 host 进程/session", hosts.length === 0 && liveSessions.length === 0, JSON.stringify(modeReport.cleanup));
    }
  }
  modeReport.finishedAt = nowIso();
  saveArtifact("mode-" + mode + ".json", modeReport);
  return modeReport;
}

// ---------------------------------------------------------------- long-run (8 windows + real host restart)
function pngSignatureOk(base64) {
  try {
    const buffer = Buffer.from(String(base64 || ""), "base64");
    return buffer.length > 1000 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  } catch {
    return false;
  }
}
function readLogTail(file, maxBytes = 8 * 1024 * 1024) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
const LONG_RUN_CRASH_PATTERNS = [
  "layer_tree_view.cc:554",
  "PresentationTimeCallbackBuffer",
  "kMaxBufferSize (",
  "DCHECK failed",
  "Check failed:",
  "FATAL:",
  "GPU process exited unexpectedly",
  "Renderer process crashed",
  "Renderer process was killed",
  "Out of memory",
  "STATUS_BREAKPOINT",
];

async function launchLongRunSession(mode, fixture) {
  const browser = await launchBrowser(mode, fixture);
  const session = await waitForHostSession(browser.localAppData, { timeoutMs: 90000 });
  const exePath = processExecutablePath(session.pid);
  check("[" + mode + "] long-run：真实 host exe 已连接", path.resolve(exePath).toLowerCase() === path.resolve(report.hostExe).toLowerCase(), JSON.stringify({ pid: session.pid, exePath, expected: report.hostExe }));
  const client = await attachClient(ctxFor(mode, browser), session, "longrun-" + mode);
  const ready = await client.requestOk("get_ready_state");
  const caps = await client.requestOk("host_capabilities");
  if (mode === "agent") {
    check("[agent] long-run：enhanced + managedMode", caps?.mode === "enhanced" && caps?.managedMode === true, JSON.stringify(caps));
  }
  const windows = [];
  for (let index = 0; index < 4; index += 1) {
    const space = await client.requestOk("open_space", {
      name: "longrun-" + mode + "-w" + (index + 1),
      url: fixture.url + "?mode=" + mode + "&w=" + (index + 1),
    });
    await client.requestOk("waitForSelector", { selector: "#h", tabId: space.tabId }, { space: space.spaceId, timeoutMs: 60000 });
    windows.push({
      id: mode + "-w" + (index + 1),
      spaceId: space.spaceId,
      windowId: space.windowId,
      tabId: space.tabId,
    });
  }
  const distinctWindows = new Set(windows.map((w) => w.windowId));
  const distinctTabs = new Set(windows.map((w) => w.tabId));
  check("[" + mode + "] long-run：创建 4 个独立窗口/标签", distinctWindows.size === 4 && distinctTabs.size === 4, JSON.stringify(windows));
  return {
    mode,
    hostExe: report.hostExe,
    browser,
    session,
    client,
    ready,
    caps,
    windows,
    samples: [],
    screenshots: [],
    restart: null,
  };
}
function ctxFor(mode, browser) {
  return { mode, browser, hostExe: report.hostExe };
}

async function longRunWindowCheck(sessionCtx, { js = false } = {}) {
  const results = [];
  for (const window of sessionCtx.windows) {
    let tabs;
    try {
      tabs = await sessionCtx.client.request("list_tabs", {}, { space: window.spaceId, timeoutMs: 10000 });
    } catch (error) {
      results.push({ id: window.id, ok: false, error: error.message });
      continue;
    }
    const tabIds = (tabs.data?.tabs || []).map((tab) => tab.tabId);
    const alive = tabs.ok === true && tabIds.includes(window.tabId);
    let jsResult;
    if (js && alive) {
      try {
        jsResult = await sessionCtx.client.request("js", { expression: "1+1", tabId: window.tabId }, { space: window.spaceId, timeoutMs: 10000 });
      } catch (error) {
        jsResult = { ok: false, error: error.message };
      }
    }
    results.push({
      id: window.id,
      spaceId: window.spaceId,
      windowId: window.windowId,
      tabId: window.tabId,
      ok: alive && (!js || (jsResult?.ok === true && jsResult.data?.value === 2)),
      tabIds,
      js: jsResult ? { ok: jsResult.ok === true, value: jsResult.data?.value, error: jsResult.error } : undefined,
    });
  }
  return results;
}

async function longRunSample(sessionCtx, elapsedSec, sampleIndex) {
  const hostStats = processStats(sessionCtx.session.pid);
  const chromeStats = processStats(sessionCtx.browser.browserPid);
  const hostRows = listHostProcesses(report.hostExe);
  const windowCheck = await longRunWindowCheck(sessionCtx, { js: sampleIndex % 4 === 0 });
  let ping;
  try {
    ping = await sessionCtx.client.request("ping", {}, { timeoutMs: 8000 });
  } catch (error) {
    ping = { ok: false, error: error.message };
  }
  const sample = {
    at: nowIso(),
    elapsedSec: Math.round(elapsedSec * 10) / 10,
    mode: sessionCtx.mode,
    hostPid: sessionCtx.session.pid,
    hostInstanceId: sessionCtx.session.instanceId,
    hostAlive: pidAlive(sessionCtx.session.pid),
    hostHandleCount: hostStats?.handleCount,
    hostPrivateBytes: hostStats?.privateBytes,
    hostWorkingSet: hostStats?.workingSet,
    hostTcpEstablished: tcpEstablishedCount(sessionCtx.session.pid),
    chromePid: sessionCtx.browser.browserPid,
    chromeAlive: pidAlive(sessionCtx.browser.browserPid),
    chromeHandleCount: chromeStats?.handleCount,
    chromePrivateBytes: chromeStats?.privateBytes,
    chromeWorkingSet: chromeStats?.workingSet,
    totalHostProcesses: hostRows.length,
    allHostPids: hostRows.map((row) => row.pid),
    pingOk: ping?.ok === true && ping?.data?.pong === true,
    windows: windowCheck,
    allWindowsOk: windowCheck.every((window) => window.ok === true),
  };
  if (sampleIndex % 4 === 0) {
    const children = childProcesses(sessionCtx.browser.browserPid);
    sample.processTypes = children.reduce((acc, child) => {
      const cmd = String(child.CommandLine || "");
      const key = /--type=renderer/.test(cmd) ? "renderer"
        : /--type=gpu-process/.test(cmd) ? "gpu"
        : /--type=utility/.test(cmd) && /network\.mojom/.test(cmd) ? "network"
        : /--type=utility/.test(cmd) ? "utility"
        : "other";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    sample.childCount = children.length;
  }
  return sample;
}

async function longRunScreenshot(sessionCtx, window, label) {
  // C's long-run gate deliberately does NOT capture managed-hidden windows
  // periodically: a capture drains presentation feedback and can mask the known
  // presentation-callback DCHECK. This host-lifecycle gate keeps the same rule and
  // verifies agent windows through product commands (list_tabs/js), not screenshots.
  if (sessionCtx.mode === "agent") {
    const entry = {
      mode: sessionCtx.mode,
      window: window.id,
      label,
      at: nowIso(),
      ok: true,
      skipped: true,
      reason: "managed-hidden window; host-lifecycle gate verifies it with list_tabs/js, not product screenshots",
    };
    sessionCtx.screenshots.push(entry);
    return entry;
  }
  try {
    const result = await sessionCtx.client.request("screenshot", { tabId: window.tabId, format: "png" }, { space: window.spaceId, timeoutMs: 30000 });
    const ok = result.ok === true && pngSignatureOk(result.data?.base64);
    const entry = {
      mode: sessionCtx.mode,
      window: window.id,
      label,
      at: nowIso(),
      ok,
      bytes: result.data?.base64 ? Buffer.from(result.data.base64, "base64").length : 0,
      fromSurface: result.data?.screenshot?.fromSurface,
      possiblyStale: result.data?.screenshot?.possiblyStale,
      error: result.ok === true ? undefined : result.error,
    };
    if (ok) {
      fs.writeFileSync(path.join(artifactsDir, "longrun-" + sessionCtx.mode + "-" + window.id + "-" + label + ".png"), Buffer.from(result.data.base64, "base64"));
    }
    sessionCtx.screenshots.push(entry);
    return entry;
  } catch (error) {
    const entry = { mode: sessionCtx.mode, window: window.id, label, at: nowIso(), ok: false, error: error.message };
    sessionCtx.screenshots.push(entry);
    return entry;
  }
}

async function restartLongRunSession(sessionCtx) {
  const oldSession = sessionCtx.session;
  const oldClient = sessionCtx.client;
  const started = Date.now();
  const stop = killHostVerified(sessionCtx, "longrun-restart", oldSession);
  const gone = await waitForPidGone(oldSession.pid, 30000);
  const next = await waitForHostSession(sessionCtx.browser.localAppData, {
    excludePid: oldSession.pid,
    instanceIdNot: oldSession.instanceId,
    timeoutMs: 90000,
  });
  const reconnectMs = Date.now() - started;
  const client = await attachClient(sessionCtx, next, "longrun-" + sessionCtx.mode);
  const ready = await client.requestOk("get_ready_state");
  sessionCtx.session = next;
  sessionCtx.client = client;
  sessionCtx.ready = ready;
  const windowCheck = await longRunWindowCheck(sessionCtx, { js: true });
  const ok = gone && next.pid !== oldSession.pid && ready?.instanceId === next.instanceId && windowCheck.every((window) => window.ok === true) && oldClient.closed === true;
  return {
    mode: sessionCtx.mode,
    ok,
    oldPid: oldSession.pid,
    newPid: next.pid,
    oldInstanceId: oldSession.instanceId,
    newInstanceId: ready?.instanceId,
    reconnectMs,
    killMs: stop.killMs,
    oldPidGone: gone,
    oldClientClosed: oldClient.closed,
    windows: windowCheck,
  };
}

async function runLongRun(fixture) {
  const longrun = {
    mode: "longrun",
    startedAt: nowIso(),
    durationSec: DURATION_SEC,
    restartAtSec: RESTART_AT_SEC,
    sampleIntervalSec: SAMPLE_INTERVAL_SEC,
    sessions: [],
    hostRestart: null,
    stability: null,
    crashes: null,
    resources: null,
    cleanup: null,
  };
  report.longrun = longrun;
  const sessions = [];
  try {
    const normal = await launchLongRunSession("normal", fixture);
    sessions.push(normal);
    const agent = await launchLongRunSession("agent", fixture);
    sessions.push(agent);
    longrun.sessions = sessions.map((s) => ({
      mode: s.mode,
      browserPid: s.browser.browserPid,
      hostPid: s.session.pid,
      hostInstanceId: s.session.instanceId,
      hostPort: s.session.port,
      windows: s.windows,
      capabilities: s.caps,
    }));
    check("long-run：8 个窗口（normal 4 + agent 4）全部建立", sessions.reduce((n, s) => n + s.windows.length, 0) === 8, JSON.stringify(sessions.map((s) => ({ mode: s.mode, windows: s.windows.length }))));

    for (const session of sessions) {
      for (const window of session.windows) {
        await longRunScreenshot(session, window, "initial");
      }
    }
    let initialScreensOk = sessions.every((s) => s.screenshots.every((shot) => shot.ok === true));
    check("long-run：初始截图检查（normal 4 张合法 PNG；agent managed-hidden 按 C gate 规则跳过）", initialScreensOk, JSON.stringify(sessions.flatMap((s) => s.screenshots)));

    const soakStart = Date.now();
    const samplesFile = path.join(artifactsDir, "longrun-samples.jsonl");
    fs.writeFileSync(samplesFile, "");
    let sampleIndex = 0;
    let nextSampleAt = 0;
    let restartDone = false;
    let samplingPaused = false;
    while ((Date.now() - soakStart) / 1000 < DURATION_SEC) {
      const elapsed = (Date.now() - soakStart) / 1000;
      if (!restartDone && elapsed >= RESTART_AT_SEC) {
        samplingPaused = true;
        const before = sessions.map((s) => ({ mode: s.mode, hostPid: s.session.pid, instanceId: s.session.instanceId, hostHandleCount: processStats(s.session.pid)?.handleCount }));
        const restarts = [];
        for (const session of sessions) restarts.push(await restartLongRunSession(session));
        longrun.hostRestart = {
          at: nowIso(),
          elapsedSec: Math.round(elapsed),
          status: restarts.every((restart) => restart.ok) ? "PASS" : "FAIL",
          before,
          after: sessions.map((s) => ({ mode: s.mode, hostPid: s.session.pid, instanceId: s.session.instanceId, hostHandleCount: processStats(s.session.pid)?.handleCount })),
          restarts,
        };
        check("long-run：真实 host restart（两种模式）PASS", longrun.hostRestart.status === "PASS", JSON.stringify(longrun.hostRestart));
        for (const session of sessions) {
          for (const window of session.windows) {
            await longRunScreenshot(session, window, "after-restart");
          }
        }
        const afterRestartShotsOk = sessions.every((s) => s.screenshots.filter((shot) => shot.label === "after-restart").every((shot) => shot.ok === true));
        check("long-run：host restart 后截图检查（normal 合法 PNG；agent 按规则跳过）", afterRestartShotsOk, JSON.stringify(sessions.flatMap((s) => s.screenshots.filter((shot) => shot.label === "after-restart"))));
        restartDone = true;
        samplingPaused = false;
        nextSampleAt = elapsed + SAMPLE_INTERVAL_SEC;
      }
      if (!samplingPaused && elapsed >= nextSampleAt) {
        for (const session of sessions) {
          try {
            const sample = await longRunSample(session, elapsed, sampleIndex);
            session.samples.push(sample);
            fs.appendFileSync(samplesFile, JSON.stringify(sample) + "\n");
          } catch (error) {
            fs.appendFileSync(samplesFile, JSON.stringify({ at: nowIso(), elapsedSec: Math.round(elapsed), mode: session.mode, error: error.message }) + "\n");
          }
        }
        sampleIndex += 1;
        nextSampleAt = elapsed + SAMPLE_INTERVAL_SEC;
      }
      await sleep(1000);
    }

    // Final sample + final screenshots for every window.
    const finalIndex = sampleIndex + 1;
    for (const session of sessions) {
      const sample = await longRunSample(session, (Date.now() - soakStart) / 1000, finalIndex);
      session.samples.push(sample);
      fs.appendFileSync(samplesFile, JSON.stringify(sample) + "\n");
      for (const window of session.windows) {
        await longRunScreenshot(session, window, "final");
      }
    }

    const aliveSamples = sessions.every((s) => s.samples.length > 0 && s.samples.every((sample) => sample.hostAlive && sample.chromeAlive && sample.allWindowsOk && sample.pingOk));
    const sampleCount = sessions.reduce((n, s) => n + s.samples.length, 0);
    const hostRows = listHostProcesses(report.hostExe);
    const expectedHostPids = sessions.map((s) => s.session.pid);
    const hostRestartOk = longrun.hostRestart?.status === "PASS";
    const finalWindowsOk = sessions.every((s) => s.samples.at(-1)?.allWindowsOk === true);
    const finalScreensOk = sessions.every((s) => s.screenshots.filter((shot) => shot.label === "final").every((shot) => shot.ok === true));
    const browserAlive = sessions.every((s) => pidAlive(s.browser.browserPid));
    const uniqueHosts = hostRows.length === 2 && expectedHostPids.every((pid) => hostRows.some((row) => row.pid === pid));
    longrun.stability = {
      status: aliveSamples && finalWindowsOk && finalScreensOk && browserAlive && uniqueHosts ? "PASS" : "FAIL",
      samples: sampleCount,
      allSamplesHealthy: aliveSamples,
      finalWindowsOk,
      finalScreensOk,
      browserAlive,
      uniqueHosts,
      hostPids: expectedHostPids,
      hostRows: hostRows.map((row) => ({ pid: row.pid, parentPid: row.parentPid, creationTime: row.creationTime, commandLine: row.commandLine.slice(0, 300) })),
    };
    check("long-run：8 窗口持续存活、命令可用（所有采样健康）", aliveSamples, JSON.stringify({ samples: sampleCount, durationSec: DURATION_SEC, status: longrun.stability.status }));
    check("long-run：结束时 8 窗口仍可操作", finalWindowsOk, JSON.stringify(sessions.map((s) => ({ mode: s.mode, last: s.samples.at(-1)?.windows }))));
    check("long-run：结束时两种模式浏览器存活", browserAlive, JSON.stringify(sessions.map((s) => ({ mode: s.mode, browserPid: s.browser.browserPid, alive: pidAlive(s.browser.browserPid) }))));
    check("long-run：结束时恰好两个 host 进程且 PID 匹配", uniqueHosts, JSON.stringify(longrun.stability));
    check("long-run：结束时截图检查（normal 合法 PNG；agent 按规则跳过）", finalScreensOk, JSON.stringify(sessions.flatMap((s) => s.screenshots.filter((shot) => shot.label === "final"))));

    // Chrome log crash patterns.
    const crashes = [];
    for (const session of sessions) {
      const text = readLogTail(session.browser.logFile);
      for (const pattern of LONG_RUN_CRASH_PATTERNS) {
        const count = text.split(pattern).length - 1;
        if (count > 0) crashes.push({ mode: session.mode, pattern, count });
      }
    }
    longrun.crashes = crashes;
    check("long-run：Chrome 日志无 FATAL/DCHECK/crash 行", crashes.length === 0, JSON.stringify(crashes));

    // Resource trends (first vs last sample, all modes combined).
    const firstSamples = sessions.map((s) => s.samples[0]).filter(Boolean);
    const lastSamples = sessions.map((s) => s.samples.at(-1)).filter(Boolean);
    const sumFirst = (key) => firstSamples.reduce((n, sample) => n + Number(sample[key] || 0), 0);
    const sumLast = (key) => lastSamples.reduce((n, sample) => n + Number(sample[key] || 0), 0);
    const peak = (key) => Math.max(...sessions.flatMap((s) => s.samples.map((sample) => Number(sample[key] || 0))));
    longrun.resources = {
      first: { hostPrivateBytes: sumFirst("hostPrivateBytes"), hostHandleCount: sumFirst("hostHandleCount"), chromePrivateBytes: sumFirst("chromePrivateBytes"), chromeHandleCount: sumFirst("chromeHandleCount") },
      last: { hostPrivateBytes: sumLast("hostPrivateBytes"), hostHandleCount: sumLast("hostHandleCount"), chromePrivateBytes: sumLast("chromePrivateBytes"), chromeHandleCount: sumLast("chromeHandleCount") },
      peak: { hostPrivateBytes: peak("hostPrivateBytes"), hostHandleCount: peak("hostHandleCount"), chromePrivateBytes: peak("chromePrivateBytes"), chromeHandleCount: peak("chromeHandleCount") },
    };
    const resourceBounded =
      longrun.resources.last.hostPrivateBytes < longrun.resources.first.hostPrivateBytes + 200 * 1024 * 1024 &&
      longrun.resources.last.hostHandleCount < longrun.resources.first.hostHandleCount + 500 &&
      longrun.resources.last.chromePrivateBytes < longrun.resources.first.chromePrivateBytes * 3 + 500 * 1024 * 1024 &&
      longrun.resources.last.chromeHandleCount < longrun.resources.first.chromeHandleCount * 2 + 2000;
    check("long-run：资源有界（host/chrome 内存与 handle 未持续放大）", resourceBounded, JSON.stringify(longrun.resources));

    longrun.finishedAt = nowIso();
    longrun.verdict = hostRestartOk && longrun.stability.status === "PASS" && crashes.length === 0 && resourceBounded ? "PASS" : "FAIL";
    longrun.cBlockedItem = {
      source: "D:\\work\\wt\\bc-longrun\\docs\\windows-longrun-stability-gate-2026-11-01.md §8",
      previous: "BLOCKED (Native Messaging Host restart not exercised: gate had no host process)",
      result: hostRestartOk ? "PASS" : "FAIL",
      evidence: "real BrowserPilot native host in both isolated WinRelease sessions; verified hard restart of both at t=" + RESTART_AT_SEC + "s; all 8 windows recovered",
    };
    check("long-run：最终判定 PASS", longrun.verdict === "PASS", JSON.stringify({ verdict: longrun.verdict, hostRestart: longrun.hostRestart?.status, stability: longrun.stability.status, crashes, cBlockedItem: longrun.cBlockedItem }));
  } catch (error) {
    failed++;
    failures.push("long-run unexpected exception");
    longrun.error = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
    check("long-run：未发生未捕获异常", false, JSON.stringify(longrun.error));
  } finally {
    for (const session of sessions) {
      try { session.client.close(); } catch {}
      try { await closePopup({ popup: session.popup, browser: session.browser }); } catch {}
      const stopped = session.browser.stop();
      if (stopped && stopped.refused) console.error("[long-run cleanup] browser stop refused: " + JSON.stringify(stopped.detail));
    }
    await sleep(1200);
    // Stop every host from this exact exe/build that was created during this run.
    // Identity is the absolute exe path + creation time (see listHostProcesses);
    // this also catches a duplicate host that a failed assertion might have left.
    for (const host of listHostProcesses(report.hostExe)) {
      if (!pidAlive(host.pid)) continue;
      const kill = stopVerifiedPid({ pid: host.pid, expectedExePath: report.hostExe, reason: "host-restart-longrun.cleanup" });
      console.error("[long-run cleanup] host stop: " + JSON.stringify(kill));
    }
    await sleep(500);
    const remainingHosts = listHostProcesses(report.hostExe);
    const remainingSessions = sessions.flatMap((s) => readSessions(s.browser.localAppData).filter((session) => pidAlive(session.pid)).map(sessionBrief));
    longrun.cleanup = { remainingHosts, remainingSessions };
    check("long-run：清理后无残留 host 进程/session", remainingHosts.length === 0 && remainingSessions.length === 0, JSON.stringify(longrun.cleanup));
    longrun.finishedAt = longrun.finishedAt || nowIso();
    saveArtifact("longrun-report.json", longrun);
    try {
      fs.writeFileSync(path.join("D:\\c\\logs", "browserpilot-host-restart-longrun-" + runId + ".json"), JSON.stringify({ ...longrun, reportSummary: { verdict: report.verdict, checks: { passed, failed } } }, null, 2) + "\n", "utf8");
    } catch (error) {
      console.error("[long-run evidence] copy failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return longrun;
}


// ---------------------------------------------------------------- main
let hostExe;
let registration;
let fixture;
let blockedReason;
try {
  if (!fs.existsSync(CHROME)) {
    blockedReason = "WinRelease chrome.exe 不存在: " + CHROME;
    check("WinRelease chrome.exe 存在", false, blockedReason);
    throw new Error(blockedReason);
  }
  check("WinRelease chrome.exe 存在", true, CHROME);
  if (!NO_BUILD) {
    const build = spawnSync(process.execPath, ["scripts/build.js"], { cwd: root, stdio: "inherit" });
    check("npm run build（扩展 dist）成功", build.status === 0, "exit=" + build.status);
    const buildHost = spawnSync(process.execPath, ["scripts/build-host.mjs"], { cwd: root, stdio: "inherit" });
    check("npm run build:host 成功", buildHost.status === 0, "exit=" + buildHost.status);
    if (build.status !== 0 || buildHost.status !== 0) {
      blockedReason = "build failed";
      throw new Error("build failed");
    }
  }
  hostExe = findNewestHostExe(root);
  check("native host exe 存在", !!hostExe && fs.existsSync(hostExe), hostExe || "missing");
  if (!hostExe) {
    blockedReason = "native host exe missing";
    throw new Error("native host exe missing");
  }
  report.hostExe = hostExe;
  registration = registerHost(hostExe);
  fixture = await startFixture();
  if (LONGRUN) {
    await runLongRun(fixture);
  } else {
    for (const mode of MODES) {
      if (mode !== "normal" && mode !== "agent") {
        check("未知 mode: " + mode, false);
        continue;
      }
      await runMode(mode, fixture);
    }
  }
} catch (error) {
  if (!blockedReason) {
    failed++;
    failures.push("prerequisite failure");
    console.error("FAIL | prerequisite :: " + (error instanceof Error ? error.stack : String(error)));
  }
} finally {
  for (const record of [...browserRecords]) {
    const stopped = stopTestProcess(record, { reason: "host-restart-e2e.finally" });
    if (!stopped.stopped && stopped.reason !== "already-exited") console.error("[cleanup] browser not stopped: " + JSON.stringify(stopped));
  }
  await sleep(800);
  if (hostExe) {
    const parents = [...browserRecords].map((record) => record.pid);
    // Records are already removed on exit; also use any session pid from the report.
    for (const session of report.sessions) {
      const pid = session.initial?.session?.pid;
      if (pid && pidAlive(pid)) {
        const kill = stopVerifiedPid({ pid, expectedExePath: hostExe, reason: "host-restart-e2e.finally-host" });
        if (!kill.stopped && kill.reason !== "already-exited") console.error("[cleanup] host not stopped: " + JSON.stringify(kill));
      }
    }
    void parents;
  }
  if (registration?.backupFile) {
    try {
      report.registration.rollback = rollbackHost(registration.backupFile, report.registration.beforeValues);
    } catch (error) {
      failed++;
      failures.push("rollback failed");
      console.error("FAIL | rollback :: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  try { fixture?.server.close(); } catch {}
  report.finishedAt = nowIso();
  report.checks = { passed, failed, failures: [...failures] };
  report.verdict = blockedReason ? "BLOCKED" : failed ? "FAIL" : "PASS";
  saveArtifact("report.json", report);
  saveArtifact("checks.json", checkLog);
  try {
    const logsDir = "D:\\c\\logs";
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "browserpilot-host-restart-" + runId + ".json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  } catch (error) {
    console.error("[evidence] copy failed: " + (error instanceof Error ? error.message : String(error)));
  }
  console.log("\nartifacts -> " + artifactsDir);
  console.log("\n" + report.verdict + " " + passed + "/" + (passed + failed) + " checks");
  if (failures.length) console.log("failed: " + failures.join("; "));
  process.exit(report.verdict === "PASS" ? 0 : 1);
}




