// 官方单命令客户端：自动发现 host、读取 capability token，不需要手写 socket 脚本。
// 发现顺序：session 文件（运行中 host 写入，含 port/authToken，最准）→ 端口扫描 + auth.json 兜底。
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import { sessionDir } from "./paths.js";

const cliArgs = process.argv.slice(2);
const noLaunch = cliArgs.includes("--no-launch");
const positional = cliArgs.filter((arg) => arg !== "--no-launch");
const name = positional[0] || "ping";
const agentId = process.env.BROWSERPILOT_AGENT_ID || "browserpilot-cli";
let args = {};
try { args = positional[1] ? JSON.parse(positional[1]) : {}; }
catch { console.error("args 必须是合法 JSON"); process.exit(2); }

const authPath = path.join(import.meta.dirname, "auth.json");
function authTokenFromFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return typeof parsed.authToken === "string" ? parsed.authToken : undefined;
  } catch {
    return undefined;
  }
}
let authToken = authTokenFromFile();
const profileCachePath = path.join(import.meta.dirname, "profile-cache.json");
const launchStatePath = path.join(os.tmpdir(), "browserpilot-client-launch-state.json");
const browserLeasePath = path.join(os.tmpdir(), "browserpilot-browser-test-lease.json");
const LAUNCH_LEASE_MS = 60_000;
const BROWSER_LEASED_COMMANDS = new Set([
  "snapshot", "readText", "screenshot", "scroll_screenshot", "getElementInfo",
  "click", "dblclick", "hover", "drag", "wheel", "down", "up", "press", "type", "fill",
  "selectOption", "check", "uncheck", "setChecked",
  "js", "waitForURL", "waitForSelector", "waitForTimeout", "pageInfo", "tab_cdp_call",
  "open_tab", "close_tab", "switch_tab", "ensure_visible",
  "open_space", "close_space", "complete_space",
  "run_template",
  "start_mask", "stop_mask",
  "download_image", "download_resource",
]);

function hasBrowserLease() {
  if (!BROWSER_LEASED_COMMANDS.has(name)) return true;
  const supplied = process.env.BROWSERPILOT_BROWSER_LEASE_TOKEN || "";
  if (!supplied) return false;
  try {
    const lease = JSON.parse(fs.readFileSync(browserLeasePath, "utf8"));
    let ownerAlive = false;
    try {
      process.kill(Number(lease?.pid), 0);
      ownerAlive = true;
    } catch {}
    return lease?.token === supplied && Number(lease.expiresAt) > Date.now() && ownerAlive;
  } catch {
    return false;
  }
}

if (!hasBrowserLease()) {
  console.error("BrowserPilot browser command requires a valid browser test lease. Use: npm run browser:lease -- run <owner> <scope> -- npm run client -- " + name + " '<args-json>' --no-launch");
  process.exit(1);
}

function sendAtPort(port, commandName, commandArgs, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buf = "";
    const events = [];
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(undefined));
    socket.on("connect", () => socket.write(JSON.stringify({ type: "command", name: commandName, args: commandArgs, requestId: "cli-1", agentId, ...(authToken ? { authToken } : {}) }) + "\n"));
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message?.type === "result" && message?.requestId === "cli-1") {
            finish(events.length ? { ...message, events } : message);
            return;
          }
          if (message?.type === "event") events.push(message);
        } catch {
          // Ignore unrelated/non-JSON lines and wait for this command's result.
        }
      }
    });
    socket.on("error", () => finish(undefined));
  });
}

async function findHost() {
  for (let port = 47001; port <= 47060; port++) {
    const candidate = await sendAtPort(port, "ping", {}, 250);
    if (candidate?.ok === true && candidate?.data?.pong === true) {
      return { port };
    }
  }
  return undefined;
}

