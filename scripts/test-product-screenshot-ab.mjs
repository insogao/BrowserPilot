// 产品截图 P0 隔离 A/B：同一 tab、同一 CDP 参数下对比
//   raw-browser  浏览器级 CDP（Target.attachToTarget，flatten 会话）
//   product-cdp  扩展 chrome.debugger 会话的裸透传（tab_cdp_call，无任何截图策略）
//   product      产品 screenshot 命令（chrome.debugger + 光标隐藏 + 8s 超时/降级/冷却）
//
// 每个样本都记录：实际耗时、PNG 编码帧号 vs DOM __probe().rafCount、fromSurface/
// possiblyStale/reason、surfaceCooldownStats、pendingScreenshotAttempts、
// screenshotCleanupStats、底层仍未完成请求数，以及窗口/页面可见性。
//
// 运行：
//   node scripts/test-product-screenshot-ab.mjs --matrix
//   node scripts/test-product-screenshot-ab.mjs                       # managed hidden（默认）
//   node scripts/test-product-screenshot-ab.mjs --stage=managed,visible
//   node scripts/test-product-screenshot-ab.mjs --stage=headless --no-build
//
// 安全边界：
//   - 只启动本次构建的 chrome.exe，独立临时 --user-data-dir 与 LOCALAPPDATA；
//   - 不使用 --no-sandbox；不接触用户真实 profile / 已有 Chrome；
//   - 进程清理只走 scripts/lib/test-process.mjs 的验证式接口；
//   - native host 注册只改 HKCU 的 com.browserpilot.browseragent，结束后按备份回滚。
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, findNewestHostExe } from "./lib/host-manifest.mjs";
import {
  launchTestProcess,
  queryProcess,
  stopTestProcess,
  stopVerifiedPid,
} from "./lib/test-process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(root, "dist");
const FIXTURE = path.join(root, "tests", "fixtures", "screenshot-frame-probe.html");
const FIXTURE_STATIC = path.join(root, "tests", "fixtures", "screenshot-frame-probe-static.html");
const REGISTER_PS1 = path.join(root, "native-host", "register.ps1");
const UNREGISTER_PS1 = path.join(root, "native-host", "unregister.ps1");
const HOST_NAME = "com.browserpilot.browseragent";
const REGISTRY_KEY = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME;
const CHROME = process.env.BROWSERPILOT_PATCHED_CHROME || "D:\\c\\src\\out\\WinDev\\chrome.exe";
const FEATURE = "InputOwnershipEnforcement";

const argv = process.argv.slice(2);
const MATRIX = argv.includes("--matrix") || argv.includes("--dry-run");
const NO_BUILD = argv.includes("--no-build");
const STAGE_ARG = (argv.find((a) => a.startsWith("--stage=")) || "").slice("--stage=".length).trim();
const STAGES = new Set((STAGE_ARG || "managed").split(",").map((s) => s.trim()).filter(Boolean));
const SCENARIO_ARG = (argv.find((a) => a.startsWith("--scenario=")) || "").slice("--scenario=".length).trim();
const SCENARIOS = new Set((SCENARIO_ARG || "").split(",").map((s) => s.trim()).filter(Boolean));
const scenarioSelected = (key) => SCENARIOS.size === 0 || SCENARIOS.has(key);
const RESULT_ARG = (argv.find((a) => a.startsWith("--result-json=")) || "").slice("--result-json=".length).trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const runToken = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
const runId = nowIso().replace(/[:.]/g, "-");
const runDir = path.join(root, ".e2e-tmp", "product-screenshot-ab-" + runId);
fs.mkdirSync(runDir, { recursive: true });

const report = {
  test: "product-screenshot-ab",
  startedAt: nowIso(),
  finishedAt: null,
  runId,
  stages: [...STAGES],
  verdict: "BLOCKED",
  env: {
    platform: process.platform,
    node: process.version,
    chrome: CHROME,
    chromeMtime: null,
    hostExe: null,
    hostExeMtime: null,
    extensionId: null,
    screens: null,
  },
  registration: null,
  sessions: [],
  attempts: [],
  notes: [],
};

function log(line) {
  console.log(line);
}
function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  log((ok ? "PASS" : "FAIL") + " | " + name + (ok || !text ? "" : " :: " + text.slice(0, 1200)));
  if (!ok) report.notes.push("FAIL " + name + " :: " + text.slice(0, 800));
  return ok;
}
function must(name, condition, detail = "") {
  if (!check(name, condition, detail)) throw new Error("check failed: " + name);
}

// ---------------------------------------------------------------- PNG decode
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 最小 PNG 解码（8-bit RGB/RGBA，非隔行）——足够读 Chrome 截图里的 marker 像素。 */
function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error("unsupported PNG (bitDepth=" + bitDepth + " colorType=" + colorType + " interlace=" + interlace + ")");
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * bpp);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    if (pos >= raw.length) throw new Error("truncated PNG data");
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error("bad PNG filter " + filter);
      }
      dst[x] = v;
    }
  }
  return {
    width,
    height,
    bpp,
    data: out,
    pixel(x, y) {
      const idx = (y * width + x) * bpp;
      return [out[idx], out[idx + 1], out[idx + 2]];
    },
  };
}

function analysePng(base64, probe) {
  const buffer = Buffer.from(base64, "base64");
  const image = decodePng(buffer);
  const dpr = Number(probe?.dpr) || 1;
  const marker = probe?.markerRect;
  let markerRgb = null;
  if (marker) {
    const x = Math.round((marker.x + marker.w / 2) * dpr);
    const y = Math.round((marker.y + marker.h / 2) * dpr);
    if (x >= 0 && y >= 0 && x < image.width && y < image.height) markerRgb = image.pixel(x, y);
  }
  // 粗网格：纯黑/纯色图检测（避免把空白帧当内容）。
  const colors = new Set();
  let dark = 0;
  let samples = 0;
  for (let y = 0; y < image.height; y += Math.max(1, Math.floor(image.height / 32))) {
    for (let x = 0; x < image.width; x += Math.max(1, Math.floor(image.width / 32))) {
      const [r, g, b] = image.pixel(x, y);
      colors.add((r << 16) | (g << 8) | b);
      if (r + g + b < 24) dark += 1;
      samples += 1;
    }
  }
  const frame = markerRgb && markerRgb[2] === 255 ? markerRgb[0] + markerRgb[1] * 256 : null;
  return {
    width: image.width,
    height: image.height,
    bytes: buffer.length,
    markerRgb,
    frame,
    distinctColors: colors.size,
    darkRatio: samples ? Number((dark / samples).toFixed(3)) : null,
  };
}

/**
 * 新鲜度判定：PNG marker 帧号必须 >= 截图开始前 DOM 的 rafCount。
 * - delta < 0：画面落后于 DOM（旧帧）→ stale；
 * - delta >= 0：截图包含了截图发起时已存在的 DOM 状态 → fresh。
 * rafCount 只在 rAF 回调/显式 __bump 里递增，且 paint() 与递增在同一任务内完成，
 * 因此不存在「DOM 帧号已增加但绘制尚未发生」的窗口。
 */
