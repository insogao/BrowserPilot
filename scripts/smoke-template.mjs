import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { acquireBrowserLease, releaseBrowserLease } from "./browser-lease-lib.mjs";
import { ensureSmokeSpace } from "./smoke-space-lib.mjs";

const root = process.cwd();
const rawArgs = process.argv.slice(2);
// 默认后台执行：窗口可见但不抢焦点、不弹到最前；--visible 才把窗口激活到最前（偶尔需要盯着看时用）。
const visible = rawArgs.includes("--visible");
// 默认复用同一个常驻 smoke 窗口（同一窗口内开标签页）；--fresh 跑完关闭该窗口。
const fresh = rawArgs.includes("--fresh");
const ids = rawArgs.filter((arg) => !arg.startsWith("--"));

if (!ids.length) {
  console.error("Usage: npm run smoke:template -- [--visible] [--fresh] <template-id> [template-id...]");
  process.exit(2);
}

function templateDir(id) {
  return path.join(root, "registry", "templates", id);
}

function smokeContractFile(id) {
  const registryContract = path.join(templateDir(id), "tests", "smoke.json");
  if (fs.existsSync(registryContract)) return registryContract;
  return path.join(root, "tests", "site-smoke", id + ".json");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function client(command, args, leaseToken, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(root, "native-host", "client.mjs"),
      command,
      JSON.stringify(args),
      "--no-launch",
    ], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        BROWSERPILOT_BROWSER_LEASE_TOKEN: leaseToken,
        // 稳定 Agent 身份：跨多次 smoke 复用同一 space（同一窗口），不随模板列表变化。
        BROWSERPILOT_AGENT_ID: "smoke-template",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      const tail = stdout.trim().slice(-300);
      resolve({ ok: false, command, args, error: `timeout after ${timeoutMs}ms${tail ? "; last output: " + tail : ""}`, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(stdout); } catch {}
      resolve({
        ok: code === 0 && parsed?.ok === true,
        command,
        args,
        code,
        stdout,
        stderr: parsed ? stderr : (stderr + (stderr ? "\n" : "") + "invalid client JSON output"),
        parsed,
      });
    });
  });
}

function checkExpect(data, expect = {}) {
  const failures = [];
  if (typeof expect.minLinks === "number" && !((data?.links?.length ?? 0) >= expect.minLinks)) {
    failures.push("links.length < minLinks");
  }
  if (typeof expect.minTweets === "number" && !((data?.tweets?.length ?? 0) >= expect.minTweets)) {
    failures.push("tweets.length < minTweets");
  }
  if (typeof expect.minResults === "number" && !((data?.results?.length ?? 0) >= expect.minResults)) {
    failures.push("results.length < minResults");
  }
  if (typeof expect.contains === "string") {
    const text = JSON.stringify(data ?? "");
    if (!text.toLowerCase().includes(expect.contains.toLowerCase())) failures.push("output missing contains");
  }
  if (Array.isArray(expect.requiredResultFields)) {
    const first = data?.results?.[0];
    for (const field of expect.requiredResultFields) {
      const value = first?.[field];
      if (value === undefined || value === null || value === "") {
        failures.push("results[0]." + field + " is missing");
      }
    }
  }
  if (typeof expect.resultUrlIncludes === "string") {
    const url = data?.results?.[0]?.url;
    if (typeof url !== "string" || !url.includes(expect.resultUrlIncludes)) {
      failures.push("results[0].url missing resultUrlIncludes");
    }
  }
  return failures;
}

function tabIdsOf(response) {
  const tabs = response?.parsed?.data?.tabs;
  return Array.isArray(tabs) ? tabs.map((t) => t.tabId).filter((id) => typeof id === "number") : [];
}

const results = [];
let lease;
let smokeSpaceId;
let spaceMode = "unknown";
let fatalError = null;

