#!/usr/bin/env node
// P1 native CookieStore import E2E harness.
//
// Real loop under test:
//   source Browser CLI (test extension, explicit consent)
//     -> chrome.runtime.connectNative
//     -> BrowserPilot native messaging host (import-only relay)
//     -> target Browser CLI named pipe
//     -> target-browser user approval dialog
//     -> CookieManager write
//     -> local synthetic test site
//     -> target restart persistence.
//
// Safety rules (see AGENTS.md and docs/p1-cookie-import-native-v2-2026-11-01.md):
//   * every browser uses a fresh --user-data-dir (mkdtemp); no real profile;
//   * the test site is a local 127.0.0.1 server with synthetic cookies only;
//   * no real WorkBuddy cookies, tokens or profiles are read;
//   * the native host is registered only under the test-only
//     HKCU\Software\Chromium\NativeMessagingHosts key and restored afterwards;
//   * cookie values and tickets never appear in logs, reports or snapshots.
//
// The harness must not be run concurrently with another run of itself: the
// native messaging host name is process-global for the current user.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as contract from "../import/contract.mjs";
import { createImportRelay } from "../../native-host/import-relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PS = path.join(HERE, "powershell");
const HOST_NAME = contract.HOST_NAME;
const REG_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`;
const SOURCE_EXTENSION_ID = contract.SOURCE_EXTENSION_ID;
const APPROVAL_TITLE = "Allow cookie import into Browser CLI?";
const SESSION_TITLE = "Browser CLI cookie import";
const TEST_DOMAIN = "127.0.0.1";
const SOURCE_EXT_PATH = path.join(REPO, "extensions", "import-source");

// ---------------------------------------------------------------------------
// CLI arguments and run state
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const chromeExe = path.resolve(String(args.chrome || "D:/c/src/out/WinDev/chrome.exe"));
const keepRun = args.keep === true;
const scenariosArg = String(args.scenarios || args.scenario || "all");
const runRoot = path.resolve(
  String(args.root || fs.mkdtempSync(path.join(os.tmpdir(), "bcli-p1-e2e-"))),
);
const logsDir = path.join(runRoot, "logs");
const evidenceDir = path.join(runRoot, "evidence");
const sessionsDir = path.join(runRoot, "sessions");
const reportedSecrets = new Set();
const logLines = [];
let registryRestore = null;

function addSecret(value) {
  if (typeof value === "string" && value.length >= 8) reportedSecrets.add(value);
}

function redact(text) {
  let out = String(text ?? "");
  out = out.replace(/BCLI(?:-[0-9A-Z]{4}){8}/g, "[REDACTED-TICKET]");
  for (const secret of reportedSecrets) {
    if (!secret) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

function log(...parts) {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  console.log(line);
  logLines.push(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function blocked(message) {
  const err = new Error(message);
  err.blocked = true;
  return err;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// Child process helpers
// ---------------------------------------------------------------------------

function run(cmd, argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runSync(cmd, argv, options = {}) {
  const result = spawnSync(cmd, argv, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

async function powershell(scriptName, argv = [], { timeoutMs = 30000 } = {}) {
  const script = path.join(PS, scriptName);
  const result = await run(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...argv],
    { timeout: timeoutMs },
  );
  if (result.code !== 0) {
    throw new Error(`powershell ${scriptName} failed (${result.code}): ${redact(result.stderr || result.stdout)}`);
  }
  return result.stdout;
}

function killPid(pid, { tree = false } = {}) {
  if (!pid) return;
  const argv = ["/PID", String(pid), "/F"];
  if (tree) argv.push("/T");
  runSync("taskkill.exe", argv);
}

async function processInfo(pid) {
  if (!pid) return null;
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue`,
    "if ($p) { $p | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate,CommandLine | ConvertTo-Json -Compress } else { 'null' }",
  ].join("; ");
  const result = runSync("powershell", ["-NoProfile", "-Command", script]);
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim() || "null");
    return parsed && parsed.ProcessId ? parsed : null;
  } catch {
    return null;
  }
}

