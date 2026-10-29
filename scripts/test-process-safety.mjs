// 防误杀安全测试（P0，2026-10-28）。
//
// 背景：测试诊断曾执行按镜像名的全局清理，可能误杀用户自己的 Chrome。
// 本测试用真实进程证明“验证式清理”只会杀掉自己启动的那一棵进程树：
//
//   1. 用基线 Chrome 启动两个 headless 实例（独立临时 --user-data-dir）：
//      “测试目标”和“控制进程”；
//   2. stopTestProcess(target) 后断言：目标及其子树消失，控制进程仍然存活；
//   3. 用伪造/过期 record（PID 指向控制进程，但创建时间 / marker / 可执行路径不匹配）
//      调用 stopTestProcess，断言全部被拒绝，控制进程仍然存活；
//   4. 最后清理控制进程，断言两者都不存在，且没有残留的本次 profile 进程。
//
// 不使用 --no-sandbox，不弹窗口，不碰用户真实 Chrome/profile，不做任何按镜像名清理。
//
// 运行：node scripts/test-process-safety.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  describeRecord,
  isAlive,
  launchTestProcess,
  stopTestProcess,
} from "./lib/test-process.mjs";

const BASELINE_CHROME =
  process.env.BROWSERPILOT_BASELINE_CHROME || "D:\\work\\wt\\browser-cli-baseline\\chrome.exe";
const STARTUP_TIMEOUT_MS = 60_000;

const evidence = {
  startedAt: new Date().toISOString(),
  browser: BASELINE_CHROME,
  target: null,
  control: null,
  stopTarget: null,
  forged: [],
  controlAliveAfterForged: null,
  stopControl: null,
  residualProcesses: null,
  checks: [],
};
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log("PASS | " + name);
  } else {
    failures++;
    console.log("FAIL | " + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail)));
  }
  evidence.checks.push({ name, ok: Boolean(condition), detail });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeArgs(profileDir) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--in-process-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--mute-audio",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "about:blank",
  ];
}

async function waitForDevTools(profileDir, label, timeoutMs) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return text.split(/\r?\n/)[0];
    }
    await sleep(200);
  }
  throw new Error(label + ": " + timeoutMs + "ms 内未生成 DevToolsActivePort");
}

/** 只读扫描：命令行里含本次临时根目录的进程（用于证明无残留）。 */
function residualProcesses(tempRoot) {
  const script =
    "$ErrorActionPreference = 'Stop'\n" +
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and " +
    "$_.Name -ne 'powershell.exe' -and $_.Name -ne 'pwsh.exe' -and " +
    "$_.CommandLine.Contains('" +
    tempRoot.replace(/'/g, "''") +
    "') } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  const text = (result.stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function waitForNoResidual(tempRoot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = residualProcesses(tempRoot);
    if (last.length === 0) return { residual: [], waitedMs: timeoutMs - (deadline - Date.now()) };
    await sleep(400);
  }
  return { residual: last, waitedMs: timeoutMs };
}