// 运行中 host 会在 session 目录写 <port>.json（port/authToken/pid/updatedAt）。
// 只信「pid 仍存活且 24h 内更新」的记录；命中即同时拿到该 host 真实的 capability token。
const SESSION_MAX_AGE_MS = 24 * 60 * 60_000;
async function findHostViaSession() {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(sessionDir(), f), "utf8")); }
        catch { return undefined; }
      })
      .filter((s) => s && Number.isInteger(s.port) && typeof s.authToken === "string" && s.authToken)
      .filter((s) => Date.now() - Number(s.updatedAt || 0) < SESSION_MAX_AGE_MS)
      .filter((s) => {
        try { process.kill(Number(s.pid), 0); return true; } catch { return false; }
      })
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = await sendAtPort(entry.port, "ping", {}, 250);
    if (candidate?.ok === true && candidate?.data?.pong === true) {
      authToken = entry.authToken;
      return { port: entry.port };
    }
  }
  return undefined;
}

function launchSavedProfile() {
  if (!fs.existsSync(profileCachePath)) return { ok: false, reason: "missing profile cache" };
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(profileCachePath, "utf8"));
  } catch {
    return { ok: false, reason: "bad profile cache" };
  }
  if (!profile?.chromeExe || !fs.existsSync(profile.chromeExe)) {
    return { ok: false, reason: "missing chrome executable" };
  }
  const now = Date.now();
  const lease = { startedAt: now, expiresAt: now + LAUNCH_LEASE_MS, pid: process.pid };
  let launchState;
  try { launchState = JSON.parse(fs.readFileSync(launchStatePath, "utf8")); } catch { launchState = undefined; }
  if (Number(launchState?.expiresAt) > now) {
    return { ok: false, reason: "launch lease active; another client is waking BrowserPilot" };
  }
  try {
    fs.writeFileSync(launchStatePath, JSON.stringify(lease, null, 2), { flag: "wx", mode: 0o600 });
  } catch {
    try {
      const fresh = JSON.parse(fs.readFileSync(launchStatePath, "utf8"));
      if (Number(fresh?.expiresAt) > now) {
        return { ok: false, reason: "launch lease active; another client is waking BrowserPilot" };
      }
      fs.writeFileSync(launchStatePath, JSON.stringify(lease, null, 2), { mode: 0o600 });
    } catch {
      return { ok: false, reason: "launch lease unavailable" };
    }
  }
  const launchArgs = [];
  if (profile.userDataDir) launchArgs.push("--user-data-dir=" + profile.userDataDir);
  if (profile.profileDir) launchArgs.push("--profile-directory=" + profile.profileDir);
  const child = spawn(profile.chromeExe, launchArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

async function waitForHost(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await findHost();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

let host = await findHostViaSession();
if (!host) host = await findHost();
let launchAttempt;
if (!host && !noLaunch) {
  launchAttempt = launchSavedProfile();
  if (launchAttempt.ok) host = await waitForHost();
}

if (!host && noLaunch) {
  console.error("未找到可认证的 BrowserPilot host；请先启动安装了 BrowserPilot 的浏览器 profile。");
  process.exit(1);
}
if (!host) {
  const reason = launchAttempt
    ? launchAttempt.ok
      ? "已尝试启动缓存 profile，但插件/native host 未在超时时间内连回。请确认该 profile 安装并启用了 BrowserPilot。"
      : "profile 缓存不可用：" + launchAttempt.reason
    : "没有尝试自动启动。";
  console.error("未找到可认证的 BrowserPilot host；" + reason + " 首次使用时，请先手动启动一次安装了 BrowserPilot 的浏览器 profile，让插件写入缓存。");
  process.exit(1);
}
const commandTimeoutMs = name === "run_template"
  ? 10 * 60_000
  : name.startsWith("waitFor") || name === "scroll_screenshot" || name === "download_resource"
    ? 5 * 60_000
    : 2 * 60_000;
const response = await sendAtPort(host.port, name, args, commandTimeoutMs);
if (!response) {
  console.error("BrowserPilot host 已发现，但命令连接在返回结果前中断或超时。");
  process.exit(1);
}
const result = { port: host.port, ...response };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok === false ? 1 : 0);
