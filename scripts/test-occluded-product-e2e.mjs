// 产品级「遮挡窗口取新帧」真实链路验收（Windows）。
//
// 目标：不用独立 CDP harness，而是走真实产品链路：
//   可见的打补丁 Chrome → 扩展 SW → connectNative → 本次构建的 native host exe →
//   host TCP 协议（list_tabs / js / screenshot）→ chrome.debugger → Page.captureScreenshot。
//
// 覆盖：
//   1) HKCU 注册本次 host（register.ps1 备份），结束 unregister.ps1 恢复并核验；
//   2) 可见窗口 + 独立临时 profile / 隔离 LOCALAPPDATA；不用 --no-sandbox / --headless；
//   3) Win32 遮挡窗口（独立的 WS_EX_NOACTIVATE 置顶窗口，同 rect；绝不 SetForegroundWindow）；
//   4) 遮挡后 document.visibilityState=hidden、hasFocus=false；截图前后前台窗口与
//      GW_HWNDPREV 完全不变；目标窗口 visible 且未最小化；
//   5) 24x24 marker 颜色帧号 vs __probe().rafCount（±4），每次截前 __bump(5)；
//   6) iframe / Canvas2D / WebGL 内容像素采样；
//   7) 同一遮挡窗口连续 N（默认 60）次 screenshot：全部 fresh、进程存活、无 FATAL；
//   8) 3 个可见窗口全部遮挡，并发 3 个 screenshot，全部 fresh，前台/z-order 不变；
//   9) JSON 报告写到 D:\c\logs\product-occluded-<timestamp>.json，任一项失败 → 非 0 退出。
//
// 进程清理只走 scripts/lib/test-process.mjs 的验证式接口（PID+创建时间+marker+exe 路径）；
// 禁止任何按镜像名/进程名的批量清理。
//
// 运行：
//   node scripts/test-occluded-product-e2e.mjs                 # 全量（默认会先 build + build:host）
//   node scripts/test-occluded-product-e2e.mjs --no-build      # 复用现有 dist / host exe
//   node scripts/test-occluded-product-e2e.mjs --repeat=10     # 调整连续截图次数（默认 60）
//   node scripts/test-occluded-product-e2e.mjs --stage=smoke   # 只做链路+遮挡+2 张截图
//   node scripts/test-occluded-product-e2e.mjs --stage=single  # 单窗口连续截图
//   node scripts/test-occluded-product-e2e.mjs --stage=multi   # 3 窗口并发
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, findNewestHostExe } from "./lib/host-manifest.mjs";
import { decodePng, pixelAt } from "./lib/png.mjs";
import {
  describeRecord,
  isAlive,
  launchTestProcess,
  stopTestProcess,
  stopVerifiedPid,
} from "./lib/test-process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(root, "dist");
const FIXTURE = path.join(root, "tests", "fixtures", "occluded-product-probe.html");
const REGISTER_PS1 = path.join(root, "native-host", "register.ps1");
const UNREGISTER_PS1 = path.join(root, "native-host", "unregister.ps1");
const HOST_NAME = "com.browserpilot.browseragent";
const REGISTRY_KEY = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME;
const CHROME =
  process.env.BROWSERPILOT_PATCHED_CHROME || "D:\\c\\src\\out\\WinDev\\chrome.exe";
const LOG_DIR = "D:\\c\\logs";

const argv = process.argv.slice(2);
const STAGE = (argv.find((a) => a.startsWith("--stage="))?.slice("--stage=".length) || "full").trim();
const REPEAT = Number(argv.find((a) => a.startsWith("--repeat="))?.slice("--repeat=".length) || 60);
const NO_BUILD = argv.includes("--no-build");
const SAVE_PNG = argv.includes("--save-png");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const runToken = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

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
  checkLog.push({ name, ok, detail: typeof detail === "string" ? detail.slice(0, 2000) : detail });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (ok || !detail ? "" : " :: " + String(detail).slice(0, 1200)));
  return ok;
}

function mustCheck(name, condition, detail = "") {
  if (!check(name, condition, detail)) throw new Error("check failed: " + name);
}

// ---------------------------------------------------------------- run dir / report
const runId = nowIso().replace(/[:.]/g, "-");
const runDir = path.join(root, ".e2e-tmp", "occluded-product-" + runId);
const artifactsDir = path.join(runDir, "artifacts");
const profileDir = path.join(runDir, "chrome-profile");
const localAppData = path.join(runDir, "localappdata");
const backupDir = path.join(runDir, "registry-backup");
fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(localAppData, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const report = {
  test: "browserpilot-product-occluded-e2e",
  stage: STAGE,
  repeatTarget: REPEAT,
  startedAt: nowIso(),
  finishedAt: null,
  verdict: "BLOCKED",
  blockedReason: null,
  runId,
  runDir,
  env: {
    platform: process.platform,
    node: process.version,
    chromePath: CHROME,
    chromeDllMtime: null,
    dist: DIST,
    fixture: FIXTURE,
    hostExe: null,
    hostExeMtime: null,
    extensionId: null,
    runToken,
    foregroundBeforeLaunch: null,
    screen: null,
  },
  build: null,
  registration: null,
  host: null,
  spaces: [],
  windows: null,
  occlusion: null,
  screenshots: [],
  stress: null,
  multiWindow: null,
  browserLog: null,
  cleanup: null,
  checks: null,
  notes: [],
};

function saveArtifact(name, data) {
  const file = path.join(artifactsDir, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", "utf8");
  return file;
}

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

// ---------------------------------------------------------------- PowerShell helpers
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

function registryDefault(keyPath) {
  const script =
    "$k='" + keyPath.replace(/'/g, "''") + "';" +
    "if (Test-Path -LiteralPath $k) { $i=Get-Item -LiteralPath $k; if (@($i.GetValueNames()) -contains '') { $v=$i.GetValue('', $null); if ($null -eq $v) { '' } else { [string]$v } } else { '<no-default>' } } else { '<missing>' }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  return (result.stdout || "").trim();
}

function processExecutablePath(pid) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(pid) + "').ExecutablePath",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  return (result.stdout || "").trim();
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
    stdoutTail: (result.stdout || "").split(/\r?\n/).slice(-8).join("\n"),
    stderrTail: (result.stderr || "").split(/\r?\n/).slice(-8).join("\n"),
  };
}

// ---------------------------------------------------------------- win32 helper (persistent PowerShell)
const WIN32_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Core -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public static class BpWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);

  public static List<IntPtr> TopWindows() {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  public static string Class(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
}

public class BpOccluderForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
      cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
      return cp;
    }
  }
  public BpOccluderForm() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    BackColor = System.Drawing.Color.FromArgb(255, 0, 255);
    Text = "browserpilot-occluder";
  }
}
'@

$script:forms = @{}
$script:currentId = $null
$script:running = $true