/** 只用于本测试自己 spawn 的直接子进程：句柄级兜底，不会命中其它进程。 */
function scopedHandleFallback(record) {
  if (!record?.child) return false;
  try {
    if (record.child.exitCode === null) {
      record.child.kill();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function forgedRecord(controlRecord, overrides) {
  return { ...controlRecord, ...overrides };
}

async function main() {
  if (!fs.existsSync(BASELINE_CHROME)) {
    console.error("找不到基线 Chrome: " + BASELINE_CHROME + "（可用 BROWSERPILOT_BASELINE_CHROME 覆盖）");
    process.exit(2);
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bp-process-safety-"));
  const targetProfile = path.join(tempRoot, "target-profile");
  const controlProfile = path.join(tempRoot, "control-profile");
  fs.mkdirSync(targetProfile, { recursive: true });
  fs.mkdirSync(controlProfile, { recursive: true });
  evidence.tempRoot = tempRoot;

  let target;
  let control;
  try {
    target = launchTestProcess({
      exe: BASELINE_CHROME,
      args: chromeArgs(targetProfile),
      marker: targetProfile,
      label: "safety-target",
    });
    control = launchTestProcess({
      exe: BASELINE_CHROME,
      args: chromeArgs(controlProfile),
      marker: controlProfile,
      label: "safety-control",
    });
    evidence.target = describeRecord(target);
    evidence.control = describeRecord(control);

    const targetPort = await waitForDevTools(targetProfile, "target", STARTUP_TIMEOUT_MS);
    const controlPort = await waitForDevTools(controlProfile, "control", STARTUP_TIMEOUT_MS);
    evidence.target.devtoolsPort = Number(targetPort);
    evidence.control.devtoolsPort = Number(controlPort);

    check("目标 Chrome 已启动且身份完整", Boolean(target.creationTime && target.marker && target.exePath));
    check("控制 Chrome 已启动且身份完整", Boolean(control.creationTime && control.marker && control.exePath));
    check("目标与控制是不同进程", target.pid !== control.pid, { target: target.pid, control: control.pid });
    check("目标存活", isAlive(target), target.pid);
    check("控制存活", isAlive(control), control.pid);

    // ---- 1) 只清理目标，控制必须存活 ------------------------------------
    const stopTarget = stopTestProcess(target, { reason: "safety-test.target" });
    evidence.stopTarget = stopTarget;
    check("stopTestProcess 清理目标成功", stopTarget.stopped === true, stopTarget);
    check("目标身份已消失", !isAlive(target), target.pid);
    check("控制进程在目标清理后仍存活", isAlive(control), control.pid);

    // ---- 2) 伪造/过期 record 必须被拒绝 ---------------------------------
    const forgedCases = [
      {
        name: "创建时间不匹配（过期 PID 回收场景）",
        record: forgedRecord(control, { creationTime: target.creationTime }),
        expectedMismatch: "creation-time",
      },
      {
        name: "marker 不匹配（命令行不含本次 marker）",
        record: forgedRecord(control, { marker: "forged-marker-" + Date.now() + "-not-in-cmdline" }),
        expectedMismatch: "marker",
      },
      {
        name: "可执行路径不匹配（PID 指向别的程序）",
        record: forgedRecord(control, {
          expectedExe: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe"),
        }),
        expectedMismatch: "exe-path",
      },
    ];

    for (const forged of forgedCases) {
      const result = stopTestProcess(forged.record, { reason: "safety-test.forged" });
      const mismatches = result?.detail?.mismatches || [];
      evidence.forged.push({
        name: forged.name,
        pid: forged.record.pid,
        refused: result.refused === true,
        stopped: result.stopped === true,
        mismatches,
      });
      check(
        "拒绝清理伪造 record：" + forged.name,
        result.refused === true && result.stopped === false && mismatches.includes(forged.expectedMismatch),
        { result, expectedMismatch: forged.expectedMismatch },
      );
      check(
        "控制进程在伪造清理被拒后仍存活：" + forged.name,
        isAlive(control),
        control.pid,
      );
    }
    evidence.controlAliveAfterForged = isAlive(control);
    check("控制进程在所有伪造清理尝试后仍存活", evidence.controlAliveAfterForged === true, control.pid);

    // ---- 3) 清理控制进程 -------------------------------------------------
    const stopControl = stopTestProcess(control, { reason: "safety-test.control" });
    evidence.stopControl = stopControl;
    check("stopTestProcess 清理控制进程成功", stopControl.stopped === true, stopControl);
    check("控制进程身份已消失", !isAlive(control), control.pid);
    check("目标与控制都不再存在", !isAlive(target) && !isAlive(control), {
      target: target.pid,
      control: control.pid,
    });

    await sleep(800);
    const residual = await waitForNoResidual(tempRoot, 15_000);
    evidence.residualProcesses = residual.residual;
    evidence.residualWaitMs = residual.waitedMs;
    check(
      "没有残留的本次 profile 进程",
      residual.residual.length === 0,
      residual.residual,
    );
  } finally {
    // 兜底：只有身份核验通过的 record 才会被清理；句柄兜底只作用于本测试 spawn 的子进程。
    for (const record of [target, control]) {
      if (!record) continue;
      try {
        if (isAlive(record)) {
          const result = stopTestProcess(record, { reason: "safety-test.cleanup" });
          if (!result.stopped) {
            console.error(
              "[safety] cleanup refused for " + record.label + " pid=" + record.pid +
                " reason=" + result.reason + " -> scoped child-handle fallback",
            );
            evidence[record.label === "safety-target" ? "cleanupFallbackTarget" : "cleanupFallbackControl"] =
              scopedHandleFallback(record);
          }
        }
      } catch (error) {
        console.error("[safety] cleanup error for " + record.label + ": " + error.message);
        scopedHandleFallback(record);
      }
    }
    await sleep(500);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold a file; the OS cleans TEMP eventually */
    }
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.failed = failures;
  console.log("\n--- evidence ---");
  console.log(JSON.stringify(evidence, null, 2));
  console.log("\nPROCESS-SAFETY %s (%d failure(s))", failures === 0 ? "PASS" : "FAIL", failures);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("FAIL | unexpected exception :: " + (error instanceof Error ? error.stack : String(error)));
  process.exit(1);
});
