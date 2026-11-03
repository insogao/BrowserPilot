// 测试进程的“验证式”启动与清理（Windows）。
//
// 背景：测试脚本曾经用 `taskkill /PID <pid> /T /F`，或更糟的按镜像名清理。
// 按 PID 清理在 PID 被回收时会杀错进程；按镜像名清理会杀掉用户自己的浏览器。
//
// 本模块的规则：
//   1. 启动时记录进程身份：PID、创建时间、可执行文件路径、完整命令行、唯一 marker；
//   2. 清理前重新查询该 PID，逐项核验 PID + 创建时间 + 命令行含 marker + 可执行路径；
//   3. 任何一项不匹配 -> 拒绝清理并记录，绝不回退到全局 kill；
//   4. 只对核验通过的 PID 执行 `taskkill /PID <pid> /T /F`（只按 PID，绝不按镜像名）。
//
// marker 的来源：调用方显式传入，或自动取 `--user-data-dir=<唯一临时目录>` 的值。
// 临时目录名必须唯一（mkdtemp / randomUUID），这样命令行核验才真正有区分度。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class ProcessSafetyError extends Error {}

const IS_WIN = process.platform === "win32";
const POWERSHELL = "powershell.exe";
const MIN_MARKER_LENGTH = 8;

// 同步 sleep（清理逻辑保持同步，便于在 finally 里直接调用）。
function sleepSync(milliseconds) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(0, milliseconds));
}

function normalizePath(value) {
  if (!value) return "";
  try {
    return path.resolve(String(value)).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function includesMarker(commandLine, marker) {
  if (!commandLine || !marker) return false;
  return commandLine.toLowerCase().includes(String(marker).toLowerCase());
}

function sameCreationTime(left, right) {
  if (!left || !right) return false;
  // WMI CreationDate is a fixed FILETIME; two queries of the same process
  // return the identical round-trip string. Exact equality is what makes a
  // recycled PID detectable -- a tolerance window would let a fresh process
  // started moments later pass as the original.
  return String(left).trim() === String(right).trim();
}

function runPowerShell(script, timeoutMs = 30000) {
  const result = spawnSync(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) {
    throw new ProcessSafetyError("PowerShell 进程查询失败: " + result.error.message);
  }
  const stdout = result.stdout || "";
  if (result.status !== 0 && !stdout.trim()) {
    // 查询失败必须与“进程不存在”区分开：否则会把一次 WMI 故障当成已退出。
    throw new ProcessSafetyError(
      "PowerShell 进程查询失败 (exit=" + result.status + "): " +
        String(result.stderr || "").trim().slice(0, 300),
    );
  }
  return stdout;
}

/**
 * 只读查询一个 PID 的当前身份。进程不存在时返回 undefined。
 * 查询失败会抛错（fail closed），不会把“查不到”当成“已退出”。
 */
export function queryProcess(pid) {
  if (!IS_WIN) return undefined;
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = " + id + "\" -ErrorAction SilentlyContinue",
    "if ($p) {",
    "  [pscustomobject]@{",
    "    pid = [int]$p.ProcessId",
    "    creationTime = $p.CreationDate.ToUniversalTime().ToString('o')",
    "    exe = $p.ExecutablePath",
    "    commandLine = $p.CommandLine",
    "  } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
  const text = runPowerShell(script).trim();
  if (!text) return undefined;
  const line = text.split(/\r?\n/).filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProcessSafetyError("无法解析进程查询结果: " + line.slice(0, 200));
  }
  if (!parsed || Number(parsed.pid) !== id) return undefined;
  return {
    pid: id,
    creationTime: typeof parsed.creationTime === "string" ? parsed.creationTime : "",
    exePath: typeof parsed.exe === "string" ? parsed.exe : "",
    commandLine: typeof parsed.commandLine === "string" ? parsed.commandLine : "",
  };
}

function deriveMarker(args) {
  for (const arg of args) {
    const text = String(arg);
    if (text.toLowerCase().startsWith("--user-data-dir=")) {
      const value = text.slice("--user-data-dir=".length).trim();
      if (value) return value;
    }
  }
  return "";
}

function rawAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!rawAlive(pid)) return true;
    sleepSync(120);
  }
  return !rawAlive(pid);
}

/**
 * 启动一个测试进程并记录其身份。
 *
 * @param {object} options
 * @param {string} options.exe        可执行文件绝对/相对路径
 * @param {string[]} [options.args]   参数（必须包含唯一 marker，通常是 --user-data-dir）
 * @param {object} [options.env]
 * @param {string} [options.marker]   显式 marker；缺省取 --user-data-dir= 的值
 * @param {string} [options.label]    日志/证据里的标签
 * @param {string[]} [options.stdio]
 * @returns {object} record（含 pid / marker / creationTime / commandLine / child）
 */