function Send-Reply($obj) {
  if ($null -ne $script:currentId) { $obj['id'] = $script:currentId }
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-WinInfo([System.IntPtr]$h) {
  $r = [BpWin32+RECT]::new()
  $rectOk = [BpWin32]::GetWindowRect($h, [ref]$r)
  $procId = [uint32]0
  [void][BpWin32]::GetWindowThreadProcessId($h, [ref]$procId)
  $above = [BpWin32]::GetWindow($h, 3)
  $below = [BpWin32]::GetWindow($h, 2)
  $rect = $null
  if ($rectOk) { $rect = @([int]$r.Left, [int]$r.Top, [int]($r.Right - $r.Left), [int]($r.Bottom - $r.Top)) }
  return [ordered]@{
    hwnd = $h.ToInt64()
    pid = [int]$procId
    className = [BpWin32]::Class($h)
    title = [BpWin32]::Text($h)
    visible = [bool][BpWin32]::IsWindowVisible($h)
    iconic = [bool][BpWin32]::IsIconic($h)
    rect = $rect
    above = $above.ToInt64()
    below = $below.ToInt64()
  }
}

while ($script:running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    $script:currentId = $cmd.id
    $op = [string]$cmd.op
    switch ($op) {
      'ping' { Send-Reply ([ordered]@{ ok = $true; pong = $true; pid = $PID }) }
      'foreground' { Send-Reply ([ordered]@{ ok = $true; hwnd = ([BpWin32]::GetForegroundWindow()).ToInt64() }) }
      'screen' {
        $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        Send-Reply ([ordered]@{ ok = $true; rect = @([int]$s.X, [int]$s.Y, [int]$s.Width, [int]$s.Height) })
      }
      'listWindows' {
        $wantPid = 0
        if ($cmd.pid) { $wantPid = [int]$cmd.pid }
        $onlyVisible = [bool]$cmd.visibleOnly
        $list = New-Object System.Collections.ArrayList
        foreach ($h in [BpWin32]::TopWindows()) {
          $info = Get-WinInfo $h
          if ($wantPid -ne 0 -and $info.pid -ne $wantPid) { continue }
          if ($onlyVisible -and -not $info.visible) { continue }
          [void]$list.Add($info)
        }
        Send-Reply ([ordered]@{ ok = $true; windows = @($list); foreground = ([BpWin32]::GetForegroundWindow()).ToInt64() })
      }
      'state' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        Send-Reply ([ordered]@{ ok = $true; window = (Get-WinInfo $h); foreground = ([BpWin32]::GetForegroundWindow()).ToInt64() })
      }
      'move' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $flags = 0x0010 -bor 0x0040
        if ([bool]$cmd.noZorder) { $flags = $flags -bor 0x0004 }
        $after = [System.IntPtr]::Zero
        $okMove = [BpWin32]::SetWindowPos($h, $after, [int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height, [uint32]$flags)
        [System.Windows.Forms.Application]::DoEvents()
        Send-Reply ([ordered]@{ ok = [bool]$okMove; window = (Get-WinInfo $h); foreground = ([BpWin32]::GetForegroundWindow()).ToInt64() })
      }
      'raise' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $okRaise = [BpWin32]::SetWindowPos($h, [System.IntPtr]::Zero, [int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height, [uint32](0x0010 -bor 0x0040))
        [System.Windows.Forms.Application]::DoEvents()
        Send-Reply ([ordered]@{ ok = [bool]$okRaise; window = (Get-WinInfo $h); foreground = ([BpWin32]::GetForegroundWindow()).ToInt64() })
      }
      'createOccluder' {
        $f = New-Object BpOccluderForm
        $f.Bounds = [System.Drawing.Rectangle]::new([int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height)
        $f.Show()
        $f.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
        $h = $f.Handle
        # HWND_TOP + SWP_NOACTIVATE|SWP_SHOWWINDOW：置顶但不激活，不调用 SetForegroundWindow。
        $okPos = [BpWin32]::SetWindowPos($h, [System.IntPtr]::Zero, [int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height, [uint32](0x0010 -bor 0x0040))
        [System.Windows.Forms.Application]::DoEvents()
        $script:forms[$h.ToInt64()] = $f
        Send-Reply ([ordered]@{ ok = [bool]$okPos; hwnd = $h.ToInt64(); window = (Get-WinInfo $h); foreground = ([BpWin32]::GetForegroundWindow()).ToInt64() })
      }
      'closeOccluder' {
        $key = [int64]$cmd.hwnd
        if ($script:forms.ContainsKey($key)) {
          $f = $script:forms[$key]
          $f.Close()
          $f.Dispose()
          $script:forms.Remove($key)
        }
        [System.Windows.Forms.Application]::DoEvents()
        Send-Reply ([ordered]@{ ok = $true; foreground = ([BpWin32]::GetForegroundWindow()).ToInt64() })
      }
      'closeAll' {
        foreach ($key in @($script:forms.Keys)) { $script:forms[$key].Close(); $script:forms[$key].Dispose() }
        $script:forms.Clear()
        [System.Windows.Forms.Application]::DoEvents()
        Send-Reply ([ordered]@{ ok = $true; foreground = ([BpWin32]::GetForegroundWindow()).ToInt64() })
      }
      'shutdown' {
        foreach ($key in @($script:forms.Keys)) { $script:forms[$key].Close(); $script:forms[$key].Dispose() }
        $script:forms.Clear()
        Send-Reply ([ordered]@{ ok = $true })
        $script:running = $false
      }
      default { Send-Reply ([ordered]@{ ok = $false; error = ('unknown op: ' + $op) }) }
    }
  } catch {
    Send-Reply ([ordered]@{ ok = $false; error = $_.Exception.Message })
  }
}
`;

class Win32Helper {
  constructor(psFile) {
    this.psFile = psFile;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
  }

  async start() {
    fs.writeFileSync(this.psFile, WIN32_PS, "utf8");
    this.child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.psFile],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
    });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("win32 helper exited (code " + code + "): " + this.stderr.slice(-800)));
      }
      this.pending.clear();
    });
    const pong = await this.call("ping", {}, 20000);
    if (!pong?.ok || !pong?.pong) throw new Error("win32 helper ping failed: " + JSON.stringify(pong));
  }

  call(op, args = {}, timeoutMs = 20000) {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error("win32 helper is not running"));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("win32 op " + op + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  async stop() {
    if (!this.child) return;
    try {
      await this.call("closeAll", {}, 8000).catch(() => undefined);
      await this.call("shutdown", {}, 8000).catch(() => undefined);
    } finally {
      try { this.child.kill(); } catch {}
      await sleep(200);
    }
  }
}

// ---------------------------------------------------------------- fixture server
function startFixtureServer() {
  const fixtureHtml = fs.readFileSync(FIXTURE, "utf8");
  const iframeHtml = `<!doctype html><html><head><meta charset="utf-8"><title>frame</title>
<style>html,body{margin:0;padding:0;height:100%;background:#ffee00;color:#000;
font:16px/1.2 monospace;overflow:hidden}div{padding:4px}</style></head>
<body><div id="frame-content">same-origin iframe payload</div></body></html>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/frame") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(iframeHtml);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(fixtureHtml);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        urlFor: (id) => "http://127.0.0.1:" + port + "/probe?id=" + encodeURIComponent(id),
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------- host discovery / TCP
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
      // ignore partial files
    }
  }
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
async function waitForHostSession(lad, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const candidates = readSessions(lad).filter(
        (s) => pidAlive(s.pid) && Date.now() - Number(s.updatedAt || 0) < 180000,
      );
      if (candidates.length) return candidates[0];
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(
    "timed out waiting for a live native host session in " +
      sessionsDirFor(lad) +
      (lastError ? " (" + lastError.message + ")" : ""),
  );
}