async function findProcessByExecutable(exePath, { timeoutMs = 10000 } = {}) {
  const escaped = String(exePath).replace(/'/g, "''");
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "Name='${path.basename(exePath)}'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -ieq '${escaped}' } | Select-Object -First 1`,
    "if ($p) { $p | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress } else { 'null' }",
  ].join("; ");
  const deadline = Date.now() + timeoutMs;
  do {
    const result = runSync("powershell", ["-NoProfile", "-Command", script]);
    if (result.code === 0) {
      try {
        const parsed = JSON.parse(result.stdout.trim() || "null");
        if (parsed && parsed.ProcessId) return parsed;
      } catch {}
    }
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

// ---------------------------------------------------------------------------
// Synthetic local test site (synthetic account/cookies only)
// ---------------------------------------------------------------------------

function randomCanary(prefix) {
  return `${prefix}-${crypto.randomBytes(16).toString("hex")}`;
}

class TestSite {
  constructor() {
    this.value = randomCanary("P1-E2E-VALUE");
    this.sessionValue = randomCanary("P1-E2E-SESSION");
    addSecret(this.value);
    addSecret(this.sessionValue);
    this.requests = [];
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const cookieHeader = req.headers.cookie || "";
      const has = (name, expected) => {
        for (const part of cookieHeader.split(";")) {
          const [key, ...rest] = part.trim().split("=");
          if (key !== name) continue;
          if (expected === undefined) return true;
          return rest.join("=") === expected;
        }
        return false;
      };
      this.requests.push({ path: url.pathname, hasPersistent: has("e2e_sid"), hasSession: has("e2e_session") });
      res.setHeader("cache-control", "no-store");
      if (url.pathname === "/set") {
        res.setHeader("set-cookie", [
          `e2e_sid=${this.value}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`,
          `e2e_session=${this.sessionValue}; Path=/; SameSite=Lax`,
        ]);
        res.end("SET_OK");
        return;
      }
      if (url.pathname === "/login-check") {
        res.end(has("e2e_sid", this.value) ? "LOGIN_OK" : "LOGIN_MISSING");
        return;
      }
      if (url.pathname === "/session-check") {
        res.end(has("e2e_session", this.sessionValue) ? "SESSION_PRESENT" : "SESSION_MISSING");
        return;
      }
      if (url.pathname === "/value-check") {
        // Deliberately returns only a boolean; never the cookie value.
        res.end(has("e2e_sid", this.value) ? "VALUE_MATCH" : "VALUE_MISMATCH");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>Browser CLI P1 synthetic site</title><h1>synthetic test site</h1>");
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    this.base = `http://127.0.0.1:${this.port}`;
    return this;
  }

  url(p) {
    return `${this.base}${p}`;
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

function httpJson(port, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, timeout: 10000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`invalid JSON from ${pathname}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`http timeout: ${pathname}`)));
    req.on("error", reject);
    req.end();
  });
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      let message;
      try {
        message = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) this.events.push(message);
    });
  }

  static async connect(wsUrl, timeoutMs = 10000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error(`CDP websocket open timed out: ${wsUrl.slice(0, 120)}`));
      }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket failed")); }, { once: true });
    });
    return new CdpConnection(ws);
  }

  call(method, params = {}, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

class CdpPage {
  constructor(connection, targetInfo) {
    this.connection = connection;
    this.targetInfo = targetInfo;
    this.id = targetInfo.id;
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const result = await this.connection.call("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.text || "unknown"}`);
    }
    return result.result?.value;
  }

  async waitFor(expression, predicate = (v) => !!v, { timeoutMs = 15000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (predicate(last)) return last;
      } catch {}
      await sleep(intervalMs);
    }
    throw new Error(`waitFor timed out: ${expression} (last=${JSON.stringify(last)})`);
  }

  async selectorRect(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
    })()`);
  }

  async click(selector, { timeoutMs = 10000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let rect = null;
    while (Date.now() < deadline) {
      rect = await this.selectorRect(selector);
      if (rect) break;
      await sleep(100);
    }
    if (!rect) throw new Error(`selector not found: ${selector}`);
    const { x, y } = rect;
    await this.connection.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.connection.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await sleep(40);
    await this.connection.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(80);
  }

  async type(selector, text) {
    await this.click(selector);
    await this.connection.call("Input.insertText", { text });
    await sleep(80);
  }

  text(selector) {
    return this.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  }

  async navigate(url) {
    await this.connection.call("Page.enable");
    await this.connection.call("Page.navigate", { url });
    await this.waitFor("document.readyState", (v) => v === "complete", { timeoutMs: 15000 });
  }

  async bodyText() {
    return this.eval("document.body?.innerText ?? ''");
  }

  async close() {
    try {
      await this.connection.call("Page.close", {}, 5000);
    } catch {}
    this.connection.close();
  }
}

// ---------------------------------------------------------------------------
// Browser process
// ---------------------------------------------------------------------------

class Browser {
  constructor({ name, exe, profileDir, args, env = {}, logFile }) {
    this.name = name;
    this.exe = exe;
    this.profileDir = profileDir;
    this.args = args;
    this.env = env;
    this.logFile = logFile;
    this.child = null;
    this.stderr = "";
    this.stdout = "";
    this.port = null;
    this.browserConnection = null;
  }

  async start() {
    fs.mkdirSync(this.profileDir, { recursive: true });
    // A reused profile (restart-persistence scenario) still contains the
    // previous browser's DevToolsActivePort. Remove it so we never read the
    // stale port before the new process writes its own.
    try {
      fs.rmSync(path.join(this.profileDir, "DevToolsActivePort"), { force: true });
    } catch {}
    log(`[browser ${this.name}] launching ${this.exe}`);
    const argv = [
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--noerrdialogs",
      ...this.args,
    ];
    if (this.logFile) {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      argv.push("--enable-logging", `--log-file=${this.logFile}`, "--v=0");
    }
    this.child = spawn(this.exe, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...this.env },
    });
    this.child.stdout.on("data", (chunk) => {
      this.stdout += chunk.toString("utf8");
      if (this.stdout.length > 512 * 1024) this.stdout = this.stdout.slice(-256 * 1024);
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
      if (this.stderr.length > 512 * 1024) this.stderr = this.stderr.slice(-256 * 1024);
    });
    this.exited = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() }));
    });
    const portFile = path.join(this.profileDir, "DevToolsActivePort");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const lines = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
        if (lines[0] && /^\d+$/.test(lines[0].trim())) {
          this.port = Number(lines[0].trim());
          break;
        }
      } catch (error) {
        // Chromium creates DevToolsActivePort in place; a concurrent read can
        // hit a transient share/rename lock. Retry until the deadline.
        if (error.code !== "EBUSY" && error.code !== "ENOENT") throw error;
      }
      if (this.child.exitCode !== null) break;
      await sleep(200);
    }
    if (!this.port) {
      const tail = this.stderr.slice(-2000) || (this.logFile ? fs.readFileSync(this.logFile, "utf8").slice(-2000) : "");
      throw new Error(`${this.name}: CDP did not start (exit=${this.child.exitCode}); ${redact(tail)}`);
    }
    log(`[browser ${this.name}] CDP port ${this.port} pid ${this.child.pid}`);
    const version = await httpJson(this.port, "GET", "/json/version");
    this.browserConnection = await CdpConnection.connect(version.webSocketDebuggerUrl);
    return this;
  }

  async listTargets() {
    return httpJson(this.port, "GET", "/json/list");
  }

  async newPage(url) {
    const created = await this.browserConnection.call("Target.createTarget", { url });
    const targetId = created.targetId;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const targets = await this.listTargets();
      const info = targets.find((t) => t.id === targetId);
      if (info && info.webSocketDebuggerUrl) {
        const connection = await CdpConnection.connect(info.webSocketDebuggerUrl);
        const page = new CdpPage(connection, info);
        // Wait for the extension page's document.
        await page.waitFor("document.readyState", (v) => v === "complete", { timeoutMs: 15000 });
        return page;
      }
      await sleep(100);
    }
    throw new Error(`${this.name}: new page did not expose a websocket (${url})`);
  }

  async firstPage() {
    const targets = await this.listTargets();
    const info = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!info) throw new Error(`${this.name}: no page target`);
    const connection = await CdpConnection.connect(info.webSocketDebuggerUrl);
    const page = new CdpPage(connection, info);
    await page.waitFor("document.readyState", (v) => v === "complete", { timeoutMs: 15000 });
    return page;
  }

  async close({ graceful = true, timeoutMs = 15000 } = {}) {
    if (!this.child) return;
    if (graceful && this.browserConnection) {
      try {
        await this.browserConnection.call("Browser.close", {}, 5000);
      } catch {}
    }
    const result = await Promise.race([this.exited, sleep(timeoutMs).then(() => null)]);
    if (!result) {
      killPid(this.child.pid, { tree: true });
      await Promise.race([this.exited, sleep(5000)]);
    }
    try {
      this.browserConnection?.close();
    } catch {}
    this.browserConnection = null;
    // Browser stderr can contain the native host's stderr. Redact before it is
    // written so a temporary log can never retain a ticket or cookie value.
    try {
      if (this.logFile) {
        fs.writeFileSync(`${this.logFile}.stderr.log`, redact(this.stderr), "utf8");
      }
    } catch {}
  }

  killTree() {
    if (this.child?.pid) killPid(this.child.pid, { tree: true });
  }

  async waitExit(timeoutMs = 15000) {
    return Promise.race([this.exited, sleep(timeoutMs).then(() => null)]);
  }
}

// ---------------------------------------------------------------------------
// Native messaging host registration (test-only key, restored afterwards)
// ---------------------------------------------------------------------------

function regPowerShell(key, body) {
  // reg.exe rejects this host key shape in the current environment; the
  // PowerShell registry provider handles HKCU\... reliably.
  const prefix = "HKCU" + String.fromCharCode(92);
  const psKey = "HKCU:" + String.fromCharCode(92) + key.slice(prefix.length);
  const script = body.replaceAll("__KEY__", psKey.replace(/'/g, "''"));
  return runSync("powershell", ["-NoProfile", "-Command", script]);
}

function regQuery(key) {
  const result = regPowerShell(
    key,
    `$p='__KEY__'; if (Test-Path -LiteralPath $p) { $v=(Get-ItemProperty -LiteralPath $p -ErrorAction Stop).'(default)'; if ($null -eq $v) { 'PRESENT-NULL' } else { 'VALUE=' + $v } } else { 'ABSENT' }`,
  );
  const out = result.stdout.trim();
  if (out === "ABSENT" || out === "") return { exists: false, value: null };
  if (out.startsWith("VALUE=")) return { exists: true, value: out.slice("VALUE=".length) };
  if (out === "PRESENT-NULL") return { exists: true, value: null };
  return { exists: true, value: null };
}

function regAdd(key, value) {
  const escaped = String(value).replace(/'/g, "''");
  const result = regPowerShell(
    key,
    `$p='__KEY__'; New-Item -Path $p -Force | Out-Null; Set-ItemProperty -LiteralPath $p -Name '(default)' -Value '${escaped}'`,
  );
  if (result.code !== 0) {
    throw new Error(`registry set failed: ${redact(result.stderr || result.stdout)}`);
  }
}

function regDelete(key) {
  const result = regPowerShell(
    key,
    `$p='__KEY__'; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }`,
  );
  if (result.code !== 0) {
    throw new Error(`registry delete failed: ${redact(result.stderr || result.stdout)}`);
  }
  const after = regQuery(key);
  if (after.exists) throw new Error(`registry key still exists after delete: ${key}`);
}

async function setupNativeHost(hostExe) {
  const manifestPath = path.join(runRoot, "host", `${HOST_NAME}.json`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "BrowserPilot E2E native messaging host (temporary)",
        path: hostExe,
        type: "stdio",
        allowed_origins: [`chrome-extension://${SOURCE_EXTENSION_ID}/`],
      },
      null,
      2,
    ),
    "utf8",
  );
  const previous = regQuery(REG_KEY);
  regAdd(REG_KEY, manifestPath);
  registryRestore = () => {
    if (previous.exists && previous.value) regAdd(REG_KEY, previous.value);
    else regDelete(REG_KEY);
    registryRestore = null;
  };
  return { manifestPath, previous };
}