export function launchTestProcess({
  exe,
  args = [],
  env,
  marker,
  label = "test-process",
  stdio = ["ignore", "pipe", "pipe"],
  cwd,
  identityTimeoutMs = 15000,
} = {}) {
  if (!IS_WIN) {
    throw new ProcessSafetyError("launchTestProcess 仅支持 Windows（需要 WMI 身份核验）");
  }
  if (!exe) throw new ProcessSafetyError("launchTestProcess 需要 exe");
  const exePath = path.resolve(exe);
  if (!fs.existsSync(exePath)) {
    throw new ProcessSafetyError("可执行文件不存在: " + exePath);
  }
  const resolvedMarker = String(marker || deriveMarker(args) || "");
  if (resolvedMarker.length < MIN_MARKER_LENGTH) {
    throw new ProcessSafetyError(
      "缺少唯一 marker（>= " + MIN_MARKER_LENGTH + " 字符）：请传入 marker，" +
        "或在参数里使用唯一的 --user-data-dir=<mkdtemp/randomUUID 目录>",
    );
  }

  const child = spawn(exePath, args, {
    cwd,
    env,
    stdio,
    windowsHide: true,
  });
  if (!child.pid) {
    throw new ProcessSafetyError("spawn 未返回 PID: " + exePath);
  }

  const record = {
    pid: child.pid,
    marker: resolvedMarker,
    expectedExe: exePath,
    exePath,
    commandLine: "",
    creationTime: "",
    child,
    label,
    launchedAt: new Date().toISOString(),
  };

  // 非 Windows：没有 WMI 身份查询；保留原来的 ChildProcess 句柄语义
  // （macOS 浏览器测试仍可用）。Windows 才是本安全整改的强制范围。
  if (!IS_WIN) {
    record.commandLine = [exePath, ...args].join(" ");
    return record;
  }

  try {
    const deadline = Date.now() + identityTimeoutMs;
    let identity;
    while (Date.now() < deadline) {
      identity = queryProcess(child.pid);
      if (identity) break;
      // Do not read child.exitCode here: the identity loop blocks the event
      // loop (Atomics.wait), so Node may not have processed the 'exit' event.
      // A direct liveness syscall is authoritative.
      if (!rawAlive(child.pid)) {
        throw new ProcessSafetyError(
          label + ": 进程在记录身份前已退出 (PID " + child.pid + ")",
        );
      }
      sleepSync(150);
    }
    if (!identity) {
      throw new ProcessSafetyError(
        label + ": " + identityTimeoutMs + "ms 内无法查询 PID " + child.pid + " 的身份",
      );
    }
    if (!includesMarker(identity.commandLine, resolvedMarker)) {
      throw new ProcessSafetyError(
        label + ": 命令行不含 marker，拒绝继续（PID " + child.pid + "）",
      );
    }
    if (normalizePath(identity.exePath) !== normalizePath(exePath)) {
      throw new ProcessSafetyError(
        label + ": 可执行路径不匹配，拒绝继续: " + identity.exePath + " != " + exePath,
      );
    }
    record.exePath = identity.exePath;
    record.commandLine = identity.commandLine;
    record.creationTime = identity.creationTime;
    return record;
  } catch (error) {
    // 这是本进程刚刚 spawn 的直接子进程：用 ChildProcess 句柄终止，
    // 不依赖 PID，也不涉及任何其它进程。
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function identityMismatches(record, current) {
  const mismatches = [];
  if (record.creationTime && !sameCreationTime(current.creationTime, record.creationTime)) {
    mismatches.push("creation-time");
  }
  if (record.marker && !includesMarker(current.commandLine, record.marker)) {
    mismatches.push("marker");
  }
  if (record.expectedExe && normalizePath(current.exePath) !== normalizePath(record.expectedExe)) {
    mismatches.push("exe-path");
  }
  return mismatches;
}

function hasIdentity(record) {
  return Boolean(record?.creationTime || record?.marker || record?.expectedExe);
}

function killVerifiedPid(pid, timeoutMs) {
  if (IS_WIN) {
    const command = "taskkill /PID " + pid + " /T /F";
    const result = spawnSync(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore", timeout: 20000 },
    );
    const gone = waitForPidGone(pid, timeoutMs);
    return {
      ok: gone,
      command,
      status: result.status,
      error: result.error ? String(result.error.message) : undefined,
    };
  }
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {
    /* already gone */
  }
  if (waitForPidGone(pid, Math.min(timeoutMs, 5000))) {
    return { ok: true, command: "SIGTERM " + pid };
  }
  try {
    process.kill(Number(pid), "SIGKILL");
  } catch {
    /* already gone */
  }
  return { ok: waitForPidGone(pid, timeoutMs), command: "SIGKILL " + pid };
}

/**
 * 非 Windows：只通过本进程 spawn 的 ChildProcess 句柄清理（与原行为一致）。
 * 没有句柄就拒绝——不按裸 PID 猜。
 */
function stopPosixRecord(record, timeoutMs, reason, refuse) {
  const child = record.child;
  if (!child) {
    return refuse("no-child-handle", { pid: record.pid });
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return { stopped: false, refused: false, pid: record.pid, reason: "already-exited", label: record.label };
  }
  try {
    child.kill("SIGTERM");
  } catch (error) {
    return refuse("kill-failed", { pid: record.pid, error: error instanceof Error ? error.message : String(error) });
  }
  if (waitForExit(record, Math.min(timeoutMs, 5000))) {
    return { stopped: true, refused: false, pid: record.pid, label: record.label, reason, command: "SIGTERM" };
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  const gone = waitForExit(record, timeoutMs);
  return {
    stopped: gone,
    refused: false,
    pid: record.pid,
    label: record.label,
    reason: gone ? reason : "kill-failed",
    command: "SIGKILL",
  };
}

/**
 * 核验后清理测试进程。任一身份项不匹配即拒绝，返回 refused:true。
 * 绝不按镜像名清理，也没有全局 kill 回退。
 */
export function stopTestProcess(record, { timeoutMs = 20000, reason = "stopTestProcess" } = {}) {
  const refuse = (why, detail) => {
    const result = {
      stopped: false,
      refused: true,
      pid: record?.pid,
      label: record?.label,
      reason: why,
      detail,
      at: new Date().toISOString(),
    };
    console.error("[test-process] REFUSE stop pid=" + record?.pid + " label=" + (record?.label ?? "") +
      " reason=" + why + " detail=" + JSON.stringify(detail));
    return result;
  };

  if (!record || !record.pid) {
    return { stopped: false, refused: false, reason: "no-pid" };
  }
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 4) {
    return refuse("unsafe-pid", { pid });
  }
  if (pid === process.pid) {
    return refuse("self-pid", { pid });
  }
  if (!hasIdentity(record)) {
    return refuse("no-identity-fields", { pid });
  }

  if (!IS_WIN) {
    return stopPosixRecord(record, timeoutMs, reason, refuse);
  }

  let current;
  try {
    current = queryProcess(pid);
  } catch (error) {
    // 查询失败时拒绝清理（不回退到全局 kill，也不假装进程已退出）。
    return refuse("identity-query-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!current) {
    return { stopped: false, refused: false, pid, reason: "already-exited", label: record.label };
  }

  const mismatches = identityMismatches(record, current);
  if (mismatches.length > 0) {
    return refuse("identity-mismatch", {
      mismatches,
      actual: {
        creationTime: current.creationTime,
        exePath: current.exePath,
        commandLine: current.commandLine.slice(0, 300),
      },
      expected: {
        creationTime: record.creationTime,
        exePath: record.expectedExe || record.exePath,
        marker: record.marker,
      },
    });
  }

  const kill = killVerifiedPid(pid, timeoutMs);
  return {
    stopped: kill.ok,
    refused: false,
    pid,
    label: record.label,
    reason: kill.ok ? reason : "kill-failed",
    verified: {
      creationTime: current.creationTime,
      exePath: current.exePath,
      marker: record.marker,
    },
    command: kill.command,
    status: kill.status,
    error: kill.error,
  };
}

/**
 * 核验单个 PID 后清理（用于 native host 等“不是本进程 spawn”的场景）。
 * 必须至少给一个身份字段：expectedExePath / commandLineIncludes / creationTime。
 */
export function stopVerifiedPid({
  pid,
  expectedExePath,
  commandLineIncludes,
  creationTime,
  reason = "stopVerifiedPid",
  timeoutMs = 20000,
} = {}) {
  if (!expectedExePath && !commandLineIncludes && !creationTime) {
    throw new ProcessSafetyError("stopVerifiedPid 需要至少一个身份字段（exe 路径 / 命令行片段 / 创建时间）");
  }
  if (!IS_WIN) {
    // 没有 WMI 查询就无法再次核验身份；拒绝比按裸 PID 猜更安全。
    console.error("[test-process] REFUSE stop pid=" + pid + " reason=identity-verification-unavailable");
    return {
      stopped: false,
      refused: true,
      pid,
      reason: "identity-verification-unavailable-on-this-platform",
    };
  }
  const record = {
    pid,
    expectedExe: expectedExePath,
    marker: commandLineIncludes,
    creationTime,
    label: reason,
  };
  return stopTestProcess(record, { timeoutMs, reason });
}

/** 身份一致的进程是否仍存活（PID 被回收时返回 false）。 */
export function isAlive(record) {
  if (!record?.pid) return false;
  if (!IS_WIN) {
    if (record.child) {
      return record.child.exitCode === null && record.child.signalCode === null;
    }
    return rawAlive(record.pid);
  }
  if (!hasIdentity(record)) {
    throw new ProcessSafetyError("isAlive 需要至少一个身份字段，无法判断 PID " + record.pid + " 是否仍是同一进程");
  }
  const current = queryProcess(record.pid);
  if (!current) return false;
  return identityMismatches(record, current).length === 0;
}

/** 等待身份一致的进程退出；返回是否已退出。 */
export function waitForExit(record, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(record)) return true;
    sleepSync(150);
  }
  return !isAlive(record);
}

/** 证据用摘要（不含 ChildProcess 对象）。 */
export function describeRecord(record) {
  if (!record) return null;
  return {
    pid: record.pid,
    label: record.label,
    marker: record.marker,
    creationTime: record.creationTime,
    exePath: record.exePath || record.expectedExe,
    commandLine: (record.commandLine || "").slice(0, 500),
    launchedAt: record.launchedAt,
  };
}