let requestSeq = 0;
function tcpRequest(port, authToken, name, args = {}, { space, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const requestId = "occl-" + ++requestSeq;
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
          agentId: "occl-e2e-agent",
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
  constructor(session) {
    this.session = session;
    this.port = session.port;
    this.authToken = session.authToken;
  }
  async request(name, args = {}, options = {}) {
    const result = await tcpRequest(this.port, this.authToken, name, args, options);
    if (result.ok !== true) {
      const error = new Error(name + " failed: " + (result.error || "unknown"));
      error.code = result.errorCode;
      throw error;
    }
    return result.data;
  }
}

// ---------------------------------------------------------------- browser launch
async function launchChrome({ fixtureUrl, logFile }) {
  const args = [
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "--load-extension=" + DIST,
    "--disable-extensions-except=" + DIST,
    "--in-process-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    // 测试专用：让 Chromium 把 FATAL/CHECK/crash 信号写进 stderr，供本测试扫描。
    // 不改变渲染/合成路径（v=0 只输出 WARNING 及以上）；不属于产品默认参数。
    "--enable-logging=stderr",
    "--v=0",
    fixtureUrl,
  ];
  const env = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    BROWSERPILOT_HOST_BASE_PORT: String(48600 + Math.floor(Math.random() * 120)),
  };
  const record = launchTestProcess({
    exe: CHROME,
    args,
    env,
    marker: profileDir,
    label: "occluded-product-chrome",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = record.child;
  let stderr = "";
  let stdout = "";
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
    stdoutTail: () => stdout.split(/\r?\n/).slice(-10).join("\n"),
    stop: () => stopTestProcess(record, { reason: "occluded-product.stop" }),
  };
}

// ---------------------------------------------------------------- image sampling
const EXPECTED = {
  canvas2d: [255, 0, 170],
  webgl: [0, 255, 102],
  iframe: [255, 238, 0],
};

function averageRegion(img, cx, cy, radius = 3) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const [pr, pg, pb] = pixelAt(img, cx + dx, cy + dy);
      r += pr;
      g += pg;
      b += pb;
      n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// 在截图左上区域找 24x24 marker 块：它是唯一 B=255 且非白的实心块。
// 用它反推 CSS px → PNG px 的实际比例，避免 innerWidth 在窗口 resize 后滞后
// （被遮挡窗口的 renderer viewport 可能还是 resize 前尺寸）。
function detectMarkerBox(img) {
  const y1 = Math.min(140, img.height - 1);
  const x1 = Math.min(400, img.width - 1);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y <= y1; y++) {
    for (let x = 0; x <= x1; x++) {
      const [r, g, b] = pixelAt(img, x, y);
      // marker: B 恒为 255；R/G 编码帧号。排除白色（信息文字等）。
      if (b >= 240 && !(r >= 250 && g >= 250)) {
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (count < 100 || maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count };
}

function sampleAtRect(img, rect, scaleX, scaleY) {
  const cx = (Number(rect.x) + Number(rect.w) / 2) * scaleX;
  const cy = (Number(rect.y) + Number(rect.h) / 2) * scaleY;
  const avg = averageRegion(img, cx, cy, 3);
  const center = pixelAt(img, cx, cy).slice(0, 3);
  return { avg, center };
}

function closeColour(actual, expected, tolerance = 12) {
  return (
    Math.abs(actual[0] - expected[0]) <= tolerance &&
    Math.abs(actual[1] - expected[1]) <= tolerance &&
    Math.abs(actual[2] - expected[2]) <= tolerance
  );
}

function analysePng(buffer, probe) {
  const img = decodePng(buffer);
  const markerBox = detectMarkerBox(img);
  // 优先用 marker 实测尺寸（24 CSS px）反推；否则退回 innerWidth/innerHeight。
  const scaleX = markerBox ? markerBox.w / 24 : img.width / Number(probe.innerWidth || img.width);
  const scaleY = markerBox ? markerBox.h / 24 : img.height / Number(probe.innerHeight || img.height);
  const scaleSource = markerBox ? "marker-box" : "inner-width";
  const rects = probe.rects || {};
  const marker = sampleAtRect(img, rects.marker, scaleX, scaleY);
  const canvas2d = sampleAtRect(img, rects.c2d, scaleX, scaleY);
  const webgl = sampleAtRect(img, rects.gl, scaleX, scaleY);
  const iframe = sampleAtRect(img, rects.iframe, scaleX, scaleY);
  // markerColour: R = low byte, G = high byte, B = 255.
  const pngFrame = marker.avg[0] + 256 * marker.avg[1];
  return {
    width: img.width,
    height: img.height,
    scale: [Number(scaleX.toFixed(4)), Number(scaleY.toFixed(4))],
    scaleSource,
    markerBox,
    marker,
    pngFrame,
    samples: {
      canvas2d: { ...canvas2d, expected: EXPECTED.canvas2d, ok: closeColour(canvas2d.avg, EXPECTED.canvas2d) },
      webgl: { ...webgl, expected: EXPECTED.webgl, ok: closeColour(webgl.avg, EXPECTED.webgl) },
      iframe: { ...iframe, expected: EXPECTED.iframe, ok: closeColour(iframe.avg, EXPECTED.iframe) },
    },
  };
}

// ---------------------------------------------------------------- product operations
async function jsProbe(client, tab, space) {
  const data = await client.request("js", { expression: "window.__probe ? window.__probe() : null", tabId: tab.tabId }, {
    space,
    timeoutMs: 20000,
  });
  return data?.value;
}
async function jsBump(client, tab, space, n = 5) {
  const data = await client.request("js", { expression: "window.__bump ? window.__bump(" + n + ") : null", tabId: tab.tabId }, {
    space,
    timeoutMs: 20000,
  });
  return data?.value;
}
async function waitForProbeReady(client, tab, space, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await jsProbe(client, tab, space);
      if (last && typeof last.rafCount === "number" && last.rects && last.iframeReady) return last;
    } catch (error) {
      last = { error: error.message };
    }
    await sleep(250);
  }
  throw new Error("fixture probe not ready in tab " + tab.tabId + ": " + JSON.stringify(last));
}

/** 真实产品命令 list_tabs：按 fixture URL 找到 tab（不使用 open_space 的返回值当捷径）。 */
async function findTabViaListTabs(client, space, urlNeedle) {
  const listing = await client.request("list_tabs", {}, { space });
  const tabs = Array.isArray(listing?.tabs) ? listing.tabs : [];
  const hit = tabs.find((tab) => String(tab.url || "").includes(urlNeedle));
  if (!hit) {
    throw new Error("list_tabs 未找到 fixture tab: " + urlNeedle + " -> " + JSON.stringify(tabs));
  }
  return { listing, tab: hit };
}

// 截图 + 全量断言。调用方负责 __bump。
async function takeMeasurement({ client, win32, tab, space, target, phase, index, savePng }) {
  const beforeWin = await win32.call("state", { hwnd: target.hwnd });
  const foregroundBefore = beforeWin.foreground;
  const aboveBefore = beforeWin.window.above;

  const bumpValue = await jsBump(client, tab, space, 5);

  const t0 = Date.now();
  const shot = await client.request("screenshot", { tabId: tab.tabId, format: "png" }, {
    space,
    timeoutMs: 40000,
  });
  const ms = Date.now() - t0;
  const buffer = Buffer.from(shot?.base64 || "", "base64");
  const meta = shot?.screenshot || {};
  const possiblyStale = shot?.possiblyStale === true || meta.possiblyStale === true;
  const fromSurface = meta.fromSurface === true;

  // 截图之后再读 probe：遮挡后 rAF 停止，frame 数不应再前进。
  const probe = await jsProbe(client, tab, space);
  let png = null;
  let pngError = null;
  if (buffer.length > 8) {
    try {
      png = analysePng(buffer, probe);
    } catch (error) {
      pngError = error instanceof Error ? error.message : String(error);
    }
  }

  const afterWin = await win32.call("state", { hwnd: target.hwnd });
  const foregroundAfter = afterWin.foreground;
  const aboveAfter = afterWin.window.above;

  const domFrame = Number(probe?.rafCount);
  const frameDelta = png ? Math.abs(Number(png.pngFrame) - domFrame) : null;
  const markerMatchesDom = png ? frameDelta <= 4 : false;
  const pngFrameAdvanced = png && typeof target.lastPngFrame === "number"
    ? png.pngFrame !== target.lastPngFrame
    : true;

  const result = {
    phase,
    index,
    tabId: tab.tabId,
    space,
    ms,
    bytes: buffer.length,
    pngWidth: png?.width ?? null,
    pngHeight: png?.height ?? null,
    pngScale: png?.scale ?? null,
    pngScaleSource: png?.scaleSource ?? null,
    markerBox: png?.markerBox ?? null,
    fromSurface,
    possiblyStale,
    reason: shot?.reason ?? meta.reason ?? null,
    meta: {
      fromSurface: meta.fromSurface ?? null,
      durationMs: meta.durationMs ?? null,
      possiblyStale: meta.possiblyStale ?? null,
      reason: meta.reason ?? null,
    },
    cursorIncluded: shot?.cursorIncluded ?? null,
    bumpValue,
    domFrame,
    pngFrame: png?.pngFrame ?? null,
    frameDelta,
    markerRgb: png?.marker?.avg ?? null,
    markerCenter: png?.marker?.center ?? null,
    markerMatchesDom,
    pngFrameAdvanced,
    probeVisibilityState: probe?.visibilityState ?? null,
    probeHasFocus: probe?.hasFocus ?? null,
    probeDpr: probe?.dpr ?? null,
    samples: png?.samples ?? null,
    pngError,
    foregroundBefore,
    foregroundAfter,
    foregroundStable: foregroundBefore === foregroundAfter,
    aboveBefore,
    aboveAfter,
    zOrderStable: aboveBefore === aboveAfter,
    targetVisible: afterWin.window.visible === true,
    targetIconic: afterWin.window.iconic === true,
    battery: null,
  };
  if (png) target.lastPngFrame = png.pngFrame;

  if (savePng && png) {
    const file = path.join(artifactsDir, phase + "-" + index + "-tab" + tab.tabId + ".png");
    fs.writeFileSync(file, buffer);
    result.pngFile = file;
  }
  return result;
}

function measurementOk(m) {
  const samples = m.samples || {};
  return (
    m.bytes > 1000 &&
    m.pngWidth > 0 &&
    m.fromSurface === true &&
    m.possiblyStale === false &&
    m.markerMatchesDom === true &&
    m.probeVisibilityState === "hidden" &&
    m.probeHasFocus === false &&
    m.foregroundStable === true &&
    m.zOrderStable === true &&
    m.targetVisible === true &&
    m.targetIconic === false &&
    samples.canvas2d?.ok === true &&
    samples.webgl?.ok === true &&
    samples.iframe?.ok === true
  );
}

function measurementDetail(m) {
  return JSON.stringify({
    ms: m.ms,
    fromSurface: m.fromSurface,
    possiblyStale: m.possiblyStale,
    domFrame: m.domFrame,
    pngFrame: m.pngFrame,
    frameDelta: m.frameDelta,
    vis: m.probeVisibilityState,
    focus: m.probeHasFocus,
    foreground: [m.foregroundBefore, m.foregroundAfter],
    above: [m.aboveBefore, m.aboveAfter],
    samples: m.samples && {
      canvas2d: m.samples.canvas2d?.avg,
      webgl: m.samples.webgl?.avg,
      iframe: m.samples.iframe?.avg,
    },
    pngError: m.pngError,
    reason: m.reason,
  });
}

// ---------------------------------------------------------------- occlusion helpers
function rectCovers(outer, inner) {
  if (!Array.isArray(outer) || !Array.isArray(inner)) return false;
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[0] + outer[2] >= inner[0] + inner[2] &&
    outer[1] + outer[3] >= inner[1] + inner[3]
  );
}

