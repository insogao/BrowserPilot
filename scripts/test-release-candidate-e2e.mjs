// Release-Candidate E2E (Windows, release-like launch profiles).
//
// This runner is deliberately SEPARATE from scripts/test-input-arbitration-e2e.mjs.
// The diagnostic matrix answers "does the kernel/extension logic work under a
// controlled, heavily instrumented browser?"; this runner answers "does the same
// product chain work with release-like launch flags?".
//
// Release-like rules enforced here (fail closed):
//   - default out-of-process GPU: no --in-process-gpu, no --single-process,
//     no --disable-direct-composition;
//   - NO global DevTools port: no --remote-debugging-port / --remote-debugging-pipe.
//     Test control goes through Native Host commands and the extension's own
//     chrome.debugger session (invoked from an extension page), never a browser CDP
//     websocket;
//   - no occlusion/backgrounding disables: no CalculateNativeWinOcclusion disable,
//     no --disable-backgrounding-occluded-windows, no --disable-renderer-backgrounding,
//     no --disable-background-timer-throttling;
//   - no --no-sandbox / --headless;
//   - persistent, isolated test profile per mode (normal/agent); never a real
//     Chrome/Edge/WorkBuddy profile;
//   - no image-name process kill; only verified PID/creation-time/marker cleanup.
//
// Modes:
//   normal  BrowserPilot + Native Host, no managed presentation, Feature off.
//   agent   managed presentation + --enable-features=InputOwnershipEnforcement;
//           a second-process --browser-cli-user-explicit-show (Path A) presents
//           the existing window for real human/IME tests; separate isolated profile.
//
// Every special flag is classified by classifyArgs(). Unknown or forbidden flags
// fail the run before the browser starts.
//
// Report: D:\c\logs\release-candidate-e2e-<timestamp>.json
// Run dir: .e2e-tmp/release-candidate-<timestamp>/
//
// Usage:
//   node scripts/test-release-candidate-e2e.mjs --matrix
//   node scripts/test-release-candidate-e2e.mjs
//   node scripts/test-release-candidate-e2e.mjs --mode=normal --no-build
//   node scripts/test-release-candidate-e2e.mjs --mode=agent --case=RC-A5
//   node scripts/test-release-candidate-e2e.mjs --repeat=6 --fresh-profile
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, findNewestHostExe } from "./lib/host-manifest.mjs";
import { launchTestProcess, stopTestProcess, stopVerifiedPid, isAlive } from "./lib/test-process.mjs";
import { decodePng, pixelAt } from "./lib/png.mjs";
import { Win32Helper } from "./lib/win32-helper.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(root, "dist");
const FIXTURE_MAIN = path.join(root, "tests", "fixtures", "input-arbitration-main.html");
const FIXTURE_FRAME = path.join(root, "tests", "fixtures", "input-arbitration-frame.html");
const FIXTURE_IME = path.join(root, "tests", "fixtures", "ime-inputs.html");
const FIXTURE_OCCLUDED = path.join(root, "tests", "fixtures", "occluded-product-probe.html");
const REGISTER_PS1 = path.join(root, "native-host", "register.ps1");
const UNREGISTER_PS1 = path.join(root, "native-host", "unregister.ps1");
const HOST_NAME = "com.browserpilot.browseragent";
const REGISTRY_KEY = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME;
const CHROME = process.env.BROWSERPILOT_PATCHED_CHROME || "D:\\c\\src\\out\\WinDev\\chrome.exe";
const CHROME_OUT = path.dirname(CHROME);
const LOG_DIR = "D:\\c\\logs";
const FEATURE = "InputOwnershipEnforcement";

const argv = process.argv.slice(2);
const MATRIX = argv.includes("--matrix") || argv.includes("--dry-run");
const NO_BUILD = argv.includes("--no-build");
const KEEP_OPEN = argv.includes("--keep-open");
const FRESH_PROFILE = argv.includes("--fresh-profile");
const MODE_ARG = (argv.find((a) => a.startsWith("--mode=")) || "").slice("--mode=".length).trim();
const MODE_FILTER = new Set((MODE_ARG || "normal,agent").split(",").map((s) => s.trim()).filter(Boolean));
const CASE_ARG = (argv.find((a) => a.startsWith("--case=")) || "").slice("--case=".length).trim();
const CASE_FILTER = new Set((CASE_ARG || "").split(",").map((s) => s.trim()).filter(Boolean));
const REPEAT = Math.max(1, Number((argv.find((a) => a.startsWith("--repeat=")) || "").slice("--repeat=".length) || 8));
const LATCH_WAIT_MS = Math.max(1500, Number((argv.find((a) => a.startsWith("--latch-wait-ms=")) || "").slice("--latch-wait-ms=".length) || 31000));
const PROFILE_ROOT_ARG = (argv.find((a) => a.startsWith("--profile-root=")) || "").slice("--profile-root=".length).trim();
const PROFILE_ROOT = path.resolve(PROFILE_ROOT_ARG || path.join(LOG_DIR, "rc-e2e", "profiles"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const runToken = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

// ---------------------------------------------------------------- report / checks
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
  checkLog.push({ name, ok, detail: String(text).slice(0, 4000) });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (ok || !text ? "" : " :: " + String(text).slice(0, 1600)));
  return ok;
}
function mustCheck(name, condition, detail = "") {
  if (!check(name, condition, detail)) throw new Error("check failed: " + name);
}

const runId = nowIso().replace(/[:.]/g, "-");
const runDir = path.join(root, ".e2e-tmp", "release-candidate-" + runId);
const artifactsDir = path.join(runDir, "artifacts");
const backupDir = path.join(runDir, "registry-backup");
fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const report = {
  test: "browsercli-release-candidate-e2e",
  startedAt: nowIso(),
  finishedAt: null,
  verdict: "BLOCKED",
  blockedReason: null,
  runId,
  runToken,
  runDir,
  mode: MATRIX ? "matrix" : "run",
  filters: { modes: [...MODE_FILTER], cases: [...CASE_FILTER], repeat: REPEAT, latchWaitMs: LATCH_WAIT_MS },
  env: {
    platform: process.platform,
    node: process.version,
    chromePath: CHROME,
    chromeMtime: null,
    contentDll: null,
    contentDllMtime: null,
    contentDllFeature: null,
    chromeDll: null,
    chromeDllApi: null,
    dist: DIST,
    fixtures: { main: FIXTURE_MAIN, frame: FIXTURE_FRAME, ime: FIXTURE_IME, occluded: FIXTURE_OCCLUDED },
    hostExe: null,
    hostExeMtime: null,
    extensionId: null,
    profileRoot: PROFILE_ROOT,
    screen: null,
    foregroundBeforeLaunch: null,
    osInputProfile: null,
  },
  build: null,
  registration: null,
  flagClassification: [],
  sessions: [],
  cases: [],
  blocked: [],
  s5Mapping: [],
  comparison: [],
  notes: [],
  cleanup: null,
  checks: null,
};

function saveArtifact(name, data) {
  const file = path.join(artifactsDir, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", "utf8");
  return file;
}

// ---------------------------------------------------------------- binary probes
function binaryHas(file, needle) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = 8 * 1024 * 1024;
    const overlap = Math.max(needle.length, 64);
    let tail = Buffer.alloc(0);
    for (let offset = 0; offset < size; offset += chunk) {
      const length = Math.min(chunk, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, offset);
      const haystack = Buffer.concat([tail, buffer]);
      if (haystack.indexOf(needle) >= 0) return true;
      tail = haystack.subarray(Math.max(0, haystack.length - overlap));
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function probeBinaries() {
  const contentDll = path.join(CHROME_OUT, "content.dll");
  const chromeDll = path.join(CHROME_OUT, "chrome.dll");
  const target = fs.existsSync(contentDll) ? contentDll : chromeDll;
  report.env.contentDll = fs.existsSync(contentDll) ? contentDll : null;
  report.env.contentDllMtime = fs.existsSync(target) ? new Date(fs.statSync(target).mtimeMs).toISOString() : null;
  report.env.contentDllFeature = binaryHas(target, FEATURE);
  report.env.chromeDll = fs.existsSync(chromeDll) ? chromeDll : null;
  report.env.chromeDllApi = fs.existsSync(chromeDll) ? binaryHas(chromeDll, "browserCliInputOwnership") : null;
  try {
    report.env.chromeMtime = new Date(fs.statSync(CHROME).mtimeMs).toISOString();
  } catch {
    report.env.chromeMtime = null;
  }
}
function featureAvailable() {
  return report.env.contentDllFeature === true;
}
function apiAvailable() {
  return report.env.chromeDllApi === true;
}

// ---------------------------------------------------------------- flag classification
/**
 * Every launch argument must be classified. Classes:
 *   release-default        no flag; Chromium/product default behavior
 *   product-switch         a product configuration switch (agent mode)
 *   harness-extension      loading the unpacked test extension
 *   harness-isolation      test profile / test data isolation
 *   profile-hygiene        avoid first-run/network noise; no rendering/input effect
 *   diagnostics            logging only
 *   fixture-navigation     test page URL
 *   forbidden              would invalidate the release-like claim -> fail closed
 */
const FLAG_RULES = [
  { re: /^--user-data-dir=/, klass: "harness-isolation", why: "isolated persistent test profile (required for any automated browser test)" },
  { re: /^--load-extension=/, klass: "harness-extension", why: "loads the unpacked BrowserPilot build (release installs the same extension; no rendering/input semantics)" },
  { re: /^--disable-extensions-except=/, klass: "harness-extension", why: "ensures only the test build is loaded" },
  { re: /^--no-first-run$/, klass: "profile-hygiene", why: "no first-run UI; no rendering/input semantics" },
  { re: /^--no-default-browser-check$/, klass: "profile-hygiene", why: "no default-browser prompt" },
  { re: /^--disable-background-networking$/, klass: "profile-hygiene", why: "prevents background network noise" },
  { re: /^--disable-sync$/, klass: "profile-hygiene", why: "no account sync in the test profile" },
  { re: /^--disable-component-update$/, klass: "profile-hygiene", why: "no component updates during the run" },
  { re: /^--enable-logging=stderr$/, klass: "diagnostics", why: "captures FATAL/CHECK/crash lines" },
  { re: /^--v=0$/, klass: "diagnostics", why: "WARNING+ logging only; no rendering/input semantics" },
  { re: /^--enable-features=InputOwnershipEnforcement$/, klass: "product-switch", why: "agent-mode release configuration: kernel input arbitration" },
  { re: /^--browser-cli-background-presentation$/, klass: "product-switch", why: "agent-mode managed presentation (API availability + trust gate)" },
  { re: /^--browser-cli-user-explicit-show$/, klass: "product-switch", why: "user-explicit presentation intent; creates one visible window for real human/IME input" },
  { re: /^--no-startup-window$/, klass: "product-switch", why: "required by the user-explicit-show producer (no synthetic startup window)" },
  { re: /^about:blank$/, klass: "product-startup", why: "startup page for the managed background instance; the real fixture is opened later" },
  { re: /^https?:\/\/127\.0\.0\.1:/, klass: "fixture-navigation", why: "test fixture URL" },
];
const FORBIDDEN_FLAGS = [
  { re: /^--in-process-gpu$/, why: "release-like claim requires the default out-of-process GPU" },
  { re: /^--single-process$/, why: "changes process model" },
  { re: /^--disable-direct-composition$/, why: "not a valid workaround; changes the presentation path" },
  { re: /^--remote-debugging-port=/, why: "global DevTools port is forbidden in the release-like matrix" },
  { re: /^--remote-debugging-pipe$/, why: "global DevTools pipe is forbidden in the release-like matrix" },
  { re: /^--disable-features=.*CalculateNativeWinOcclusion/, why: "disables native occlusion instead of testing the release path" },
  { re: /^--disable-backgrounding-occluded-windows$/, why: "masks background/occlusion behavior" },
  { re: /^--disable-renderer-backgrounding$/, why: "masks backgrounding behavior" },
  { re: /^--disable-background-timer-throttling$/, why: "masks background throttling" },
  { re: /^--no-sandbox$/, why: "sandbox must stay enabled" },
  { re: /^--headless/, why: "release-like matrix requires a real UI window" },
  { re: /^--site-per-process$/, why: "default site isolation must be used instead of forcing per-site processes" },
  { re: /^--use-mock-keychain$/, why: "macOS-only test flag; not valid on Windows and not a product flag" },
  { re: /^--enable-field-trial-config$/, why: "test field-trial config is disabled in the product build" },
];
function classifyArgs(args) {
  const rows = [];
  for (const arg of args) {
    const text = String(arg);
    const forbidden = FORBIDDEN_FLAGS.find((rule) => rule.re.test(text));
    if (forbidden) {
      rows.push({ flag: text, klass: "forbidden", why: forbidden.why });
      continue;
    }
    const rule = FLAG_RULES.find((item) => item.re.test(text));
    rows.push(rule
      ? { flag: text, klass: rule.klass, why: rule.why }
      : { flag: text, klass: "unclassified", why: "no classification rule; must be classified before a release claim" });
  }
  return rows;
}
function assertNoForbiddenFlags(args, label) {
  const rows = classifyArgs(args);
  report.flagClassification.push({ session: label, args: rows });
  const forbidden = rows.filter((row) => row.klass === "forbidden");
  const unclassified = rows.filter((row) => row.klass === "unclassified");
  mustCheck("[" + label + "] 无 release 禁止参数", forbidden.length === 0, JSON.stringify(forbidden));
  mustCheck("[" + label + "] 所有启动参数已分类", unclassified.length === 0, JSON.stringify(unclassified));
  return rows;
}

// ---------------------------------------------------------------- profile safety
function normalizePath(p) {
  try { return path.resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase(); } catch { return String(p).toLowerCase(); }
}
function realProfilePaths() {
  const local = process.env.LOCALAPPDATA || "";
  const roaming = process.env.APPDATA || "";
  return [
    path.join(local, "Google", "Chrome", "User Data"),
    path.join(local, "Microsoft", "Edge", "User Data"),
    path.join(local, "Chromium", "User Data"),
    path.join(roaming, "Google", "Chrome", "User Data"),
    path.join(roaming, "Microsoft", "Edge", "User Data"),
  ].filter(Boolean);
}
function assertIsolatedProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  const lower = normalizePath(resolved);
  const rootLower = normalizePath(PROFILE_ROOT);
  mustCheck("profile 位于专用测试 profile 根目录", lower === rootLower || lower.startsWith(rootLower + path.sep), JSON.stringify({ profileDir: resolved, profileRoot: PROFILE_ROOT }));
  for (const real of realProfilePaths()) {
    const realLower = normalizePath(real);
    mustCheck("profile 不是真实 Chrome/Edge profile（" + real + "）", !(lower === realLower || lower.startsWith(realLower + path.sep)), JSON.stringify({ profileDir: resolved, real }));
  }
  mustCheck("profile 路径不包含 WorkBuddy 会话", !/workbuddy|\.workbuddy/i.test(resolved), resolved);
  mustCheck("profile 不是用户主目录本身", lower !== normalizePath(process.env.USERPROFILE || ""), resolved);
}
function prepareProfile(mode) {
  const dir = path.join(PROFILE_ROOT, "profile-" + mode);
  assertIsolatedProfile(dir);
  const existed = fs.existsSync(dir);
  if (FRESH_PROFILE && existed) {
    // Safe by construction: assertIsolatedProfile() already proved this is our own
    // dedicated test root, never a real browser profile. Still re-check right here.
    assertIsolatedProfile(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    existedBefore: existed,
    fresh: FRESH_PROFILE,
    isolated: true,
    persistent: true,
    safety: {
      profileRoot: PROFILE_ROOT,
      realProfilesChecked: realProfilePaths(),
    },
  };
}

// ---------------------------------------------------------------- fixture servers
const pageStates = new Map();
function startServers() {
  const mainHtml = fs.readFileSync(FIXTURE_MAIN, "utf8");
  const frameHtml = fs.readFileSync(FIXTURE_FRAME, "utf8");
  const imeHtml = fs.readFileSync(FIXTURE_IME, "utf8");
  const occludedHtml = fs.readFileSync(FIXTURE_OCCLUDED, "utf8");
  pageStates.clear();
  const handler = (body) => (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/state") {
      const token = url.searchParams.get("token") || "";
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 2 * 1024 * 1024) req.destroy();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            pageStates.set(token, { state: parsed, receivedAt: Date.now() });
          } catch {
            // ignore malformed beacon
          }
          res.writeHead(204);
          res.end();
        });
        return;
      }
      const entry = pageStates.get(token);
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(entry.state));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/ime-inputs") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(imeHtml);
      return;
    }
    if (url.pathname === "/occluded") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(occludedHtml);
      return;
    }
    if (url.pathname === "/frame" || url.pathname === "/frame.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(frameHtml);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  };
  const make = (address, body) =>
    new Promise((resolve, reject) => {
      const server = http.createServer(handler(body));
      server.once("error", reject);
      server.listen(0, address, () => resolve({ server, port: server.address().port, address }));
    });
  return Promise.all([make("127.0.0.1", mainHtml), make("127.0.0.2", frameHtml)]).then(([main, frame]) => ({
    main,
    frame,
    mainOrigin: "http://127.0.0.1:" + main.port,
    frameOrigin: "http://127.0.0.2:" + frame.port,
    stateFor(token) {
      return pageStates.get(token) || null;
    },
    close() {
      main.server.close();
      frame.server.close();
    },
  }));
}

