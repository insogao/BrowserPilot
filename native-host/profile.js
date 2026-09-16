// profile 探测：host 是浏览器的子进程 → 上溯父进程链读取浏览器命令行。
// Windows 用 PowerShell/WMI；macOS/Linux 用 ps。参考技术路径 §4.2。
import { execFileSync } from "node:child_process";
import fs from "node:fs";

function queryProcesses() {
  try {
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// macOS/Linux：ps 一次拉全量进程表，字段对齐 WMI 的结构（ProcessId/ParentProcessId/CommandLine）。
function queryProcessesPosix() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return out
      .split("\n")
      .map((line) => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        return m ? { ProcessId: Number(m[1]), ParentProcessId: Number(m[2]), CommandLine: m[3] } : undefined;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// marker 按“更具体优先”排序：Google Chrome for Testing 必须排在 Google Chrome 之前。
const POSIX_BROWSERS = [
  ["Google Chrome for Testing", "chrome"],
  ["Google Chrome", "chrome"],
  ["Chromium", "chromium"],
  ["Microsoft Edge", "edge"],
  ["Brave Browser", "brave"],
];

export function argValue(cmd, flag) {
  // 支持 --flag="value with spaces"、"--flag=value with spaces"（整参数带引号，到闭引号截止）
  // 与 --flag=value（无引号）。无引号值面向 ps 这类把 argv 摊平成一行、丢失参数边界的
  // 命令文本：允许值内嵌空格，到下一个旗标 token（空白 + -/-- + 旗标名 + =/空白/行尾）
  // 或行尾截止，不吞后续旗标，也不在普通路径文本处提前截断。旗标前要求行首或空白，
  // 避免前导/内嵌误匹配。
  const name = flag.replace(/^-*/, "").replace(/=$/, "");
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextFlag = "\\s+-{1,2}[A-Za-z][A-Za-z0-9_-]*(?:=|\\s|$)";
  const re = new RegExp(
    "(?:^|\\s)(?:\"-{1,2}" + safe + "=([^\"]*)\"|-{1,2}" + safe + "=(?:\"([^\"]*)\"|([\\s\\S]*?)(?=" + nextFlag + "|\\s*$)))",
    "i",
  );
  const m = cmd.match(re);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

export function exeFromCmd(cmd) {
  const m = cmd.match(/([a-zA-Z]:[\s\S]*?\.(?:exe|cmd|bat))/i);
  return m ? m[1] : undefined;
}

export function browserFromCmd(cmd) {
  if (/chrome\.exe/i.test(cmd)) return "chrome";
  if (/msedge\.exe/i.test(cmd)) return "edge";
  if (/brave\.exe/i.test(cmd)) return "brave";
  return undefined;
}

// 以下两个导出供 test-profile.mjs 做解析用例（不伪造进程；.app fixture 仅用于存在性检查）。
export function posixBrowserFromCmd(cmd) {
  for (const [marker, browser] of POSIX_BROWSERS) {
    if (cmd.includes(marker)) return browser;
  }
  return undefined;
}

/** mac 浏览器二进制路径含空格（…/Google Chrome.app/Contents/MacOS/Google Chrome），
 *  不能按空格切分，也不能按旗标位置截断（旗标前可能有位置参数）；用浏览器名 marker 定位：
 *  从每处 marker 出现点截前缀，要求形如 .app/Contents/MacOS/ 且真实存在
 *  （.app 目录名本身也含 marker，会因前缀不含 MacOS/ 或不存在而自动跳到下一处）。
 *  同族可能有多个 marker（Google Chrome for Testing / Google Chrome），按具体优先逐个尝试。 */
export function posixExeFromCmd(cmd) {
  const browser = posixBrowserFromCmd(cmd);
  if (!browser) return undefined;
  for (const [marker] of POSIX_BROWSERS.filter(([, b]) => b === browser)) {
    let from = 0;
    for (;;) {
      const at = cmd.indexOf(marker, from);
      if (at < 0) break;
      const bin = cmd.slice(0, at + marker.length);
      if (bin.startsWith("/") && bin.includes(".app/Contents/MacOS/") && fs.existsSync(bin)) return bin;
      from = at + 1;
    }
  }
  return undefined;
}

export function detectProfile() {
  const override = process.env.BROWSERPILOT_PROFILE_OVERRIDE;
  if (override) {
    // 测试注入：JSON {browser,userDataDir,profileDir,chromeExe}
    try {
      const o = JSON.parse(override);
      return { ok: true, ...o, detail: "override" };
    } catch {
      return { ok: false, detail: "bad override" };
    }
  }

  const isWin = process.platform === "win32";
  const procs = isWin ? queryProcesses() : queryProcessesPosix();
  const byId = new Map(procs.map((p) => [p.ProcessId, p]));

  let pid = process.ppid;
  for (let hop = 0; hop < 10 && pid > 0; hop++) {
    const p = byId.get(pid);
    if (!p) break;
    const cmd = p.CommandLine || "";
    const browser = isWin ? browserFromCmd(cmd) : posixBrowserFromCmd(cmd);
    const userDataDir = argValue(cmd, "--user-data-dir=");
    const profileDir = argValue(cmd, "--profile-directory=");
    const exe = isWin ? exeFromCmd(cmd) : posixExeFromCmd(cmd);
    if (browser && (userDataDir || profileDir)) {
      return {
        ok: true,
        browser,
        userDataDir,
        profileDir: profileDir || "Default",
        chromeExe: exe,
        detail: "from-ancestor",
      };
    }
    // 浏览器主进程不带 user-data-dir（常规从 Dock/开始菜单启动）也识别为浏览器实例
    if (browser && !userDataDir) {
      return { ok: true, browser, profileDir: profileDir || "Default", chromeExe: exe, detail: "browser-ancestor-no-udd" };
    }
    pid = p.ParentProcessId;
  }

  return { ok: false, detail: "no chrome ancestor found" };
}