async function zOrderEvidence(win32, targetHwnd, occluderHwnd) {
  const listing = await win32.call("listWindows", { visibleOnly: true });
  const windows = Array.isArray(listing.windows) ? listing.windows : listing.windows ? [listing.windows] : [];
  const indexOf = (hwnd) => windows.findIndex((w) => Number(w.hwnd) === Number(hwnd));
  const targetIndex = indexOf(targetHwnd);
  const occluderIndex = indexOf(occluderHwnd);
  const target = targetIndex >= 0 ? windows[targetIndex] : null;
  const occluder = occluderIndex >= 0 ? windows[occluderIndex] : null;
  return {
    foreground: listing.foreground,
    visibleWindowCount: windows.length,
    targetIndex,
    occluderIndex,
    occluderAbove: occluderIndex >= 0 && targetIndex >= 0 && occluderIndex < targetIndex,
    covers: target && occluder ? rectCovers(occluder.rect, target.rect) : false,
    target: target
      ? { hwnd: target.hwnd, pid: target.pid, rect: target.rect, visible: target.visible, iconic: target.iconic, above: target.above }
      : null,
    occluder: occluder ? { hwnd: occluder.hwnd, rect: occluder.rect, visible: occluder.visible } : null,
  };
}

async function waitOccluded(client, tab, space, target, win32, occluderHwnd, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await jsProbe(client, tab, space);
      if (last?.visibilityState === "hidden" && last?.hasFocus === false) {
        const z = await zOrderEvidence(win32, target.hwnd, occluderHwnd);
        return { probe: last, z };
      }
    } catch (error) {
      last = { error: error.message };
    }
    await sleep(250);
  }
  const z = await zOrderEvidence(win32, target.hwnd, occluderHwnd).catch(() => null);
  return { probe: last, z, timedOut: true };
}

// ---------------------------------------------------------------- find chrome window by title
async function findWindowByTitle(win32, pid, titleNeedle, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listing = await win32.call("listWindows", { pid });
    const windows = Array.isArray(listing.windows) ? listing.windows : listing.windows ? [listing.windows] : [];
    const hit = windows.find((w) => String(w.title || "").includes(titleNeedle));
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

// 找到 Chrome 顶层窗口后把窗口移到目标 rect。Chrome 可能在窗口首次 Show 之后
// 异步套用自己的初始 bounds，因此这里必须「移动 → 等待 → 复核 rect」，稳定后才用于遮挡。
async function moveAndSettle(win32, hwnd, desiredRect, { raise = true, attempts = 4 } = {}) {
  let rect = [...desiredRect];
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await win32.call("move", {
      hwnd,
      x: rect[0],
      y: rect[1],
      width: rect[2],
      height: rect[3],
      noZorder: !raise,
    });
    await sleep(900);
    const state = await win32.call("state", { hwnd });
    const current = state.window.rect;
    if (
      current &&
      current[0] === rect[0] &&
      current[1] === rect[1] &&
      current[2] === rect[2] &&
      current[3] === rect[3]
    ) {
      return { rect: current, window: state.window, foreground: state.foreground, attempts: attempt, stable: true, move: last };
    }
    // Chrome 坚持自己的尺寸时，以它为准（遮挡窗口必须覆盖实际 rect）。
    if (current) rect = [...current];
  }
  const state = await win32.call("state", { hwnd });
  return { rect: state.window.rect, window: state.window, foreground: state.foreground, attempts, stable: false, move: last };
}

async function visibleWindows(win32, pid, limit = 15) {
  const listing = await win32.call("listWindows", { pid, visibleOnly: true });
  const windows = Array.isArray(listing.windows) ? listing.windows : listing.windows ? [listing.windows] : [];
  return windows.slice(0, limit).map((w) => ({
    hwnd: w.hwnd,
    title: String(w.title || "").slice(0, 80),
    rect: w.rect,
    iconic: w.iconic,
  }));
}

// ---------------------------------------------------------------- main
const fixture = await startFixtureServer();
const win32 = new Win32Helper(path.join(runDir, "win32-helper.ps1"));
let registration = null;
let chrome = null;
let client = null;
let hostSession = null;
let occluders = [];

async function stopChromeAndHost(cleanup) {
  if (chrome) {
    const stopped = chrome.stop();
    cleanup.chromeStop = stopped;
    console.log("[cleanup] chrome stop -> " + JSON.stringify(stopped));
    if (stopped.refused) {
      failed++;
      failures.push("chrome stop refused");
    }
  }
  // 等待 browser 进程退出（身份核验，不按名字）。
  if (chrome?.record) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      let alive = true;
      try {
        alive = isAlive(chrome.record);
      } catch {
        alive = false;
      }
      if (!alive) break;
      await sleep(250);
    }
    try {
      cleanup.chromeAliveAfterStop = isAlive(chrome.record);
    } catch {
      cleanup.chromeAliveAfterStop = false;
    }
  }
  // host 是 Chrome 的子进程；stdin EOF 后会自己退出。残留时按 exe 路径核验清理。
  if (hostSession) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && pidAlive(hostSession.pid)) await sleep(200);
    if (pidAlive(hostSession.pid) && report.env.hostExe) {
      const stoppedHost = stopVerifiedPid({
        pid: hostSession.pid,
        expectedExePath: report.env.hostExe,
        reason: "occluded-product.host-session",
      });
      cleanup.hostStop = stoppedHost;
      console.log("[cleanup] host stop -> " + JSON.stringify(stoppedHost));
    } else {
      cleanup.hostExitedOnItsOwn = true;
    }
    cleanup.hostAliveAfterStop = pidAlive(hostSession.pid);
  }
  cleanup.ownSessions = readSessions(localAppData).map((s) => ({ pid: s.pid, port: s.port, alive: pidAlive(s.pid) }));
}

