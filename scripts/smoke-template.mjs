import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { acquireBrowserLease, releaseBrowserLease } from "./browser-lease-lib.mjs";

const root = process.cwd();
const ids = process.argv.slice(2);

if (!ids.length) {
  console.error("Usage: npm run smoke:template -- <template-id> [template-id...]");
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
        BROWSERPILOT_AGENT_ID: ("smoke-template:" + ids.join(".")).slice(0, 80),
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

const results = [];
let lease;
let smokeSpaceId;

try {
  lease = acquireBrowserLease("smoke-template", ids.join(","));
  let setupError;
  const setupPing = await client("ping", {}, lease.token, 15_000);
  if (!setupPing.ok) {
    setupError = (setupPing.stderr || setupPing.stdout || "BrowserPilot host unavailable").trim();
  } else {
    const opened = await client("open_space", { name: "Smoke: " + ids.join(", "), url: "about:blank", state: "maximized" }, lease.token, 30_000);
    if (opened.ok && typeof opened.parsed?.data?.spaceId === "string") {
      smokeSpaceId = opened.parsed.data.spaceId;
    } else {
      setupError = (opened.stderr || opened.stdout || "open_space failed").trim();
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
    continue;
  }

  const smoke = readJson(smokeFile);
  const runArgs = smoke.args ?? { id, params: smoke.params ?? {} };
  // 与 client.mjs 内部的 run_template 10 分钟上限对齐：聊天类模板的流式等待可超过 3 分钟，
  // 外层先杀会让 Adapter 拿不到真实失败现场（只剩 "timeout"）。
  const run = await client("run_template", runArgs, lease.token, 600_000);
  item.commands.push({ command: "run_template", ok: run.ok, error: run.stderr.trim() || undefined });
  if (!run.ok) {
    item.status = "failed";
    item.error = (run.stderr || run.stdout || "run_template failed").trim();
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

console.log(JSON.stringify({ ok: results.every((r) => r.status === "passed"), results }, null, 2));
process.exitCode = results.every((r) => r.status === "passed") ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (lease && smokeSpaceId) {
    await client("complete_space", { spaceId: smokeSpaceId, keep: false }, lease.token, 30_000).catch(() => undefined);
  }
  if (lease) releaseBrowserLease(lease.token);
}