function restoreNativeHost() {
  if (registryRestore) {
    try {
      registryRestore();
    } catch (err) {
      log(`WARN could not restore native host registry: ${redact(err.message)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Target browser: descriptor, ticket, dialogs
// ---------------------------------------------------------------------------

class TargetBrowser {
  constructor(options) {
    this.name = options.name;
    this.run = options.run;
    this.profileDir = options.profileDir || path.join(runRoot, "profiles", `${this.name}-${stamp()}`);
    this.sessionDir = options.sessionDir || sessionsDir;
    this.importMode = options.importMode !== false;
    this.browser = null;
    this.descriptor = null;
    this.descriptorPath = null;
    this.ticket = null;
    this.pipeName = null;
    this.dialogs = [];
  }

  async start({ importMode = this.importMode } = {}) {
    this.importMode = importMode;
    fs.mkdirSync(this.sessionDir, { recursive: true });
    const targetArgs = [];
    if (this.importMode) {
      const existing = fs.existsSync(this.sessionDir)
        ? fs.readdirSync(this.sessionDir).filter((f) => f.endsWith(".json"))
        : [];
      targetArgs.push("--browser-cli-cookie-import", `--browser-cli-cookie-import-session-dir=${this.sessionDir}`);
      this.existingDescriptors = new Set(existing);
    }
    this.browser = new Browser({
      name: this.name,
      exe: chromeExe,
      profileDir: this.profileDir,
      args: [...targetArgs, "--window-size=1000,700", "about:blank"],
      env: { BROWSER_CLI_IMPORT_SESSION_DIR: this.sessionDir },
      logFile: path.join(logsDir, `${this.name}-chrome.log`),
    });
    await this.browser.start();
    if (this.importMode) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const files = fs.existsSync(this.sessionDir)
          ? fs.readdirSync(this.sessionDir).filter((f) => f.endsWith(".json"))
          : [];
        const fresh = files.filter((f) => !this.existingDescriptors?.has(f));
        for (const file of fresh) {
          const candidatePath = path.join(this.sessionDir, file);
          let candidate;
          try {
            candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
          } catch {
            continue;
          }
          // Another target (for example the long-lived expiry target) may
          // publish a descriptor first. Only take the descriptor whose
          // targetPid is this browser process.
          if (candidate.targetPid !== this.browser.child.pid) continue;
          this.descriptorPath = candidatePath;
          this.descriptor = candidate;
          this.pipeName = candidate.pipeName;
          break;
        }
        if (this.descriptor) break;
        if (this.browser.child.exitCode !== null) break;
        await sleep(150);
      }
      if (!this.descriptor) {
        const logTail = readLogTail(this.browser);
        throw blocked(`${this.name}: target session descriptor was not created; ${redact(logTail)}`);
      }
      assertEqual(this.descriptor.schema, contract.SESSION_SCHEMA, "descriptor schema");
      assertEqual(this.descriptor.protocolVersion, 2, "descriptor protocol");
      assertEqual(this.descriptor.targetPid, this.browser.child.pid, "descriptor targetPid");
      assert(!JSON.stringify(this.descriptor).includes("ticket\""), "descriptor must not contain a plaintext ticket");
    }
    return this;
  }

  async readTicket() {
    const deadline = Date.now() + 15000;
    let last = "";
    while (Date.now() < deadline) {
      const output = await powershell("read-ticket.ps1", ["-TargetPid", String(this.browser.child.pid)]);
      last = output.trim();
      if (/^BCLI(?:-[0-9A-Z]{4}){8}$/.test(last)) {
        this.ticket = last;
        addSecret(last);
        addSecret(contract.normalizeTicket(last));
        return last;
      }
      if (this.browser.child.exitCode !== null) break;
      await sleep(200);
    }
    throw blocked(`${this.name}: ticket not found in target session dialog (${last.length} chars)`);
  }

  async dumpWindows() {
    const output = await powershell("dump-windows.ps1", ["-TargetPid", String(this.browser.child.pid)]);
    return output;
  }

  async windowState() {
    return powershell("enum-windows.ps1", ["-TargetPid", String(this.browser.child.pid)]);
  }

  async waitForWindow(title, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const dump = await this.dumpWindows();
      if (dump.includes(`name=[${title}]`)) return dump;
      if (this.browser.child.exitCode !== null) break;
      await sleep(200);
    }
    return null;
  }

  async clickDialog(title, button, { physical = false } = {}) {
    const argv = [
      "-TargetPid",
      String(this.browser.child.pid),
      "-WindowTitle",
      title,
      "-ButtonName",
      button,
    ];
    if (physical) argv.push("-Physical");
    const output = await powershell("click-button.ps1", argv);
    this.dialogs.push({ title, button, physical, output: redact(output.trim()) });
    return output.trim();
  }

  async pipeSddl() {
    const output = await powershell("named-pipe-sddl.ps1", [
      "-TargetPid",
      String(this.browser.child.pid),
      "-PipeName",
      this.pipeName,
    ]);
    return output.trim();
  }

  async openSite(url) {
    const page = await this.browser.newPage(url);
    return page;
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

function readLogTail(browser) {
  try {
    if (browser.logFile && fs.existsSync(browser.logFile)) {
      return fs.readFileSync(browser.logFile, "utf8").slice(-4000);
    }
  } catch {}
  return browser.stderr.slice(-4000) || "";
}

// ---------------------------------------------------------------------------
// Raw pipe client (audit only; not the product transport)
// ---------------------------------------------------------------------------

class PipeClient {
  constructor(pipeName) {
    this.pipeName = pipeName;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.closed = false;
    this.closeWaiters = [];
  }

  async connect() {
    this.socket = net.connect({ path: this.pipeName });
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("close", () => {
      this.closed = true;
      for (const waiter of [...this.closeWaiters]) waiter();
      this.closeWaiters = [];
    });
    return this;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const message = JSON.parse(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);
      this.frames.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  }

  send(message) {
    const json = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    this.socket.write(Buffer.concat([header, json]));
  }

  waitFrame(predicate, timeoutMs = 15000) {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.closed) return Promise.reject(new Error("pipe closed"));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new Error("pipe frame timeout"));
        }
      }, timeoutMs);
    });
  }

  // Resolves with {type:"frame", frame} or {type:"closed"} or {type:"timeout"}.
  // Used by the expiry scenario: the target may close the pipe without sending
  // the ticket-expired frame if it stops the pipe thread before draining.
  waitFrameOrClose(predicate, timeoutMs = 15000) {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve({ type: "frame", frame: existing });
    if (this.closed) return Promise.resolve({ type: "closed" });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        const closeIndex = this.closeWaiters.indexOf(onClose);
        if (closeIndex >= 0) this.closeWaiters.splice(closeIndex, 1);
        resolve(value);
      };
      const waiter = {
        predicate,
        resolve: (frame) => finish({ type: "frame", frame }),
      };
      const onClose = () => finish({ type: "closed" });
      const timer = setTimeout(() => finish({ type: "timeout" }), timeoutMs);
      this.waiters.push(waiter);
      this.closeWaiters.push(onClose);
    });
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {}
  }
}

function makeJobPayload({ domain = TEST_DOMAIN, cookieValue, sessionValue, jobNonce, includeSession = true }) {
  const domains = [domain];
  const cookies = [
    {
      domain,
      hostOnly: true,
      path: "/",
      name: "e2e_sid",
      value: cookieValue,
      secure: false,
      httpOnly: true,
      sameSite: "lax",
      session: false,
      expirationDate: 2000000000,
    },
  ];
  if (includeSession) {
    cookies.push({
      domain,
      hostOnly: true,
      path: "/",
      name: "e2e_session",
      value: sessionValue,
      secure: false,
      httpOnly: false,
      sameSite: "lax",
      session: true,
    });
  }
  return (async () => {
    const consent = await contract.buildConsent({ extensionVersion: "0.3.0", domains });
    return {
      contract: contract.CONTRACT_ID,
      protocolVersion: contract.PROTOCOL_VERSION,
      jobNonce,
      source: { browser: "chrome", profileLabel: "synthetic", extensionVersion: "0.3.0" },
      consent,
      domains,
      cookies,
    };
  })();
}

async function sendRawJob(client, ticket, payload) {
  const text = JSON.stringify(payload);
  const bytes = Buffer.from(text, "utf8");
  const digest = await contract.jobDigest(text);
  const chunks = contract.chunkJobPayload(text);
  client.send({
    type: "hello",
    protocol: 2,
    ticket: contract.normalizeTicket(ticket),
    hostPid: process.pid,
    jobNonce: payload.jobNonce,
    jobDigest: digest,
    totalBytes: bytes.length,
    chunkCount: chunks.length,
  });
  const ready = await client.waitFrame((m) => m.type === "ready" || m.type === "error");
  if (ready.type === "error") return { error: ready.code, frames: client.frames };
  client.send({
    type: "job-begin",
    jobNonce: payload.jobNonce,
    jobDigest: digest,
    totalBytes: bytes.length,
    chunkCount: chunks.length,
  });
  for (let i = 0; i < chunks.length; i += 1) {
    client.send({ type: "job-chunk", jobNonce: payload.jobNonce, index: i, data: chunks[i] });
  }
  client.send({ type: "job-commit", jobNonce: payload.jobNonce });
  const accepted = await client.waitFrame((m) => m.type === "accepted" || m.type === "error");
  return { ready, accepted, frames: client.frames };
}

// ---------------------------------------------------------------------------
// Source browser and extension popup
// ---------------------------------------------------------------------------

class SourceBrowser {
  constructor(options = {}) {
    this.name = options.name || "source";
    this.profileDir = options.profileDir || path.join(runRoot, "profiles", `${this.name}-${stamp()}`);
    this.sessionDir = options.sessionDir || sessionsDir;
    this.browser = null;
    this.popup = null;
  }

  async start(initialUrl) {
    this.browser = new Browser({
      name: this.name,
      exe: chromeExe,
      profileDir: this.profileDir,
      args: [
        `--load-extension=${SOURCE_EXT_PATH}`,
        "--window-size=900,700",
        ...(initialUrl ? [initialUrl] : []),
      ],
      env: { BROWSER_CLI_IMPORT_SESSION_DIR: this.sessionDir },
      logFile: path.join(logsDir, `${this.name}-chrome.log`),
    });
    await this.browser.start();
    return this;
  }

  async openPopup() {
    const url = `chrome-extension://${SOURCE_EXTENSION_ID}/popup.html`;
    this.popup = await this.browser.newPage(url);
    await this.popup.waitFor("document.querySelector('#ack') !== null", (v) => v === true, {
      timeoutMs: 15000,
    });
    return this.popup;
  }

  async scan() {
    assert(this.popup, "popup not open");
    const popup = this.popup;
    const ackChecked = await popup.eval("document.querySelector('#ack')?.checked === true");
    if (!ackChecked) await popup.click("#ack");
    await popup.click("#scanBtn");
    await popup.waitFor(
      "document.querySelector('#scanSummary')?.textContent || ''",
      (text) => text.includes("共") && text.includes("条 Cookie"),
      { timeoutMs: 20000 },
    );
    await popup.waitFor(
      `document.querySelector('input.domain-check[data-domain="${TEST_DOMAIN}"]') !== null`,
      (v) => v === true,
      { timeoutMs: 10000 },
    );
    const summary = await popup.text("#scanSummary");
    return { summary: redact(summary) };
  }

  async selectDomainAndSend(ticket) {
    assert(this.popup, "popup not open");
    const popup = this.popup;
    const selector = `input.domain-check[data-domain="${TEST_DOMAIN}"]`;
    const checked = await popup.eval(
      `document.querySelector('${selector}')?.checked === true`,
    );
    if (!checked) await popup.click(selector);
    await popup.waitFor(
      "document.querySelector('#selectionCount')?.textContent || ''",
      (text) => text.includes("已选 1 个域名"),
      { timeoutMs: 5000 },
    );
    await popup.type("#ticket", ticket);
    const consent = await popup.eval("document.querySelector('#sendConsent')?.checked === true");
    if (!consent) await popup.click("#sendConsent");
    await popup.waitFor(
      "document.querySelector('#sendBtn')?.disabled === false",
      (v) => v === true,
      { timeoutMs: 5000 },
    );
    await popup.click("#sendBtn");
    const summary = await popup.waitFor(
      "document.querySelector('#sendSummary')?.textContent || ''",
      (text) => text.includes("已交给本机中转进程") || text.includes("发送失败"),
      { timeoutMs: 20000 },
    );
    return { summary: redact(summary), success: summary.includes("已交给本机中转进程") };
  }

  async waitTerminal({ timeoutMs = 30000 } = {}) {
    const popup = this.popup;
    const state = await popup.waitFor(
      "document.querySelector('#stateLabel')?.textContent || ''",
      (text) =>
        text.includes("目标已完成") ||
        text.includes("目标报告失败") ||
        text.includes("导入已取消") ||
        text.includes("拒绝了本次导入"),
      { timeoutMs },
    );
    const auth = await popup.text("#stateAuth");
    const cookie = await popup.text("#stateCookie");
    const detail = await popup.text("#resultDetail");
    const failures = await popup.text("#failures");
    const lastJob = await popup.eval(
      "chrome.storage.session.get('bp_last_job').then((v) => v.bp_last_job || null)",
    );
    return {
      stateText: redact(state),
      authorizationText: redact(auth),
      cookieText: redact(cookie),
      detail: redact(detail),
      failures: redact(failures),
      lastJob: lastJob ? JSON.parse(redact(JSON.stringify(lastJob))) : null,
    };
  }

  async cancelFromPopup() {
    assert(this.popup, "popup not open");
    await this.popup.click("#cancelBtn");
    const summary = await this.popup.waitFor(
      "document.querySelector('#sendSummary')?.textContent || ''",
      (text) =>
        text.includes("已请求取消") ||
        text.includes("已取消") ||
        text.includes("取消失败"),
      { timeoutMs: 10000 },
    );
    return {
      summary: redact(summary),
      ok: summary.includes("已请求取消") || summary.includes("已取消"),
    };
  }

  async storageSnapshot() {
    if (!this.popup) return null;
    return this.popup.eval(
      "chrome.storage.session.get(null).then((v) => JSON.parse(JSON.stringify(v)))",
    );
  }

  async openStorageProbe() {
    const url = `chrome-extension://${SOURCE_EXTENSION_ID}/popup.html`;
    const page = await this.browser.newPage(url);
    try {
      return await page.eval(
        "chrome.storage.session.get(null).then((v) => JSON.parse(JSON.stringify(v)))",
      );
    } finally {
      await page.close();
    }
  }

  sanitizeStorage(storage) {
    if (!storage || typeof storage !== "object") return null;
    const job = storage.bp_last_job || null;
    return {
      keys: Object.keys(storage).sort(),
      hasLastJob: !!job,
      jobId: typeof job?.jobId === "string" ? job.jobId : null,
      state: typeof job?.state === "string" ? job.state : null,
      selectedDomainCount: Array.isArray(storage.bp_selected_domains)
        ? storage.bp_selected_domains.length
        : 0,
    };
  }

  async sourceLoginCheck(site) {
    const page = this.browser ? await this.browser.firstPage() : null;
    if (!page) return null;
    const result = await page.eval("fetch('/login-check').then((r) => r.text())");
    return result;
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

const scenarioResults = [];

function recordScenario(name, verdict, details, error) {
  const record = {
    scenario: name,
    verdict,
    details,
    ...(error ? { error: redact(String(error)) } : {}),
    at: new Date().toISOString(),
  };
  scenarioResults.push(record);
  log(`RESULT ${name}: ${verdict}${error ? ` (${redact(String(error.message || error))})` : ""}`);
  return record;
}

async function runScenario(name, fn) {
  log(`\n=== ${name} ===`);
  const details = {};
  try {
    await fn(details);
    return recordScenario(name, "PASS", details);
  } catch (err) {
    const verdict = err && err.blocked ? "BLOCKED" : "FAIL";
    return recordScenario(name, verdict, details, err);
  }
}

function primaryJobView(sourceStatus) {
  return sourceStatus?.lastJob?.lastView || sourceStatus?.lastJob || null;
}

function assertTargetView(sourceStatus, expected) {
  const view = primaryJobView(sourceStatus);
  assert(view, "popup did not persist a job view");
  assertEqual(view.state, expected.state, "target job state");
  if (expected.status !== undefined) {
    assertEqual(view.cookieImported?.status, expected.status, "cookieImported.status");
  }
  if (expected.applied !== undefined) {
    assertEqual(view.cookieImported?.applied, expected.applied, "cookieImported.applied");
  }
  if (expected.failed !== undefined) {
    assertEqual(view.cookieImported?.failed, expected.failed, "cookieImported.failed");
  }
  if (expected.targetUserConfirmed !== undefined) {
    assertEqual(
      view.authorization?.targetUserConfirmed,
      expected.targetUserConfirmed,
      "authorization.targetUserConfirmed",
    );
  }
  if (expected.simulated !== undefined) {
    assertEqual(view.authorization?.simulated, expected.simulated, "authorization.simulated");
  }
  if (expected.authorizationSource !== undefined) {
    assertEqual(view.authorization?.source, expected.authorizationSource, "authorization.source");
  }
  assertEqual(view.loginVerified?.status, "not_verified", "loginVerified.status");
  return view;
}

async function siteCheck(target, site, pathname, expected, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    log(`[site] ${pathname} attempt (expect ${expected})`);
    const page = await target.openSite(site.url(pathname));
    try {
      last = (await page.bodyText()).trim();
    } finally {
      await page.close();
    }
    log(`[site] ${pathname} -> ${last}`);
    if (last === expected) return last;
    await sleep(250);
  }
  throw new Error(`${pathname}: expected ${expected}, got ${JSON.stringify(last)}`);
}

function descriptorSafeView(descriptor) {
  if (!descriptor) return null;
  return {
    schema: descriptor.schema,
    protocolVersion: descriptor.protocolVersion,
    targetProduct: descriptor.targetProduct,
    targetVersion: descriptor.targetVersion,
    targetPid: descriptor.targetPid,
    targetStartTimeMs: descriptor.targetStartTimeMs,
    targetInstanceId: descriptor.targetInstanceId,
    profileHash: descriptor.profileHash,
    ticketHash: descriptor.ticketHash,
    transport: descriptor.transport,
    pipeName: descriptor.pipeName,
    createdAt: descriptor.createdAt,
    expiresAt: descriptor.expiresAt,
  };
}

function assertPipeDacl(sddlText) {
  const sddlLine = sddlText.split(/\r?\n/).find((line) => line.startsWith("SDDL=")) || sddlText;
  // SDDL "GA" (generic all) is rendered as "FA" (file all access) when the
  // security descriptor is parsed, so accept both spellings.
  assert(/(?:^|\()A;;F?A;;;SY\)/.test(sddlLine), `pipe DACL missing SYSTEM full access: ${sddlLine}`);
  assert(/(?:^|\()A;;F?A;;;OW\)/.test(sddlLine), `pipe DACL missing owner full access: ${sddlLine}`);
  for (const forbidden of [";;;WD)", ";;;AU)", ";;;BU)", ";;;AN)"]) {
    assert(!sddlLine.includes(forbidden), `pipe DACL grants ${forbidden}: ${sddlLine}`);
  }
  return sddlLine;
}

async function launchPair({ targetName, sourceName, site, importMode = true, initialSite = true }) {
  const target = new TargetBrowser({ name: targetName });
  const source = new SourceBrowser({ name: sourceName });
  try {
    await target.start({ importMode });
    const ticket = await target.readTicket();
    await source.start(initialSite ? site.url("/set") : null);
    if (initialSite) {
      const check = await source.sourceLoginCheck(site);
      assertEqual(check, "LOGIN_OK", "synthetic source login before import");
    }
    return { target, source, ticket };
  } catch (err) {
    // launchPair may fail before the caller's try/finally exists. Close both
    // browsers here so a descriptor/PID race cannot leak a target process.
    try {
      await source.close();
    } catch {}
    try {
      await target.close();
    } catch {}
    throw err;
  }
}

async function closePair(pair) {
  if (!pair) return;
  try {
    await pair.source?.close();
  } catch {}
  try {
    await pair.target?.close();
  } catch {}
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioApproveAndRestart(site) {
  return runScenario("approve-native-write-restart", async (details) => {
    const pair = await launchPair({ targetName: "target-approve", sourceName: "source-approve", site });
    try {
      const { target, source, ticket } = pair;
      details.targetPid = target.browser.child.pid;
      details.pipeName = target.pipeName;
      details.descriptor = descriptorSafeView(target.descriptor);
      const sddl = await target.pipeSddl();
      details.pipeDacl = assertPipeDacl(sddl);
      const sessionDump = await target.waitForWindow(SESSION_TITLE, 10000);
      assert(sessionDump, "target ticket dialog was not shown");
      details.ticketDialog = {
        shown: true,
        hwnd: (sessionDump.match(/WINDOW hwnd=(\d+) pid=\d+ name=\[Browser CLI cookie import\]/) || [])[1] || null,
      };
      const popup = await source.openPopup();
      details.popupUrl = popup.targetInfo.url;
      const scan = await source.scan();
      details.scanSummary = scan.summary;
      const sent = await source.selectDomainAndSend(ticket);
      details.sendSummary = sent.summary;
      assert(sent.success, `source extension did not hand off the job: ${sent.summary}`);

      const approvalDump = await target.waitForWindow(APPROVAL_TITLE, 20000);
      assert(approvalDump, "target approval dialog was not shown");
      const approvalWindow = approvalDump.match(/WINDOW hwnd=(\d+) pid=\d+ name=\[Allow cookie import into Browser CLI\?\]/);
      details.approvalDialog = {
        shown: true,
        hwnd: approvalWindow ? approvalWindow[1] : null,
        uia: redact(approvalDump),
      };
      try {
        details.targetWindows = redact(await target.windowState());
      } catch (err) {
        details.targetWindows = `window-state-error: ${redact(String(err.message || err))}`;
      }

      let gesture = "UIAutomation.Invoke";
      try {
        const clickOutput = await target.clickDialog(APPROVAL_TITLE, "Allow", { physical: true });
        details.physicalClick = redact(clickOutput);
        gesture = "SendInput-topmost";
      } catch (err) {
        details.physicalClickError = redact(String(err.message || err));
        const clickOutput = await target.clickDialog(APPROVAL_TITLE, "Allow", { physical: false });
        details.uiaClick = redact(clickOutput);
      }
      details.gesture = gesture;

      let status;
      try {
        status = await source.waitTerminal({ timeoutMs: 30000 });
      } catch (err) {
        if (gesture === "SendInput-topmost") {
          details.physicalClickOutcome = "did-not-advance";
          gesture = "UIAutomation.Invoke";
          details.gesture = gesture;
          const clickOutput = await target.clickDialog(APPROVAL_TITLE, "Allow", { physical: false });
          details.uiaClick = redact(clickOutput);
          status = await source.waitTerminal({ timeoutMs: 30000 });
        } else {
          throw err;
        }
      }
      details.terminal = status;
      const view = assertTargetView(status, {
        state: "done",
        status: "imported",
        applied: 2,
        failed: 0,
        targetUserConfirmed: true,
        simulated: false,
        authorizationSource: "target-browser-dialog",
      });
      details.jobId = view.jobId;
      details.totals = view.totals;
      details.authorization = view.authorization;
      details.loginVerified = view.loginVerified.status;

      const login = await siteCheck(target, site, "/login-check", "LOGIN_OK");
      const session = await siteCheck(target, site, "/session-check", "SESSION_PRESENT");
      details.beforeRestart = { login, session };
      const valueCheck = await siteCheck(target, site, "/value-check", "VALUE_MATCH");
      details.valueCheck = valueCheck;

      // Stop the source first (closes the relay), then restart the target.
      await source.close();
      await target.close();
      details.firstTargetExit = "closed";

      log("[approve] restarting target with the same profile (normal mode)");
      const restarted = new TargetBrowser({ name: "target-approve-restart", profileDir: target.profileDir });
      await restarted.start({ importMode: false });
      log("[approve] restarted target is up");
      try {
        const loginAfter = await siteCheck(restarted, site, "/login-check", "LOGIN_OK");
        const sessionAfter = await siteCheck(restarted, site, "/session-check", "SESSION_MISSING");
        details.afterRestart = { login: loginAfter, session: sessionAfter };
      } finally {
        await restarted.close();
      }
    } finally {
      await closePair(pair);
    }
  });
}

async function scenarioDeny(site) {
  return runScenario("deny-no-write", async (details) => {
    const pair = await launchPair({ targetName: "target-deny", sourceName: "source-deny", site });
    try {
      const { target, source, ticket } = pair;
      details.targetPid = target.browser.child.pid;
      details.pipeName = target.pipeName;
      const popup = await source.openPopup();
      await source.scan();
      const sent = await source.selectDomainAndSend(ticket);
      assert(sent.success, `source send failed: ${sent.summary}`);
      const approvalDump = await target.waitForWindow(APPROVAL_TITLE, 20000);
      assert(approvalDump, "target approval dialog was not shown");
      details.approvalShown = true;
      const clickOutput = await target.clickDialog(APPROVAL_TITLE, "Deny", { physical: false });
      details.denyClick = redact(clickOutput);
      const status = await source.waitTerminal({ timeoutMs: 20000 });
      details.terminal = status;
      assertTargetView(status, {
        state: "denied",
        status: "not_started",
        applied: 0,
        failed: 0,
        targetUserConfirmed: false,
      });
      details.login = await siteCheck(target, site, "/login-check", "LOGIN_MISSING", { timeoutMs: 5000 });
      details.session = await siteCheck(target, site, "/session-check", "SESSION_MISSING", { timeoutMs: 5000 });
    } finally {
      await closePair(pair);
    }
  });
}

async function scenarioCancel(site) {
  return runScenario("cancel-then-late-allow", async (details) => {
    const pair = await launchPair({ targetName: "target-cancel", sourceName: "source-cancel", site });
    try {
      const { target, source, ticket } = pair;
      details.targetPid = target.browser.child.pid;
      details.pipeName = target.pipeName;
      const popup = await source.openPopup();
      await source.scan();
      const sent = await source.selectDomainAndSend(ticket);
      assert(sent.success, `source send failed: ${sent.summary}`);
      assert(await target.waitForWindow(APPROVAL_TITLE, 20000), "target approval dialog was not shown");
      const cancel = await source.cancelFromPopup();
      details.cancel = cancel;
      assert(cancel.ok, `source cancel failed: ${cancel.summary}`);
      const status = await source.waitTerminal({ timeoutMs: 20000 });
      details.terminal = status;
      assertTargetView(status, { state: "cancelled", applied: 0, failed: 0, targetUserConfirmed: false });
      // The dialog may still be open. A late Allow must not write anything.
      try {
        const late = await target.clickDialog(APPROVAL_TITLE, "Allow", { physical: false });
        details.lateAllow = redact(late);
      } catch (err) {
        details.lateAllow = `dialog-not-clickable: ${redact(String(err.message || err))}`;
      }
      await sleep(1500);
      details.login = await siteCheck(target, site, "/login-check", "LOGIN_MISSING", { timeoutMs: 5000 });
      details.session = await siteCheck(target, site, "/session-check", "SESSION_MISSING", { timeoutMs: 5000 });
      const storage = await source.storageSnapshot();
      details.storageStates = storage?.bp_last_job?.state || null;
    } finally {
      await closePair(pair);
    }
  });
}

async function scenarioHostInterruption(site) {
  return runScenario("host-interruption", async (details) => {
    const pair = await launchPair({ targetName: "target-hostkill", sourceName: "source-hostkill", site });
    try {
      const { target, source, ticket } = pair;
      details.targetPid = target.browser.child.pid;
      details.sourcePid = source.browser.child.pid;
      const popup = await source.openPopup();
      await source.scan();
      const sent = await source.selectDomainAndSend(ticket);
      assert(sent.success, `source send failed: ${sent.summary}`);
      const host = await findProcessByExecutable(hostExePath, { timeoutMs: 15000 });
      assert(host, "native host process was not found");
      details.hostPid = host.ProcessId;
      details.hostParentPid = host.ParentProcessId;
      assert(await target.waitForWindow(APPROVAL_TITLE, 20000), "target approval dialog was not shown");
      killPid(host.ProcessId);
      await sleep(1500);
      const popupState = await source.popup.text("#stateLabel").catch(() => "");
      const popupSummary = await source.popup.text("#sendSummary").catch(() => "");
      details.popupAfterKill = {
        stateLabel: redact(popupState),
        sendSummary: redact(popupSummary),
      };
      details.login = await siteCheck(target, site, "/login-check", "LOGIN_MISSING", { timeoutMs: 5000 });
      details.hostExited = !(await processInfo(host.ProcessId));
    } finally {
      await closePair(pair);
    }
  });
}

async function scenarioSourceReplacement(site) {
  return runScenario("source-process-replacement", async (details) => {
    const pair = await launchPair({ targetName: "target-srckill", sourceName: "source-srckill", site });
    try {
      const { target, source, ticket } = pair;
      details.targetPid = target.browser.child.pid;
      details.sourcePid = source.browser.child.pid;
      const popup = await source.openPopup();
      await source.scan();
      const sent = await source.selectDomainAndSend(ticket);
      assert(sent.success, `source send failed: ${sent.summary}`);
      const host = await findProcessByExecutable(hostExePath, { timeoutMs: 15000 });
      details.hostPidBefore = host ? host.ProcessId : null;
      assert(await target.waitForWindow(APPROVAL_TITLE, 20000), "target approval dialog was not shown");
      source.browser.killTree();
      await source.browser.waitExit(15000);
      details.sourceKilled = true;
      await sleep(1500);
      details.login = await siteCheck(target, site, "/login-check", "LOGIN_MISSING", { timeoutMs: 5000 });
      details.session = await siteCheck(target, site, "/session-check", "SESSION_MISSING", { timeoutMs: 5000 });
      details.hostExited = host ? !(await processInfo(host.ProcessId)) : null;

      // Replacement source process: same source profile, new process. The
      // one-time ticket was memory-only, so nothing can be replayed.
      const replacement = new SourceBrowser({ name: "source-replacement", profileDir: source.profileDir });
      await replacement.start(site.url("/set"));
      try {
        const storage = await replacement.openStorageProbe();
        details.replacementStorage = replacement.sanitizeStorage(storage);
        assert(!JSON.stringify(storage).includes("bp_last_job"), "session storage survived source replacement");
      } finally {
        await replacement.close();
      }
    } finally {
      await closePair(pair);
    }
  });
}

async function scenarioDuplicate(site) {
  return runScenario("duplicate-submit", async (details) => {
    const pair = await launchPair({ targetName: "target-duplicate", sourceName: "source-duplicate", site });
    try {
      const { target, source, ticket } = pair;
      details.targetPid = target.browser.child.pid;
      details.pipeName = target.pipeName;
      const popup = await source.openPopup();
      await source.scan();
      const sent = await source.selectDomainAndSend(ticket);
      assert(sent.success, `first send failed: ${sent.summary}`);
      assert(await target.waitForWindow(APPROVAL_TITLE, 20000), "target approval dialog was not shown");
      await target.clickDialog(APPROVAL_TITLE, "Allow", { physical: false });
      const firstStatus = await source.waitTerminal({ timeoutMs: 30000 });
      details.first = firstStatus;
      const view = assertTargetView(firstStatus, {
        state: "done",
        status: "imported",
        applied: 2,
        failed: 0,
        targetUserConfirmed: true,
        simulated: false,
        authorizationSource: "target-browser-dialog",
      });
      details.firstJobId = view.jobId;

      // Re-enter the same ticket through the source UI. The popup cleared it
      // after the first success, so this is a genuine second user submit.
      await source.scan();
      const second = await source.selectDomainAndSend(ticket);
      details.secondSend = second;
      assert(!second.success, "second submit with the same ticket unexpectedly succeeded");
      details.secondError = second.summary;
      details.login = await siteCheck(target, site, "/login-check", "LOGIN_OK", { timeoutMs: 5000 });
      details.secondJobId = (await source.storageSnapshot())?.bp_last_job?.jobId || null;
      assertEqual(details.secondJobId, details.firstJobId, "duplicate submit created a new job");

      // Protocol-level replay on a fresh target: two hellos on one pipe.
      const replayTarget = new TargetBrowser({ name: "target-replay" });
      await replayTarget.start();
      try {
        details.replayTargetPid = replayTarget.browser.child.pid;
        details.replayPipeName = replayTarget.pipeName;
        const replayTicket = await replayTarget.readTicket();
        const client = await new PipeClient(replayTarget.pipeName).connect();
        await sleep(2000);
        try {
          const payload = await makeJobPayload({
            cookieValue: site.value,
            sessionValue: site.sessionValue,
            jobNonce: "a".repeat(32),
          });
          const text = JSON.stringify(payload);
          const digest = await contract.jobDigest(text);
          const bytes = Buffer.from(text, "utf8");
          const chunks = contract.chunkJobPayload(text);
          const hello = {
            type: "hello",
            protocol: 2,
            ticket: contract.normalizeTicket(replayTicket),
            hostPid: process.pid,
            jobNonce: payload.jobNonce,
            jobDigest: digest,
            totalBytes: bytes.length,
            chunkCount: chunks.length,
          };
          client.send(hello);
          const ready = await client.waitFrame((m) => m.type === "ready" || m.type === "error");
          assertEqual(ready.type, "ready", "first hello");
          client.send(hello);
          const secondHello = await client.waitFrame((m) => m.type === "error", 10000);
          details.replaySecondHello = { type: secondHello.type, code: secondHello.code };
          assertEqual(secondHello.code, "ticket-consumed", "replay error code");
        } finally {
          client.close();
        }
      } finally {
        await replayTarget.close();
      }
    } finally {
      await closePair(pair);
    }
  });
}

async function scenarioCrossProfile(site) {
  return runScenario("cross-profile-ticket", async (details) => {
    const a = new TargetBrowser({ name: "target-profile-a" });
    const b = new TargetBrowser({ name: "target-profile-b" });
    try {
      await a.start();
      await b.start();
      details.a = { targetPid: a.browser.child.pid, pipeName: a.pipeName, descriptor: descriptorSafeView(a.descriptor) };
      details.b = { targetPid: b.browser.child.pid, pipeName: b.pipeName, descriptor: descriptorSafeView(b.descriptor) };
      const ticketA = await a.readTicket();
      const ticketB = await b.readTicket();
      assert(a.pipeName !== b.pipeName, "targets shared a pipe name");
      assert(a.descriptor.ticketHash !== b.descriptor.ticketHash, "targets shared a ticket hash");
      assert(a.descriptor.targetPid !== b.descriptor.targetPid, "targets shared a PID");

      // Cross-profile: A's ticket against B's pipe.
      const client = await new PipeClient(b.pipeName).connect();
      await sleep(2000);
      try {
        const payload = await makeJobPayload({
          cookieValue: site.value,
          sessionValue: site.sessionValue,
          jobNonce: "b".repeat(32),
        });
        const text = JSON.stringify(payload);
        const digest = await contract.jobDigest(text);
        const bytes = Buffer.from(text, "utf8");
        const chunks = contract.chunkJobPayload(text);
        client.send({
          type: "hello",
          protocol: 2,
          ticket: contract.normalizeTicket(ticketA),
          hostPid: process.pid,
          jobNonce: payload.jobNonce,
          jobDigest: digest,
          totalBytes: bytes.length,
          chunkCount: chunks.length,
        });
        const response = await client.waitFrame((m) => m.type === "ready" || m.type === "error");
        details.crossProfileResponse = { type: response.type, code: response.code || null };
        assertEqual(response.type, "error", "cross-profile hello must fail");
        assertEqual(response.code, "ticket-invalid", "cross-profile error code");
      } finally {
        client.close();
      }
      details.bLogin = await siteCheck(b, site, "/login-check", "LOGIN_MISSING", { timeoutMs: 5000 });
      details.bSession = await siteCheck(b, site, "/session-check", "SESSION_MISSING", { timeoutMs: 5000 });

      // Positive control: A's own ticket on A's still-open pipe reaches ready.
      // B's pipe was torn down by the target when the failed audit client
      // disconnected (one client, one session), so use A for the control.
      const own = await new PipeClient(a.pipeName).connect();
      await sleep(2000);
      try {
        const payload = await makeJobPayload({
          cookieValue: site.value,
          sessionValue: site.sessionValue,
          jobNonce: "c".repeat(32),
        });
        const text = JSON.stringify(payload);
        const digest = await contract.jobDigest(text);
        const bytes = Buffer.from(text, "utf8");
        const chunks = contract.chunkJobPayload(text);
        own.send({
          type: "hello",
          protocol: 2,
          ticket: contract.normalizeTicket(ticketA),
          hostPid: process.pid,
          jobNonce: payload.jobNonce,
          jobDigest: digest,
          totalBytes: bytes.length,
          chunkCount: chunks.length,
        });
        const ready = await own.waitFrame((m) => m.type === "ready" || m.type === "error");
        details.ownTicketResponse = { type: ready.type, code: ready.code || null };
        assertEqual(ready.type, "ready", "own ticket hello");
      } finally {
        own.close();
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
}

async function scenarioClientIdentityAndDacl(site) {
  return runScenario("pipe-identity-dacl", async (details) => {
    // One target for the DACL + wrong-PID rejection, a second target for the
    // positive control. A client disconnect ends a target's single session, so
    // both checks cannot share one pipe.
    const wrong = new TargetBrowser({ name: "target-audit-wrong" });
    const right = new TargetBrowser({ name: "target-audit-right" });
    try {
      await wrong.start();
      details.wrongTargetPid = wrong.browser.child.pid;
      details.wrongPipeName = wrong.pipeName;
      const sddl = await wrong.pipeSddl();
      details.pipeDacl = assertPipeDacl(sddl);
      const wrongTicket = await wrong.readTicket();
      const wrongClient = await new PipeClient(wrong.pipeName).connect();
      try {
        // The target's UI thread must process OnImportPipeConnected (client
        // PID) before hello; otherwise the PID comparison sees 0. The product
        // relay has the same race window (recorded in the report).
        await sleep(2000);
        const payload = await makeJobPayload({
          cookieValue: site.value,
          sessionValue: site.sessionValue,
          jobNonce: "d".repeat(32),
        });
        const text = JSON.stringify(payload);
        const digest = await contract.jobDigest(text);
        const bytes = Buffer.from(text, "utf8");
        const chunks = contract.chunkJobPayload(text);
        wrongClient.send({
          type: "hello",
          protocol: 2,
          ticket: contract.normalizeTicket(wrongTicket),
          hostPid: process.pid + 1,
          jobNonce: payload.jobNonce,
          jobDigest: digest,
          totalBytes: bytes.length,
          chunkCount: chunks.length,
        });
        const mismatch = await wrongClient.waitFrame((m) => m.type === "error" || m.type === "ready");
        details.wrongHostPid = { type: mismatch.type, code: mismatch.code || null };
        assertEqual(mismatch.type, "error", "wrong hostPid hello must fail");
        assertEqual(mismatch.code, "host-identity-mismatch", "wrong hostPid error code");
      } finally {
        wrongClient.close();
      }
      details.wrongLogin = await siteCheck(wrong, site, "/login-check", "LOGIN_MISSING", { timeoutMs: 5000 });

      await right.start();
      details.rightTargetPid = right.browser.child.pid;
      details.rightPipeName = right.pipeName;
      const rightTicket = await right.readTicket();
      const rightClient = await new PipeClient(right.pipeName).connect();
      try {
        await sleep(2000);
        const payload = await makeJobPayload({
          cookieValue: site.value,
          sessionValue: site.sessionValue,
          jobNonce: "c".repeat(32),
        });
        const text = JSON.stringify(payload);
        const digest = await contract.jobDigest(text);
        const bytes = Buffer.from(text, "utf8");
        const chunks = contract.chunkJobPayload(text);
        rightClient.send({
          type: "hello",
          protocol: 2,
          ticket: contract.normalizeTicket(rightTicket),
          hostPid: process.pid,
          jobNonce: payload.jobNonce,
          jobDigest: digest,
          totalBytes: bytes.length,
          chunkCount: chunks.length,
        });
        const ready = await rightClient.waitFrame((m) => m.type === "ready" || m.type === "error");
        details.correctHostPid = { type: ready.type, code: ready.code || null };
        assertEqual(ready.type, "ready", "correct hostPid hello");
      } finally {
        rightClient.close();
      }
      details.rightLogin = await siteCheck(right, site, "/login-check", "LOGIN_MISSING", { timeoutMs: 5000 });
    } finally {
      await wrong.close();
      await right.close();
    }
  });
}

async function scenarioExpiredTicket(site) {
  return runScenario("expired-ticket", async (details) => {
    const target = new TargetBrowser({ name: "target-expiry" });
    const client = new PipeClient("");
    try {
      await target.start();
      details.targetPid = target.browser.child.pid;
      details.pipeName = target.pipeName;
      const ticket = await target.readTicket();
      client.pipeName = target.pipeName;
      await client.connect();
      details.connectedAt = new Date().toISOString();
      const started = Date.now();
      // Hold the connection without hello. The target's 5-minute session timer
      // must tear the session down. Observe both the intended ticket-expired
      // frame and the actual close, because the target queues the error and
      // then immediately joins the pipe thread in Shutdown().
      const outcome = await client.waitFrameOrClose(
        (m) => m.type === "error" || m.type === "ready",
        330000,
      );
      details.elapsedMs = Date.now() - started;
      details.expiryOutcome = outcome.type === "frame"
        ? { type: outcome.frame.type, code: outcome.frame.code || null }
        : outcome.type;
      // The pipe close is observed before the UI thread finishes Shutdown()
      // and RemoveDescriptor(). Poll briefly instead of racing the unlink.
      let descriptorRemoved = false;
      for (let i = 0; i < 50; i += 1) {
        if (!fs.existsSync(target.descriptorPath)) {
          descriptorRemoved = true;
          break;
        }
        await sleep(200);
      }
      details.descriptorAfterExpiry = descriptorRemoved ? "removed" : "present";
      const frameDelivered =
        outcome.type === "frame" &&
        outcome.frame.type === "error" &&
        outcome.frame.code === "ticket-expired";
      details.subChecks = {
        expiryEnforced:
          details.elapsedMs >= 295000 && details.descriptorAfterExpiry === "removed",
        errorFrameDelivered: frameDelivered,
      };
      assertEqual(
        details.subChecks.expiryEnforced,
        true,
        "session was not torn down at the 5-minute ticket TTL",
      );

      // Product relay path: a stale descriptor must be skipped.
      const staleDir = path.join(runRoot, "stale-sessions");
      fs.mkdirSync(staleDir, { recursive: true });
      const stale = {
        ...target.descriptor,
        createdAt: new Date(Date.now() - 600000).toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      const stalePath = path.join(staleDir, "session-stale.json");
      fs.writeFileSync(stalePath, JSON.stringify(stale));
      const events = [];
      const relay = createImportRelay({
        send: (message) => events.push(message),
        sessionDir: staleDir,
      });
      const payload = await makeJobPayload({
        cookieValue: site.value,
        sessionValue: site.sessionValue,
        jobNonce: "e".repeat(32),
      });
      const text = JSON.stringify(payload);
      const digest = await contract.jobDigest(text);
      const bytes = Buffer.from(text, "utf8");
      const chunks = contract.chunkJobPayload(text);
      await relay.handle({ type: "hello", protocol: 2, mode: "cookie-import", extensionVersion: "0.3.0" });
      await relay.handle({
        type: "begin",
        ticket,
        jobNonce: payload.jobNonce,
        jobDigest: digest,
        totalBytes: bytes.length,
        chunkCount: chunks.length,
      });
      const relayError = events.find((m) => m.type === "error") || null;
      details.staleRelayError = relayError ? { code: relayError.code } : null;
      assertEqual(relayError?.code, "target-not-running", "stale descriptor relay error");
      relay.close();

      // The real session descriptor is also gone after expiry. A product relay
      // with the old ticket must not find a target.
      const realEvents = [];
      const realRelay = createImportRelay({
        send: (message) => realEvents.push(message),
        sessionDir: target.sessionDir,
      });
      await realRelay.handle({ type: "hello", protocol: 2, mode: "cookie-import", extensionVersion: "0.3.0" });
      await realRelay.handle({
        type: "begin",
        ticket,
        jobNonce: payload.jobNonce,
        jobDigest: digest,
        totalBytes: bytes.length,
        chunkCount: chunks.length,
      });
      const realError = realEvents.find((m) => m.type === "error") || null;
      details.expiredTicketRelayError = realError ? { code: realError.code } : null;
      assertEqual(realError?.code, "target-not-running", "expired ticket relay error");
      realRelay.close();
      details.login = await siteCheck(target, site, "/login-check", "LOGIN_MISSING", { timeoutMs: 5000 });
      assertEqual(details.subChecks.errorFrameDelivered, true,
        "target closed the pipe at session expiry without delivering the ticket-expired error frame");

    } finally {
      client.close();
      await target.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let hostExePath = null;

async function buildOrLocateHost() {
  if (args["host-exe"]) {
    hostExePath = path.resolve(String(args["host-exe"]));
    assert(fs.existsSync(hostExePath), `host exe not found: ${hostExePath}`);
  } else {
    const outDir = path.join(runRoot, "host");
    const result = await run(process.execPath, [
      path.join(HERE, "build-host-e2e.mjs"),
      "--out",
      outDir,
    ]);
    if (result.code !== 0) throw new Error(`host build failed: ${redact(result.stderr || result.stdout)}`);
    hostExePath = result.stdout.trim().split(/\r?\n/).pop();
    assert(fs.existsSync(hostExePath), `host build output not found: ${hostExePath}`);
  }
  return hostExePath;
}

async function main() {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  log(`run root: ${runRoot}`);
  log(`chrome: ${chromeExe}`);
  assert(fs.existsSync(chromeExe), `chrome.exe not found: ${chromeExe}`);

  const site = await new TestSite().start();
  log(`synthetic site: ${site.base}`);
  try {
    await buildOrLocateHost();
    log(`native host exe: ${hostExePath}`);
    fs.mkdirSync(path.join(runRoot, "host"), { recursive: true });
    const hostInfo = await setupNativeHost(hostExePath);
    log(`native host registered under ${REG_KEY} -> ${hostInfo.manifestPath} (previous=${hostInfo.previous.exists ? "present" : "absent"})`);

    const selected = scenariosArg === "all"
      ? ["approve", "deny", "cancel", "host", "source", "duplicate", "cross", "audit", "expired"]
      : scenariosArg.split(",").map((s) => s.trim()).filter(Boolean);
    const mapping = {
      approve: () => scenarioApproveAndRestart(site),
      deny: () => scenarioDeny(site),
      cancel: () => scenarioCancel(site),
      host: () => scenarioHostInterruption(site),
      source: () => scenarioSourceReplacement(site),
      duplicate: () => scenarioDuplicate(site),
      cross: () => scenarioCrossProfile(site),
      audit: () => scenarioClientIdentityAndDacl(site),
      expired: () => scenarioExpiredTicket(site),
    };
    // Start the expiry scenario first: it holds one target for its full
    // five-minute ticket TTL, while the other scenarios run in parallel.
    let expiryPromise = null;
    if (selected.includes("expired")) {
      expiryPromise = mapping.expired();
    }
    for (const name of selected) {
      if (name === "expired") continue;
      if (!mapping[name]) {
        log(`unknown scenario: ${name}`);
        continue;
      }
      await mapping[name]();
    }
    if (expiryPromise) await expiryPromise;
  } finally {
    restoreNativeHost();
    await site.close();
  }

  const summary = {
    chromeExe,
    hostExe: hostExePath,
    runRoot,
    scenarios: scenarioResults,
    secretLeaks: [],
  };

  // Evidence hygiene: scan every log and the report for canaries/tickets.
  const secrets = [...reportedSecrets];
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(logsDir);
  walk(evidenceDir);
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const secret of secrets) {
      if (secret && text.includes(secret)) summary.secretLeaks.push({ file: path.relative(runRoot, file), kind: "secret" });
    }
    if (/BCLI(?:-[0-9A-Z]{4}){8}/.test(text)) summary.secretLeaks.push({ file: path.relative(runRoot, file), kind: "ticket" });
  }
  summary.hygiene = summary.secretLeaks.length === 0 ? "PASS" : "FAIL";

  const reportPath = path.join(runRoot, "report.json");
  const reportText = JSON.stringify(summary, null, 2);
  for (const secret of secrets) {
    if (secret && reportText.includes(secret)) {
      summary.secretLeaks.push({ file: "report.json", kind: "secret" });
    }
  }
  if (/BCLI(?:-[0-9A-Z]{4}){8}/.test(reportText)) {
    summary.secretLeaks.push({ file: "report.json", kind: "ticket" });
  }
  summary.hygiene = summary.secretLeaks.length === 0 ? "PASS" : "FAIL";
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(path.join(runRoot, "harness.log"), logLines.join("\n"), "utf8");
  if (args.report) {
    fs.writeFileSync(path.resolve(String(args.report)), JSON.stringify(summary, null, 2), "utf8");
  }
  console.log("\n=== SUMMARY ===");
  for (const record of scenarioResults) {
    console.log(`${record.verdict.padEnd(7)} ${record.scenario}${record.error ? ` :: ${record.error}` : ""}`);
  }
  console.log(`hygiene: ${summary.hygiene}`);
  console.log(`report: ${reportPath}`);
  if (!keepRun) {
    // Delete the temporary profiles, host build and logs. The caller gets the
    // redacted summary on stdout (and the optional --report file).
    try {
      fs.rmSync(runRoot, { recursive: true, force: true });
    } catch (err) {
      console.log(`WARN could not remove run root: ${redact(err.message)}`);
    }
  }
  const failed = scenarioResults.some((r) => r.verdict === "FAIL");
  const blocked = scenarioResults.some((r) => r.verdict === "BLOCKED");
  process.exitCode = failed ? 1 : blocked ? 3 : 0;
}

main().catch((err) => {
  console.error(redact(err && err.stack ? err.stack : String(err)));
  restoreNativeHost();
  process.exitCode = 2;
});