function judgeFreshness(png, probeBefore, probeAfter) {
  const before = probeBefore?.rafCount ?? null;
  const after = probeAfter?.rafCount ?? null;
  if (!png || png.frame === null) {
    return { fresh: false, why: "no-marker", pngFrame: null, domBefore: before, domAfter: after };
  }
  const rafRunning = before !== null && after !== null && after > before;
  const delta = before === null ? null : png.frame - before;
  return {
    fresh: delta !== null && delta >= 0,
    why: delta === null ? "no-dom" : delta >= 0 ? "current-or-newer" : "older-than-dom",
    pngFrame: png.frame,
    domBefore: before,
    domAfter: after,
    delta,
    rafRunning,
  };
}

// ---------------------------------------------------------------- raw CDP
class RawCdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.disconnected = null;
    this.lateSettles = 0;
    this.lateLog = [];
  }
  connect(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("raw CDP connect timeout"));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("raw CDP websocket error"));
      };
      ws.onclose = () => {
        this.disconnected = true;
        for (const [id, item] of this.pending) {
          clearTimeout(item.timer);
          this.pending.delete(id);
          item.reject(new Error("raw CDP closed"));
        }
      };
      ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.id === undefined) return;
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (item.abandoned) {
          this.lateSettles += 1;
          this.lateLog.push({ method: item.method, tag: item.tag, ok: !message.error, at: Date.now() });
          return;
        }
        if (message.error) {
          const error = new Error(message.error.message || "CDP error");
          error.code = message.error.code;
          item.reject(error);
          return;
        }
        item.resolve(message.result);
      };
    });
  }
  send(method, params = {}, { sessionId, timeoutMs = 20000, abandon = false, tag = null } = {}) {
    if (!this.ws || this.disconnected) return Promise.reject(new Error("raw CDP not connected"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const item = { method, tag, resolve, reject, abandoned: false, timer: null };
      item.timer = setTimeout(() => {
        if (abandon) {
          item.abandoned = true;
          const error = new Error(method + " timed out after " + timeoutMs + "ms");
          error.timeout = true;
          reject(error);
          return;
        }
        this.pending.delete(id);
        const error = new Error(method + " timed out after " + timeoutMs + "ms");
        error.timeout = true;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, item);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  outstanding() {
    return this.pending.size;
  }
  async targets() {
    const result = await this.send("Target.getTargets", {}, { timeoutMs: 15000 });
    return result?.targetInfos || [];
  }
  async findTarget(needle, type = "page", timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = [];
    while (Date.now() < deadline) {
      last = await this.targets().catch(() => []);
      const hit = last.find((t) => t.type === type && String(t.url || "").includes(needle));
      if (hit) return hit;
      await sleep(250);
    }
    throw new Error("target not found: " + needle + " (last=" + JSON.stringify(last.map((t) => t.url).slice(0, 8)) + ")");
  }
  async attach(targetId) {
    const result = await this.send("Target.attachToTarget", { targetId, flatten: true }, { timeoutMs: 30000 });
    return result?.sessionId;
  }
  async evaluate(sessionId, expression, timeoutMs = 20000) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      { sessionId, timeoutMs },
    );
    if (result?.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(result.exceptionDetails).slice(0, 400));
    return result?.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

function readDevToolsPort(profileDir, timeoutMs = 40000) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
        if (lines.length >= 2) return { port: Number(lines[0]), wsPath: lines[1] };
      } catch {
        // not written yet
      }
      await sleep(150);
    }
    return null;
  })();
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
      // partial
    }
  }
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
async function waitForHostSession(lad, { timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = readSessions(lad).filter((s) => pidAlive(s.pid) && Date.now() - Number(s.updatedAt || 0) < 300000);
    if (candidates.length) return candidates[0];
    await sleep(250);
  }
  throw new Error("timed out waiting for native host session in " + sessionsDirFor(lad));
}

