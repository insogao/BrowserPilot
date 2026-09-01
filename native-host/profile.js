// profile 探测：host 是 Chrome 的子进程 → 上溯父进程链读取 chrome.exe 命令行。
// 参考技术路径 §4.2。Windows 下用 PowerShell/WMI 拿 CommandLine。
import { execFileSync } from "node:child_process";

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

export function argValue(cmd, flag) {
  // 匹配 --flag="value" 或 --flag=value；flag 含尾随 '='
  const re = new RegExp("-{1,2}" + flag.replace(/^-*/, "") + "\"?([^\"]*)\"?", "i");
  const m = cmd.match(re);
  return m ? m[1] : undefined;
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

  const procs = queryProcesses();
  const byId = new Map(procs.map((p) => [p.ProcessId, p]));

  let pid = process.ppid;
  for (let hop = 0; hop < 10 && pid > 0; hop++) {
    const p = byId.get(pid);
    if (!p) break;
    const cmd = p.CommandLine || "";
    const browser = browserFromCmd(cmd);
    const userDataDir = argValue(cmd, "--user-data-dir=");
    const profileDir = argValue(cmd, "--profile-directory=");
    if (browser && (userDataDir || profileDir)) {
      return {
        ok: true,
        browser,
        userDataDir,
        profileDir: profileDir || "Default",
        chromeExe: exeFromCmd(cmd),
        detail: "from-ancestor",
      };
    }
    // chrome.exe 进程不在 user-data-dir 里也识别为浏览器实例
    if (browser && !userDataDir) {
      return { ok: true, browser, profileDir: profileDir || "Default", chromeExe: exeFromCmd(cmd), detail: "browser-ancestor-no-udd" };
    }
    pid = p.ParentProcessId;
  }

  return { ok: false, detail: "no chrome ancestor found" };
}