try {
  // ------------------------------------------------------------ preflight
  report.env.chromeDllMtime = (() => {
    try {
      return new Date(fs.statSync(CHROME.replace(/chrome\.exe$/i, "chrome.dll")).mtimeMs).toISOString();
    } catch {
      return null;
    }
  })();
  mustCheck("平台为 Windows（Win32 遮挡 + WMI 进程核验）", process.platform === "win32", process.platform);
  mustCheck("打补丁的 chrome.exe 存在", fs.existsSync(CHROME), CHROME);
  mustCheck("fixture 存在", fs.existsSync(FIXTURE), FIXTURE);
  mustCheck("D:/c/logs 可写", fs.existsSync(LOG_DIR), LOG_DIR);

  if (!NO_BUILD) {
    const extBuild = runNpm("build");
    const hostBuild = runNpm("build:host");
    report.build = { extension: extBuild, host: hostBuild };
    mustCheck("npm run build 成功", extBuild.ok, JSON.stringify(extBuild));
    mustCheck("npm run build:host 成功", hostBuild.ok, JSON.stringify(hostBuild));
  } else {
    report.build = { skipped: true, reason: "--no-build" };
  }

  mustCheck("扩展 dist/manifest.json 存在", fs.existsSync(path.join(DIST, "manifest.json")), DIST);
  const hostExe = findNewestHostExe(root);
  mustCheck("native host exe 存在", !!hostExe && fs.existsSync(hostExe), hostExe || "run npm run build:host");
  report.env.hostExe = hostExe;
  report.env.hostExeMtime = new Date(fs.statSync(hostExe).mtimeMs).toISOString();
  const repoManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  report.env.extensionId = extensionIdFromKey(repoManifest.key);
  // fixture 里 title 是 occlp-<id>，这里用 runToken 保证窗口标题唯一。
  const probeId = (suffix) => runToken + "-" + suffix;

  await win32.start();
  const screenInfo = await win32.call("screen");
  report.env.screen = screenInfo.rect;
  const fgAtStart = await win32.call("foreground");
  report.env.foregroundBeforeLaunch = fgAtStart.hwnd;
  const screenRect = Array.isArray(screenInfo.rect) ? screenInfo.rect : [0, 0, 1920, 1080];
  const targetWidth = Math.max(720, Math.min(1100, screenRect[2] - 120));
  const targetHeight = Math.max(520, Math.min(800, screenRect[3] - 120));
  const targetRect = [40, 40, targetWidth, targetHeight];
  report.env.targetRect = targetRect;

  // ------------------------------------------------------------ registration
  const beforeValue = registryDefault(REGISTRY_KEY);
  const reg = runPowerShellFile(REGISTER_PS1, ["-HostPath", hostExe, "-BackupDir", backupDir]);
  mustCheck("register.ps1 执行成功", reg.status === 0 && reg.json?.ok === true, JSON.stringify({ status: reg.status, stderr: (reg.stderr || "").slice(-800), json: reg.json }));
  registration = reg.json;
  const afterRegisterValue = registryDefault(REGISTRY_KEY);
  const backup = JSON.parse(fs.readFileSync(registration.backupFile, "utf8"));
  report.registration = {
    registryKey: REGISTRY_KEY,
    beforeValue,
    afterRegisterValue,
    manifestPath: registration.manifestPath,
    hostPath: registration.hostPath,
    extensionId: registration.extensionId,
    backupFile: registration.backupFile,
    backupTarget: backup.targets?.[0] || null,
  };
  mustCheck("注册后 HKCU 指向本次 host manifest", afterRegisterValue === registration.manifestPath, JSON.stringify({ afterRegisterValue, manifestPath: registration.manifestPath }));
  mustCheck("注册备份记录旧值", (backup.targets?.[0]?.previousDefault ?? null) === (beforeValue === "<missing>" ? null : beforeValue), JSON.stringify(backup.targets?.[0] || null));
  mustCheck("注册的扩展 ID 与仓库 manifest.json 推导一致", registration.extensionId === report.env.extensionId, JSON.stringify({ registered: registration.extensionId, derived: report.env.extensionId }));

  // ------------------------------------------------------------ launch visible chrome
  const bootUrl = fixture.urlFor(probeId("boot"));
  const logFile = path.join(artifactsDir, "chrome.log");
  chrome = await launchChrome({ fixtureUrl: bootUrl, logFile });
  report.windows = { chromeArgs: chrome.args, chromeEnv: chrome.env, chromeLog: logFile, chromeRecord: describeRecord(chrome.record) };
  mustCheck("可见 Chrome 已启动（非 headless）", chrome.record.pid > 0 && !chrome.args.includes("--headless") && !chrome.args.includes("--no-sandbox"), JSON.stringify({ pid: chrome.record.pid, args: chrome.args }));

  hostSession = await waitForHostSession(localAppData, { timeoutMs: 90000 });
  const hostExeActual = processExecutablePath(hostSession.pid);
  report.host = {
    session: { port: hostSession.port, pid: hostSession.pid, file: hostSession.file },
    processExecutablePath: hostExeActual,
    expectedExe: hostExe,
    sessionFileContent: JSON.parse(fs.readFileSync(hostSession.file, "utf8")),
  };
  report.host.sessionFileContent = redact(report.host.sessionFileContent);
  mustCheck("connectNative 拉起本次构建的 host exe", !!hostExeActual && path.resolve(hostExeActual).toLowerCase() === path.resolve(hostExe).toLowerCase(), JSON.stringify({ hostExeActual, expected: hostExe }));
  client = new HostClient(hostSession);
  const ping = await client.request("ping");
  const version = await client.request("version");
  const ready = await client.request("get_ready_state");
  report.host.ping = ping;
  report.host.version = version;
  report.host.readyState = redact(ready);
  mustCheck("host ping 返回 pong", ping?.pong === true, JSON.stringify(ping));
  mustCheck("host version 返回 BrowserPilot", version?.name === "BrowserPilot", JSON.stringify(version));
  report.runtimeStarted = true;

  // ------------------------------------------------------------ single window (w0)
  const w0 = await client.request("open_space", { name: "occl-w0", url: fixture.urlFor(probeId("w0")) });
  const w0FromTabs = await findTabViaListTabs(client, w0.spaceId, "id=" + probeId("w0"));
  mustCheck("list_tabs 找到 w0 fixture tab", w0FromTabs.tab.tabId === w0.tabId, JSON.stringify({ openSpace: w0, listTabs: w0FromTabs }));
  const w0tab = { tabId: w0FromTabs.tab.tabId, windowId: w0FromTabs.tab.windowId, spaceId: w0.spaceId };
  report.spaces.push({ id: "w0", spaceId: w0.spaceId, windowId: w0.windowId, tabId: w0tab.tabId, url: fixture.urlFor(probeId("w0")), resolvedVia: "list_tabs" });
  const readyW0 = await waitForProbeReady(client, w0tab, w0.spaceId, 45000);
  mustCheck("w0 fixture 已加载（probe 就绪）", !!readyW0, JSON.stringify(readyW0).slice(0, 500));
  const hwndW0 = await findWindowByTitle(win32, chrome.record.pid, "occlp-" + probeId("w0"), 45000);
  mustCheck("w0 Chrome 窗口已找到（标题唯一匹配）", !!hwndW0, JSON.stringify({ pid: chrome.record.pid }));
  const w0Target = { id: "w0", hwnd: hwndW0.hwnd, pid: hwndW0.pid, tab: w0tab, space: w0.spaceId };

  // 提到目标 rect（SWP_NOACTIVATE，不激活；这一步是 setup，允许改变 z-order）。
  // 必须等 Chrome 自己可能的重排稳定后再取实际 rect，否则遮挡窗口可能盖不住。
  const settledW0 = await moveAndSettle(win32, w0Target.hwnd, targetRect, { raise: true });
  w0Target.rect = settledW0.rect;
  report.windows.w0Move = settledW0;
  report.windows.chromeWindowsAfterW0 = await visibleWindows(win32, chrome.record.pid);
  report.windows.listTabsW0 = await client.request("list_tabs", {}, { space: w0.spaceId }).catch((error) => ({ error: error.message }));
  const preProbe = await jsProbe(client, w0tab, w0.spaceId);
  report.occlusion = {
    targetRect,
    actualRectW0: settledW0.rect,
    foregroundBeforeOccluder: settledW0.foreground,
    w0: {
      hwnd: w0Target.hwnd,
      preOcclusionProbe: {
        visibilityState: preProbe?.visibilityState,
        hasFocus: preProbe?.hasFocus,
        dpr: preProbe?.dpr,
        innerWidth: preProbe?.innerWidth,
        innerHeight: preProbe?.innerHeight,
      },
      preOcclusionWindow: settledW0.window,
      preOcclusionVisibleWindows: report.windows.chromeWindowsAfterW0,
    },
  };
  // 本机（非交互/非前台会话）Chrome 对非前台窗口本来就可能判定 hidden；
  // 这里只把它记录为观察值，不伪造 visible。硬性要求是遮挡后 hidden 且无焦点。
  report.notes.push(
    "pre-occlusion visibilityState=" + String(preProbe?.visibilityState) +
      "（本机非前台窗口可能已被系统/其它窗口遮挡；不作为 PASS 条件）",
  );
  mustCheck("遮挡前 w0 页面 hasFocus=false（测试未抢前台）", preProbe?.hasFocus === false, JSON.stringify({ hasFocus: preProbe?.hasFocus }));

  // 创建遮挡窗口：与目标同 rect、WS_EX_NOACTIVATE、HWND_TOP，不调用 SetForegroundWindow。
  const occRect = settledW0.rect;
  const occ0 = await win32.call("createOccluder", { x: occRect[0], y: occRect[1], width: occRect[2], height: occRect[3] });
  occluders.push(occ0.hwnd);
  report.occlusion.w0.occluder = { hwnd: occ0.hwnd, window: occ0.window, foregroundAfterCreate: occ0.foreground };
  mustCheck("遮挡窗口创建后前台窗口未改变", occ0.foreground === settledW0.foreground, JSON.stringify({ before: settledW0.foreground, after: occ0.foreground }));

  const occluded = await waitOccluded(client, w0tab, w0.spaceId, w0Target, win32, occ0.hwnd, 20000);
  report.occlusion.w0.after = occluded;
  mustCheck("遮挡后 document.visibilityState=hidden", occluded.probe?.visibilityState === "hidden", JSON.stringify(occluded.probe).slice(0, 800));
  mustCheck("遮挡后 document.hasFocus()=false", occluded.probe?.hasFocus === false, JSON.stringify({ hasFocus: occluded.probe?.hasFocus }));
  mustCheck("遮挡窗口在 z-order 上位于目标之上且完全覆盖", occluded.z?.occluderAbove === true && occluded.z?.covers === true, JSON.stringify(occluded.z));
  mustCheck("目标窗口遮挡后仍 visible 且未最小化", occluded.z?.target?.visible === true && occluded.z?.target?.iconic === false, JSON.stringify(occluded.z?.target));

  // ------------------------------------------------------------ screenshots
  const stageDoesSingle = STAGE === "full" || STAGE === "single" || STAGE === "smoke";
  const stageDoesMulti = STAGE === "full" || STAGE === "multi";
  const singleCount = STAGE === "smoke" ? 2 : REPEAT;

  const singleResults = [];
  if (stageDoesSingle) {
    const first = await takeMeasurement({
      client, win32, tab: w0tab, space: w0.spaceId, target: w0Target,
      phase: "single", index: 0, savePng: SAVE_PNG,
    });
    singleResults.push(first);
    check("screenshot[0] fromSurface=true", first.fromSurface === true, measurementDetail(first));
    check("screenshot[0] possiblyStale=false", first.possiblyStale === false, measurementDetail(first));
    check("screenshot[0] PNG marker 与 DOM 帧号一致（±4）", first.markerMatchesDom === true, measurementDetail(first));
    check("screenshot[0] iframe/canvas2d/WebGL 像素命中", first.samples?.iframe?.ok && first.samples?.canvas2d?.ok && first.samples?.webgl?.ok, measurementDetail(first));

    for (let i = 1; i < singleCount; i++) {
      const m = await takeMeasurement({
        client, win32, tab: w0tab, space: w0.spaceId, target: w0Target,
        phase: "single", index: i, savePng: SAVE_PNG,
      });
      singleResults.push(m);
      if (i % 10 === 0 || i === singleCount - 1) {
        console.log("[single] shot " + i + "/" + (singleCount - 1) + " ms=" + m.ms + " fromSurface=" + m.fromSurface + " stale=" + m.possiblyStale + " dom=" + m.domFrame + " png=" + m.pngFrame + " d=" + m.frameDelta);
      }
      if (!measurementOk(m)) {
        check("连续截图第 " + i + " 次全部断言通过", false, measurementDetail(m));
        break; // 后续没有意义；保留首次失败证据
      }
      if (i % 15 === 0 && chrome) {
        let alive = false;
        try { alive = isAlive(chrome.record); } catch {}
        if (!alive) {
          check("连续截图过程中浏览器进程存活", false, "browser exited at shot " + i);
          break;
        }
      }
    }
    report.screenshots.push(...singleResults);
    const allFresh = singleResults.every((m) => measurementOk(m));
    const staleCount = singleResults.filter((m) => m.possiblyStale !== false).length;
    const nonSurface = singleResults.filter((m) => m.fromSurface !== true).length;
    report.stress = {
      requested: singleCount,
      completed: singleResults.length,
      allFresh,
      staleCount,
      nonSurface,
      ms: singleResults.map((m) => m.ms),
      minMs: Math.min(...singleResults.map((m) => m.ms)),
      maxMs: Math.max(...singleResults.map((m) => m.ms)),
      avgMs: Math.round(singleResults.reduce((s, m) => s + m.ms, 0) / Math.max(1, singleResults.length)),
      frameDeltas: singleResults.map((m) => m.frameDelta),
      lastDomFrame: singleResults[singleResults.length - 1]?.domFrame,
      lastPngFrame: singleResults[singleResults.length - 1]?.pngFrame,
    };
    check(
      "连续 " + singleCount + " 次 screenshot 全部 fresh（fromSurface + 非 stale + marker 匹配 + 内容采样）",
      allFresh && singleResults.length === singleCount,
      JSON.stringify({ completed: singleResults.length, requested: singleCount, staleCount, nonSurface, firstFailure: failures.slice(-1)[0] }),
    );

    // 60 次后：浏览器存活 + host/extension 仍可用 + 日志无 FATAL。
    let aliveAfter = false;
    try { aliveAfter = isAlive(chrome.record); } catch {}
    report.stress.browserAlive = aliveAfter;
    check("连续截图后浏览器进程仍存活（PID+创建时间+marker 核验）", aliveAfter === true, JSON.stringify(describeRecord(chrome.record)));

    let hostPingAfter = null;
    let listTabsAfter = null;
    try {
      hostPingAfter = await client.request("ping");
      listTabsAfter = await client.request("list_tabs", {}, { space: w0.spaceId });
    } catch (error) {
      hostPingAfter = { error: error.message };
    }
    report.stress.hostPingAfter = hostPingAfter;
    report.stress.listTabsAfter = listTabsAfter;
    check("连续截图后 host/extension 仍可用（ping + list_tabs）", hostPingAfter?.pong === true && Array.isArray(listTabsAfter?.tabs) && listTabsAfter.tabs.length >= 1, JSON.stringify({ ping: hostPingAfter, tabs: listTabsAfter?.tabs?.map((t) => t.tabId) }));

    // stderr 日志扫描（只读文件；不伪造）。
    let logText = "";
    try { logText = fs.readFileSync(logFile, "utf8"); } catch {}
    const patterns = {
      layerTree554: /layer_tree_view\.cc:554/g,
      fatal: /FATAL/g,
      accessViolation: /0xC0000005/gi,
      checkFailed: /Check failed/gi,
      dcheck: /DCHECK/gi,
      rendererCrash: /Renderer process (crashed|gone|killed)/gi,
      gpuCrash: /GPU process (crashed|gone|killed)/gi,
    };
    const matches = {};
    for (const [key, re] of Object.entries(patterns)) {
      const found = logText.match(re) || [];
      matches[key] = { count: found.length, samples: [] };
      if (found.length) {
        const lines = logText.split(/\r?\n/).filter((line) => re.test(line));
        // 重置 lastIndex（带 g 的正则 test 会推进）
        re.lastIndex = 0;
        matches[key].samples = lines.slice(0, 5).map((line) => line.slice(0, 500));
      }
    }
    const crashSignalCount = matches.rendererCrash.count + matches.gpuCrash.count;
    const fatalCount =
      matches.layerTree554.count + matches.fatal.count + matches.accessViolation.count + matches.checkFailed.count + crashSignalCount;
    let crashDumps = [];
    try {
      crashDumps = fs
        .readdirSync(path.join(profileDir, "Crashpad", "reports"))
        .filter((name) => /\.dmp$/i.test(name));
    } catch {
      crashDumps = [];
    }
    report.browserLog = { file: logFile, bytes: logText.length, patterns: matches, crashSignalCount, crashDumps, fatalCount };
    check(
      "浏览器 stderr 无 layer_tree_view.cc:554 / FATAL / 0xC0000005 / Check failed / renderer crash，且 Crashpad 无 dump",
      fatalCount === 0 && crashDumps.length === 0,
      JSON.stringify(report.browserLog),
    );
  }

  // ------------------------------------------------------------ multi-window concurrent
  if (stageDoesMulti) {
    const w1 = await client.request("open_space", { name: "occl-w1", url: fixture.urlFor(probeId("w1")) });
    const w2 = await client.request("open_space", { name: "occl-w2", url: fixture.urlFor(probeId("w2")) });
    const w1FromTabs = await findTabViaListTabs(client, w1.spaceId, "id=" + probeId("w1"));
    const w2FromTabs = await findTabViaListTabs(client, w2.spaceId, "id=" + probeId("w2"));
    mustCheck("list_tabs 找到 w1/w2 fixture tab", w1FromTabs.tab.tabId === w1.tabId && w2FromTabs.tab.tabId === w2.tabId, JSON.stringify({ open: [w1.tabId, w2.tabId], listed: [w1FromTabs.tab.tabId, w2FromTabs.tab.tabId] }));
    const w1tab = { tabId: w1FromTabs.tab.tabId, windowId: w1FromTabs.tab.windowId, spaceId: w1.spaceId };
    const w2tab = { tabId: w2FromTabs.tab.tabId, windowId: w2FromTabs.tab.windowId, spaceId: w2.spaceId };
    report.spaces.push({ id: "w1", spaceId: w1.spaceId, windowId: w1.windowId, tabId: w1tab.tabId, url: fixture.urlFor(probeId("w1")), resolvedVia: "list_tabs" });
    report.spaces.push({ id: "w2", spaceId: w2.spaceId, windowId: w2.windowId, tabId: w2tab.tabId, url: fixture.urlFor(probeId("w2")), resolvedVia: "list_tabs" });
    await waitForProbeReady(client, w1tab, w1.spaceId, 45000);
    await waitForProbeReady(client, w2tab, w2.spaceId, 45000);
    const hwndW1 = await findWindowByTitle(win32, chrome.record.pid, "occlp-" + probeId("w1"), 45000);
    const hwndW2 = await findWindowByTitle(win32, chrome.record.pid, "occlp-" + probeId("w2"), 45000);
    mustCheck("w1/w2 Chrome 窗口已找到", !!hwndW1 && !!hwndW2, JSON.stringify({ pid: chrome.record.pid, w1: hwndW1?.hwnd, w2: hwndW2?.hwnd }));

    const targets = [
      { id: "w0", hwnd: w0Target.hwnd, tab: w0tab, space: w0.spaceId },
      { id: "w1", hwnd: hwndW1.hwnd, tab: w1tab, space: w1.spaceId },
      { id: "w2", hwnd: hwndW2.hwnd, tab: w2tab, space: w2.spaceId },
    ];
    // 全部移到同一 rect（SWP_NOACTIVATE；Chrome 可能异步套用初始 bounds，settle 后取实际 rect）。
    for (const t of targets) {
      const settled = await moveAndSettle(win32, t.hwnd, targetRect, { raise: true });
      t.rect = settled.rect;
      t.move = settled;
    }
    // 新窗口可能创建在旧 occluder 之上：为每个目标在「实际 rect」上创建新的遮挡窗口，
    // 全部用 HWND_TOP + SWP_NOACTIVATE，确保位于所有 Chrome 窗口之上。
    for (const t of targets) {
      const occ = await win32.call("createOccluder", { x: t.rect[0], y: t.rect[1], width: t.rect[2], height: t.rect[3] });
      occluders.push(occ.hwnd);
      t.occluder = occ.hwnd;
    }
    const fgBeforeMulti = (await win32.call("foreground")).hwnd;
    const multiSetup = [];
    for (const t of targets) {
      const occludedNow = await waitOccluded(client, t.tab, t.space, t, win32, t.occluder, 20000);
      multiSetup.push({ id: t.id, hwnd: t.hwnd, occluder: t.occluder, ...occludedNow });
    }
    report.multiWindow = { targetRect, foregroundBefore: fgBeforeMulti, setup: multiSetup };
    for (const s of multiSetup) {
      check("多窗口 " + s.id + " 遮挡后 hidden 且无焦点", s.probe?.visibilityState === "hidden" && s.probe?.hasFocus === false, JSON.stringify(s.probe).slice(0, 800));
      check("多窗口 " + s.id + " 遮挡窗口覆盖且位于其上", s.z?.occluderAbove === true && s.z?.covers === true, JSON.stringify(s.z));
    }

    // 并发：先并发 bump，再并发 screenshot，最后并发 probe。
    const beforeStates = {};
    for (const t of targets) beforeStates[t.id] = await win32.call("state", { hwnd: t.hwnd });
    const concurrentStart = Date.now();
    await Promise.all(targets.map((t) => jsBump(client, t.tab, t.space, 5)));
    const shots = await Promise.all(
      targets.map(async (t) => {
        const t0 = Date.now();
        const shot = await client.request("screenshot", { tabId: t.tab.tabId, format: "png" }, { space: t.space, timeoutMs: 40000 });
        return { id: t.id, ms: Date.now() - t0, shot };
      }),
    );
    const probes = await Promise.all(targets.map((t) => jsProbe(client, t.tab, t.space)));
    const concurrentMs = Date.now() - concurrentStart;
    const results = [];
    for (let idx = 0; idx < targets.length; idx++) {
      const t = targets[idx];
      const { shot, ms } = shots[idx];
      const probe = probes[idx];
      const buffer = Buffer.from(shot?.base64 || "", "base64");
      const meta = shot?.screenshot || {};
      let png = null;
      let pngError = null;
      try { png = analysePng(buffer, probe); } catch (error) { pngError = error instanceof Error ? error.message : String(error); }
      const after = await win32.call("state", { hwnd: t.hwnd });
      const m = {
        id: t.id,
        tabId: t.tab.tabId,
        space: t.space,
        ms,
        bytes: buffer.length,
        fromSurface: meta.fromSurface === true,
        possiblyStale: shot?.possiblyStale === true || meta.possiblyStale === true,
        reason: shot?.reason ?? meta.reason ?? null,
        domFrame: Number(probe?.rafCount),
        pngFrame: png?.pngFrame ?? null,
        frameDelta: png ? Math.abs(Number(png.pngFrame) - Number(probe?.rafCount)) : null,
        markerMatchesDom: png ? Math.abs(Number(png.pngFrame) - Number(probe?.rafCount)) <= 4 : false,
        probeVisibilityState: probe?.visibilityState ?? null,
        probeHasFocus: probe?.hasFocus ?? null,
        samples: png?.samples ?? null,
        pngError,
        foregroundBefore: beforeStates[t.id].foreground,
        foregroundAfter: after.foreground,
        foregroundStable: beforeStates[t.id].foreground === after.foreground,
        aboveBefore: beforeStates[t.id].window.above,
        aboveAfter: after.window.above,
        zOrderStable: beforeStates[t.id].window.above === after.window.above,
        targetVisible: after.window.visible === true,
        targetIconic: after.window.iconic === true,
      };
      results.push(m);
      const samples = m.samples || {};
      const ok =
        m.bytes > 1000 &&
        m.fromSurface === true &&
        m.possiblyStale === false &&
        m.markerMatchesDom === true &&
        m.probeVisibilityState === "hidden" &&
        m.probeHasFocus === false &&
        m.foregroundStable === true &&
        m.zOrderStable === true &&
        m.targetVisible === true &&
        samples.canvas2d?.ok === true &&
        samples.webgl?.ok === true &&
        samples.iframe?.ok === true;
      check("并发截图 " + m.id + " 全部 fresh/采样/前景/z-order 断言", ok, JSON.stringify(m));
    }
    report.multiWindow.concurrentMs = concurrentMs;
    report.multiWindow.concurrent = results;
    report.multiWindow.allFresh = results.every((r) => r.fromSurface === true && r.possiblyStale === false && r.markerMatchesDom === true);
    report.multiWindow.foregroundStable = results.every((r) => r.foregroundStable === true);
    report.multiWindow.zOrderStable = results.every((r) => r.zOrderStable === true);
    check("3 个并发 screenshot 全部 fresh", report.multiWindow.allFresh === true, JSON.stringify(results.map((r) => ({ id: r.id, fromSurface: r.fromSurface, stale: r.possiblyStale, dom: r.domFrame, png: r.pngFrame, d: r.frameDelta }))));
    check("并发截图前后前台窗口完全不变", report.multiWindow.foregroundStable === true, JSON.stringify(results.map((r) => [r.foregroundBefore, r.foregroundAfter])));
    check("并发截图前后每个窗口 GW_HWNDPREV 完全不变", report.multiWindow.zOrderStable === true, JSON.stringify(results.map((r) => [r.aboveBefore, r.aboveAfter])));
    let aliveMulti = false;
    try { aliveMulti = isAlive(chrome.record); } catch {}
    report.multiWindow.browserAlive = aliveMulti;
    check("多窗口并发后浏览器进程仍存活", aliveMulti === true, JSON.stringify(describeRecord(chrome.record)));
  }

  report.verdict = failed === 0 ? "PASS" : "PARTIAL";
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error("[test] fatal: " + message);
  report.error = message;
  report.blockedReason = error instanceof Error ? error.message : String(error);
  // 进入真实产品链路（host session 已建立）之后出错 = PARTIAL；之前 = BLOCKED。
  report.verdict = report.runtimeStarted ? "PARTIAL" : "BLOCKED";
} finally {
  const cleanup = { at: nowIso() };
  try {
    await stopChromeAndHost(cleanup);
  } catch (error) {
    cleanup.error = error instanceof Error ? error.message : String(error);
  }
  try {
    if (win32.child) {
      await win32.stop();
      cleanup.win32HelperStopped = true;
    }
  } catch (error) {
    cleanup.win32HelperError = error instanceof Error ? error.message : String(error);
  }
  occluders = [];
  try {
    fixture.close();
    cleanup.fixtureServerClosed = true;
  } catch (error) {
    cleanup.fixtureServerError = error instanceof Error ? error.message : String(error);
  }
  // 注册表回滚：先停 Chrome（避免 host 继续使用），再 unregister.ps1 恢复原值。
  try {
    if (registration?.backupFile) {
      const expectedBefore = report.registration?.beforeValue;
      const rollback = runPowerShellFile(UNREGISTER_PS1, ["-BackupFile", registration.backupFile]);
      const afterRollback = registryDefault(REGISTRY_KEY);
      report.registration = {
        ...(report.registration || {}),
        rollback: { status: rollback.status, json: rollback.json, stderrTail: (rollback.stderr || "").slice(-800) },
        afterRollback,
        restored: afterRollback === expectedBefore,
      };
      check("unregister.ps1 恢复注册表到测试前值", afterRollback === expectedBefore, JSON.stringify({ afterRollback, expected: expectedBefore }));
      cleanup.registry = { afterRollback, restored: report.registration.restored };
    } else {
      cleanup.registry = { skipped: "no registration backup" };
    }
  } catch (error) {
    cleanup.registryError = error instanceof Error ? error.message : String(error);
    failed++;
    failures.push("registry rollback failed");
  }
  // 最终残留检查：只核验自己启动的 PID / 自己的 session 目录。
  try {
    if (chrome?.record) {
      let alive = false;
      try { alive = isAlive(chrome.record); } catch { alive = false; }
      cleanup.chromeAliveFinal = alive;
      check("清理后测试 Chrome 进程不存在", alive === false, JSON.stringify(describeRecord(chrome.record)));
    }
    if (hostSession) {
      const alive = pidAlive(hostSession.pid);
      cleanup.hostAliveFinal = alive;
      check("清理后测试 host 进程不存在", alive === false, "pid " + hostSession.pid);
    }
    const liveSessions = readSessions(localAppData).filter((s) => pidAlive(s.pid));
    cleanup.liveSessions = liveSessions.map((s) => ({ pid: s.pid, port: s.port }));
    check("隔离 LOCALAPPDATA 无残留 host session", liveSessions.length === 0, JSON.stringify(liveSessions));
  } catch (error) {
    cleanup.finalCheckError = error instanceof Error ? error.message : String(error);
  }
  if (win32.stderr) cleanup.win32HelperStderr = win32.stderr.slice(-2000);

  report.cleanup = cleanup;
  report.finishedAt = nowIso();
  report.checks = { passed, failed, failures: [...failures], log: checkLog };
  if (report.verdict !== "BLOCKED") {
    report.verdict = failed > 0 || report.error ? "PARTIAL" : "PASS";
  }

  const reportFile = path.join(LOG_DIR, "product-occluded-" + nowIso().replace(/[:.]/g, "-") + ".json");
  try {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
    report.reportFile = reportFile;
    console.log("\nreport -> " + reportFile);
  } catch (error) {
    console.error("[test] report write failed: " + (error instanceof Error ? error.message : String(error)));
  }
  saveArtifact("report.json", report);
  console.log("\n" + passed + "/" + (passed + failed) + " checks passed");
  console.log("VERDICT: " + report.verdict);
  if (failures.length) console.log("failed: " + failures.join("; "));
  process.exit(report.verdict === "PASS" ? 0 : 1);
}