let requestSeq = 0;
function tcpRequest(port, authToken, agentId, name, args = {}, { space, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const requestId = "shot-ab-" + ++requestSeq;
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(name + " host request timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    const finish = (fn, value) => {
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    socket.on("connect", () => {
      socket.write(JSON.stringify({
        type: "command",
        name,
        args,
        requestId,
        agentId,
        authToken,
        ...(space ? { space } : {}),
      }) + "\n");
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

// ---------------------------------------------------------------- fixture server
function startFixtureServer() {
  const html = fs.readFileSync(FIXTURE, "utf8");
  const staticHtml = fs.readFileSync(FIXTURE_STATIC, "utf8");
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const isStatic = String(req.url || "").startsWith("/static");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(isStatic ? staticHtml : html);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, origin: "http://127.0.0.1:" + port, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------- win32 window state
const WIN32_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BpShotW {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
}
'@
$want = [int]$args[0]
$list = New-Object System.Collections.ArrayList
$cb = [BpShotW+EnumWindowsProc]{
  param($h, $l)
  $p = [uint32]0
  [void][BpShotW]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -ne $want) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][BpShotW]::GetWindowTextW($h, $sb, 512)
  $r = [BpShotW+RECT]::new()
  $ok = [BpShotW]::GetWindowRect($h, [ref]$r)
  $rect = $null
  if ($ok) { $rect = @([int]$r.Left, [int]$r.Top, [int]($r.Right - $r.Left), [int]($r.Bottom - $r.Top)) }
  [void]$list.Add([ordered]@{
    hwnd = $h.ToInt64()
    title = $sb.ToString()
    visible = [bool][BpShotW]::IsWindowVisible($h)
    iconic = [bool][BpShotW]::IsIconic($h)
    rect = $rect
  })
  return $true
}
[void][BpShotW]::EnumWindows($cb, [IntPtr]::Zero)
ConvertTo-Json -Compress -InputObject @($list)
`;

const WIN32_OP = String.raw`
param([string]$op, [long]$hwnd, [int]$x, [int]$y, [int]$w, [int]$h, [int]$flags)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BpShotOp {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
'@
$hw = [System.IntPtr]$hwnd
$ok = $false
if ($op -eq 'move') { $ok = [BpShotOp]::SetWindowPos($hw, [System.IntPtr]::Zero, $x, $y, $w, $h, [uint32]$flags) }
elseif ($op -eq 'show') { $ok = [BpShotOp]::ShowWindow($hw, 4) }
elseif ($op -eq 'hide') { $ok = [BpShotOp]::ShowWindow($hw, 0) }
$err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
$r = [BpShotOp+RECT]::new()
$got = [BpShotOp]::GetWindowRect($hw, [ref]$r)
$rect = $null
if ($got) { $rect = @([int]$r.Left, [int]$r.Top, [int]($r.Right - $r.Left), [int]($r.Bottom - $r.Top)) }
ConvertTo-Json -Compress -InputObject ([ordered]@{
  ok = [bool]$ok
  lastError = [int]$err
  visible = [bool][BpShotOp]::IsWindowVisible($hw)
  iconic = [bool][BpShotOp]::IsIconic($hw)
  rect = $rect
})
`;

function windowOp(op, hwnd, { x = 0, y = 0, w = 0, h = 0, flags = 0 } = {}) {
  const file = path.join(runDir, "window-op.ps1");
  if (!fs.existsSync(file)) fs.writeFileSync(file, WIN32_OP, "utf8");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, op, String(hwnd), String(x), String(y), String(w), String(h), String(flags)],
    { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) return { ok: false, error: String(result.stderr || "").slice(-400) };
  const text = (result.stdout || "").trim();
  try { return JSON.parse(text.split(/\r?\n/).filter(Boolean).pop()); } catch { return { ok: false, error: "bad output: " + text.slice(0, 200) }; }
}

function queryWindows(pid) {
  const file = path.join(runDir, "window-query.ps1");
  if (!fs.existsSync(file)) fs.writeFileSync(file, WIN32_QUERY, "utf8");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, String(pid)],
    { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) return { error: String(result.stderr || "").slice(-400) };
  const text = (result.stdout || "").trim();
  if (!text) return { windows: [] };
  try {
    const parsed = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop());
    return { windows: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { error: "bad window query output: " + text.slice(0, 300) };
  }
}

// ---------------------------------------------------------------- registry + build
function runPowerShellFile(file, args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
    { encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );
  const stdout = (result.stdout || "").trim();
  let json = null;
  try { json = stdout ? JSON.parse(stdout.split(/\r?\n/).filter(Boolean).pop()) : null; } catch { json = null; }
  return { status: result.status, stdout, stderr: String(result.stderr || ""), json };
}
function registryDefault(key) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$k='" + key.replace(/'/g, "''") + "'; if (Test-Path -LiteralPath $k) { $v = (Get-ItemProperty -LiteralPath $k).'(default)'; if ($null -eq $v) { '<no-default>' } else { $v } } else { '<missing>' }",
  ], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  return (result.stdout || "").trim();
}
function looksLikeOurManifest(value) {
  return /browserpilot-host|host\.manifest\.json/i.test(String(value || ""));
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
  return {
    ok: result.status === 0,
    status: result.status,
    tail: (result.stdout || "").split(/\r?\n/).slice(-4).join("\n") + " " + (result.stderr || "").split(/\r?\n/).slice(-4).join("\n"),
  };
}

// ---------------------------------------------------------------- session driver
function chromeArgs({ profileDir, managed, headless, bootUrl }) {
  const args = [
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "--in-process-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-position=100,80",
    "--window-size=1000,760",
    "--site-per-process",
    "--enable-logging=stderr",
    "--v=0",
  ];
  if (headless) args.unshift("--headless=new");
  if (managed) {
    args.push("--load-extension=" + DIST, "--disable-extensions-except=" + DIST);
    args.push("--enable-features=" + FEATURE, "--browser-cli-background-presentation");
  } else if (!headless) {
    args.push("--load-extension=" + DIST, "--disable-extensions-except=" + DIST);
  }
  if (bootUrl) args.push(bootUrl);
  return args;
}

async function startSession({ name, managed, headless = false, withExtension = true }) {
  const sessionDir = path.join(runDir, name);
  const profileDir = path.join(sessionDir, "chrome-profile");
  const localAppData = path.join(sessionDir, "localappdata");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

  const bootUrl = withExtension ? servers.origin + "/boot?token=" + runToken + "-" + name : null;
  const args = chromeArgs({ profileDir, managed, headless, bootUrl });
  const env = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    BROWSERPILOT_HOST_BASE_PORT: String(48900 + Math.floor(Math.random() * 90)),
  };
  const logFile = path.join(sessionDir, "chrome.log");
  const record = launchTestProcess({
    exe: CHROME,
    args,
    env,
    marker: profileDir,
    label: name,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  record.child.stdout.on("data", (d) => logStream.write(d));
  record.child.stderr.on("data", (d) => logStream.write(d));
  record.child.on("exit", (code) => logStream.end("\n[exit] code=" + code + "\n"));

  const session = {
    name,
    managed,
    headless,
    withExtension,
    profileDir,
    localAppData,
    record,
    logFile,
    pid: record.pid,
    cdp: null,
    client: null,
    hostSession: null,
    hostIdentity: null,
    tabs: [],
    startedAt: nowIso(),
  };
  report.sessions.push(session);

  try {
    const active = await readDevToolsPort(profileDir);
    must("[" + name + "] DevToolsActivePort 已写入", !!active, JSON.stringify(active));
    const wsUrl = "ws://127.0.0.1:" + active.port + active.wsPath;
    session.cdp = new RawCdp(wsUrl);
    await session.cdp.connect();
    log("[" + name + "] raw browser CDP connected " + wsUrl);

    if (withExtension) {
      session.hostSession = await waitForHostSession(localAppData);
      session.client = new HostClient(session.hostSession, "shot-ab");
      const ping = await session.client.request("ping", {}, { timeoutMs: 10000 });
      must("[" + name + "] host ping=pong", ping.ok === true && ping.data?.pong === true, JSON.stringify(ping));
      session.hostIdentity = queryProcess(session.hostSession.pid) || null;
      const hostExe = findNewestHostExe(root);
      session.hostExe = hostExe;
      session.hostExeMatches = !!session.hostIdentity?.exePath && path.resolve(session.hostIdentity.exePath).toLowerCase() === path.resolve(hostExe).toLowerCase();
      must("[" + name + "] connectNative 拉起本次构建的 host exe", session.hostExeMatches, JSON.stringify({
        actual: session.hostIdentity?.exePath,
        expected: hostExe,
      }));
    }
    return session;
  } catch (error) {
    // 启动阶段失败也必须收掉浏览器/host，绝不留下测试进程。
    await stopSession(session).catch((stopError) => log("[" + name + "] stop after failure failed: " + String(stopError?.message || stopError)));
    throw error;
  }
}

async function stopSession(session) {
  const cleanup = { at: nowIso() };
  try { session.cdp?.close(); } catch {}
  cleanup.chrome = stopTestProcess(session.record, { reason: session.name + ".stop" });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && session.record.child.exitCode === null) {
    await sleep(200);
  }
  if (session.hostSession && queryProcess(session.hostSession.pid)) {
    if (session.hostIdentity?.creationTime && (session.hostIdentity?.exePath || session.hostExe)) {
      cleanup.host = stopVerifiedPid({
        pid: session.hostSession.pid,
        expectedExePath: session.hostIdentity?.exePath || session.hostExe,
        creationTime: session.hostIdentity?.creationTime,
        reason: session.name + ".host-stop",
        timeoutMs: 15000,
      });
    } else {
      cleanup.host = { stopped: false, skipped: "no-verified-identity" };
    }
  } else {
    cleanup.host = { stopped: true, alreadyExited: true };
  }
  session.cleanup = cleanup;
  session.finishedAt = nowIso();
  log("[" + session.name + "] cleanup " + JSON.stringify(cleanup));
}

async function openTab(session, key, opts = {}) {
  const id = "ab-" + runToken + "-" + key;
  const url = servers.origin + (opts.static ? "/static" : "/probe") + "?id=" + encodeURIComponent(id);
  const data = await session.client.call("open_space", { name: id, url }, { timeoutMs: 60000 });
  const target = await session.cdp.findTarget("id=" + id, "page", 40000);
  const rawSessionId = await session.cdp.attach(target.targetId);
  const tab = {
    key,
    id,
    url,
    spaceId: data.spaceId,
    tabId: data.tabId,
    windowId: data.windowId,
    targetId: target.targetId,
    rawSessionId,
    order: null,
    steps: 0,
    window: null,
  };
  session.tabs.push(tab);
  // 等 fixture 就绪（__probe 可用）。
  const deadline = Date.now() + 30000;
  let probe = null;
  while (Date.now() < deadline) {
    probe = await session.cdp.evaluate(rawSessionId, "window.__probe ? window.__probe() : null", 10000).catch(() => null);
    if (probe && typeof probe.rafCount === "number") break;
    await sleep(200);
  }
  must("[openTab " + key + "] fixture __probe 就绪", !!probe, JSON.stringify(probe));
  const win = queryWindows(session.pid);
  const title = "shot-probe-" + id;
  const hit = (win.windows || []).find((w) => String(w.title || "").includes(id)) || null;
  tab.window = hit
    ? { hwnd: hit.hwnd, visible: hit.visible, iconic: hit.iconic, rect: hit.rect }
    : { error: win.error || "window not found by title " + title };
  tab.initialProbe = probe;
  log("[openTab " + key + "] tabId=" + data.tabId + " space=" + data.spaceId + " window=" + JSON.stringify(tab.window) + " vis=" + probe.visibilityState);
  return tab;
}

async function probeTab(session, tab) {
  return await session.cdp.evaluate(tab.rawSessionId, "window.__probe ? window.__probe() : null", 15000);
}
async function bumpTab(session, tab, n) {
  return await session.cdp.evaluate(tab.rawSessionId, "(window.__bump ? window.__bump(" + Number(n) + ") : null)", 15000);
}
async function diagnostics(session, tab, { resetCooldown = false } = {}) {
  const r = await session.client.request(
    "screenshot_diagnostics",
    { tabId: tab.tabId, ...(resetCooldown ? { resetCooldown: true } : {}) },
    { space: tab.spaceId, timeoutMs: 30000 },
  );
  if (!r.ok) return { error: r.error, errorCode: r.errorCode };
  return {
    ...r.data,
    pendingForTab: r.data.pending,
    cooldownForTab: (r.data.cooldowns || []).find((c) => c.tabId === tab.tabId) || null,
  };
}

function pushAttempt(session, tab, spec, base) {
  const attempt = {
    session: session.name,
    tab: tab.key,
    order: tab.order,
    seq: tab.steps,
    kind: spec.kind,
    phase: spec.phase ?? null,
    fromSurface: spec.fromSurface ?? null,
    productTimeoutMs: spec.productTimeoutMs ?? null,
    rawTimeoutMs: spec.timeoutMs ?? null,
    hostTimeoutMs: spec.hostTimeoutMs ?? null,
    at: nowIso(),
    ...base,
  };
  tab.steps += 1;
  report.attempts.push(attempt);
  const fresh = attempt.freshness?.fresh;
  log(
    "  [" + attempt.session + "/" + attempt.tab + " #" + attempt.seq + "] " + attempt.kind + " " + (attempt.phase || "")
      + " wall=" + attempt.wallMs + "ms ok=" + attempt.ok
      + (attempt.ok ? " bytes=" + (attempt.png?.bytes ?? 0) + " pngFrame=" + (attempt.png?.frame ?? "?") : "")
      + (attempt.freshness ? " dom=" + attempt.freshness.domBefore + " delta=" + attempt.freshness.delta + " fresh=" + fresh : "")
      + (attempt.product ? " fromSurface=" + attempt.product.fromSurface + " stale=" + attempt.product.possiblyStale
        + " internal=" + attempt.product.durationMs + "ms" + (attempt.product.reason ? " reason=" + String(attempt.product.reason).slice(0, 90) : "") : "")
      + (attempt.error ? " error=" + String(attempt.error).slice(0, 160) : ""),
  );
  return attempt;
}

/** raw 浏览器级 CDP 截图。 */
async function runRaw(session, tab, spec) {
  const probeBefore = await probeTab(session, tab).catch(() => null);
  const domBeforeInvoke = probeBefore?.rafCount ?? null;
  const start = Date.now();
  let result = null;
  let error = null;
  let errorCode = null;
  const fromSurface = spec.fromSurface !== false;
  try {
    result = await session.cdp.send(
      "Page.captureScreenshot",
      { format: "png", fromSurface },
      { sessionId: tab.rawSessionId, timeoutMs: spec.timeoutMs ?? 8000, abandon: true, tag: (spec.phase || "raw") + "@" + tab.key },
    );
  } catch (e) {
    error = e?.message || String(e);
    errorCode = e?.code ?? null;
  }
  const wallMs = Date.now() - start;
  const probeAfter = await probeTab(session, tab).catch(() => null);
  const base64 = result?.data || "";
  let png = null;
  let pngError = null;
  if (base64) {
    try { png = analysePng(base64, probeAfter || probeBefore); } catch (e) { pngError = String(e?.message || e); }
  }
  return pushAttempt(session, tab, { ...spec, kind: "raw", fromSurface }, {
    sessionType: "browser-level Target.attachToTarget (flatten)",
    wallMs,
    ok: !!base64,
    error,
    errorCode,
    png,
    pngError,
    freshness: judgeFreshness(png, { ...probeBefore, rafCount: domBeforeInvoke }, probeAfter),
    dom: {
      rafBefore: domBeforeInvoke,
      rafAfter: probeAfter?.rafCount ?? null,
      visibilityState: (probeAfter || probeBefore)?.visibilityState ?? null,
      hasFocus: (probeAfter || probeBefore)?.hasFocus ?? null,
    },
    rawOutstandingAfter: session.cdp.outstanding(),
    rawLateSettles: session.cdp.lateSettles,
    rawLateLog: session.cdp.lateLog.slice(-10),
  });
}

/** 扩展 chrome.debugger 会话的裸透传（无产品截图策略）。 */
async function runProductCdp(session, tab, spec) {
  const probeBefore = await probeTab(session, tab).catch(() => null);
  const fromSurface = spec.fromSurface !== false;
  const start = Date.now();
  const r = await session.client.request(
    "tab_cdp_call",
    { tabId: tab.tabId, method: "Page.captureScreenshot", params: { format: "png", fromSurface } },
    { space: tab.spaceId, timeoutMs: spec.hostTimeoutMs ?? 90000 },
  );
  const wallMs = Date.now() - start;
  const probeAfter = await probeTab(session, tab).catch(() => null);
  const base64 = r.ok ? r.data?.result?.data || "" : "";
  let png = null;
  let pngError = null;
  if (base64) {
    try { png = analysePng(base64, probeAfter || probeBefore); } catch (e) { pngError = String(e?.message || e); }
  }
  const diagAfter = await diagnostics(session, tab).catch((e) => ({ error: String(e?.message || e) }));
  return pushAttempt(session, tab, { ...spec, kind: "product-cdp", fromSurface }, {
    sessionType: "extension chrome.debugger (tab_cdp_call passthrough)",
    wallMs,
    ok: r.ok === true && !!base64,
    error: r.ok ? null : r.error,
    errorCode: r.errorCode,
    png,
    pngError,
    freshness: judgeFreshness(png, probeBefore, probeAfter),
    dom: {
      rafBefore: probeBefore?.rafCount ?? null,
      rafAfter: probeAfter?.rafCount ?? null,
      visibilityState: (probeAfter || probeBefore)?.visibilityState ?? null,
      hasFocus: (probeAfter || probeBefore)?.hasFocus ?? null,
    },
    diagnostics: diagAfter,
    rawOutstandingAfter: session.cdp.outstanding(),
    rawLateSettles: session.cdp.lateSettles,
  });
}

/** 产品 screenshot 命令。 */
async function runProduct(session, tab, spec) {
  const probeBefore = await probeTab(session, tab).catch(() => null);
  const diagBefore = await diagnostics(session, tab).catch((e) => ({ error: String(e?.message || e) }));
  const args = { tabId: tab.tabId, format: "png" };
  if (spec.productTimeoutMs) args.timeoutMs = spec.productTimeoutMs;
  const start = Date.now();
  const r = await session.client.request("screenshot", args, {
    space: tab.spaceId,
    timeoutMs: spec.hostTimeoutMs ?? Math.max(60000, (spec.productTimeoutMs || 8000) * 3),
  });
  const wallMs = Date.now() - start;
  const diagAfter = await diagnostics(session, tab).catch((e) => ({ error: String(e?.message || e) }));
  const probeAfter = await probeTab(session, tab).catch(() => null);
  const base64 = r.ok ? r.data?.base64 || "" : "";
  let png = null;
  let pngError = null;
  if (base64) {
    try { png = analysePng(base64, probeAfter || probeBefore); } catch (e) { pngError = String(e?.message || e); }
  }
  const meta = r.ok ? r.data?.screenshot || null : null;
  return pushAttempt(session, tab, { ...spec, kind: "product", fromSurface: meta?.fromSurface ?? null }, {
    sessionType: "extension chrome.debugger (product captureScreenshotWithCursorPolicy)",
    wallMs,
    ok: r.ok === true && !!base64,
    error: r.ok ? null : r.error,
    errorCode: r.errorCode,
    png,
    pngError,
    product: r.ok
      ? {
          fromSurface: meta?.fromSurface ?? null,
          path: meta?.path ?? null,
          possiblyStale: meta?.possiblyStale ?? r.data?.possiblyStale ?? null,
          reason: meta?.reason ?? r.data?.reason ?? null,
          durationMs: meta?.durationMs ?? null,
          cursorIncluded: r.data?.cursorIncluded ?? null,
          preCaptureMs: meta?.durationMs != null ? wallMs - meta.durationMs : null,
        }
      : null,
    freshness: judgeFreshness(png, probeBefore, probeAfter),
    dom: {
      rafBefore: probeBefore?.rafCount ?? null,
      rafAfter: probeAfter?.rafCount ?? null,
      visibilityState: (probeAfter || probeBefore)?.visibilityState ?? null,
      hasFocus: (probeAfter || probeBefore)?.hasFocus ?? null,
    },
    diagnosticsBefore: diagBefore,
    diagnosticsAfter: diagAfter,
    rawOutstandingAfter: session.cdp.outstanding(),
    rawLateSettles: session.cdp.lateSettles,
  });
}

async function runDiagStep(session, tab, spec) {
  const output = await diagnostics(session, tab, { resetCooldown: spec.resetCooldown === true });
  pushAttempt(session, tab, { ...spec, kind: "diag" }, {
    sessionType: "extension SW in-process state",
    wallMs: null,
    ok: !output.error,
    error: output.error ?? null,
    diagnosticsAfter: output,
  });
}

async function runInspect(session, tab, spec) {
  const probe = await probeTab(session, tab).catch(() => null);
  const diag = await diagnostics(session, tab).catch((e) => ({ error: String(e?.message || e) }));
  pushAttempt(session, tab, { ...spec, kind: "inspect" }, {
    sessionType: "observation only",
    wallMs: 0,
    ok: !diag.error,
    error: diag.error ?? null,
    dom: {
      rafBefore: probe?.rafCount ?? null,
      rafAfter: probe?.rafCount ?? null,
      visibilityState: probe?.visibilityState ?? null,
      hasFocus: probe?.hasFocus ?? null,
    },
    diagnosticsAfter: diag,
    rawOutstandingAfter: session.cdp.outstanding(),
    rawLateSettles: session.cdp.lateSettles,
  });
}

async function runSteps(session, tab, order, steps) {
  tab.order = order;
  for (const spec of steps) {
    if (spec.kind === "raw") await runRaw(session, tab, spec);
    else if (spec.kind === "product-cdp") await runProductCdp(session, tab, spec);
    else if (spec.kind === "product") await runProduct(session, tab, spec);
    else if (spec.kind === "diag") await runDiagStep(session, tab, spec);
    else if (spec.kind === "inspect") await runInspect(session, tab, spec);
    else if (spec.kind === "sleep") {
      log("  [" + session.name + "/" + tab.key + "] sleep " + spec.ms + "ms");
      await sleep(spec.ms);
    }
    else throw new Error("unknown step kind: " + spec.kind);
  }
}

// ---------------------------------------------------------------- scenarios
const MANAGED_SCENARIOS = [
  {
    key: "raw-first",
    order: "raw-first",
    steps: [
      { kind: "raw", phase: "cold", fromSurface: true, timeoutMs: 8000 },
      { kind: "raw", phase: "warm", fromSurface: true, timeoutMs: 8000 },
      { kind: "product", phase: "warm", productTimeoutMs: 8000 },
      { kind: "product", phase: "warm-long", productTimeoutMs: 30000 },
      { kind: "product-cdp", phase: "warm", fromSurface: true, hostTimeoutMs: 90000 },
      { kind: "raw", phase: "warm", fromSurface: false, timeoutMs: 8000 },
      { kind: "product-cdp", phase: "warm", fromSurface: false, hostTimeoutMs: 30000 },
    ],
  },
  {
    key: "product-first",
    order: "product-first",
    steps: [
      { kind: "product", phase: "cold", productTimeoutMs: 8000 },
      { kind: "diag", phase: "after-cold" },
      { kind: "product", phase: "cooldown", productTimeoutMs: 8000 },
      { kind: "diag", phase: "after-cooldown-reset", resetCooldown: true },
      { kind: "product", phase: "warm-after-reset", productTimeoutMs: 8000 },
      { kind: "raw", phase: "warm-after-reset", fromSurface: true, timeoutMs: 8000 },
    ],
  },
  {
    key: "raw-30s-cold",
    order: "raw-first",
    steps: [
      { kind: "raw", phase: "cold", fromSurface: true, timeoutMs: 30000 },
      { kind: "raw", phase: "warm", fromSurface: true, timeoutMs: 8000 },
      { kind: "product", phase: "warm", productTimeoutMs: 8000 },
    ],
  },
  {
    key: "product-30s-cold",
    order: "product-first",
    steps: [
      { kind: "product", phase: "cold", productTimeoutMs: 30000 },
      { kind: "product", phase: "warm", productTimeoutMs: 8000 },
      { kind: "raw", phase: "warm", fromSurface: true, timeoutMs: 8000 },
      { kind: "product-cdp", phase: "warm", fromSurface: true, hostTimeoutMs: 90000 },
    ],
  },
  {
    key: "product-60s-cold",
    order: "product-first",
    steps: [
      { kind: "product", phase: "cold", productTimeoutMs: 60000 },
      { kind: "product", phase: "warm", productTimeoutMs: 8000 },
    ],
  },
  {
    key: "prior-hang",
    order: "warm-then-prior-hang",
    steps: [
      { kind: "raw", phase: "warmup", fromSurface: true, timeoutMs: 30000 },
      { kind: "product", phase: "warm-baseline-no-prior", productTimeoutMs: 8000 },
      { kind: "raw", phase: "prior-hang-abandoned-1s", fromSurface: true, timeoutMs: 1000 },
      { kind: "inspect", phase: "outstanding-check" },
      { kind: "product", phase: "right-after-prior-hang", productTimeoutMs: 8000 },
      { kind: "diag", phase: "after-prior-hang", resetCooldown: true },
      { kind: "product", phase: "after-reset-long", productTimeoutMs: 30000 },
      { kind: "raw", phase: "warm-after", fromSurface: true, timeoutMs: 8000 },
    ],
  },
  {
    // 复现 F3 的会话形态：先创建 3 个 managed hidden 窗口，再让主窗口空闲 ~45s
    // （F3 在 Chrome 启动后约 28s 才第一次截图），然后 product-first。
    key: "f3-like-idle",
    order: "product-first",
    extraTabs: ["f3-other1", "f3-other2"],
    idleBeforeMs: 45000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "product", phase: "cold-after-idle", productTimeoutMs: 8000 },
      { kind: "diag", phase: "after-cold", resetCooldown: true },
      { kind: "raw", phase: "right-after-product", fromSurface: true, timeoutMs: 8000 },
      { kind: "product", phase: "after-raw", productTimeoutMs: 8000 },
      { kind: "product-cdp", phase: "after", fromSurface: true, hostTimeoutMs: 90000 },
      { kind: "raw", phase: "warm", fromSurface: false, timeoutMs: 8000 },
    ],
  },
  {
    // 同样的空闲窗口，但 raw-first：区分「产品路径问题」与「窗口空闲后合成器不产帧」。
    key: "f3-like-idle-raw-first",
    order: "raw-first",
    idleBeforeMs: 45000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "raw", phase: "cold-after-idle", fromSurface: true, timeoutMs: 8000 },
      { kind: "raw", phase: "cold-after-idle-30s", fromSurface: true, timeoutMs: 30000 },
      { kind: "product", phase: "after-raw", productTimeoutMs: 8000 },
      { kind: "product", phase: "after-raw-long", productTimeoutMs: 30000 },
    ],
  },
  {
    // F3 精确复刻：3 个窗口 + moveAndSettle(SWP_SHOWWINDOW) + 空闲 ~30s + product-first。
    key: "f3-like-move",
    order: "product-first",
    extraTabs: ["f3m-other1", "f3m-other2"],
    moveWindow: true,
    idleBeforeMs: 30000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "product", phase: "cold-after-idle", productTimeoutMs: 8000 },
      { kind: "diag", phase: "after-cold", resetCooldown: true },
      { kind: "raw", phase: "right-after-product", fromSurface: true, timeoutMs: 8000 },
      { kind: "raw", phase: "after", fromSurface: true, timeoutMs: 30000 },
      { kind: "product", phase: "after-raw", productTimeoutMs: 8000 },
      { kind: "raw", phase: "after", fromSurface: false, timeoutMs: 8000 },
    ],
  },
  {
    key: "f3-like-move-raw-first",
    order: "raw-first",
    moveWindow: true,
    idleBeforeMs: 30000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "raw", phase: "cold-after-idle", fromSurface: true, timeoutMs: 8000 },
      { kind: "raw", phase: "cold-after-idle-30s", fromSurface: true, timeoutMs: 30000 },
      { kind: "product", phase: "after-raw", productTimeoutMs: 8000 },
    ],
  },
  {
    // 静态页面（无 rAF/无定时器，等价 F3 fixture 的隐藏窗口空闲状态）+ product-first。
    key: "static-product-first",
    order: "product-first",
    static: true,
    steps: [
      { kind: "inspect", phase: "before-first-capture" },
      { kind: "product", phase: "cold", productTimeoutMs: 8000 },
      { kind: "diag", phase: "after-cold", resetCooldown: true },
      { kind: "raw", phase: "right-after-product", fromSurface: true, timeoutMs: 8000 },
      { kind: "product", phase: "after-raw", productTimeoutMs: 8000 },
      { kind: "product", phase: "after-raw-long", productTimeoutMs: 30000 },
      { kind: "raw", phase: "after", fromSurface: false, timeoutMs: 8000 },
    ],
  },
  {
    key: "static-idle-product-first",
    order: "product-first",
    static: true,
    idleBeforeMs: 30000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "product", phase: "cold-after-idle", productTimeoutMs: 8000 },
      { kind: "diag", phase: "after-cold", resetCooldown: true },
      { kind: "raw", phase: "right-after-product", fromSurface: true, timeoutMs: 8000 },
      { kind: "product", phase: "after-raw", productTimeoutMs: 8000 },
    ],
  },
  {
    key: "static-idle-raw-first",
    order: "raw-first",
    static: true,
    idleBeforeMs: 30000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "raw", phase: "cold-after-idle", fromSurface: true, timeoutMs: 8000 },
      { kind: "raw", phase: "cold-after-idle-30s", fromSurface: true, timeoutMs: 30000 },
      { kind: "product", phase: "after-raw", productTimeoutMs: 8000 },
      { kind: "product", phase: "after-raw-long", productTimeoutMs: 30000 },
    ],
  },
  {
    key: "static-cold-raw-30s",
    order: "raw-first",
    static: true,
    idleBeforeMs: 10000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "raw", phase: "cold", fromSurface: true, timeoutMs: 30000 },
    ],
  },
  {
    key: "static-cold-raw-60s",
    order: "raw-first",
    static: true,
    idleBeforeMs: 10000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "raw", phase: "cold", fromSurface: true, timeoutMs: 60000 },
    ],
  },
  {
    key: "static-cold-product-30s",
    order: "product-first",
    static: true,
    idleBeforeMs: 10000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "product", phase: "cold", productTimeoutMs: 30000 },
    ],
  },
  {
    key: "static-cold-product-60s",
    order: "product-first",
    static: true,
    idleBeforeMs: 10000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "product", phase: "cold", productTimeoutMs: 60000 },
    ],
  },
  {
    // 拆解「首个 fromSurface 请求挂住后，什么事件能让它真正返回」。
    key: "unstick-probe",
    order: "raw-first",
    static: true,
    idleBeforeMs: 10000,
    steps: [
      { kind: "inspect", phase: "after-idle" },
      { kind: "raw", phase: "hang-8s", fromSurface: true, timeoutMs: 8000 },
      { kind: "inspect", phase: "right-after-timeout" },
      { kind: "sleep", ms: 5000 },
      { kind: "inspect", phase: "after-5s-no-action" },
      { kind: "sleep", ms: 5000 },
      { kind: "inspect", phase: "after-10s-no-action" },
      { kind: "raw", phase: "second-raw-8s", fromSurface: true, timeoutMs: 8000 },
      { kind: "inspect", phase: "after-second-raw" },
      { kind: "product", phase: "product-after", productTimeoutMs: 8000 },
      { kind: "inspect", phase: "after-product" },
      { kind: "raw", phase: "third-raw-8s", fromSurface: true, timeoutMs: 8000 },
      { kind: "inspect", phase: "final" },
    ],
  },
  {
    key: "winop-probe",
    order: "product-first",
    windowOps: [
      { op: "move", flags: 0 },
      { op: "move", flags: 0x0010 | 0x0040 },
      { op: "show" },
      { op: "hide" },
    ],
    steps: [
      { kind: "inspect", phase: "after-ops" },
      { kind: "product", phase: "after-ops", productTimeoutMs: 8000 },
      { kind: "raw", phase: "after", fromSurface: true, timeoutMs: 8000 },
      { kind: "raw", phase: "after", fromSurface: false, timeoutMs: 8000 },
    ],
  },
];

const VISIBLE_SCENARIOS = [
  {
    key: "v-raw-first",
    order: "raw-first",
    steps: [
      { kind: "raw", phase: "cold", fromSurface: true, timeoutMs: 8000 },
      { kind: "raw", phase: "warm", fromSurface: true, timeoutMs: 8000 },
      { kind: "product", phase: "warm", productTimeoutMs: 8000 },
      { kind: "raw", phase: "warm", fromSurface: false, timeoutMs: 8000 },
      { kind: "product-cdp", phase: "warm", fromSurface: false, hostTimeoutMs: 30000 },
      { kind: "raw", phase: "warm", fromSurface: true, timeoutMs: 30000 },
    ],
  },
  {
    key: "v-product-first",
    order: "product-first",
    steps: [
      { kind: "product", phase: "cold", productTimeoutMs: 8000 },
      { kind: "raw", phase: "warm", fromSurface: true, timeoutMs: 8000 },
      { kind: "product", phase: "warm", productTimeoutMs: 8000 },
    ],
  },
];

function printMatrix() {
  log("product screenshot A/B matrix");
  log("  managed-hidden scenarios:");
  for (const s of MANAGED_SCENARIOS) log("    " + s.key + " (" + s.order + "): " + s.steps.map((x) => x.kind + "/" + (x.phase || "")).join(" -> "));
  log("  visible scenarios:");
  for (const s of VISIBLE_SCENARIOS) log("    " + s.key + " (" + s.order + "): " + s.steps.map((x) => x.kind + "/" + (x.phase || "")).join(" -> "));
  log("  headless: raw cold 8s -> raw warm 8s -> fromSurface=false -> raw 30s");
}

async function runManaged() {
  const session = await startSession({ name: "managed-hidden", managed: true });
  try {
    for (const scenario of MANAGED_SCENARIOS) {
      if (!scenarioSelected(scenario.key)) continue;
      for (const extra of scenario.extraTabs || []) await openTab(session, extra, { static: scenario.static });
      const tab = await openTab(session, scenario.key, { static: scenario.static });
      if (scenario.moveWindow && tab.window?.hwnd) {
        // 复刻 harness 的 moveAndSettle：SetWindowPos(SWP_NOACTIVATE|SWP_SHOWWINDOW)。
        // managed 模式不会真的把窗口呈现给用户；这一步把窗口从「从未 show」推进到
        // 「show 请求被抑制/再次隐藏」的状态——F3 失败时的窗口就处于该状态。
        const moved = windowOp("move", tab.window.hwnd, { x: 80, y: 80, w: 940, h: 700, flags: 0x0010 | 0x0040 });
        tab.window = { ...tab.window, ...moved, moveOp: "SWP_NOACTIVATE|SWP_SHOWWINDOW" };
        log("[" + scenario.key + "] window move -> " + JSON.stringify(tab.window));
      }
      if (scenario.windowOps && tab.window?.hwnd) {
        for (const op of scenario.windowOps) {
          const out = windowOp(op.op, tab.window.hwnd, { x: 80, y: 80, w: 940, h: 700, flags: op.flags ?? 0 });
          log("[" + scenario.key + "] windowOp " + JSON.stringify(op) + " -> " + JSON.stringify(out));
          tab.window = { ...tab.window, ...out };
        }
      }
      if (scenario.idleBeforeMs) {
        log("[" + scenario.key + "] idle " + scenario.idleBeforeMs + "ms before first capture");
        await sleep(scenario.idleBeforeMs);
      }
      await runSteps(session, tab, scenario.order, scenario.steps);
    }
  } finally {
    await stopSession(session);
  }
}

async function runVisible() {
  const session = await startSession({ name: "visible", managed: false });
  try {
    for (const scenario of VISIBLE_SCENARIOS) {
      if (!scenarioSelected(scenario.key)) continue;
      const tab = await openTab(session, scenario.key);
      await runSteps(session, tab, scenario.order, scenario.steps);
    }
  } finally {
    await stopSession(session);
  }
}

async function runHeadless() {
  const session = await startSession({ name: "headless", managed: false, headless: true, withExtension: false });
  try {
    const keys = ["h-raw-first", "h-raw-30s-cold", "h-false-cold"];
    for (const [index, key] of keys.entries()) {
      const id = "ab-" + runToken + "-" + key;
      const url = servers.origin + "/probe?id=" + encodeURIComponent(id);
      const created = await session.cdp.send("Target.createTarget", { url }, { timeoutMs: 30000 });
      const target = await session.cdp.findTarget("id=" + id, "page", 40000);
      const rawSessionId = await session.cdp.attach(target.targetId);
      const tab = {
        key, id, url, targetId: target.targetId, rawSessionId,
        spaceId: null, tabId: null, windowId: null, order: null, steps: 0,
        window: { headless: true },
      };
      session.tabs.push(tab);
      const deadline = Date.now() + 30000;
      let probe = null;
      while (Date.now() < deadline) {
        probe = await session.cdp.evaluate(rawSessionId, "window.__probe ? window.__probe() : null", 10000).catch(() => null);
        if (probe && typeof probe.rafCount === "number") break;
        await sleep(200);
      }
      must("[headless " + key + "] fixture __probe 就绪", !!probe, JSON.stringify({ created, probe }));
      tab.initialProbe = probe;
      if (index === 0) {
        await runSteps(session, tab, "raw-first", [
          { kind: "raw", phase: "cold", fromSurface: true, timeoutMs: 8000 },
          { kind: "raw", phase: "warm", fromSurface: true, timeoutMs: 8000 },
          { kind: "raw", phase: "warm", fromSurface: false, timeoutMs: 8000 },
          { kind: "raw", phase: "warm", fromSurface: true, timeoutMs: 30000 },
        ]);
      } else if (index === 1) {
        await runSteps(session, tab, "raw-first", [
          { kind: "raw", phase: "cold", fromSurface: true, timeoutMs: 30000 },
        ]);
      } else {
        await runSteps(session, tab, "raw-first", [
          { kind: "raw", phase: "cold", fromSurface: false, timeoutMs: 8000 },
        ]);
      }
    }
  } finally {
    await stopSession(session);
  }
}

// ---------------------------------------------------------------- summary
function buildSummary() {
  const byKey = {};
  for (const a of report.attempts) {
    if (a.kind === "diag") continue;
    const key = a.session + "/" + a.tab;
    const row = {
      tab: a.tab,
      order: a.order,
      kind: a.kind,
      phase: a.phase,
      seq: a.seq,
      wallMs: a.wallMs,
      ok: a.ok,
      bytes: a.png?.bytes ?? 0,
      pngFrame: a.png?.frame ?? null,
      domBefore: a.freshness?.domBefore ?? null,
      domAfter: a.freshness?.domAfter ?? null,
      delta: a.freshness?.delta ?? null,
      fresh: a.freshness?.fresh ?? null,
      possiblyStale: a.product?.possiblyStale ?? null,
      fromSurface: a.product?.fromSurface ?? a.fromSurface ?? null,
      reason: a.product?.reason ?? null,
      internalMs: a.product?.durationMs ?? null,
      preCaptureMs: a.product?.preCaptureMs ?? null,
      error: a.error ?? null,
      pending: a.diagnosticsAfter?.pending ?? null,
      cooldown: a.diagnosticsAfter?.cooldownForTab
        ? {
            active: a.diagnosticsAfter.cooldownForTab.active,
            remainingMs: a.diagnosticsAfter.cooldownForTab.remainingMs,
            consecutiveTimeouts: a.diagnosticsAfter.cooldownForTab.consecutiveTimeouts,
            hardStopped: a.diagnosticsAfter.cooldownForTab.hardStopped,
          }
        : null,
      cleanup: a.diagnosticsAfter?.cleanup ?? null,
      rawOutstanding: a.rawOutstandingAfter ?? null,
      rawLateSettles: a.rawLateSettles ?? null,
    };
    (byKey[key] ||= []).push(row);
  }
  return byKey;
}

function printTable(rows) {
  const header = ["seq", "kind", "phase", "wallMs", "ok", "bytes", "pngFrame", "domBefore", "delta", "fresh", "stale", "fromSurface", "internalMs", "pending", "rawOut"];
  log(header.join("\t"));
  for (const r of rows) {
    log([
      r.seq,
      r.kind,
      r.phase ?? "",
      r.wallMs ?? "",
      r.ok ? "Y" : "N",
      r.bytes,
      r.pngFrame ?? "",
      r.domBefore ?? "",
      r.delta ?? "",
      r.fresh === null ? "" : r.fresh ? "Y" : "N",
      r.possiblyStale === null ? "" : r.possiblyStale ? "Y" : "N",
      r.fromSurface === null ? "" : r.fromSurface ? "true" : "false",
      r.internalMs ?? "",
      r.pending ?? "",
      r.rawOutstanding ?? "",
    ].join("\t"));
  }
}

// ---------------------------------------------------------------- main
let servers = null;
let registration = null;
let unregisterResult = null;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error("patched chrome.exe not found: " + CHROME);
  if (!fs.existsSync(FIXTURE)) throw new Error("fixture not found: " + FIXTURE);
  report.env.chromeMtime = new Date(fs.statSync(CHROME).mtimeMs).toISOString();
  try { report.env.extensionId = extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).key); } catch {}

  if (MATRIX) {
    printMatrix();
    report.verdict = "MATRIX";
    return;
  }
  must("平台为 Windows", process.platform === "win32", process.platform);
  must("patched chrome.exe 存在", fs.existsSync(CHROME), CHROME);
  must("Chrome 不是 headless 专用构建（存在 chrome.exe）", true);

  if (!NO_BUILD) {
    const ext = runNpm("build");
    const host = runNpm("build:host");
    report.build = { ext, host };
    must("npm run build 成功", ext.ok, JSON.stringify(ext));
    must("npm run build:host 成功", host.ok, JSON.stringify(host));
  }
  must("扩展 dist/manifest.json 存在", fs.existsSync(path.join(DIST, "manifest.json")), DIST);
  const hostExe = findNewestHostExe(root);
  must("native host exe 存在", !!hostExe && fs.existsSync(hostExe), String(hostExe));
  report.env.hostExe = hostExe;
  report.env.hostExeMtime = new Date(fs.statSync(hostExe).mtimeMs).toISOString();

  servers = await startFixtureServer();
  report.env.fixtureOrigin = servers.origin;

  const needsExtension = STAGES.has("managed") || STAGES.has("visible");
  if (needsExtension) {
    const beforeValue = registryDefault(REGISTRY_KEY);
    // 只允许备份/恢复「非本 worktree」的值。若 HKCU 已指向本 worktree 的 manifest，
    // 说明上次运行残留，此时把它当用户原始值会把残留永久固化——必须 fail closed。
    const staleFromThisWorktree = String(beforeValue).toLowerCase().includes(root.toLowerCase());
    must(
      "注册表当前值不是本 worktree 的残留 manifest",
      !staleFromThisWorktree,
      JSON.stringify({ beforeValue, worktree: root }),
    );
    const backupDir = path.join(runDir, "registry-backup");
    fs.mkdirSync(backupDir, { recursive: true });
    const reg = runPowerShellFile(REGISTER_PS1, ["-HostPath", hostExe, "-BackupDir", backupDir]);
    must("register.ps1 执行成功", reg.status === 0 && reg.json?.ok === true, JSON.stringify({ status: reg.status, stderr: reg.stderr.slice(-500), json: reg.json }));
    registration = reg.json;
    report.registration = {
      registryKey: REGISTRY_KEY,
      beforeValue,
      manifestPath: registration.manifestPath,
      hostPath: registration.hostPath,
      extensionId: registration.extensionId,
      backupFile: registration.backupFile,
    };
    must("注册后 HKCU 指向本次 host manifest", registryDefault(REGISTRY_KEY) === registration.manifestPath, JSON.stringify({
      after: registryDefault(REGISTRY_KEY),
      expected: registration.manifestPath,
    }));
    must("注册的扩展 ID 与仓库 manifest.json 推导一致", registration.extensionId === report.env.extensionId, JSON.stringify({
      registered: registration.extensionId,
      derived: report.env.extensionId,
    }));
  }

  if (STAGES.has("managed")) await runManaged();
  if (STAGES.has("visible")) await runVisible();
  if (STAGES.has("headless")) await runHeadless();

  report.verdict = "COMPLETED";
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error("[ab] fatal: " + message);
  report.error = message;
  report.verdict = "FAILED";
} finally {
  try { servers?.close(); } catch {}
  if (registration?.backupFile) {
    unregisterResult = runPowerShellFile(UNREGISTER_PS1, ["-BackupFile", registration.backupFile]);
    report.registration = {
      ...(report.registration || {}),
      rollback: { status: unregisterResult.status, json: unregisterResult.json, stderr: unregisterResult.stderr.slice(-500) },
      afterRollback: registryDefault(REGISTRY_KEY),
    };
    check(
      "unregister.ps1 恢复注册表到测试前值",
      report.registration.afterRollback === report.registration.beforeValue,
      JSON.stringify(report.registration),
    );
  }
  report.finishedAt = nowIso();
  report.summary = buildSummary();
  const resultFile = RESULT_ARG || (fs.existsSync("D:\\c\\logs")
    ? path.join("D:\\c\\logs", "product-screenshot-ab-" + runId + ".json")
    : path.join(runDir, "result.json"));
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  log("result: " + resultFile);
  log("verdict: " + report.verdict);
  if (report.summary && Object.keys(report.summary).length) {
    for (const [key, rows] of Object.entries(report.summary)) {
      log("\n== " + key + " ==");
      printTable(rows);
    }
  }
  process.exitCode = report.verdict === "COMPLETED" ? 0 : 1;
}