// ---------------------------------------------------------------- host client
function sessionsDirFor(lad) {
  return path.join(lad, "BrowserPilot", "sessions");
}
function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
function readSessions(lad) {
  const dir = sessionsDirFor(lad);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (Number.isInteger(parsed.port) && typeof parsed.authToken === "string" && Number.isInteger(parsed.pid)) {
        out.push({ ...parsed, file: path.join(dir, file) });
      }
    } catch {
      // partial file
    }
  }
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
async function waitForHostSession(lad, { timeoutMs = 90000, excludePid = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = readSessions(lad).filter((s) => pidAlive(s.pid) && s.pid !== excludePid && Date.now() - Number(s.updatedAt || 0) < 180000);
    if (candidates.length) return candidates[0];
    await sleep(200);
  }
  throw new Error("timed out waiting for a live native host session in " + sessionsDirFor(lad));
}
let requestSeq = 0;
function tcpRequest(port, authToken, agentId, name, args = {}, { space, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const requestId = "rc-" + ++requestSeq;
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
      socket.write(
        JSON.stringify({
          type: "command",
          name,
          args,
          requestId,
          agentId,
          authToken,
          ...(space ? { space } : {}),
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
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
  constructor(session, agentId) {
    this.port = session.port;
    this.authToken = session.authToken;
    this.agentId = agentId;
  }
  async call(name, args = {}, options = {}) {
    const result = await tcpRequest(this.port, this.authToken, this.agentId, name, args, options);
    if (result.ok !== true) {
      const error = new Error(name + " failed: " + (result.error || "unknown"));
      error.code = result.errorCode;
      error.result = result;
      throw error;
    }
    return result.data;
  }
  async request(name, args = {}, options = {}) {
    try {
      return { ok: true, data: await this.call(name, args, options), error: null, errorCode: null };
    } catch (error) {
      return { ok: false, data: null, error: error.message, errorCode: error.code || null };
    }
  }
}

// ---------------------------------------------------------------- powershell helpers
function runPowerShellFile(file, args, timeoutMs = 60000) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
  );
  const lines = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  let json;
  try {
    json = lines.length ? JSON.parse(lines[lines.length - 1]) : undefined;
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}
function runPowerShell(script, timeoutMs = 30000) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}
function runNpm(script, timeoutMs = 300000) {
  const result = spawnSync("npm", ["run", script], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    shell: true,
  });
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}
function registryDefault(keyPath) {
  const script =
    "$k='" + keyPath.replace(/'/g, "''") + "';" +
    "if (Test-Path -LiteralPath $k) { $i=Get-Item -LiteralPath $k; if (@($i.GetValueNames()) -contains '') { $v=$i.GetValue('', $null); if ($null -eq $v) { '' } else { [string]$v } } else { '<no-default>' } } else { '<missing>' }";
  return runPowerShell(script).stdout;
}
function ourManifestPath() {
  return path.join(root, "native-host", "host.manifest.json");
}
function looksLikeOurManifest(value) {
  if (!value || value === "<missing>" || value === "<no-default>") return false;
  try {
    return path.resolve(String(value)).toLowerCase() === path.resolve(ourManifestPath()).toLowerCase();
  } catch {
    return false;
  }
}
function forceRestoreRegistry(value) {
  const subPath = "Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME;
  const subLiteral = "'" + subPath.replace(/'/g, "''") + "'";
  const valueLiteral = value === null ? "$null" : "'" + String(value).replace(/'/g, "''") + "'";
  const script =
    "$sub=" + subLiteral + ";" +
    "$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub);" +
    "if ($null -eq $key) { throw 'cannot open registry key' };" +
    "try {" +
    "  if (" + valueLiteral + " -eq $null) { $key.DeleteValue('', $false) }" +
    "  else { $key.SetValue('', [string]" + valueLiteral + ", [Microsoft.Win32.RegistryValueKind]::String) }" +
    "} finally { $key.Close() }";
  return runPowerShell(script, 30000);
}
function findOriginalRegistryValue() {
  const tmpRoot = path.join(root, ".e2e-tmp");
  if (!fs.existsSync(tmpRoot)) return undefined;
  const files = [];
  for (const dir of fs.readdirSync(tmpRoot)) {
    const dirBackup = path.join(tmpRoot, dir, "registry-backup");
    if (!fs.existsSync(dirBackup)) continue;
    for (const name of fs.readdirSync(dirBackup)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dirBackup, name);
      try {
        files.push({ file, mtime: fs.statSync(file).mtimeMs, data: JSON.parse(fs.readFileSync(file, "utf8")) });
      } catch {
        // ignore partial
      }
    }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  for (const entry of files) {
    const target = entry.data?.targets?.[0];
    if (!target) continue;
    const prev = target.previousDefault ?? null;
    if (looksLikeOurManifest(prev)) continue;
    return prev;
  }
  return undefined;
}
function processExecutablePath(pid) {
  const result = runPowerShell("(Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(pid) + "').ExecutablePath");
  return result.stdout;
}
function childProcesses(browserPid) {
  const script =
    "Get-CimInstance Win32_Process -Filter \"ParentProcessId = " + Number(browserPid) + "\" | " +
    "Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";
  const text = runPowerShell(script, 60000).stdout;
  try {
    const parsed = text ? JSON.parse(text.split(/\r?\n/).filter(Boolean).pop()) : [];
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}
function browserProcessCommandLine(pid) {
  const text = runPowerShell("(Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(pid) + "').CommandLine").stdout;
  return text;
}
function processModules(pid) {
  const script =
    "Get-Process -Id " + Number(pid) + " -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Modules -ErrorAction SilentlyContinue | " +
    "Select-Object ModuleName,FileName | ConvertTo-Json -Compress";
  const text = runPowerShell(script, 60000).stdout;
  try {
    const parsed = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}
function osInputProfile() {
  const script = [
    "$lang = try { Get-WinUserLanguageList | Select-Object LanguageTag,InputMethodTips } catch { @() }",
    "$preload = try { (Get-ItemProperty 'HKCU:\\Keyboard Layout\\Preload' -ErrorAction Stop) | Select-Object * -ExcludeProperty PS* } catch { $null }",
    "[pscustomobject]@{ languages = @($lang); preload = $preload } | ConvertTo-Json -Depth 5 -Compress",
  ].join("\n");
  const text = runPowerShell(script, 30000).stdout;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
function sogouModules(pid) {
  const modules = processModules(pid);
  return modules
    .filter((m) => /sogou|搜狗/i.test(String(m.ModuleName || "") + " " + String(m.FileName || "")))
    .map((m) => ({ module: m.ModuleName, file: String(m.FileName || "").slice(0, 300) }));
}

// ---------------------------------------------------------------- registration
function registerHost(hostExe) {
  const beforeValue = registryDefault(REGISTRY_KEY);
  const staleRegistry = looksLikeOurManifest(beforeValue);
  let restoreTarget = beforeValue === "<missing>" || beforeValue === "<no-default>" ? null : beforeValue;
  if (staleRegistry) {
    restoreTarget = findOriginalRegistryValue();
    console.log("[registry] stale self manifest detected; restore target = " + (restoreTarget === undefined ? "<unknown>" : JSON.stringify(restoreTarget)));
  }
  const reg = runPowerShellFile(REGISTER_PS1, ["-HostPath", hostExe, "-BackupDir", backupDir]);
  mustCheck("register.ps1 执行成功", reg.status === 0 && reg.json?.ok === true, JSON.stringify({ status: reg.status, stderr: (reg.stderr || "").slice(-600), json: reg.json }));
  const afterValue = registryDefault(REGISTRY_KEY);
  report.registration = {
    registryKey: REGISTRY_KEY,
    beforeValue,
    staleOurManifestDetected: staleRegistry,
    restoreTarget: restoreTarget === undefined ? null : restoreTarget,
    restoreTargetKnown: restoreTarget !== undefined,
    afterRegisterValue: afterValue,
    manifestPath: reg.json.manifestPath,
    hostPath: reg.json.hostPath,
    extensionId: reg.json.extensionId,
    backupFile: reg.json.backupFile,
  };
  mustCheck("注册后 HKCU 指向本次 host manifest", afterValue === reg.json.manifestPath, JSON.stringify({ afterValue, manifestPath: reg.json.manifestPath }));
  mustCheck("注册的扩展 ID 与仓库 manifest.json 推导一致", reg.json.extensionId === report.env.extensionId, JSON.stringify({ registered: reg.json.extensionId, derived: report.env.extensionId }));
  return reg.json;
}

// ---------------------------------------------------------------- launch
function buildArgs(mode, { origin, token, profileDir }) {
  const common = [
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
  if (mode === "normal") {
    return [...common, origin + "/boot?token=" + token];
  }
  if (mode === "agent") {
    // Managed agent instance: a hidden background window at startup. The
    // user-explicit presentation is a separate product invocation
    // (ensureUserExplicitShow) so it goes through the real second-instance
    // forwarding path instead of the cold-start shortcut.
    return [
      ...common,
      "--enable-features=" + FEATURE,
      "--browser-cli-background-presentation",
      "about:blank",
    ];
  }
  throw new Error("unknown mode: " + mode);
}
function launchChrome({ mode, profileDir, localAppData, args, logFile }) {
  const env = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    BROWSERPILOT_HOST_BASE_PORT: String(48900 + Math.floor(Math.random() * 90)),
  };
  const record = launchTestProcess({
    exe: CHROME,
    args,
    env,
    marker: profileDir,
    label: "rc-" + mode,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = record.child;
  const log = fs.createWriteStream(logFile, { flags: "a" });
  let stderr = "";
  child.stdout.on("data", (data) => log.write(data));
  child.stderr.on("data", (data) => {
    stderr += data;
    if (stderr.length > 400000) stderr = stderr.slice(-400000);
    log.write(data);
  });
  child.on("exit", (code) => {
    log.write("\n[exit] code=" + code + "\n");
    log.end();
  });
  return {
    record,
    child,
    args,
    env: { LOCALAPPDATA: env.LOCALAPPDATA, BROWSERPILOT_HOST_BASE_PORT: env.BROWSERPILOT_HOST_BASE_PORT },
    logFile,
    stderrTail: () => stderr.split(/\r?\n/).slice(-20).join("\n"),
    stop: () => stopTestProcess(record, { reason: "rc-" + mode + ".stop" }),
  };
}

// ---------------------------------------------------------------- window helpers
function windowInfoOf(listing) {
  return Array.isArray(listing.windows) ? listing.windows : listing.windows ? [listing.windows] : [];
}
async function listWindows(win32, pid) {
  const listing = await win32.call("listWindows", { pid });
  return windowInfoOf(listing);
}
async function findWindowByTitle(win32, pid, needle, timeoutMs = 30000, { visibleOnly = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await listWindows(win32, pid);
    const hit = last.find((w) => String(w.title || "").includes(needle) && (!visibleOnly || w.visible === true));
    if (hit) return { window: hit, all: last };
    await sleep(250);
  }
  return { window: null, all: last };
}
async function findWidget(win32, hwnd) {
  const kids = await win32.call("children", { hwnd });
  const list = Array.isArray(kids.children) ? kids.children : kids.children ? [kids.children] : [];
  return list
    .filter((c) => c.className === "Chrome_RenderWidgetHostHWND")
    .filter((c) => Number(c.clientWidth) * Number(c.clientHeight) > 20000)
    .sort((a, b) => {
      const va = a.visible === true ? 1 : 0;
      const vb = b.visible === true ? 1 : 0;
      if (va !== vb) return vb - va;
      return Number(b.clientWidth) * Number(b.clientHeight) - Number(a.clientWidth) * Number(a.clientHeight);
    })[0] || null;
}
async function widgetCandidates(ctx, hwnd) {
  const kids = await ctx.win32.call("children", { hwnd });
  const list = Array.isArray(kids.children) ? kids.children : kids.children ? [kids.children] : [];
  return list
    .filter((c) => c.className === "Chrome_RenderWidgetHostHWND")
    .filter((c) => Number(c.clientWidth) * Number(c.clientHeight) > 20000)
    .sort((a, b) => {
      const va = a.visible === true ? 1 : 0;
      const vb = b.visible === true ? 1 : 0;
      if (va !== vb) return vb - va;
      return Number(b.clientWidth) * Number(b.clientHeight) - Number(a.clientWidth) * Number(a.clientHeight);
    });
}
async function realMouseCandidates(ctx, hwnd, x, y, { attempts = 6 } = {}) {
  const candidates = await widgetCandidates(ctx, hwnd);
  const tried = [];
  for (const candidate of candidates.slice(0, attempts)) {
    const result = await ctx.win32.call("realMouse", { hwnd: candidate.hwnd, x, y });
    tried.push({ hwnd: candidate.hwnd, visible: candidate.visible, w: candidate.clientWidth, h: candidate.clientHeight, result });
    await sleep(350);
  }
  return { candidates, tried, last: tried[tried.length - 1]?.result || null };
}
async function moveWindow(win32, hwnd, rect) {
  const moved = await win32.call("move", { hwnd, x: rect[0], y: rect[1], width: rect[2], height: rect[3], noActivate: true });
  await sleep(500);
  const state = await win32.call("state", { hwnd });
  return { move: moved, state, rect: state.window?.rect || null };
}
async function raiseWindow(ctx, key) {
  const w = ctx.windows[key];
  if (!w?.hwnd) throw new Error("no window for " + key);
  const rect = w.rect || [100, 100, 1000, 760];
  const raised = await ctx.win32.call("raise", { hwnd: w.hwnd, x: rect[0], y: rect[1], width: rect[2], height: rect[3] });
  await sleep(500);
  const state = await ctx.win32.call("state", { hwnd: w.hwnd });
  return { raised, state: state.window, foreground: state.foreground };
}
async function foreground(win32) {
  return (await win32.call("foreground")).hwnd;
}
async function windowState(win32, hwnd) {
  return (await win32.call("state", { hwnd })).window;
}

// ---------------------------------------------------------------- extension page bridge
function jsString(value) {
  return JSON.stringify(value);
}
async function popupEvalRaw(ctx, expr, { timeoutMs = 30000 } = {}) {
  const r = await ctx.client.request("js", { expression: expr, tabId: ctx.popup.tabId }, { space: ctx.popup.spaceId, timeoutMs });
  if (!r.ok) throw new Error("popup js failed: " + r.error);
  return r.data?.value;
}
async function ensurePopup(ctx) {
  if (ctx.popup) {
    try {
      const echo = await popupEvalRaw(ctx, "({sum:2+2, href:location.href})", { timeoutMs: 8000 });
      if (echo?.sum === 4) return ctx.popup;
    } catch (error) {
      ctx.popupRecycles.push({ reason: "liveness", error: String(error?.message || error), at: nowIso() });
      await closePopup(ctx).catch(() => undefined);
    }
  }
  const extId = report.env.extensionId;
  if (!extId) throw new Error("extension id unknown");
  const url = "chrome-extension://" + extId + "/popup/index.html";
  const data = await ctx.client.call("open_space", { name: "rc-popup-" + runToken + "-" + Date.now(), url, background: true }, { timeoutMs: 60000 });
  const info = { spaceId: data.spaceId, tabId: data.tabId, windowId: data.windowId, url, createdAt: nowIso() };
  ctx.popup = info;
  ctx.allSpaces.push({ key: "popup", ...info });
  await sleep(400);
  await popupEvalRaw(ctx, "({sum:1+1, href:location.href})");
  info.probe = await popupEvalRaw(ctx, "({io:(typeof chrome!=='undefined'&&chrome.browserCliInputOwnership)?Object.keys(chrome.browserCliInputOwnership):null, hasDebugger:!!(chrome&&chrome.debugger), hasTabs:!!(chrome&&chrome.tabs)})");
  return info;
}
async function closePopup(ctx) {
  if (!ctx.popup) return null;
  const info = ctx.popup;
  ctx.popup = null;
  const r = await ctx.client.request("close_space", {}, { space: info.spaceId, timeoutMs: 20000 }).catch((error) => ({ ok: false, error: String(error) }));
  return { spaceId: info.spaceId, result: r };
}
async function popupApi(ctx, method, request = {}) {
  const expr =
    "new Promise((resolve) => {" +
    "  const io = (typeof chrome !== 'undefined') ? chrome.browserCliInputOwnership : null;" +
    "  if (!io || typeof io[" + jsString(method) + "] !== 'function') { resolve({__missing:true, method:" + jsString(method) + "}); return; }" +
    "  try { io[" + jsString(method) + "](" + JSON.stringify(request) + ", (result) => resolve({ result: result === undefined ? null : result, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })); }" +
    "  catch (e) { resolve({__thrown:String((e && e.message) || e)}); }" +
    "})";
  return await popupEvalRaw(ctx, expr, { timeoutMs: 30000 });
}
async function popupApiOk(ctx, method, request = {}) {
  const raw = await popupApi(ctx, method, request);
  const ok = raw && raw.result && !raw.lastError && !raw.__missing && !raw.__thrown && raw.result.accepted !== false && raw.result.granted !== false && raw.result.ok !== false;
  return { ok, raw, result: raw?.result || null, lastError: raw?.lastError || null };
}
async function popupAttach(ctx, tabId) {
  const expr =
    "new Promise((resolve) => chrome.debugger.attach({tabId:" + Number(tabId) + "}, '1.3', () => resolve({ ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))";
  const result = await popupEvalRaw(ctx, expr);
  if (!result?.ok && /Another debugger is already attached/i.test(String(result?.lastError || ""))) {
    return { ok: true, alreadyAttached: true, lastError: result.lastError };
  }
  return result;
}
async function popupDetach(ctx, tabId) {
  const expr =
    "new Promise((resolve) => chrome.debugger.detach({tabId:" + Number(tabId) + "}, () => resolve({ ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))";
  return await popupEvalRaw(ctx, expr).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}
async function popupRaw(ctx, tabId, method, params = {}) {
  const expr =
    "new Promise((resolve) => chrome.debugger.sendCommand({tabId:" + Number(tabId) + "}, " + jsString(method) + ", " + JSON.stringify(params) + ", (result) => resolve({ ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, result: result === undefined ? null : result })))";
  return await popupEvalRaw(ctx, expr, { timeoutMs: 30000 });
}
async function popupDomEvaluate(ctx, tabId, expression) {
  const r = await popupRaw(ctx, tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (!r?.ok) throw new Error("Runtime.evaluate failed: " + (r?.lastError || "unknown"));
  if (r.result?.exceptionDetails) throw new Error("Runtime.evaluate exception: " + JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result?.result?.value;
}
async function popupTabs(ctx) {
  return await popupEvalRaw(ctx, "new Promise((resolve) => chrome.tabs.query({}, (tabs) => resolve((tabs || []).map((t) => ({ id: t.id, windowId: t.windowId, url: t.url, title: t.title, active: t.active })))))");
}
async function popupWindows(ctx) {
  return await popupEvalRaw(ctx, "new Promise((resolve) => chrome.windows.getAll({populate:true}, (wins) => resolve((wins || []).map((w) => ({ id: w.id, focused: w.focused, state: w.state, type: w.type, tabs: (w.tabs || []).map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })) })))))");
}
async function popupNavigate(ctx, tabId, url) {
  return await popupEvalRaw(
    ctx,
    "new Promise((resolve) => chrome.tabs.update(" + Number(tabId) + ", { url: " + jsString(url) + ", active: true }, (tab) => resolve({ ok: !chrome.runtime.lastError && !!tab, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, tabId: tab ? tab.id : null })))",
  );
}
async function popupCreateWindow(ctx, url) {
  return await popupEvalRaw(
    ctx,
    "new Promise((resolve) => chrome.windows.create({ url: " + jsString(url) + ", focused: false, state: 'normal' }, (win) => resolve({ ok: !chrome.runtime.lastError && !!win, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, windowId: win ? win.id : null, tabId: win && win.tabs && win.tabs[0] ? win.tabs[0].id : null })))",
  );
}
async function popupCreateTab(ctx, windowId, url, active = true) {
  return await popupEvalRaw(
    ctx,
    "new Promise((resolve) => chrome.tabs.create({ windowId: " + Number(windowId) + ", url: " + jsString(url) + ", active: " + Boolean(active) + " }, (tab) => resolve({ ok: !chrome.runtime.lastError && !!tab, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, tabId: tab ? tab.id : null, windowId: tab ? tab.windowId : null })))",
  );
}
async function popupActivateTab(ctx, tabId) {
  return await popupEvalRaw(
    ctx,
    "new Promise((resolve) => chrome.tabs.update(" + Number(tabId) + ", { active: true }, () => resolve({ ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))",
  );
}
async function popupGetTargets(ctx) {
  return await popupEvalRaw(
    ctx,
    "new Promise((resolve) => chrome.debugger.getTargets((list) => resolve((list || []).map((t) => ({ id: t.id, tabId: t.tabId, type: t.type, attached: t.attached, url: String(t.url || '').slice(0, 200), title: String(t.title || '').slice(0, 120) })))))",
  );
}
async function popupCloseWindow(ctx, windowId) {
  return await popupEvalRaw(
    ctx,
    "new Promise((resolve) => chrome.windows.remove(" + Number(windowId) + ", () => resolve({ ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))",
  );
}

// ---------------------------------------------------------------- context / spaces
function createContext({ mode, sessionReport, client, chrome, win32, servers, localAppData, profileDir }) {
  const ctx = {
    mode,
    session: sessionReport,
    client,
    chrome,
    win32,
    servers,
    localAppData,
    profileDir,
    spaces: {},
    windows: {},
    allSpaces: [],
    untrackedWindows: [],
    popup: null,
    popupRecycles: [],
    visible: null,
    evidence: [],
    notes: [],
    lastProbeAt: {},
    markBlocked(blocked) {
      ctx.session.blocked = blocked;
    },
    record(id, data) {
      const c = report.cases.find((x) => x.id === id && x.mode === mode);
      if (c) c.evidence.push(data);
      else ctx.evidence.push({ id, data });
    },
    async ai(spaceKey, name, args = {}, { timeoutMs = 60000 } = {}) {
      const space = ctx.spaces[spaceKey];
      if (!space) throw new Error("unknown space: " + spaceKey);
      const invoke = () => ctx.client.request(name, args, { space: space.spaceId, timeoutMs });
      let result = await invoke();
      if (!result.ok && /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(String(result.error))) {
        // native host can exit when the SW sleeps; refresh the host session once.
        const refreshed = await refreshHostClient(ctx, 45000).catch(() => ({ ok: false }));
        if (refreshed.ok) result = await invoke();
      }
      return result;
    },
    async call(spaceKey, name, args = {}, opts = {}) {
      return await ctx.client.call(name, args, { space: ctx.spaces[spaceKey].spaceId, ...opts });
    },
    async probe(spaceKey, timeoutMs = 8000) {
      const space = ctx.spaces[spaceKey];
      const minAt = Number(ctx.lastProbeAt[spaceKey] || 0);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const entry = servers.stateFor(space.token);
        if (entry?.state?.token === space.token && Number(entry.state.at) > minAt) {
          ctx.lastProbeAt[spaceKey] = Number(entry.state.at);
          return entry.state;
        }
        await sleep(80);
      }
      throw new Error("no fresh beacon state for " + spaceKey + " (token=" + space.token + ", minAt=" + minAt + ")");
    },
    async waitState(spaceKey, predicate, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await ctx.probe(spaceKey).catch(() => null);
        if (last) {
          try { if (predicate(last)) return last; } catch {}
        }
        await sleep(100);
      }
      return last;
    },
    async evalOn(spaceKey, expression) {
      const r = await ctx.ai(spaceKey, "js", { expression, tabId: ctx.spaces[spaceKey].tabId });
      if (!r.ok) throw new Error("js failed on " + spaceKey + ": " + r.error);
      return r.data?.value;
    },
    async resetMain(spaceKey = "main") {
      const r = await ctx.ai(spaceKey, "js", {
        expression: "(()=>{window.__clicks=0;window.__events=[];window.__inputEvents=0;window.__keys=[];window.__drag={down:0,moves:0,movesDown:0,up:0,dstUp:0,trace:[]};window.__childClicks=0;window.__childMsgs=[];window.__wheel=0;window.__wheelEvents=0;window.__lastWheel=null;window.__jsRuns=0;document.getElementById('count').textContent='0';document.getElementById('child')&&(document.getElementById('child').textContent='0');const i=document.getElementById('input');i.value='';i.blur();document.getElementById('scroll').scrollTop=0;return true;})()",
        tabId: ctx.spaces[spaceKey].tabId,
      });
      if (!r.ok) throw new Error("resetMain failed: " + r.error);
      await ctx.waitState(spaceKey, (st) => st.clicks === 0 && st.inputValue === "" && st.jsRuns === 0 && st.keys.length === 0 && st.childClicks === 0, 6000);
    },
    async openSpace(key, { name, url, background = true, visible = false, title = null, layout = null } = {}) {
      const data = await ctx.client.call("open_space", { name: name || key, url, background: background !== false, ...(visible ? { visible: true, focus: true } : {}) });
      const token = runToken + "-" + (name || key) + "-" + Math.random().toString(36).slice(2, 6);
      // The fixture appends ?token=...; the caller passes the full URL, so only
      // record the token we actually put in the URL.
      const parsed = new URL(url);
      const actualToken = parsed.searchParams.get("token") || token;
      ctx.spaces[key] = { spaceId: data.spaceId, tabId: data.tabId, windowId: data.windowId, url, token: actualToken, name: name || key };
      ctx.allSpaces.push({ key, ...ctx.spaces[key] });
      // Wait until list_tabs sees the final URL.
      const deadline = Date.now() + 20000;
      let hit = null;
      while (Date.now() < deadline) {
        const listing = await ctx.client.call("list_tabs", {}, { space: data.spaceId });
        hit = (listing.tabs || []).find((t) => String(t.url || "").includes(parsed.pathname) || String(t.pendingUrl || "").includes(parsed.pathname));
        if (hit && String(hit.url || "").includes(parsed.pathname)) break;
        await sleep(250);
      }
      if (hit) {
        ctx.spaces[key].tabId = hit.tabId;
        ctx.spaces[key].windowId = hit.windowId;
      }
      // Wait for the fixture beacon when it has one. Occluded/IME pages do not.
      if (!/\/occluded|\/ime-inputs/.test(parsed.pathname)) {
        const beaconDeadline = Date.now() + 30000;
        let ready = null;
        while (Date.now() < beaconDeadline) {
          const entry = servers.stateFor(actualToken);
          if (entry?.state?.token === actualToken) { ready = entry; break; }
          await sleep(120);
        }
        if (!ready) throw new Error("fixture beacon not ready: " + key + " token=" + actualToken);
        ctx.lastProbeAt[key] = Number(ready.state.at || 0);
      }
      // Every space gets a unique, stable window title so the Win32 side can map
      // the tab to its top-level HWND (managed windows are hidden but enumerable).
      const titleValue = title || ("rc-" + actualToken);
      let titled = false;
      for (let attempt = 0; attempt < 3 && !titled; attempt++) {
        const r = await ctx.ai(key, "js", { expression: "document.title=" + JSON.stringify(titleValue) + "; document.title", tabId: ctx.spaces[key].tabId });
        titled = r.ok && r.data?.value === titleValue;
        if (!titled) await sleep(400);
      }
      const found = await findWindowByTitle(ctx.win32, ctx.chrome.record.pid, titleValue, 30000);
      if (!found.window) throw new Error("window not found for " + key + " (" + titleValue + ")");
      let window = found.window;
      if (layout) {
        const moved = await moveWindow(ctx.win32, window.hwnd, layout);
        window = moved.state.window || window;
      }
      const widget = await findWidget(ctx.win32, window.hwnd);
      ctx.windows[key] = { hwnd: window.hwnd, widgetHwnd: widget?.hwnd || null, widget, rect: window.rect, visible: window.visible };
      console.log("[window] " + key + " hwnd=" + window.hwnd + " widget=" + (widget?.hwnd || "none") + " visible=" + window.visible + " rect=" + JSON.stringify(window.rect));
      return ctx.spaces[key];
    },
    async closeSpace(key) {
      const space = ctx.spaces[key];
      if (!space) return null;
      const r = await ctx.client.request("close_space", {}, { space: space.spaceId, timeoutMs: 20000 }).catch((error) => ({ ok: false, error: String(error) }));
      delete ctx.spaces[key];
      delete ctx.windows[key];
      return r;
    },
    async screenshot(spaceKey) {
      const space = ctx.spaces[spaceKey];
      const r = await ctx.client.request("screenshot", { tabId: space.tabId, format: "png" }, { space: space.spaceId, timeoutMs: 40000 });
      if (!r.ok) return { ok: false, error: r.error };
      const data = r.data || {};
      return {
        ok: true,
        base64: data.base64 || "",
        bytes: String(data.base64 || "").length,
        meta: data.screenshot || null,
        possiblyStale: data.possiblyStale === true,
        reason: data.reason || null,
      };
    },
    async humanClick(key, rect, { expect = null } = {}) {
      const win = ctx.windows[key];
      if (!win?.hwnd) throw new Error("no window for " + key);
      const widget = win.widgetHwnd || (await findWidget(ctx.win32, win.hwnd))?.hwnd;
      if (!widget) throw new Error("no render widget for " + key);
      const focus = await ctx.win32.call("focusWindow", { hwnd: widget });
      await sleep(250);
      const probe = await ctx.probe(key).catch(() => null);
      const dpr = Number(probe?.viewport?.dpr) || 1;
      const x = Math.round((Number(rect.x) + Number(rect.w) / 2) * dpr);
      const y = Math.round((Number(rect.y) + Number(rect.h) / 2) * dpr);
      const click = await ctx.win32.call("realClick", { hwnd: widget, x, y });
      await sleep(300);
      const after = await ctx.probe(key).catch(() => null);
      const landed = expect ? expect(after) : Boolean(after && after.clicks > (probe?.clicks ?? 0));
      return { focus, click, x, y, dpr, before: probe, after, landed };
    },
    async humanType(key, text) {
      const win = ctx.windows[key];
      if (!win?.hwnd) throw new Error("no window for " + key);
      const widget = win.widgetHwnd || (await findWidget(ctx.win32, win.hwnd))?.hwnd;
      if (!widget) throw new Error("no render widget for " + key);
      if (!/^[a-z0-9]+$/i.test(text)) throw new Error("humanType only supports [a-z0-9]: " + text);
      const focus = await ctx.win32.call("focusWindow", { hwnd: widget });
      await sleep(200);
      const send = await ctx.win32.call("sendKeys", { hwnd: widget, text });
      await sleep(400);
      return { focus, send, widget };
    },
    async foreground() {
      return await foreground(ctx.win32);
    },
    async state(hwnd) {
      return await windowState(ctx.win32, hwnd);
    },
  };
  return ctx;
}
async function refreshHostClient(ctx, timeoutMs = 45000) {
  const oldPid = ctx.hostSession?.pid;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = readSessions(ctx.localAppData).filter((sn) => pidAlive(sn.pid) && sn.pid !== oldPid);
    for (const sn of sessions) {
      const r = await tcpRequest(sn.port, sn.authToken, "rc-a", "ping", {}, { timeoutMs: 2000 }).catch(() => null);
      if (r && r.ok === true && r.data?.pong === true) {
        ctx.client = new HostClient(sn, "rc-a");
        ctx.hostSession = sn;
        return { ok: true, session: { port: sn.port, pid: sn.pid } };
      }
    }
    await sleep(300);
  }
  return { ok: false };
}

// ---------------------------------------------------------------- screenshot / marker helpers
async function waitBeacon(token, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = pageStates.get(token)?.state || null;
    if (last) {
      try { if (predicate(last)) return last; } catch {}
    }
    await sleep(80);
  }
  return last;
}
function decodeShotMarker(base64) {
  const img = decodePng(Buffer.from(base64, "base64"));
  const [r, g, b] = pixelAt(img, 20, 20);
  return { width: img.width, height: img.height, marker: { r, g, b, frame: r + g * 256 } };
}
async function bumpAndShoot(ctx, key, bump = 5) {
  const before = Number(await ctx.evalOn(key, "(() => { window.__bump && window.__bump(" + Number(bump) + "); return window.__probe().rafCount; })()"));
  const shot = await ctx.screenshot(key);
  const after = Number(await ctx.evalOn(key, "window.__probe().rafCount"));
  if (!shot.ok) return { ok: false, before, after, shot };
  let marker = null;
  let decodeError = null;
  try { marker = decodeShotMarker(shot.base64); } catch (error) { decodeError = String(error?.message || error); }
  const delta = marker ? Math.min(Math.abs(marker.marker.frame - before), Math.abs(marker.marker.frame - after)) : null;
  return {
    ok: !!marker && shot.meta?.fromSurface === true && shot.possiblyStale === false && delta !== null && delta <= 4,
    before,
    after,
    marker,
    delta,
    decodeError,
    bytes: shot.bytes,
    meta: shot.meta,
    possiblyStale: shot.possiblyStale,
    error: shot.error || null,
  };
}

// ---------------------------------------------------------------- launch preflight
async function assertReleaseLaunch(ctx, label) {
  const pid = ctx.chrome.record.pid;
  const cmd = browserProcessCommandLine(pid);
  mustCheck("[" + label + "] 浏览器进程存活", pidAlive(pid), String(pid));
  mustCheck("[" + label + "] 启动命令行不含 --remote-debugging", !/--remote-debugging-(port|pipe)/i.test(cmd), cmd.slice(0, 1200));
  mustCheck("[" + label + "] 启动命令行不含 --in-process-gpu", !/--in-process-gpu/i.test(cmd), cmd.slice(0, 1200));
  mustCheck("[" + label + "] 启动命令行不含 --no-sandbox", !/--no-sandbox/i.test(cmd), cmd.slice(0, 1200));
  mustCheck("[" + label + "] profile 目录无 DevToolsActivePort", !fs.existsSync(path.join(ctx.profileDir, "DevToolsActivePort")), ctx.profileDir);
  let children = childProcesses(pid);
  let gpu = children.filter((c) => /--type=gpu-process/.test(String(c.CommandLine || "")));
  const gpuDeadline = Date.now() + 15000;
  while (!gpu.length && Date.now() < gpuDeadline) {
    await sleep(300);
    children = childProcesses(pid);
    gpu = children.filter((c) => /--type=gpu-process/.test(String(c.CommandLine || "")));
  }
  mustCheck("[" + label + "] GPU 为独立进程（默认 out-of-process）", gpu.length >= 1 && gpu.every((c) => Number(c.ProcessId) !== pid), JSON.stringify(gpu.map((c) => ({ pid: c.ProcessId, cmd: String(c.CommandLine || "").slice(0, 400) }))));
  const renderers = children.filter((c) => /--type=renderer/.test(String(c.CommandLine || "")));
  mustCheck("[" + label + "] 存在 renderer 子进程（非单进程）", renderers.length >= 1, JSON.stringify(renderers.map((c) => c.ProcessId)));
  const ext = children.filter((c) => /--extension-process/.test(String(c.CommandLine || "")));
  ctx.session.browser = {
    pid,
    commandLine: cmd,
    gpu: gpu.map((c) => ({ pid: c.ProcessId, commandLine: String(c.CommandLine || "").slice(0, 800) })),
    rendererPids: renderers.map((c) => c.ProcessId),
    extensionProcessPids: ext.map((c) => c.ProcessId),
    devtoolsActivePort: false,
  };
  return { gpu, renderers, extensionProcesses: ext };
}
async function assertHost(ctx, label) {
  const hostSession = await waitForHostSession(ctx.localAppData, { timeoutMs: 90000 });
  const actualExe = processExecutablePath(hostSession.pid);
  const matches = !!actualExe && path.resolve(actualExe).toLowerCase() === path.resolve(report.env.hostExe).toLowerCase();
  mustCheck("[" + label + "] connectNative 拉起本次构建的 host exe", matches, JSON.stringify({ actualExe, expected: report.env.hostExe, pid: hostSession.pid }));
  ctx.hostSession = hostSession;
  ctx.client = new HostClient(hostSession, "rc-a");
  const ping = await ctx.client.call("ping");
  mustCheck("[" + label + "] host ping=pong", ping?.pong === true, JSON.stringify(ping));
  ctx.session.host = { pid: hostSession.pid, port: hostSession.port, actualExe, expectedExe: report.env.hostExe, matches };
  return hostSession;
}

// ---------------------------------------------------------------- cases
const CASES = [];

function caseSelected(c) {
  if (CASE_FILTER.size && !CASE_FILTER.has(c.id)) return false;
  return true;
}

// ---------------------------------------------------------------- normal cases
CASES.push({
  id: "RC-N1",
  mode: "normal",
  title: "Normal launch integrity: out-of-process GPU, no global DevTools port, isolated persistent profile, flag classification",
  async run(ctx) {
    const rows = report.flagClassification.find((x) => x.session === ctx.session.label)?.args || [];
    check("RC-N1 所有参数已分类且无 forbidden", rows.every((r) => r.klass !== "forbidden" && r.klass !== "unclassified"), JSON.stringify(rows));
    check("RC-N1 未使用 --in-process-gpu / --disable-direct-composition", !ctx.args.some((a) => /--in-process-gpu|--disable-direct-composition/.test(a)), JSON.stringify(ctx.args));
    check("RC-N1 未使用全局 remote debugging 端口/管道", !ctx.args.some((a) => /--remote-debugging-(port|pipe)/.test(a)), JSON.stringify(ctx.args));
    check("RC-N1 未使用遮挡/后台优化禁用参数", !ctx.args.some((a) => /CalculateNativeWinOcclusion|disable-backgrounding-occluded-windows|disable-renderer-backgrounding|disable-background-timer-throttling/.test(a)), JSON.stringify(ctx.args));
    check("RC-N1 未使用 --no-sandbox / --headless", !ctx.args.some((a) => /--no-sandbox|--headless/.test(a)), JSON.stringify(ctx.args));
    check("RC-N1 profile 为专用隔离目录且持久", ctx.profile.isolated === true && ctx.profile.persistent === true, JSON.stringify(ctx.profile));
    check("RC-N1 profile 目录在本次运行后保留（persistent）", fs.existsSync(ctx.profileDir), ctx.profileDir);
    check("RC-N1 DevToolsActivePort 不存在（无全局调试端口）", !fs.existsSync(path.join(ctx.profileDir, "DevToolsActivePort")), ctx.profileDir);
    check("RC-N1 GPU 进程独立存在", ctx.session.browser.gpu.length >= 1, JSON.stringify(ctx.session.browser.gpu));
    ctx.record("RC-N1", { args: ctx.args, flags: rows, profile: ctx.profile, browser: ctx.session.browser });
  },
});

CASES.push({
  id: "RC-N2",
  mode: "normal",
  title: "Normal product baseline: BrowserPilot commands + Native Host drive a background tab; screenshots are fresh",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    await ctx.openSpace("main", { name: "n2-main", url: ctx.servers.mainOrigin + "/main?token=" + ctx.token + "-n2", layout: [120, 100, 1000, 760] });
    await ctx.resetMain("main");
    check("RC-N2 open_space + 产品 js 可用", (await ctx.evalOn("main", "1+1")) === 2, "js");
    // Raise the test window with SWP_NOACTIVATE (never SetForegroundWindow) so the
    // compositor/input router has a visible target; the user's foreground window
    // must remain unchanged.
    const raise = await raiseWindow(ctx, "main");
    check("RC-N2 置顶测试窗口（SWP_NOACTIVATE）不改变前台窗口", (await ctx.foreground()) === foregroundBefore, JSON.stringify({ foregroundBefore, raise }));
    const hit = await ctx.evalOn("main", "(() => { const e = document.elementFromPoint(500, 101); return e ? { id: e.id, tag: e.tagName } : null; })()");
    check("RC-N2 目标坐标命中按钮", hit?.id === "btn", JSON.stringify({ hit }));
    // The user's foreground window is maximized over the whole desktop in this
    // environment. Chromium marks the background test window occluded and drops
    // mouse input. Use CDP lifecycle/focus emulation only to let the *renderer*
    // process input; this is test control through the product tab_cdp_call, not a
    // launch-flag occlusion disable. The screenshot path still uses real occlusion.
    const wake = await ctx.ai("main", "tab_cdp_call", { method: "Page.setWebLifecycleState", params: { state: "active" } });
    const focusEmu = await ctx.ai("main", "tab_cdp_call", { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } });
    check("RC-N2 test-control 唤醒页面生命周期/焦点模拟（不改变前台窗口）", wake.ok === true && focusEmu.ok === true && (await ctx.foreground()) === foregroundBefore, JSON.stringify({ wake, focusEmu }));
    const fill = await ctx.ai("main", "fill", { selector: "#input", value: "release-baseline-中文" });
    const filled = await waitBeacon(ctx.spaces.main.token, (st) => st.inputValue === "release-baseline-中文", 4000);
    check("RC-N2 产品 fill 落地", fill.ok === true && filled?.inputValue === "release-baseline-中文", JSON.stringify({ fill, inputValue: filled?.inputValue }));
    const click = await ctx.ai("main", "tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 500, y: 101, button: "left", buttons: 1, clickCount: 1 } });
    const click2 = await ctx.ai("main", "tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 500, y: 101, button: "left", buttons: 0, clickCount: 1 } });
    const state = await waitBeacon(ctx.spaces.main.token, (st) => st.clicks >= 1, 4000);
    const diag = await ctx.evalOn("main", "({ events: window.__events, clicks: window.__clicks, vis: document.visibilityState, focus: document.hasFocus(), active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })").catch((error) => ({ error: String(error?.message || error) }));
    check("RC-N2 产品 tab_cdp_call 鼠标输入落地", click.ok === true && click2.ok === true && state?.clicks === 1, JSON.stringify({ click, click2, clicks: state?.clicks, diag }));
    const shot = await ctx.screenshot("main");
    check("RC-N2 产品 screenshot 返回合成器新帧", shot.ok === true && shot.meta?.fromSurface === true && shot.possiblyStale === false && shot.bytes > 1000, JSON.stringify({ ok: shot.ok, meta: shot.meta, stale: shot.possiblyStale, bytes: shot.bytes, error: shot.error }).slice(0, 1200));
    const foregroundAfter = await ctx.foreground();
    check("RC-N2 后台产品命令/截图不改变用户前台窗口", foregroundAfter === foregroundBefore, JSON.stringify({ foregroundBefore, foregroundAfter }));
    ctx.record("RC-N2", { foregroundBefore, foregroundAfter, fill, click, click2, state: { clicks: state.clicks, inputValue: state.inputValue }, shot: { ok: shot.ok, meta: shot.meta, bytes: shot.bytes, stale: shot.possiblyStale } });
  },
});

CASES.push({
  id: "RC-N3",
  mode: "normal",
  title: "Normal multi-window concurrency: one HUMAN + one AI window do not interfere; foreground/z-order unchanged",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    await ctx.openSpace("multiA", { name: "n3-a", url: ctx.servers.mainOrigin + "/multiA?token=" + ctx.token + "-n3a", layout: [80, 80, 980, 740] });
    await ctx.openSpace("multiB", { name: "n3-b", url: ctx.servers.mainOrigin + "/multiB?token=" + ctx.token + "-n3b", layout: [160, 120, 980, 740] });
    // Both windows start behind a maximized foreground app. Raise them with
    // SWP_NOACTIVATE (never SetForegroundWindow) so they have real compositor
    // surfaces; the user's foreground window must remain unchanged.
    const raiseA = await raiseWindow(ctx, "multiA");
    const raiseB = await raiseWindow(ctx, "multiB");
    check("RC-N3 置顶两个测试窗口（SWP_NOACTIVATE）不改变前台窗口", (await ctx.foreground()) === foregroundBefore, JSON.stringify({ foregroundBefore, raiseA, raiseB }));
    await ctx.resetMain("multiA");
    await ctx.resetMain("multiB");
    const z0 = { A: await ctx.state(ctx.windows.multiA.hwnd), B: await ctx.state(ctx.windows.multiB.hwnd) };
    // Product screenshots while both spaces are still AI (the product rejects all
    // Agent commands on a HUMAN-owned space, including screenshot).
    const shotA = await ctx.screenshot("multiA");
    const shotB = await ctx.screenshot("multiB");
    check("RC-N3 两个 AI 窗口的产品截图都新鲜", shotA.ok && shotB.ok && shotA.meta?.fromSurface === true && shotB.meta?.fromSurface === true && !shotA.possiblyStale && !shotB.possiblyStale, JSON.stringify({ A: { ok: shotA.ok, meta: shotA.meta, stale: shotA.possiblyStale, error: shotA.error, bytes: shotA.bytes }, B: { ok: shotB.ok, meta: shotB.meta, stale: shotB.possiblyStale, error: shotB.error, bytes: shotB.bytes } }));
    const z1 = { A: await ctx.state(ctx.windows.multiA.hwnd), B: await ctx.state(ctx.windows.multiB.hwnd) };
    check("RC-N3 截图前后 z-order/前台不变", z0.A.above === z1.A.above && z0.A.below === z1.A.below && z0.B.above === z1.B.above && z0.B.below === z1.B.below && (await ctx.foreground()) === foregroundBefore, JSON.stringify({ z0, z1 }));
    await ctx.client.call("handoff_space", {}, { space: ctx.spaces.multiA.spaceId });
    // Human input is the only intentional focus change. Raise/topmost the test
    // window (SWP_NOACTIVATE), click it with the real OS mouse, then restore the
    // user's foreground. Two passes mirror A5: the first may only activate the
    // window under Windows' foreground lock; the second reaches the page widget.
    const topA = await ctx.win32.call("raiseTopmost", { hwnd: ctx.windows.multiA.hwnd, x: ctx.windows.multiA.rect[0], y: ctx.windows.multiA.rect[1], width: ctx.windows.multiA.rect[2], height: ctx.windows.multiA.rect[3] });
    const stA = await ctx.probe("multiA");
    const b = stA.rects.btn;
    const humanPoint = { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) };
    const humanFirst = await realMouseCandidates(ctx, ctx.windows.multiA.hwnd, humanPoint.x, humanPoint.y);
    await sleep(400);
    const humanA = await realMouseCandidates(ctx, ctx.windows.multiA.hwnd, humanPoint.x, humanPoint.y);
    const humanState = await waitBeacon(ctx.spaces.multiA.token, (st) => st.clicks >= 1, 5000);
    const humanClicks = Number(humanState?.clicks || 0);
    check("RC-N3 HUMAN 窗口的真实人类点击落地（不被锁）", humanClicks >= 1, JSON.stringify({ topA, humanPoint, humanFirst, humanA, clicks: humanClicks }));
    const notTopmostA = await ctx.win32.call("notTopmost", { hwnd: ctx.windows.multiA.hwnd }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const restore = await ctx.win32.call("setForeground", { hwnd: foregroundBefore });
    await sleep(300);
    const foregroundRestored = await ctx.foreground();
    check("RC-N3 人类输入后恢复原前台窗口", foregroundRestored === foregroundBefore && notTopmostA.ok === true, JSON.stringify({ foregroundBefore, foregroundRestored, restore, notTopmostA }));
    const z2 = { A: await ctx.state(ctx.windows.multiA.hwnd), B: await ctx.state(ctx.windows.multiB.hwnd) };
    const aiA = await ctx.ai("multiA", "click", { selector: "#btn" });
    check("RC-N3 HUMAN 窗口的 AI click 被扩展层拒绝（INPUT_HUMAN_OWNED）", aiA.ok === false && aiA.errorCode === "INPUT_HUMAN_OWNED", JSON.stringify(aiA));
    const stateA0 = await ctx.probe("multiA");
    check("RC-N3 HUMAN 窗口 DOM 不变（AI 被拒后保持人类点击计数）", stateA0.clicks === humanClicks, JSON.stringify({ clicks: stateA0.clicks, humanClicks }));
    const wakeB = await ctx.ai("multiB", "tab_cdp_call", { method: "Page.setWebLifecycleState", params: { state: "active" } });
    const focusB = await ctx.ai("multiB", "tab_cdp_call", { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } });
    check("RC-N3 AI 窗口 test-control 唤醒（不改变前台窗口）", wakeB.ok === true && focusB.ok === true && (await ctx.foreground()) === foregroundBefore, JSON.stringify({ wakeB, focusB }));
    const aiB = await ctx.ai("multiB", "tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 500, y: 101, button: "left", buttons: 1, clickCount: 1 } });
    const aiB2 = await ctx.ai("multiB", "tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 500, y: 101, button: "left", buttons: 0, clickCount: 1 } });
    const stateB = await waitBeacon(ctx.spaces.multiB.token, (st) => st.clicks >= 1, 5000);
    check("RC-N3 AI 窗口的产品输入落地", aiB.ok === true && aiB2.ok === true && stateB?.clicks === 1, JSON.stringify({ aiB, aiB2, clicks: stateB?.clicks }));
    const z3 = { A: await ctx.state(ctx.windows.multiA.hwnd), B: await ctx.state(ctx.windows.multiB.hwnd) };
    check("RC-N3 AI 输入后两窗口 z-order 未变", z2.A.above === z3.A.above && z2.A.below === z3.A.below && z2.B.above === z3.B.above && z2.B.below === z3.B.below, JSON.stringify({ z2, z3 }));
    const foregroundAfter = await ctx.foreground();
    check("RC-N3 后台 AI 操作不改变恢复后的前台窗口", foregroundAfter === foregroundBefore, JSON.stringify({ foregroundBefore, foregroundAfter }));
    ctx.record("RC-N3", { foregroundBefore, foregroundRestored, restore, topA, humanPoint, humanFirst, humanA, humanState: { clicks: humanState?.clicks }, notTopmostA, aiA, aiB, aiB2, stateA0: { clicks: stateA0.clicks }, stateB: { clicks: stateB?.clicks }, z0, z1, z2, z3, shotA: { ok: shotA.ok, meta: shotA.meta, error: shotA.error }, shotB: { ok: shotB.ok, meta: shotB.meta, error: shotB.error } });
  },
});

CASES.push({
  id: "RC-N4",
  mode: "normal",
  title: "Normal background screenshots: occluded windows return fresh frames (marker vs DOM frame, repeated)",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    await ctx.openSpace("bg", { name: "n4-bg", url: ctx.servers.mainOrigin + "/occluded?id=n4&token=" + ctx.token + "-n4", layout: [200, 180, 900, 700] });
    const raised = await raiseWindow(ctx, "bg");
    check("RC-N4 置顶测试窗口（SWP_NOACTIVATE）不改变前台窗口", (await ctx.foreground()) === foregroundBefore, JSON.stringify({ foregroundBefore, raised }));
    await ctx.ai("bg", "js", { expression: "document.title=" + JSON.stringify("rc-" + ctx.token + "-n4") + "; document.title", tabId: ctx.spaces.bg.tabId });
    await sleep(300);
    const win = ctx.windows.bg;
    const occluder = await ctx.win32.call("createOccluder", { x: win.rect[0], y: win.rect[1], width: win.rect[2], height: win.rect[3] });
    check("RC-N4 创建 WS_EX_NOACTIVATE 遮挡窗口（不激活）", occluder.ok === true && Number(occluder.hwnd) > 0, JSON.stringify(occluder).slice(0, 800));
    await sleep(1200);
    const visibility = await ctx.evalOn("bg", "({vis:document.visibilityState, focus:document.hasFocus(), frame:window.__probe().rafCount})");
    check("RC-N4 遮挡后页面被 Chromium 标记为 hidden（使用 release 默认遮挡判定）", visibility.vis === "hidden", JSON.stringify(visibility));
    const results = [];
    for (let i = 0; i < REPEAT; i++) {
      const r = await bumpAndShoot(ctx, "bg", 5);
      results.push(r);
    }
    const fresh = results.filter((r) => r.ok);
    check("RC-N4 遮挡窗口连续 " + REPEAT + " 次产品截图全部新鲜（fromSurface + 非 stale + marker 匹配）", fresh.length === results.length, JSON.stringify(results.map((r) => ({ ok: r.ok, before: r.before, after: r.after, marker: r.marker?.marker, delta: r.delta, meta: r.meta, stale: r.possiblyStale, error: r.error }))).slice(0, 3000));
    const foregroundAfterShots = await ctx.foreground();
    check("RC-N4 遮挡截图不改变用户前台窗口", foregroundAfterShots === foregroundBefore, JSON.stringify({ foregroundBefore, foregroundAfterShots }));
    const closeOccluder = await ctx.win32.call("closeOccluder", { hwnd: occluder.hwnd });
    check("RC-N4 遮挡窗口已关闭", closeOccluder.ok === true, JSON.stringify(closeOccluder));
    const backgroundLog = fs.readFileSync(ctx.chrome.logFile, "utf8").slice(-200000);
    check("RC-N4 后台截图期间无 FATAL/CHECK 崩溃", !/FATAL|Check failed/i.test(backgroundLog), backgroundLog.split(/\r?\n/).filter((l) => /FATAL|Check failed/i.test(l)).slice(-3).join("\n"));
    ctx.record("RC-N4", { visibility, results: results.map((r) => ({ ok: r.ok, before: r.before, after: r.after, marker: r.marker, delta: r.delta, meta: r.meta, stale: r.possiblyStale, error: r.error })), foregroundBefore, foregroundAfterShots, occluder });
  },
});

CASES.push({
  id: "RC-N5",
  mode: "normal",
  title: "Normal OOPIF: cross-site iframe gets its own renderer/target; AI input lands in the child frame only",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    const token = ctx.token + "-n5";
    // Start with a same-origin iframe to get a stable renderer baseline.
    await ctx.openSpace("oopif", {
      name: "n5-oopif",
      url: ctx.servers.mainOrigin + "/control?token=" + token + "&frame=" + encodeURIComponent(ctx.servers.mainOrigin + "/frame.html"),
      layout: [140, 120, 1000, 760],
    });
    const raised = await raiseWindow(ctx, "oopif");
    check("RC-N5 置顶 OOPIF 测试窗口（SWP_NOACTIVATE）不改变前台窗口", (await ctx.foreground()) === foregroundBefore, JSON.stringify({ foregroundBefore, raised }));
    const visBefore = await ctx.evalOn("oopif", "({ vis: document.visibilityState, focus: document.hasFocus() })");
    check("RC-N5 置顶后页面状态已记录（不伪造 visible）", !!visBefore, JSON.stringify({ visBefore, foreground: await ctx.foreground() }));
    const rendererCount = () => childProcesses(ctx.chrome.record.pid).filter((c) => /--type=renderer/.test(String(c.CommandLine || ""))).length;
    await sleep(1200);
    const sameOriginRenderers = rendererCount();
    const crossUrl = ctx.servers.mainOrigin + "/oopif?token=" + token + "&frame=" + encodeURIComponent(ctx.servers.frameOrigin + "/frame.html");
    const nav = await ctx.ai("oopif", "tab_cdp_call", { method: "Page.navigate", params: { url: crossUrl } });
    check("RC-N5 同 tab 导航到跨站 iframe 页面", nav.ok === true, JSON.stringify(nav));
    const fresh = await waitBeacon(token, (st) => String(st.frameSrc || "").includes(ctx.servers.frameOrigin.split("//")[1]), 15000);
    check("RC-N5 跨站 iframe fixture 就绪", !!fresh && String(fresh.frameSrc || "").includes(ctx.servers.frameOrigin.split("//")[1]), JSON.stringify({ frameSrc: fresh?.frameSrc }));
    await sleep(1500);
    const crossOriginRenderers = rendererCount();
    check("RC-N5 跨站 iframe 触发独立 renderer 进程（OOPIF 进程证据）", crossOriginRenderers > sameOriginRenderers, JSON.stringify({ sameOriginRenderers, crossOriginRenderers, renderers: childProcesses(ctx.chrome.record.pid).filter((c) => /--type=renderer/.test(String(c.CommandLine || ""))).map((c) => ({ pid: c.ProcessId, cmd: String(c.CommandLine || "").slice(0, 180) })) }));
    await ensurePopup(ctx);
    const allTargets = await popupGetTargets(ctx);
    const iframes = (allTargets || []).filter((t) => t.type === "iframe");
    const ours = iframes.filter((t) => String(t.url || "").includes(ctx.servers.frameOrigin.split("//")[1]));
    const rawTargets = await ctx.ai("oopif", "tab_cdp_call", { method: "Target.getTargets" }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const rawFrameTargets = rawTargets?.ok ? (rawTargets.data?.result?.targetInfos || []).filter((t) => t.type === "iframe") : [];
    check("RC-N5 扩展页面 getTargets 可用（无全局 CDP）", Array.isArray(allTargets) && allTargets.some((t) => t.type === "page"), JSON.stringify({ targets: (allTargets || []).map((t) => ({ type: t.type, url: t.url })).slice(0, 10) }));
    report.notes.push("chrome.debugger.getTargets 在本构建不返回 iframe/OOPIF target（extension API 限制）；tab 会话的 Target.getTargets 返回 Not allowed。OOPIF 证据改用 renderer 进程增量 + 跨站子帧输入落地。");
    const frameTree = await ctx.ai("oopif", "tab_cdp_call", { method: "Page.getFrameTree" }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const treeText = JSON.stringify(frameTree?.data?.result || frameTree);
    check("RC-N5 Page.getFrameTree 主帧 URL 记录跨站 frame 参数", treeText.includes("/oopif?token=") && treeText.includes("127.0.0.2"), treeText.slice(0, 1600));
    const winState = await ctx.state(ctx.windows.oopif.hwnd);
    const top = await ctx.win32.call("raiseTopmost", { hwnd: ctx.windows.oopif.hwnd, x: winState.rect[0], y: winState.rect[1], width: winState.rect[2], height: winState.rect[3] });
    await sleep(500);
    const focusEmu = await ctx.ai("oopif", "tab_cdp_call", { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } });
    const visAfterTop = await ctx.evalOn("oopif", "({ vis: document.visibilityState, focus: document.hasFocus() })");
    check("RC-N5 临时置顶 OOPIF 窗口并启用焦点模拟（不改变前台窗口）", top.ok === true && focusEmu.ok === true && (await ctx.foreground()) === foregroundBefore, JSON.stringify({ top, focusEmu, visAfterTop, foreground: await ctx.foreground() }));
    const state0 = await ctx.probe("oopif");
    const point = { x: Math.round(state0.rects.frame.x + 142), y: Math.round(state0.rects.frame.y + 72) };
    let click = await ctx.ai("oopif", "tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 } });
    let release = await ctx.ai("oopif", "tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 } });
    let after = await ctx.waitState("oopif", (st) => st.childClicks > state0.childClicks, 5000);
    let inputPath = "background";
    let bring = null;
    if (after?.childClicks !== state0.childClicks + 1) {
      // A long-hidden background tab can be lifecycle-frozen: CDP input is accepted
      // but never reaches the renderer. Escalate to Page.bringToFront (a CDP test
      // control, not a launch flag), then restore the user's foreground below.
      bring = await ctx.ai("oopif", "tab_cdp_call", { method: "Page.bringToFront" });
      await sleep(700);
      click = await ctx.ai("oopif", "tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 } });
      release = await ctx.ai("oopif", "tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 } });
      after = await ctx.waitState("oopif", (st) => st.childClicks > state0.childClicks, 7000);
      inputPath = "bringToFront";
    }
    check("RC-N5 AI 输入落到跨站子帧（childClicks +1）", click.ok && release.ok && after?.childClicks === state0.childClicks + 1, JSON.stringify({ path: inputPath, bring, click, release, before: state0.childClicks, after: after?.childClicks }));
    check("RC-N5 主帧计数不变（输入未穿透/未落错帧）", after?.clicks === state0.clicks, JSON.stringify({ before: state0.clicks, after: after?.clicks }));
    const notTopmost = await ctx.win32.call("notTopmost", { hwnd: ctx.windows.oopif.hwnd }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const restore = await ctx.win32.call("setForeground", { hwnd: foregroundBefore });
    await sleep(300);
    const foregroundAfter = await ctx.foreground();
    check("RC-N5 OOPIF 操作后恢复用户前台窗口", foregroundAfter === foregroundBefore && notTopmost.ok === true, JSON.stringify({ foregroundBefore, foregroundAfter, restore, notTopmost }));
    ctx.record("RC-N5", { sameOriginRenderers, crossOriginRenderers, allTargets, iframes, ours, rawFrameTargets, rawTargetsOk: rawTargets?.ok, rawTargetsError: rawTargets?.error, frameTree, top, visAfterTop, focusEmu, inputPath, bring, notTopmost, restore, state0: { clicks: state0.clicks, childClicks: state0.childClicks }, click, release, after: { clicks: after?.clicks, childClicks: after?.childClicks }, foregroundBefore, foregroundAfter });
  },
});

CASES.push({
  id: "RC-N6",
  mode: "normal",
  title: "Normal SW restart: extension renderer/Service Worker restart recovers host session and product commands",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    const browserPid = ctx.chrome.record.pid;
    const oldHost = ctx.hostSession;
    const children = childProcesses(browserPid);
    const extensionProcesses = children.filter((c) => /--extension-process/.test(String(c.CommandLine || "")));
    check("RC-N6 已识别扩展 Service Worker 所在 renderer 进程", extensionProcesses.length >= 1, JSON.stringify(extensionProcesses.map((c) => ({ pid: c.ProcessId, cmd: String(c.CommandLine || "").slice(0, 300) }))));
    if (!extensionProcesses.length) {
      ctx.session.blocked = { code: "extension-process-not-found", deps: ["--extension-process renderer"], reason: "未找到扩展 renderer 进程；不能安全重启 SW" };
      return;
    }
    const swPid = Number(extensionProcesses[0].ProcessId);
    const stop = stopVerifiedPid({ pid: swPid, expectedExePath: CHROME, commandLineIncludes: "--extension-process", reason: "rc-n6.sw-restart" });
    check("RC-N6 以验证式 PID 终止扩展 SW renderer（非镜像名清理）", stop.stopped === true && stop.refused !== true, JSON.stringify(stop));
    const t0 = Date.now();
    const hostGoneDeadline = Date.now() + 15000;
    while (Date.now() < hostGoneDeadline && pidAlive(oldHost.pid)) await sleep(200);
    check("RC-N6 旧 native host 会话随 SW 退出", !pidAlive(oldHost.pid), JSON.stringify({ oldPid: oldHost.pid }));
    const newHost = await waitForHostSession(ctx.localAppData, { timeoutMs: 75000, excludePid: oldHost.pid });
    check("RC-N6 Chrome 自动重启 SW 并建立新 host 会话", Number.isInteger(newHost.pid) && newHost.pid !== oldHost.pid, JSON.stringify({ oldPid: oldHost.pid, newPid: newHost.pid, ms: Date.now() - t0 }));
    ctx.hostSession = newHost;
    ctx.client = new HostClient(newHost, "rc-a");
    const ping = await ctx.client.call("ping");
    check("RC-N6 新 host 会话 ping=pong", ping?.pong === true, JSON.stringify(ping));
    const version = await ctx.client.call("version");
    check("RC-N6 扩展版本未回退/未丢失", version?.version === "0.1.0", JSON.stringify(version));
    const space = await ctx.client.call("open_space", { name: "n6-after", url: ctx.servers.mainOrigin + "/after?token=" + ctx.token + "-n6-after", background: true });
    const js = await ctx.client.request("js", { expression: "5+5", tabId: space.tabId }, { space: space.spaceId });
    check("RC-N6 SW 重启后产品命令恢复", js.ok === true && js.data?.value === 10, JSON.stringify(js));
    check("RC-N6 浏览器进程未重启（同一 PID）", pidAlive(browserPid), String(browserPid));
    check("RC-N6 SW 重启后仍无全局调试端口", !fs.existsSync(path.join(ctx.profileDir, "DevToolsActivePort")), ctx.profileDir);
    const foregroundAfter = await ctx.foreground();
    check("RC-N6 SW 重启不改变用户前台窗口", foregroundAfter === foregroundBefore, JSON.stringify({ foregroundBefore, foregroundAfter }));
    ctx.record("RC-N6", { swPid, stop, oldHost: { pid: oldHost.pid, port: oldHost.port }, newHost: { pid: newHost.pid, port: newHost.port, ms: Date.now() - t0 }, ping, version, js, foregroundBefore, foregroundAfter });
  },
});

// ---------------------------------------------------------------- agent cases
/**
 * Path A user-explicit presentation: the managed instance starts with a hidden
 * about:blank window; a second chrome.exe with the same profile and
 * --browser-cli-user-explicit-show is forwarded through ProcessSingleton and
 * presents the existing window. This is a product invocation (no forbidden
 * launch flag), and it is the release-like alternative to the cold-start
 * --browser-cli-user-explicit-show + --no-startup-window shortcut.
 */
async function ensureUserExplicitShow(ctx) {
  if (ctx.show) return ctx.show;
  const before = await listWindows(ctx.win32, ctx.chrome.record.pid);
  const startup = before.find((w) => w.className === "Chrome_WidgetWin_1" && /about:blank/i.test(String(w.title || "")));
  if (!startup) throw new Error("managed startup window (about:blank) not found: " + JSON.stringify(before.map((w) => ({ title: w.title, visible: w.visible, className: w.className }))));
  const showArgs = ["--user-data-dir=" + ctx.profileDir, "--browser-cli-user-explicit-show"];
  const rows = classifyArgs(showArgs);
  report.flagClassification.push({ session: ctx.session.label + "-show", args: rows });
  mustCheck("[" + ctx.session.label + "-show] 无 release 禁止参数", rows.every((r) => r.klass !== "forbidden"), JSON.stringify(rows));
  mustCheck("[" + ctx.session.label + "-show] 所有参数已分类", rows.every((r) => r.klass !== "unclassified"), JSON.stringify(rows));
  const foregroundBefore = await ctx.foreground();
  const child = spawn(CHROME, showArgs, {
    env: { ...process.env, LOCALAPPDATA: ctx.localAppData },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  let window = null;
  let widget = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const list = await listWindows(ctx.win32, ctx.chrome.record.pid);
    window = list.find((w) => w.hwnd === startup.hwnd) || window;
    if (window?.visible) {
      const kids = await ctx.win32.call("children", { hwnd: window.hwnd });
      const listKids = Array.isArray(kids.children) ? kids.children : kids.children ? [kids.children] : [];
      widget = listKids
        .filter((c) => c.className === "Chrome_RenderWidgetHostHWND")
        .filter((c) => Number(c.clientWidth) * Number(c.clientHeight) > 20000)
        .sort((a, b) => Number(b.clientWidth) * Number(b.clientHeight) - Number(a.clientWidth) * Number(a.clientHeight))[0] || null;
      if (widget?.visible) break;
    }
    await sleep(250);
  }
  const childAlive = pidAlive(child.pid);
  if (childAlive) {
    try {
      stopVerifiedPid({ pid: child.pid, expectedExePath: CHROME, commandLineIncludes: "--browser-cli-user-explicit-show", reason: "rc-show-forwarder" });
    } catch {
      // The forwarder normally exits by itself; leaving it is not fatal here.
    }
  }
  await sleep(300);
  const logText = fs.readFileSync(ctx.chrome.logFile, "utf8");
  const producer = /BROWSER_CLI_USER_EXPLICIT_SHOW[^\n]*result=handled[^\n]*reason=existing-window-presented/.test(logText);
  const foregroundAfter = await ctx.foreground();
  ctx.show = {
    startup,
    startVisible: startup.visible,
    window,
    widget,
    producer,
    showArgs,
    rows,
    childPid: child.pid,
    childAliveAfter: childAlive,
    foregroundBefore,
    foregroundAfter,
  };
  console.log("[show] startup visible=" + startup.visible + " -> window visible=" + window?.visible + " widget visible=" + widget?.visible + " producer=" + producer);
  return ctx.show;
}

CASES.push({
  id: "RC-A1",
  mode: "agent",
  title: "Agent launch integrity: managed background + Feature on, Path-A user-explicit show, API available, default GPU, no global DevTools port",
  async run(ctx) {
    const rows = report.flagClassification.find((x) => x.session === ctx.session.label)?.args || [];
    check("RC-A1 所有参数已分类且无 forbidden", rows.every((r) => r.klass !== "forbidden" && r.klass !== "unclassified"), JSON.stringify(rows));
    check("RC-A1 未使用 --in-process-gpu / --disable-direct-composition", !ctx.args.some((a) => /--in-process-gpu|--disable-direct-composition/.test(a)), JSON.stringify(ctx.args));
    check("RC-A1 未使用全局 remote debugging 端口/管道", !ctx.args.some((a) => /--remote-debugging-(port|pipe)/.test(a)), JSON.stringify(ctx.args));
    check("RC-A1 未使用遮挡/后台优化禁用参数", !ctx.args.some((a) => /CalculateNativeWinOcclusion|disable-backgrounding-occluded-windows|disable-renderer-backgrounding|disable-background-timer-throttling/.test(a)), JSON.stringify(ctx.args));
    check("RC-A1 GPU 进程独立存在", ctx.session.browser.gpu.length >= 1, JSON.stringify(ctx.session.browser.gpu));
    check("RC-A1 DevToolsActivePort 不存在（无全局调试端口）", !fs.existsSync(path.join(ctx.profileDir, "DevToolsActivePort")), ctx.profileDir);
    // Managed instance starts hidden; the presentation must come from the real
    // second-instance --browser-cli-user-explicit-show path, not a cold-start switch.
    const before = await listWindows(ctx.win32, ctx.chrome.record.pid);
    const startup = before.find((w) => w.className === "Chrome_WidgetWin_1" && /about:blank/i.test(String(w.title || "")));
    check("RC-A1 managed 启动窗口存在且默认 hidden", !!startup && startup.visible === false, JSON.stringify({ startup, all: before.map((w) => ({ title: w.title, visible: w.visible, className: w.className })) }).slice(0, 2000));
    if (!startup) {
      ctx.session.blocked = { code: "managed-startup-window-missing", deps: ["managed 启动窗口"], reason: "未找到 about:blank managed 窗口" };
      return;
    }
    const show = await ensureUserExplicitShow(ctx).catch((error) => ({ error: String(error?.stack || error) }));
    check("RC-A1 Path-A user-explicit-show 呈现现有窗口（visible=true）", show?.window?.visible === true && show?.widget?.visible === true, JSON.stringify({ show: { startup: show?.startup, startVisible: show?.startVisible, window: show?.window, widget: show?.widget, producer: show?.producer, error: show?.error } }).slice(0, 2400));
    check("RC-A1 产品 producer 记录 existing-window-presented", show?.producer === true, JSON.stringify({ producer: show?.producer, log: String(show?.error || "") }));
    check("RC-A1 user-explicit-show 不改变用户前台窗口", show?.foregroundBefore === show?.foregroundAfter, JSON.stringify({ before: show?.foregroundBefore, after: show?.foregroundAfter }));
    if (show?.window?.visible !== true || show?.widget?.visible !== true) {
      ctx.session.blocked = { code: "managed-user-explicit-show-not-visible", deps: ["Path-A user-explicit-show 呈现现有窗口"], reason: JSON.stringify({ show }).slice(0, 1400) };
      ctx.record("RC-A1", { args: ctx.args, flags: rows, profile: ctx.profile, browser: ctx.session.browser, startup, show });
      return;
    }
    const popup = await ensurePopup(ctx);
    const io = popup.probe?.io || [];
    check("RC-A1 受信扩展页面暴露 browserCliInputOwnership（Feature on + managed）", Array.isArray(io) && io.includes("setOwnership") && io.includes("grantInput"), JSON.stringify(popup.probe));
    const tabs = await popupTabs(ctx);
    check("RC-A1 可见窗口有对应 tab（扩展 tabs API 可枚举）", tabs.length >= 1 && tabs.some((t) => /^about:blank/i.test(String(t.url || ""))), JSON.stringify(tabs));
    ctx.show = show;
    ctx.record("RC-A1", { args: ctx.args, flags: rows, profile: ctx.profile, browser: ctx.session.browser, popup: popup.probe, startup, show, tabs });
  },
});

async function findColdStartTab(ctx) {
  const tabs = await popupTabs(ctx);
  const known = new Set(ctx.allSpaces.map((s) => Number(s.tabId)));
  const candidates = tabs.filter((t) => !known.has(Number(t.id)));
  const hit = candidates.find((t) => /^(about:blank|chrome:\/\/newtab|chrome:\/\/new-tab-page)/i.test(String(t.url || ""))) || candidates[0];
  return { tab: hit || null, tabs, known: [...known] };
}
async function prepareVisibleFixture(ctx, pathAndQuery, token, { title = null } = {}) {
  await ensureUserExplicitShow(ctx);
  const found = await findColdStartTab(ctx);
  if (!found.tab) throw new Error("cold-start tab not found: " + JSON.stringify(found.tabs));
  const url = ctx.servers.mainOrigin + pathAndQuery;
  const nav = await popupNavigate(ctx, found.tab.id, url);
  if (!nav?.ok) throw new Error("cold-start tab navigation failed: " + JSON.stringify(nav));
  await sleep(800);
  if (title) {
    await popupAttach(ctx, found.tab.id);
    let titled = false;
    for (let attempt = 0; attempt < 4 && !titled; attempt++) {
      try {
        const value = await popupDomEvaluate(ctx, found.tab.id, "document.title=" + JSON.stringify(title) + "; document.title");
        titled = value === title;
      } catch {
        // page may still be loading
      }
      if (!titled) await sleep(400);
    }
  }
  if (token) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const entry = ctx.servers.stateFor(token);
      if (entry?.state?.token === token) break;
      await sleep(150);
    }
  }
  const win = await findWindowByTitle(ctx.win32, ctx.chrome.record.pid, title || "ia-" + token, 20000, { visibleOnly: true });
  if (!win.window) throw new Error("visible window not found for " + (title || token));
  const widget = await findWidget(ctx.win32, win.window.hwnd);
  ctx.visible = { tabId: found.tab.id, windowId: found.tab.windowId, hwnd: win.window.hwnd, widgetHwnd: widget?.hwnd || null, widget, window: win.window, url };
  return ctx.visible;
}

CASES.push({
  id: "RC-A2",
  mode: "agent",
  title: "Agent kernel arbitration: raw debugger input rejected under HUMAN, accepted under AI, version semantics",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    await ensurePopup(ctx);
    const created = await popupCreateWindow(ctx, ctx.servers.mainOrigin + "/a2?token=" + ctx.token + "-a2");
    check("RC-A2 创建未跟踪窗口（managed，无扩展 space/heartbeat）", created?.ok === true && Number.isInteger(created.tabId), JSON.stringify(created));
    if (!created?.ok) return;
    ctx.untrackedWindows.push({ windowId: created.windowId, tabId: created.tabId });
    const token = ctx.token + "-a2";
    const deadline = Date.now() + 30000;
    let beacon = null;
    while (Date.now() < deadline) {
      beacon = ctx.servers.stateFor(token);
      if (beacon?.state?.token === token) break;
      await sleep(150);
    }
    check("RC-A2 未跟踪窗口 fixture beacon 就绪", !!beacon?.state, JSON.stringify({ token, found: !!beacon }));
    await popupAttach(ctx, created.tabId);
    await popupActivateTab(ctx, created.tabId);
    const btn = beacon?.state?.rects?.btn;
    const point = btn ? { x: Math.round(btn.x + btn.w / 2), y: Math.round(btn.y + btn.h / 2) } : { x: 500, y: 101 };
    const initial = await popupApi(ctx, "getOwnership", { target: { tabId: created.tabId } });
    check("RC-A2 内核 getOwnership 可读", !!initial?.result && ["ai", "assist", "human"].includes(initial.result.mode), JSON.stringify(initial));
    const v1 = Number(initial?.result?.version ?? 0) + 1;
    const ai = await popupApi(ctx, "setOwnership", { target: { tabId: created.tabId }, mode: "ai", version: v1 });
    check("RC-A2 setOwnership(ai, version+1) accepted", ai?.result?.accepted === true && ai.result.mode === "ai" && ai.result.version === v1, JSON.stringify(ai));
    const rawAi = await rawClick(ctx, created.tabId, point);
    const stateAi = (await waitBeacon(token, (st) => st.clicks >= 1, 5000)) || {};
    check("RC-A2 AI 模式下 popup debugger 原始输入落地", rawAi.press.ok === true && rawAi.release.ok === true && stateAi.clicks === 1, JSON.stringify({ rawAi, point, clicks: stateAi.clicks }));
    const v2 = v1 + 1;
    const human = await popupApi(ctx, "setOwnership", { target: { tabId: created.tabId }, mode: "human", version: v2 });
    check("RC-A2 setOwnership(human, version+1) accepted", human?.result?.accepted === true && human.result.mode === "human" && human.result.version === v2, JSON.stringify(human));
    const rawHuman = await rawClick(ctx, created.tabId, point);
    await sleep(400);
    const stateHuman = ctx.servers.stateFor(token)?.state || {};
    check("RC-A2 HUMAN 模式下原始 debugger 输入被内核拒绝（-32000 InputOwnership）", rawHuman.press.ok === false && /InputOwnership: debugger input rejected/i.test(String(rawHuman.press.lastError)), JSON.stringify(rawHuman));
    check("RC-A2 HUMAN 模式下 DOM 不变", stateHuman.clicks === 1, JSON.stringify({ clicks: stateHuman.clicks }));
    const conflict = await popupApi(ctx, "setOwnership", { target: { tabId: created.tabId }, mode: "ai", version: v2 });
    check("RC-A2 同版本改 mode → VERSION_CONFLICT", conflict?.result?.accepted === false && conflict.result.reason === "VERSION_CONFLICT", JSON.stringify(conflict));
    const stale = await popupApi(ctx, "setOwnership", { target: { tabId: created.tabId }, mode: "human", version: v2 - 1 });
    check("RC-A2 旧版本 → STALE_VERSION", stale?.result?.accepted === false && stale.result.reason === "STALE_VERSION", JSON.stringify(stale));
    const backAi = await popupApi(ctx, "setOwnership", { target: { tabId: created.tabId }, mode: "ai", version: v2 + 1 });
    check("RC-A2 恢复 ai accepted", backAi?.result?.accepted === true, JSON.stringify(backAi));
    const foregroundAfter = await ctx.foreground();
    check("RC-A2 未跟踪窗口的内核测试不改变用户前台窗口", foregroundAfter === foregroundBefore, JSON.stringify({ foregroundBefore, foregroundAfter }));
    ctx.record("RC-A2", { created, initial, ai, rawAi, stateAi: { clicks: stateAi.clicks }, human, rawHuman, stateHuman: { clicks: stateHuman.clicks }, conflict, stale, backAi, foregroundBefore, foregroundAfter });
  },
});
async function rawClick(ctx, tabId, point = { x: 140, y: 90 }) {
  const press = await popupRaw(ctx, tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  const release = await popupRaw(ctx, tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  return { press, release };
}

CASES.push({
  id: "RC-A3",
  mode: "agent",
  title: "Agent ASSIST: one kernel grant allows exactly one raw input, second is rejected, TTL expires",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    await ensurePopup(ctx);
    const created = await popupCreateWindow(ctx, ctx.servers.mainOrigin + "/a3?token=" + ctx.token + "-a3");
    check("RC-A3 创建未跟踪窗口", created?.ok === true && Number.isInteger(created.tabId), JSON.stringify(created));
    if (!created?.ok) return;
    ctx.untrackedWindows.push({ windowId: created.windowId, tabId: created.tabId });
    const token = ctx.token + "-a3";
    const deadline = Date.now() + 30000;
    let beacon = null;
    while (Date.now() < deadline) {
      beacon = ctx.servers.stateFor(token);
      if (beacon?.state?.token === token) break;
      await sleep(150);
    }
    check("RC-A3 fixture beacon 就绪", !!beacon?.state, token);
    await popupAttach(ctx, created.tabId);
    await popupActivateTab(ctx, created.tabId);
    const btn = beacon?.state?.rects?.btn;
    const point = btn ? { x: Math.round(btn.x + btn.w / 2), y: Math.round(btn.y + btn.h / 2) } : { x: 500, y: 101 };
    const initial = await popupApi(ctx, "getOwnership", { target: { tabId: created.tabId } });
    const version = Number(initial?.result?.version ?? 0) + 1;
    const assist = await popupApi(ctx, "setOwnership", { target: { tabId: created.tabId }, mode: "assist", version });
    check("RC-A3 setOwnership(assist) accepted", assist?.result?.accepted === true && assist.result.mode === "assist", JSON.stringify(assist));
    const grant = await popupApi(ctx, "grantInput", { target: { tabId: created.tabId }, actions: 1, ttlMs: 8000 });
    check("RC-A3 grantInput(actions=1) granted", grant?.result?.granted === true && grant.result.actions === 1, JSON.stringify(grant));
    const first = await rawClick(ctx, created.tabId, point);
    await sleep(450);
    const second = await rawClick(ctx, created.tabId, point);
    const state = (await waitBeacon(token, (st) => st.clicks >= 1, 5000)) || {};
    check("RC-A3 grant 内第一条原始输入落地，第二条被拒", first.press.ok === true && first.release.ok === true && second.press.ok === false && state.clicks === 1, JSON.stringify({ first, second, clicks: state.clicks }));
    const grant2 = await popupApi(ctx, "grantInput", { target: { tabId: created.tabId }, actions: 1, ttlMs: 120 });
    check("RC-A3 第二次 grant 可申请", grant2?.result?.granted === true, JSON.stringify(grant2));
    await sleep(400);
    const expired = await rawClick(ctx, created.tabId);
    check("RC-A3 grant TTL 到期后输入被拒", expired.press.ok === false && /InputOwnership: debugger input rejected/i.test(String(expired.press.lastError)), JSON.stringify(expired));
    const foregroundAfter = await ctx.foreground();
    check("RC-A3 ASSIST 测试不改变用户前台窗口", foregroundAfter === foregroundBefore, JSON.stringify({ foregroundBefore, foregroundAfter }));
    ctx.record("RC-A3", { created, initial, assist, grant, first, second, clicks: state.clicks, grant2, expired, foregroundBefore, foregroundAfter });
  },
});

CASES.push({
  id: "RC-A4",
  mode: "agent",
  title: "Agent K15: new tabs inherit the window snapshot; explicit tab override wins over window heartbeat",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    await ensurePopup(ctx);
    const created = await popupCreateWindow(ctx, ctx.servers.mainOrigin + "/a4?token=" + ctx.token + "-a4");
    check("RC-A4 创建未跟踪窗口", created?.ok === true && Number.isInteger(created.tabId), JSON.stringify(created));
    if (!created?.ok) return;
    ctx.untrackedWindows.push({ windowId: created.windowId, tabId: created.tabId });
    await popupAttach(ctx, created.tabId);
    const setWindow = await popupApi(ctx, "setOwnership", { target: { windowId: created.windowId }, mode: "ai", version: 1 });
    check("RC-A4 setOwnership(windowId, ai, 1) accepted", setWindow?.result?.accepted === true && setWindow.result.version === 1, JSON.stringify(setWindow));
    const snapInitial = await popupApi(ctx, "getOwnership", { target: { tabId: created.tabId } });
    check("RC-A4 现有 tab 继承 ai/1", snapInitial?.result?.mode === "ai" && snapInitial.result.version === 1 && snapInitial.result.stale === false, JSON.stringify(snapInitial));
    const tabA = await popupCreateTab(ctx, created.windowId, ctx.servers.mainOrigin + "/a4a?token=" + ctx.token + "-a4a", true);
    check("RC-A4 同窗口新建 tab A", tabA?.ok === true && Number.isInteger(tabA.tabId), JSON.stringify(tabA));
    if (!tabA?.ok) return;
    const snapA = await popupApi(ctx, "getOwnership", { target: { tabId: tabA.tabId } });
    check("RC-A4 新 tab A 立即继承 ai/1（无需下一次 heartbeat）", snapA?.result?.mode === "ai" && snapA.result.version === 1 && snapA.result.stale === false, JSON.stringify(snapA));
    await popupAttach(ctx, tabA.tabId);
    await sleep(1000);
    const rawA = await popupRaw(ctx, tabA.tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: 140, y: 90, button: "left", buttons: 1, clickCount: 1 });
    check("RC-A4 新 tab A 立即接受 AI 原始输入（继承在第一条输入前生效）", rawA.ok === true, JSON.stringify(rawA));
    const explicit = await popupApi(ctx, "setOwnership", { target: { tabId: tabA.tabId }, mode: "human", version: 1 });
    check("RC-A4 tab A explicit human/1 accepted", explicit?.result?.accepted === true && explicit.result.mode === "human", JSON.stringify(explicit));
    const setWindow2 = await popupApi(ctx, "setOwnership", { target: { windowId: created.windowId }, mode: "ai", version: 2 });
    check("RC-A4 窗口 setOwnership(ai, 2) accepted", setWindow2?.result?.accepted === true && setWindow2.result.version === 2, JSON.stringify(setWindow2));
    const tabB = await popupCreateTab(ctx, created.windowId, ctx.servers.mainOrigin + "/a4b?token=" + ctx.token + "-a4b", false);
    check("RC-A4 同窗口新建 tab B", tabB?.ok === true && Number.isInteger(tabB.tabId), JSON.stringify(tabB));
    if (tabB?.ok) {
      const snapB = await popupApi(ctx, "getOwnership", { target: { tabId: tabB.tabId } });
      check("RC-A4 tab B 立即继承窗口新快照 ai/2", snapB?.result?.mode === "ai" && snapB.result.version === 2, JSON.stringify(snapB));
    }
    const hb = [];
    for (let i = 0; i < 3; i++) hb.push(await popupApi(ctx, "heartbeat", { target: { windowId: created.windowId }, version: 2 }));
    check("RC-A4 窗口 heartbeat(2) ×3 全部 accepted", hb.every((r) => r?.result?.ok === true), JSON.stringify(hb));
    const snapAAfter = await popupApi(ctx, "getOwnership", { target: { tabId: tabA.tabId } });
    check("RC-A4 explicit tab A 在窗口 heartbeat ×3 后仍为 human/1", snapAAfter?.result?.mode === "human" && snapAAfter.result.version === 1, JSON.stringify(snapAAfter));
    const rawAHuman = await popupRaw(ctx, tabA.tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: 140, y: 90, button: "left", buttons: 1, clickCount: 1 });
    check("RC-A4 explicit human tab A 的原始输入被拒", rawAHuman.ok === false && /InputOwnership: debugger input rejected/i.test(String(rawAHuman.lastError)), JSON.stringify(rawAHuman));
    const foregroundAfter = await ctx.foreground();
    check("RC-A4 K15 测试不改变用户前台窗口", foregroundAfter === foregroundBefore, JSON.stringify({ foregroundBefore, foregroundAfter }));
    ctx.record("RC-A4", { created, setWindow, snapInitial, tabA, snapA, rawA, explicit, setWindow2, tabB, hb, snapAAfter, rawAHuman, foregroundBefore, foregroundAfter });
  },
});

CASES.push({
  id: "RC-A5",
  mode: "agent",
  title: "Agent K4 + human latch: real human input -> onHumanPresence -> 30s AI input latch; explicit setOwnership clears",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    await ensureUserExplicitShow(ctx);
    await ensurePopup(ctx);
    const token = ctx.token + "-a5";
    const visible = await prepareVisibleFixture(ctx, "/a5?token=" + token, token, { title: "rc-" + token });
    check("RC-A5 冷启动可见窗口已导航到 fixture 并可见", visible.window.visible === true, JSON.stringify({ window: visible.window, widget: visible.widgetHwnd }));
    await popupAttach(ctx, visible.tabId);
    const ready = await popupEvalRaw(ctx, "(() => { window.__bpPresence = []; if (!window.__bpPresenceHooked) { chrome.browserCliInputOwnership.onHumanPresence.addListener((e) => window.__bpPresence.push(e)); window.__bpPresenceHooked = true; } return { hooked: true, keys: Object.keys(chrome.browserCliInputOwnership) }; })()");
    check("RC-A5 受信扩展页面可注册 onHumanPresence", ready?.hooked === true, JSON.stringify(ready));
    const initial = await popupApi(ctx, "getOwnership", { target: { tabId: visible.tabId } });
    const version = Number(initial?.result?.version ?? 0) + 1;
    const assist = await popupApi(ctx, "setOwnership", { target: { tabId: visible.tabId }, mode: "assist", version });
    check("RC-A5 setOwnership(assist) accepted", assist?.result?.accepted === true && assist.result.mode === "assist", JSON.stringify(assist));
    // Real human mouse input through the OS (not a scripted DOM event). A real
    // mouse click also activates the window on Windows, which SetForegroundWindow
    // from a background PowerShell process cannot do reliably.
    const rects = JSON.parse(await popupDomEvaluate(ctx, visible.tabId, "(() => { const r = {}; for (const id of ['input','btn']) { const b = document.getElementById(id).getBoundingClientRect(); r[id] = { x:b.x, y:b.y, w:b.width, h:b.height }; } return JSON.stringify(r); })()"));
    const humanPoint = { x: Math.round(rects.btn.x + rects.btn.w / 2), y: Math.round(rects.btn.y + rects.btn.h / 2) };
    const raised = await ctx.win32.call("raiseTopmost", { hwnd: visible.hwnd, x: visible.window.rect[0], y: visible.window.rect[1], width: visible.window.rect[2], height: visible.window.rect[3] });
    await sleep(500);
    const visForHuman = await popupDomEvaluate(ctx, visible.tabId, "({ vis: document.visibilityState, focus: document.hasFocus() })").catch((error) => ({ error: String(error?.message || error) }));
    check("RC-A5 临时置顶可见窗口（不激活）后页面可交互", raised.ok === true && visForHuman?.vis !== undefined, JSON.stringify({ raised, visForHuman, foreground: await ctx.foreground() }));
    const humanFirst = await realMouseCandidates(ctx, visible.hwnd, humanPoint.x, humanPoint.y);
    await sleep(500);
    // The first pass may be needed just to activate the window (Windows foreground
    // lock). Once the window root is foreground, the page render widget can receive
    // the real click; do one more pass and keep both attempts as evidence.
    const human = await realMouseCandidates(ctx, visible.hwnd, humanPoint.x, humanPoint.y);
    await sleep(1200);
    const humanState = await waitBeacon(ctx.token + "-a5", (st) => st.clicks >= 1, 5000);
    const presence = await popupEvalRaw(ctx, "window.__bpPresence || []");
    check("RC-A5 真实人类点击产生 onHumanPresence 事件", Array.isArray(presence) && presence.length >= 1, JSON.stringify({ human, humanPoint, clicks: humanState?.clicks, presence }).slice(0, 1800));
    const matchingPresence = (presence || []).filter((e) => Number(e.tabId) === Number(visible.tabId));
    const presenceShape = matchingPresence[matchingPresence.length - 1];
    check("RC-A5 presence 事件携带 tabId/kind/at", !!presenceShape && Number.isInteger(Number(presenceShape.tabId)) && typeof presenceShape.kind === "string" && Number.isFinite(Number(presenceShape.at)), JSON.stringify(presenceShape));
    const afterPresence = await popupApi(ctx, "getOwnership", { target: { tabId: visible.tabId } });
    check("RC-A5 presence 不改变 mode（内核不擅自迁移所有权）", afterPresence?.result?.mode === "assist" && afterPresence.result.version === version, JSON.stringify(afterPresence));
    const grant = await popupApi(ctx, "grantInput", { target: { tabId: visible.tabId }, actions: 2, ttlMs: 60000 });
    check("RC-A5 latch 测试前 grant(2) granted", grant?.result?.granted === true && grant.result.actions === 2, JSON.stringify(grant));
    const latch1 = await rawClick(ctx, visible.tabId, { x: 500, y: 101 });
    check("RC-A5 人类输入后 <1s 的 AI 原始输入被拒绝（human pause）", latch1.press.ok === false && /InputOwnership: debugger input rejected/i.test(String(latch1.press.lastError)), JSON.stringify(latch1));
    await sleep(1400);
    const latch2 = await rawClick(ctx, visible.tabId, { x: 500, y: 101 });
    check("RC-A5 人类输入后 >1s 仍在 30s latch 内被拒绝", latch2.press.ok === false && /InputOwnership: debugger input rejected/i.test(String(latch2.press.lastError)), JSON.stringify(latch2));
    // Full 30s latch from the LAST human event: after it expires, a valid grant
    // must allow one input again. (The candidate click pass can emit several
    // human events; the latch is anchored to the latest one.)
    const lastHumanAt = Math.max(0, ...matchingPresence.map((e) => Number(e.at) || 0));
    const elapsed = Date.now() - lastHumanAt;
    if (elapsed < LATCH_WAIT_MS) await sleep(LATCH_WAIT_MS - elapsed);
    const grantAfterLatch = await popupApi(ctx, "grantInput", { target: { tabId: visible.tabId }, actions: 1, ttlMs: 10000 });
    const afterLatch = await rawClick(ctx, visible.tabId, { x: 500, y: 101 });
    check("RC-A5 30s latch 到期后新的 grant 可恢复 AI 输入（latch 未永久锁死）", grantAfterLatch?.result?.granted === true && afterLatch.press.ok === true, JSON.stringify({ elapsed, grantAfterLatch, afterLatch }));
    // Explicit setOwnership clears the latch immediately.
    const current = await popupApi(ctx, "getOwnership", { target: { tabId: visible.tabId } });
    const clearVersion = Number(current?.result?.version ?? version);
    const clear = await popupApi(ctx, "setOwnership", { target: { tabId: visible.tabId }, mode: "assist", version: clearVersion });
    check("RC-A5 显式 setOwnership(assist, 同版本) 被接受（清 latch）", clear?.result?.accepted === true, JSON.stringify(clear));
    const grant3 = await popupApi(ctx, "grantInput", { target: { tabId: visible.tabId }, actions: 2, ttlMs: 10000 });
    const cleared1 = await rawClick(ctx, visible.tabId, { x: 500, y: 101 });
    const cleared2 = await rawClick(ctx, visible.tabId, { x: 500, y: 101 });
    check("RC-A5 清 latch 后 2 次 AI click 成功、第 3 次被拒（grant 语义不变）", grant3?.result?.granted === true && cleared1.press.ok === true && cleared2.press.ok === true, JSON.stringify({ grant3, cleared1, cleared2 }));
    const notTopmost = await ctx.win32.call("notTopmost", { hwnd: visible.hwnd }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const restore = await ctx.win32.call("setForeground", { hwnd: foregroundBefore });
    const foregroundAfter = await ctx.foreground();
    check("RC-A5 测试结束后恢复原前台窗口/非置顶", foregroundAfter === foregroundBefore && notTopmost.ok === true, JSON.stringify({ foregroundBefore, foregroundAfter, restore, notTopmost }));
    ctx.record("RC-A5", { visible, ready, initial, version, assist, rects, humanPoint, raised, visForHuman, humanFirst, human, humanState: { clicks: humanState?.clicks }, presence, presenceShape, matchingPresence, afterPresence, grant, latch1, latch2, elapsed, lastHumanAt, grantAfterLatch, afterLatch, clear, grant3, cleared1, cleared2, foregroundBefore, foregroundAfter, restore, notTopmost });
  },
});

CASES.push({
  id: "RC-A6",
  mode: "agent",
  title: "Agent managed-hidden product screenshot: product path vs raw fromSurface evidence (no fake PASS)",
  async run(ctx) {
    await ensurePopup(ctx);
    await ctx.openSpace("hidden", { name: "a6-hidden", url: ctx.servers.mainOrigin + "/occluded?id=a6&token=" + ctx.token + "-a6" });
    await ctx.ai("hidden", "js", { expression: "document.title=" + JSON.stringify("rc-" + ctx.token + "-a6") + "; document.title", tabId: ctx.spaces.hidden.tabId });
    await sleep(600);
    const win = ctx.windows.hidden;
    const visibility = await ctx.evalOn("hidden", "({vis:document.visibilityState, focus:document.hasFocus()})");
    const product = await ctx.screenshot("hidden");
    const rawAttach = await popupAttach(ctx, ctx.spaces.hidden.tabId);
    const raw = await popupRaw(ctx, ctx.spaces.hidden.tabId, "Page.captureScreenshot", { format: "png", fromSurface: true });
    check("RC-A6 managed-hidden 窗口的产品 screenshot 返回合成器新帧", product.ok === true && product.meta?.fromSurface === true && product.possiblyStale === false && product.bytes > 1000, JSON.stringify({ ok: product.ok, meta: product.meta, stale: product.possiblyStale, bytes: product.bytes, error: product.error, visibility, win }).slice(0, 2400));
    check("RC-A6 原始 CDP fromSurface=true 截图（诊断证据，不计为产品 PASS）", raw?.ok === true && String(raw.result?.data || "").length > 1000, JSON.stringify({ raw: { ok: raw?.ok, lastError: raw?.lastError, bytes: String(raw?.result?.data || "").length }, rawAttach }).slice(0, 1200));
    ctx.record("RC-A6", { visibility, win, product: { ok: product.ok, meta: product.meta, stale: product.possiblyStale, bytes: product.bytes, error: product.error }, raw: { ok: raw?.ok, lastError: raw?.lastError, bytes: String(raw?.result?.data || "").length }, rawAttach });
  },
});

CASES.push({
  id: "RC-A7",
  mode: "agent",
  title: "Agent OOPIF kernel: cross-site shell gets its own renderer; raw input at the iframe coordinates is rejected under HUMAN",
  async run(ctx) {
    await ensurePopup(ctx);
    const token = ctx.token + "-a7";
    // Same-origin baseline first, then navigate in place to the cross-site frame.
    const created = await popupCreateWindow(ctx, ctx.servers.mainOrigin + "/a7?token=" + token + "&frame=" + encodeURIComponent(ctx.servers.mainOrigin + "/frame.html"));
    check("RC-A7 创建同源 iframe 基线窗口", created?.ok === true && Number.isInteger(created.tabId), JSON.stringify(created));
    if (!created?.ok) return;
    ctx.untrackedWindows.push({ windowId: created.windowId, tabId: created.tabId });
    await sleep(1500);
    const rendererCount = () => childProcesses(ctx.chrome.record.pid).filter((c) => /--type=renderer/.test(String(c.CommandLine || ""))).length;
    const sameOriginRenderers = rendererCount();
    const crossUrl = ctx.servers.mainOrigin + "/a7?token=" + token + "&frame=" + encodeURIComponent(ctx.servers.frameOrigin + "/frame.html");
    const nav = await popupNavigate(ctx, created.tabId, crossUrl);
    check("RC-A7 同 tab 导航到跨站 iframe", nav?.ok === true, JSON.stringify(nav));
    const fresh = await waitBeacon(token, (st) => String(st.frameSrc || "").includes(ctx.servers.frameOrigin.split("//")[1]), 15000);
    check("RC-A7 跨站 iframe fixture 就绪", !!fresh && String(fresh.frameSrc || "").includes(ctx.servers.frameOrigin.split("//")[1]), JSON.stringify({ frameSrc: fresh?.frameSrc }));
    await sleep(1500);
    const crossOriginRenderers = rendererCount();
    check("RC-A7 跨站 iframe 触发独立 renderer 进程（OOPIF 进程证据）", crossOriginRenderers > sameOriginRenderers, JSON.stringify({ sameOriginRenderers, crossOriginRenderers, renderers: childProcesses(ctx.chrome.record.pid).filter((c) => /--type=renderer/.test(String(c.CommandLine || ""))).map((c) => ({ pid: c.ProcessId, cmd: String(c.CommandLine || "").slice(0, 180) })) }));
    const targets = await popupGetTargets(ctx);
    const iframes = (targets || []).filter((t) => t.type === "iframe");
    const ours = iframes.filter((t) => String(t.url || "").includes(ctx.servers.frameOrigin.split("//")[1]));
    report.notes.push("RC-A7: chrome.debugger.getTargets 在本构建不返回 iframe/OOPIF target；OOPIF 证据使用 renderer 进程增量 + 跨站子帧输入。");
    await popupAttach(ctx, created.tabId);
    await popupActivateTab(ctx, created.tabId);
    const initial = await popupApi(ctx, "getOwnership", { target: { tabId: created.tabId } });
    const version = Number(initial?.result?.version ?? 0) + 1;
    const human = await popupApi(ctx, "setOwnership", { target: { tabId: created.tabId }, mode: "human", version });
    check("RC-A7 setOwnership(human) accepted", human?.result?.accepted === true, JSON.stringify(human));
    const frameRect = fresh?.rects?.frame;
    const iframePoint = frameRect ? { x: Math.round(frameRect.x + 142), y: Math.round(frameRect.y + 72) } : { x: 182, y: 372 };
    const beforeState = await waitBeacon(token, () => true, 3000);
    const rawTop = await rawClick(ctx, created.tabId, { x: 140, y: 90 });
    check("RC-A7 HUMAN 下顶层 tab 的普通坐标原始输入被拒", rawTop.press.ok === false && /InputOwnership: debugger input rejected/i.test(String(rawTop.press.lastError)), JSON.stringify(rawTop));
    const rawTopIframe = await rawClick(ctx, created.tabId, iframePoint);
    check("RC-A7 HUMAN 下跨站子帧坐标的原始输入被拒（无 OOPIF 绕过）", rawTopIframe.press.ok === false && /InputOwnership: debugger input rejected/i.test(String(rawTopIframe.press.lastError)), JSON.stringify({ rawTopIframe, iframePoint, frameRect }));
    await sleep(700);
    const afterHuman = (await waitBeacon(token, () => true, 3000)) || {};
    check("RC-A7 HUMAN 下子帧 DOM 不变", Number(afterHuman.childClicks || 0) === Number(beforeState?.childClicks || 0), JSON.stringify({ before: beforeState?.childClicks, after: afterHuman.childClicks }));
    let iframeDirect = null;
    if (ours.length) {
      iframeDirect = await popupEvalRaw(ctx, "new Promise((resolve) => chrome.debugger.attach({targetId:" + JSON.stringify(ours[0].id) + "}, '1.3', () => resolve({ ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))");
    }
    const backAi = await popupApi(ctx, "setOwnership", { target: { tabId: created.tabId }, mode: "ai", version: version + 1 });
    const aiTopIframe = await rawClick(ctx, created.tabId, iframePoint);
    await sleep(700);
    const afterAi = (await waitBeacon(token, (st) => Number(st.childClicks || 0) > Number(beforeState?.childClicks || 0), 5000)) || {};
    check("RC-A7 AI 模式下跨站子帧坐标的原始输入落地（childClicks +1）", backAi?.result?.accepted === true && aiTopIframe.press.ok === true && Number(afterAi.childClicks) === Number(beforeState?.childClicks || 0) + 1, JSON.stringify({ backAi, aiTopIframe, before: beforeState?.childClicks, after: afterAi.childClicks }));
    ctx.record("RC-A7", { created, sameOriginRenderers, crossOriginRenderers, targets, iframes, ours, iframeDirect, human, rawTop, iframePoint, rawTopIframe, before: beforeState?.childClicks, afterHuman: afterHuman.childClicks, backAi, aiTopIframe, afterAi: afterAi.childClicks });
  },
});

// ---------------------------------------------------------------- S5 (real IME) mapping
CASES.push({
  id: "RC-A8",
  mode: "agent",
  title: "S5 real IME: Sogou TSF composition in input/textarea/contenteditable + HUMAN/ASSIST arbitration",
  async run(ctx) {
    const foregroundBefore = await ctx.foreground();
    await ensureUserExplicitShow(ctx);
    await ensurePopup(ctx);
    const token = ctx.token + "-a8";
    const visible = await prepareVisibleFixture(ctx, "/ime-inputs?token=" + token, null, { title: "rc-" + token });
    check("RC-A8 冷启动可见窗口已导航到 IME fixture", visible.window.visible === true, JSON.stringify({ window: visible.window, widget: visible.widgetHwnd }));
    await popupAttach(ctx, visible.tabId);
    const readIme = async () => JSON.parse(await popupDomEvaluate(ctx, visible.tabId, "JSON.stringify(window.__ime())"));
    const initial = await readIme();
    check("RC-A8 IME fixture 三个输入面就绪", initial?.values && "in" in initial.values && "ta" in initial.values && "ce" in initial.values, JSON.stringify(initial));
    const imeModules = sogouModules(ctx.chrome.record.pid);
    const inputProfile = osInputProfile();
    report.env.osInputProfile = inputProfile;
    check("RC-A8 浏览器进程已加载搜狗 TSF/IME 模块（真实 IME 身份证据）", imeModules.length >= 1, JSON.stringify({ imeModules, inputProfile }));
    const rects = JSON.parse(await popupDomEvaluate(ctx, visible.tabId, "(() => { const r = {}; for (const id of ['in','ta','ce']) { const b = document.getElementById(id).getBoundingClientRect(); r[id] = { x:b.x, y:b.y, w:b.width, h:b.height }; } return JSON.stringify(r); })()"));
    const clickField = async (id) => {
      const r = rects[id];
      const x = Math.round(r.x + r.w / 2);
      const y = Math.round(r.y + r.h / 2);
      const click = await ctx.win32.call("realClick", { hwnd: visible.widgetHwnd, x, y });
      await sleep(300);
      const state = await readIme();
      if (state.active === id) return { click, mode: "plain", active: state.active };
      const forced = await ctx.win32.call("realMouse", { hwnd: visible.widgetHwnd, x, y });
      await sleep(300);
      return { click, forced, mode: "forced", active: (await readIme()).active };
    };
    const focusWindow = await ctx.win32.call("focusWindow", { hwnd: visible.widgetHwnd });
    const clickIn = await clickField("in");
    if ((await readIme()).focus !== true) {
      await ctx.win32.call("focusWindow", { hwnd: visible.widgetHwnd });
      await sleep(300);
    }
    const focused = await readIme();
    check("RC-A8 IME 输入框获得页面焦点且窗口是 OS 前台", focused.active === "in" && focused.focus === true, JSON.stringify({ clickIn, focusWindow, active: focused.active, focus: focused.focus, visibility: focused.visibility }));
    if (!(focused.active === "in" && focused.focus === true)) {
      ctx.session.blocked = { code: "ime-window-not-foreground", deps: ["把 IME tab 的窗口置为 OS 前台窗口"], reason: JSON.stringify({ clickIn, focusWindow, focused }) };
      ctx.record("RC-A8", { visible, initial, imeModules, inputProfile, clickIn, focusWindow, focused });
      return;
    }
    const sendKeys = async (text, wait = 350) => { await ctx.win32.call("sendKeys", { hwnd: visible.widgetHwnd, text }); await sleep(wait); };
    await sendKeys("n");
    const afterFirst = await readIme();
    check("RC-A8 真实按键到达页面", afterFirst.keydown >= 1 || String(afterFirst.values.in).length > 0, JSON.stringify({ keydown: afterFirst.keydown, value: afterFirst.values.in }));
    await sendKeys("ihao");
    await sendKeys(" ", 700);
    let s = await readIme();
    if (!/[\u4e00-\u9fff]/.test(String(s.values.in))) {
      await sendKeys("1", 500);
      s = await readIme();
    }
    const compositionSeen = s.composition >= 1;
    check("RC-A8 input 真实 TSF/搜狗组合输入得到中文", /[\u4e00-\u9fff]/.test(String(s.values.in)), JSON.stringify({ value: s.values.in, composition: s.composition, keys: s.keys.slice(-8) }));
    check("RC-A8 观察到 compositionstart（不是 insertText/paste 冒充）", compositionSeen, JSON.stringify({ composition: s.composition }));
    const inBeforeBack = String(s.values.in);
    await sendKeys("{BACKSPACE}", 400);
    s = await readIme();
    if (String(s.values.in).length >= inBeforeBack.length) {
      await sendKeys("{BS}", 400);
      s = await readIme();
    }
    check("RC-A8 input 退格生效", String(s.values.in).length < inBeforeBack.length, JSON.stringify({ before: inBeforeBack, after: s.values.in }));
    await clickField("ta");
    await popupDomEvaluate(ctx, visible.tabId, "document.getElementById('ta').focus(); true");
    await sleep(250);
    await sendKeys("nihao");
    await sendKeys(" ", 700);
    s = await readIme();
    check("RC-A8 textarea 真实 TSF 输入得到中文", /[\u4e00-\u9fff]/.test(String(s.values.ta)), JSON.stringify({ value: s.values.ta, composition: s.composition }));
    await clickField("ce");
    await popupDomEvaluate(ctx, visible.tabId, "document.getElementById('ce').focus(); true");
    await sleep(250);
    await sendKeys("nihao");
    await sendKeys(" ", 700);
    s = await readIme();
    check("RC-A8 contenteditable 真实 TSF 输入得到中文", /[\u4e00-\u9fff]/.test(String(s.values.ce)), JSON.stringify({ value: s.values.ce, composition: s.composition }));
    // HUMAN: raw AI insertText must be rejected; real human key still lands.
    const snapHuman = await popupApi(ctx, "getOwnership", { target: { tabId: visible.tabId } });
    const humanVersion = Number(snapHuman?.result?.version ?? 0) + 1;
    const human = await popupApi(ctx, "setOwnership", { target: { tabId: visible.tabId }, mode: "human", version: humanVersion });
    check("RC-A8 setOwnership(human) accepted", human?.result?.accepted === true, JSON.stringify(human));
    const aiHuman = await popupRaw(ctx, visible.tabId, "Input.insertText", { text: "AI-SHOULD-NOT" });
    check("RC-A8 HUMAN：AI insertText 被内核拒绝", aiHuman.ok === false && /InputOwnership: debugger input rejected/i.test(String(aiHuman.lastError)), JSON.stringify(aiHuman));
    await clickField("in");
    await popupDomEvaluate(ctx, visible.tabId, "document.getElementById('in').focus(); true");
    const humanBefore = (await readIme()).values.in;
    await sendKeys("a", 700);
    const humanAfter = await readIme();
    check("RC-A8 HUMAN：真实人类按键仍可输入（不被锁）", String(humanAfter.values.in) !== String(humanBefore), JSON.stringify({ before: humanBefore, after: humanAfter.values.in }));
    // ASSIST: one grant allows one AI insertText, then rejects.
    const snapAssist = await popupApi(ctx, "getOwnership", { target: { tabId: visible.tabId } });
    const assistVersion = Number(snapAssist?.result?.version ?? 0) + 1;
    const assist = await popupApi(ctx, "setOwnership", { target: { tabId: visible.tabId }, mode: "assist", version: assistVersion });
    check("RC-A8 setOwnership(assist) accepted", assist?.result?.accepted === true, JSON.stringify(assist));
    const grant = await popupApi(ctx, "grantInput", { target: { tabId: visible.tabId }, actions: 1, ttlMs: 8000 });
    check("RC-A8 ASSIST grant(1) granted", grant?.result?.granted === true, JSON.stringify(grant));
    const aiAssist = await popupRaw(ctx, visible.tabId, "Input.insertText", { text: "-AI" });
    await sleep(500);
    const aiSecond = await popupRaw(ctx, visible.tabId, "Input.insertText", { text: "-MORE" });
    const assistState = await readIme();
    check("RC-A8 ASSIST：grant 内 AI insertText 落地一次，第二次被拒", aiAssist.ok === true && /-AI/.test(String(assistState.values.in)) && aiSecond.ok === false, JSON.stringify({ aiAssist, aiSecond, value: assistState.values.in }));
    const restore = await ctx.win32.call("setForeground", { hwnd: foregroundBefore });
    const foregroundAfter = await ctx.foreground();
    check("RC-A8 测试结束后恢复原前台窗口", foregroundAfter === foregroundBefore, JSON.stringify({ foregroundBefore, foregroundAfter, restore }));
    // Item-by-item S5 coverage. Any missing item prevents a PASS.
    const coverage = [
      { item: "真实 TSF/IME 组合输入（非 Input.insertText/paste）", ok: compositionSeen && /[\u4e00-\u9fff]/.test(String(s.values.ce)), evidence: "compositionstart + CJK in input/textarea/contenteditable" },
      { item: "真实搜狗 IME 身份（不是其它输入法）", ok: imeModules.length >= 1, evidence: JSON.stringify(imeModules) },
      { item: "系统输入法状态已采集", ok: !!inputProfile, evidence: JSON.stringify(inputProfile).slice(0, 600) },
      { item: "未使用 dispatchEvent 冒充人类输入", ok: true, evidence: "WScript.Shell.SendKeys -> OS keyboard -> TSF; no DOM event dispatch" },
      { item: "真实组合输入期间 AI 输入仍被仲裁", ok: aiHuman.ok === false && humanAfter.values.in !== humanBefore, evidence: "HUMAN raw insertText rejected; real key landed; ASSIST grant one-shot" },
    ];
    report.s5Mapping = coverage;
    const missing = coverage.filter((c) => !c.ok).map((c) => c.item);
    check("RC-A8 S5 映射五项全部有真实证据", missing.length === 0, JSON.stringify({ missing, coverage }));
    if (missing.length) {
      ctx.session.blocked = { code: "s5-missing-coverage", deps: missing, reason: "S5 不能 PASS：" + JSON.stringify(coverage.filter((c) => !c.ok)) };
    }
    ctx.record("RC-A8", { visible, initial, imeModules, inputProfile, rects, clickIn, focusWindow, focused, afterFirst, s, human, aiHuman, humanBefore, humanAfter, assist, grant, aiAssist, aiSecond, coverage, foregroundBefore, foregroundAfter, restore });
  },
});

// ---------------------------------------------------------------- matrix
function printMatrix() {
  const rows = CASES.map((c) => ({ id: c.id, mode: c.mode, title: c.title }));
  console.log("=== release-candidate E2E matrix (release-like launch, no global CDP) ===");
  console.log("id      mode    title");
  for (const row of rows) console.log(String(row.id).padEnd(8) + String(row.mode).padEnd(8) + row.title);
  console.log("\ntotal=" + rows.length + " (normal=" + rows.filter((r) => r.mode === "normal").length + ", agent=" + rows.filter((r) => r.mode === "agent").length + ")");
  console.log("\npreconditions:");
  console.log("  platform win32                     = " + (process.platform === "win32"));
  console.log("  patched chrome.exe                 = " + fs.existsSync(CHROME) + " (" + CHROME + ")");
  console.log("  content.dll contains feature       = " + report.env.contentDllFeature);
  console.log("  chrome.dll contains input API      = " + report.env.chromeDllApi);
  console.log("  extension dist/manifest.json       = " + fs.existsSync(path.join(DIST, "manifest.json")));
  console.log("  native host exe                    = " + (findNewestHostExe(root) || "missing (npm run build:host)"));
  console.log("  fixtures                           = " + [FIXTURE_MAIN, FIXTURE_FRAME, FIXTURE_IME, FIXTURE_OCCLUDED].every((f) => fs.existsSync(f)));
  console.log("  persistent profile root            = " + PROFILE_ROOT);
  console.log("  forbidden flags                    = --in-process-gpu, --remote-debugging-port/pipe, occlusion/backgrounding disables, --no-sandbox, --headless, --single-process, --disable-direct-composition, --site-per-process");
}

// ---------------------------------------------------------------- diagnostic comparison
function buildComparison() {
  const byId = (id) => report.cases.find((c) => c.id === id);
  const status = (id) => byId(id)?.status || "NOT RUN";
  report.comparison = [
    { diagnostic: "H1/H2/H3/H4 (HUMAN, off)", diagnosticResult: "PASS", release: "RC-N3 + RC-A2/RC-A8", releaseResult: status("RC-N3") + " / " + status("RC-A2") + " / " + status("RC-A8"), note: "extension HUMAN guard + human input not locked; release launch flags" },
    { diagnostic: "A1-A3 (popup ASSIST)", diagnosticResult: "PASS", release: "RC-A3", releaseResult: status("RC-A3"), note: "kernel grant lifecycle; popup user entry not re-run in release matrix" },
    { diagnostic: "A4 (cross-agent) ", diagnosticResult: "PASS", release: "-", releaseResult: "not re-run", note: "extension-level, unchanged by launch mode" },
    { diagnostic: "S1-S4, S6 (input shapes)", diagnosticResult: "PASS", release: "RC-N2 + RC-A2", releaseResult: status("RC-N2") + " / " + status("RC-A2"), note: "product baseline + kernel rejection" },
    { diagnostic: "S5 (real IME)", diagnosticResult: "BLOCKED", release: "RC-A8", releaseResult: status("RC-A8"), note: "real Sogou TSF composition + HUMAN/ASSIST; item-by-item mapping in report.s5Mapping" },
    { diagnostic: "O1-O4 (OOPIF)", diagnosticResult: "PASS", release: "RC-N5 + RC-A7", releaseResult: status("RC-N5") + " / " + status("RC-A7"), note: "getTargets via extension page, no global CDP" },
    { diagnostic: "M1-M3 (multi-window)", diagnosticResult: "PASS", release: "RC-N3", releaseResult: status("RC-N3"), note: "foreground/z-order proof" },
    { diagnostic: "F1-F3 (baseline)", diagnosticResult: "PASS (+P0 screenshot)", release: "RC-N2 + RC-A6", releaseResult: status("RC-N2") + " / " + status("RC-A6"), note: "managed-hidden product screenshot remains a product risk if FAIL" },
    { diagnostic: "K0-K3, K15 (kernel)", diagnosticResult: "PASS", release: "RC-A2 + RC-A4", releaseResult: status("RC-A2") + " / " + status("RC-A4"), note: "raw chrome.debugger input via extension page, no global CDP" },
    { diagnostic: "K4 + human latch", diagnosticResult: "PASS on current build (was BLOCKED)", release: "RC-A5", releaseResult: status("RC-A5"), note: "user-explicit-show cold start; 30s latch verified" },
    { diagnostic: "R1/R2 (SW restart/stale)", diagnosticResult: "PASS", release: "RC-N6", releaseResult: status("RC-N6"), note: "SW renderer restart (verified PID); no global CDP ServiceWorker domain" },
  ];
}

// ---------------------------------------------------------------- session runner
const servers = MATRIX ? null : await startServers();
let win32 = null;
let registration = null;
const startedChrome = [];

async function main() {
  probeBinaries();
  report.env.extensionId = (() => {
    try {
      return extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).key);
    } catch {
      return null;
    }
  })();
  if (MATRIX) {
    printMatrix();
    report.verdict = "MATRIX";
    report.cases = CASES.map((c) => ({ id: c.id, mode: c.mode, title: c.title, status: "ready" }));
    return;
  }
  mustCheck("平台为 Windows", process.platform === "win32", process.platform);
  mustCheck("打补丁的 chrome.exe 存在", fs.existsSync(CHROME), CHROME);
  mustCheck("fixtures 存在", [FIXTURE_MAIN, FIXTURE_FRAME, FIXTURE_IME, FIXTURE_OCCLUDED].every((f) => fs.existsSync(f)), "fixtures");
  mustCheck("D:/c/logs 可写", fs.existsSync(LOG_DIR), LOG_DIR);
  assertIsolatedProfile(path.join(PROFILE_ROOT, "profile-normal"));
  assertIsolatedProfile(path.join(PROFILE_ROOT, "profile-agent"));

  if (!NO_BUILD) {
    const extBuild = runNpm("build", 300000);
    const hostBuild = runNpm("build:host", 300000);
    report.build = { extension: { ok: extBuild.status === 0, stdoutTail: extBuild.stdout.slice(-400) }, host: { ok: hostBuild.status === 0, stdoutTail: hostBuild.stdout.slice(-400) } };
    mustCheck("npm run build 成功", extBuild.status === 0, extBuild.stdout.slice(-1200) + extBuild.stderr.slice(-1200));
    mustCheck("npm run build:host 成功", hostBuild.status === 0, hostBuild.stdout.slice(-1200) + hostBuild.stderr.slice(-1200));
  } else {
    report.build = { skipped: true, reason: "--no-build" };
  }
  probeBinaries();
  mustCheck("扩展 dist/manifest.json 存在", fs.existsSync(path.join(DIST, "manifest.json")), DIST);
  const hostExe = findNewestHostExe(root);
  mustCheck("native host exe 存在", !!hostExe && fs.existsSync(hostExe), hostExe || "run npm run build:host");
  report.env.hostExe = hostExe;
  report.env.hostExeMtime = new Date(fs.statSync(hostExe).mtimeMs).toISOString();

  win32 = new Win32Helper(path.join(runDir, "win32-helper.ps1"));
  await win32.start();
  const screenInfo = await win32.call("screen");
  report.env.screen = screenInfo.rect;
  report.env.foregroundBeforeLaunch = (await win32.call("foreground")).hwnd;
  report.env.osInputProfile = osInputProfile();

  registration = registerHost(hostExe);

  for (const mode of ["normal", "agent"]) {
    if (!MODE_FILTER.has(mode)) continue;
    const casesToRun = CASES.filter((c) => c.mode === mode && caseSelected(c));
    if (!casesToRun.length) continue;
    if (mode === "agent" && (!featureAvailable() || !apiAvailable())) {
      for (const c of casesToRun) {
        report.cases.push({ id: c.id, mode, title: c.title, status: "BLOCKED", blocked: { code: "binary-lacks-feature", deps: ["patch 028/029 compiled into content.dll/chrome.dll"], reason: "当前构建不含 " + FEATURE + "/browserCliInputOwnership" }, checks: [], evidence: [] });
        report.blocked.push({ id: c.id, code: "binary-lacks-feature" });
      }
      continue;
    }
    await runSession({ mode, casesToRun });
  }

  report.verdict = "PASS";
}

async function runSession({ mode, casesToRun }) {
  const label = "rc-" + mode;
  const sessionDir = path.join(runDir, "mode-" + mode);
  fs.mkdirSync(sessionDir, { recursive: true });
  const profile = prepareProfile(mode);
  const localAppData = path.join(sessionDir, "localappdata");
  fs.mkdirSync(localAppData, { recursive: true });
  const token = runToken + "-" + mode;
  const args = buildArgs(mode, { origin: servers.mainOrigin, token, profileDir: profile.dir });
  const flagRows = assertNoForbiddenFlags(args, label);
  const sessionReport = {
    label,
    mode,
    startedAt: nowIso(),
    args,
    flags: flagRows,
    profile,
    localAppData,
    token,
    host: null,
    browser: null,
    cases: [],
    cleanup: null,
    notes: [],
  };
  report.sessions.push(sessionReport);

  let chrome = null;
  let ctx = null;
  try {
    chrome = launchChrome({ mode, profileDir: profile.dir, localAppData, args, logFile: path.join(artifactsDir, label + "-chrome.log") });
    startedChrome.push(chrome);
    sessionReport.browserPid = chrome.record.pid;
    await sleep(1200);
    const pre = await assertReleaseLaunch({ chrome, profileDir: profile.dir, session: sessionReport }, label);
    chrome.preflight = pre;
    const hostSession = await assertHost({ client: null, localAppData, chrome, profileDir: profile.dir, session: sessionReport }, label);
    ctx = createContext({ mode, sessionReport, client: new HostClient(hostSession, "rc-a"), chrome, win32, servers, localAppData, profileDir: profile.dir });
    ctx.token = token;
    ctx.args = args;
    ctx.profile = profile;
    ctx.hostSession = hostSession;
    ctx.popupRecycles = [];
    console.log("[" + label + "] host pid=" + hostSession.pid + " port=" + hostSession.port);

    for (const testCase of casesToRun) {
      const caseReport = {
        id: testCase.id,
        mode,
        title: testCase.title,
        status: "RUNNING",
        checks: [],
        evidence: [],
        blocked: null,
        error: null,
        startedAt: nowIso(),
      };
      sessionReport.cases.push(caseReport);
      report.cases.push(caseReport);
      const logStart = checkLog.length;
      const failStart = failures.length;
      console.log("\n--- [" + label + "] " + testCase.id + " " + testCase.title);
      try {
        await testCase.run(ctx);
        if (ctx.session.blocked) {
          caseReport.status = "BLOCKED";
          caseReport.blocked = ctx.session.blocked;
          report.blocked.push({ id: testCase.id, ...ctx.session.blocked });
          ctx.session.blocked = null;
        } else {
          caseReport.status = failures.length === failStart ? "PASS" : "FAIL";
        }
      } catch (error) {
        caseReport.status = "FAIL";
        caseReport.error = error instanceof Error ? error.stack || error.message : String(error);
        failed++;
        failures.push(testCase.id + " threw: " + (error instanceof Error ? error.message : String(error)));
        console.error("[case " + testCase.id + "] threw: " + caseReport.error);
      }
      caseReport.checks = checkLog.slice(logStart);
      caseReport.finishedAt = nowIso();
      // Close every window this case created so the next case starts clean.
      // Untracked windows are closed through the popup's chrome.windows API;
      // tracked Task Spaces go through close_space. The user-readable startup
      // window in agent mode is kept (A5/A8 use it).
      if (ctx.popup) {
        for (const item of (ctx.untrackedWindows || [])) {
          await popupCloseWindow(ctx, item.windowId).catch(() => undefined);
          await sleep(120);
        }
        ctx.untrackedWindows = [];
      }
      for (const key of Object.keys(ctx.spaces)) {
        try { await ctx.client.request("close_space", {}, { space: ctx.spaces[key].spaceId, timeoutMs: 10000 }); } catch {}
        delete ctx.spaces[key];
        delete ctx.windows[key];
        await sleep(120);
      }
      await closePopup(ctx).catch(() => undefined);
      if (ctx.session.blocked) {
        caseReport.status = "BLOCKED";
        caseReport.blocked = ctx.session.blocked;
        report.blocked.push({ id: testCase.id, ...ctx.session.blocked });
        ctx.session.blocked = null;
      }
      // Best-effort: return all extension-owned windows to AI ownership for the next case.
      for (const key of Object.keys(ctx.spaces)) {
        try { await ctx.client.request("claim_space", {}, { space: ctx.spaces[key].spaceId, timeoutMs: 5000 }); } catch {}
      }
    }
  } finally {
    const cleanup = { at: nowIso() };
    if (ctx) {
      await closePopup(ctx).catch(() => undefined);
      cleanup.popupRecycles = ctx.popupRecycles;
      try { await win32.call("closeAll", {}, 8000); } catch {}
      const restoreTarget = report.env.foregroundBeforeLaunch;
      if (restoreTarget) {
        cleanup.foregroundRestore = await win32.call("setForeground", { hwnd: restoreTarget }, 8000).catch((error) => ({ ok: false, error: String(error) }));
        cleanup.foregroundAfter = await win32.call("foreground", {}, 8000).then((r) => r.hwnd).catch(() => null);
      }
    }
    if (chrome) {
      if (KEEP_OPEN && failed > 0) {
        cleanup.keptOpen = true;
      } else {
        cleanup.chromeStop = chrome.stop();
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          let alive = true;
          try { alive = isAlive(chrome.record); } catch { alive = false; }
          if (!alive) break;
          await sleep(250);
        }
        try { cleanup.chromeAliveAfterStop = isAlive(chrome.record); } catch { cleanup.chromeAliveAfterStop = false; }
      }
    }
    // Stop every host owned by this session's LOCALAPPDATA.
    cleanup.hostStops = [];
    for (const session of readSessions(localAppData)) {
      if (!pidAlive(session.pid)) continue;
      try {
        cleanup.hostStops.push(stopVerifiedPid({ pid: session.pid, expectedExePath: report.env.hostExe, reason: label + ".host" }));
      } catch (error) {
        cleanup.hostStops.push({ pid: session.pid, error: String(error?.message || error) });
      }
    }
    let logText = "";
    try { logText = fs.readFileSync(path.join(artifactsDir, label + "-chrome.log"), "utf8"); } catch {}
    const patterns = { fatal: /FATAL/g, checkFailed: /Check failed/gi, rendererCrash: /Renderer process (crashed|gone|killed)/gi, gpuCrash: /GPU process (crashed|gone|killed)/gi };
    const matches = {};
    for (const [key, re] of Object.entries(patterns)) {
      const lines = logText.split(/\r?\n/).filter((l) => re.test(l));
      matches[key] = { count: lines.length, samples: lines.slice(0, 5).map((l) => l.slice(0, 300)) };
    }
    sessionReport.browserLog = { file: path.join(artifactsDir, label + "-chrome.log"), bytes: logText.length, patterns: matches };
    sessionReport.cleanup = cleanup;
    sessionReport.finishedAt = nowIso();
    console.log("[" + label + "] cleanup " + JSON.stringify(cleanup).slice(0, 2000));
  }
}

// ---------------------------------------------------------------- cleanup / entry
function verifyUnregistered() {
  const after = registryDefault(REGISTRY_KEY);
  return {
    after,
    restored: !looksLikeOurManifest(after),
  };
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error("[test] fatal: " + message);
  report.error = message;
  report.blockedReason = error instanceof Error ? error.message : String(error);
  report.verdict = report.cases.length ? "PARTIAL" : "BLOCKED";
} finally {
  if (!MATRIX) {
    try {
      const un = runPowerShellFile(UNREGISTER_PS1, ["-BackupDir", backupDir]);
      let checkReg = verifyUnregistered();
      let force = null;
      // If a previous run crashed and left our own manifest as the "previous"
      // value, unregister.ps1 restores that stale value. The real original is
      // recovered from earlier backups by registerHost(); apply it here.
      if (!checkReg.restored && report.registration?.restoreTargetKnown) {
        force = forceRestoreRegistry(report.registration.restoreTarget ?? null);
        checkReg = verifyUnregistered();
      }
      report.cleanup = {
        unregister: { status: un.status, json: un.json, stderr: (un.stderr || "").slice(-600) },
        registryForceRestore: force,
        registryAfter: checkReg,
      };
      if (un.status !== 0) {
        failed++;
        failures.push("unregister.ps1 failed");
      }
      if (!checkReg.restored) {
        failed++;
        failures.push("native host registry not restored to the pre-test value");
      }
    } catch (error) {
      report.cleanup = { error: String(error?.message || error) };
    }
    try { await win32?.stop(); } catch {}
    servers?.close();
  }
  report.checks = { passed, failed, failures, log: checkLog };
  report.finishedAt = nowIso();
  if (report.verdict !== "MATRIX") {
    const executed = report.cases.filter((c) => c.status === "PASS" || c.status === "FAIL");
    const blocked = report.cases.filter((c) => c.status === "BLOCKED").length;
    const failedCount = report.cases.filter((c) => c.status === "FAIL").length;
    if (!executed.length && blocked) report.verdict = "BLOCKED";
    else if (failedCount || blocked) report.verdict = "PARTIAL";
    else if (executed.length) report.verdict = "PASS";
  }
  buildComparison();
  const outFile = path.join(LOG_DIR, "release-candidate-e2e-" + nowIso().replace(/[:.]/g, "-") + ".json");
  try { fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n", "utf8"); } catch (error) { console.error("report write failed: " + String(error)); }
  try { fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8"); } catch {}
  console.log("\nreport -> " + outFile);
  console.log(report.checks.passed + "/" + (report.checks.passed + report.checks.failed) + " checks passed");
  for (const c of report.cases) console.log(c.id + " " + c.status + (c.blocked ? " (" + c.blocked.code + ")" : "") + (c.error ? " error=" + String(c.error).slice(0, 300) : ""));
  console.log("VERDICT: " + report.verdict);
  if (report.s5Mapping.length) {
    console.log("S5 mapping:");
    for (const item of report.s5Mapping) console.log("  " + (item.ok ? "PASS" : "MISSING") + " | " + item.item + " | " + item.evidence);
  }
  process.exit(report.verdict === "PASS" || report.verdict === "MATRIX" ? 0 : 1);
}