try {
  lease = acquireBrowserLease("smoke-template", ids.join(","));
  let setupError;
  const setupPing = await client("ping", {}, lease.token, 15_000);
  if (!setupPing.ok) {
    setupError = (setupPing.stderr || setupPing.stdout || "BrowserPilot host unavailable").trim();
  } else {
    try {
      const ensured = await ensureSmokeSpace(
        (command, args, timeoutMs) => client(command, args, lease.token, timeoutMs),
        { visible },
      );
      smokeSpaceId = ensured.spaceId;
      spaceMode = ensured.spaceMode;
    } catch (e) {
      setupError = e instanceof Error ? e.message : String(e);
    }
  }

  for (const id of ids) {
    const dir = templateDir(id);
    const templateFile = path.join(dir, "template.json");
    const smokeFile = smokeContractFile(id);
    const item = { id, status: "pending", commands: [] };
    results.push(item);

    if (setupError) {
      item.status = "blocked";
      item.error = setupError;
      continue;
    }

    if (!fs.existsSync(smokeFile)) {
      item.status = "failed";
      item.error = "missing smoke contract: " + path.relative(root, smokeFile);
      continue;
    }

    // 运行前拿不到标签清单就无法归因本轮新标签：此时继续跑会在结束后无法清理（可能泄漏），
    // 直接中断该模板（blocked），不 install/不 run。
    const before = await client("list_tabs", {}, lease.token, 15_000);
    if (!before.ok) {
      item.status = "blocked";
      item.error = "setup: list_tabs 失败，无法归因标签清单，拒绝运行: " + (before.stderr || before.stdout || "").trim();
      continue;
    }
    const beforeIds = new Set(tabIdsOf(before));
    const closeOpenedTabs = async () => {
      const after = await client("list_tabs", {}, lease.token, 15_000);
      // 收尾清单也失败时无法知道哪些标签是本轮新开的：不关（避免误关常驻 about:blank 导致窗口消失），
      // 但必须如实上报 cleanup_unverified，不能报告 passed。
      if (!after.ok) return { unverified: true, error: (after.stderr || after.stdout || "list_tabs failed").trim() };
      const opened = tabIdsOf(after).filter((tabId) => !beforeIds.has(tabId));
      const failedCloses = [];
      for (const tabId of opened) {
        const closed = await client("close_tab", { tabId }, lease.token, 15_000);
        if (!closed.ok) failedCloses.push(tabId);
      }
      item.tabsOpened = opened.length;
      if (failedCloses.length) return { unverified: true, error: "close_tab 失败: " + failedCloses.join(",") };
      return { unverified: false, tabs: opened.length };
    };

    const isRuntimePackage = fs.existsSync(templateFile);
    const installCommand = isRuntimePackage ? "install_template" : "import_template";
    const installArgs = isRuntimePackage
      ? { content: fs.readFileSync(templateFile, "utf8") }
      : { id };
    const install = await client(installCommand, installArgs, lease.token, 30_000);
    item.commands.push({ command: installCommand, ok: install.ok, error: install.stderr.trim() || undefined });
    if (!install.ok) {
      item.status = "failed";
      item.error = (install.stderr || install.stdout || installCommand + " failed").trim();
      const cleanup = await closeOpenedTabs();
      if (cleanup.unverified) item.error += "; cleanup_unverified: " + cleanup.error;
      continue;
    }

    const smoke = readJson(smokeFile);
    const runArgs = smoke.args ?? { id, params: smoke.params ?? {} };
    // 与 client.mjs 内部的 run_template 10 分钟上限对齐：聊天类模板的流式等待可超过 3 分钟，
    // 外层先杀会让 Adapter 拿不到真实失败现场（只剩 "timeout"）。
    const run = await client("run_template", runArgs, lease.token, 600_000);
    item.commands.push({ command: "run_template", ok: run.ok, error: run.stderr.trim() || undefined });
    const cleanup = await closeOpenedTabs();
    if (!run.ok) {
      item.status = "failed";
      item.error = (run.stderr || run.stdout || "run_template failed").trim();
      if (cleanup.unverified) item.error += "; cleanup_unverified: " + cleanup.error;
      continue;
    }
    if (cleanup.unverified) {
      item.status = "failed";
      item.error = "cleanup_unverified: " + cleanup.error;
      continue;
    }
    const rawData = run.parsed?.data;
    const data = rawData && typeof rawData === "object" && "value" in rawData ? rawData.value : rawData;
    const failures = checkExpect(data, smoke.expect ?? {});
    if (failures.length) {
      item.status = "failed";
      item.error = failures.join("; ");
      item.data = data;
      continue;
    }
    item.status = "passed";
    item.data = data;
  }
} catch (error) {
  fatalError = error instanceof Error ? error.message : String(error);
  console.error(fatalError);
} finally {
  // 默认保留 smoke 窗口供下次复用（同一窗口开标签页）；--fresh 才关闭。
  if (lease && smokeSpaceId && fresh) {
    await client("complete_space", { spaceId: smokeSpaceId, keep: false }, lease.token, 30_000).catch(() => undefined);
  }
  if (lease) releaseBrowserLease(lease.token);
}

const allPassed = !fatalError && results.every((r) => r.status === "passed");
console.log(JSON.stringify({ ok: allPassed, fatalError: fatalError ?? undefined, spaceId: smokeSpaceId, spaceMode, results }, null, 2));
process.exitCode = allPassed ? 0 : 1;
