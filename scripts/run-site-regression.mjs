import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const mode = process.argv[2] ?? "--all";
const allowedModes = new Set(["--all", "--finance", "--remaining", "--runtime", "--builtins", "--migrate-builtins", "--plan"]);
if (!allowedModes.has(mode)) {
  console.error("Usage: node scripts/run-site-regression.mjs [--all|--finance|--remaining|--runtime|--builtins|--migrate-builtins|--plan]");
  process.exit(2);
}

const plan = JSON.parse(fs.readFileSync(path.join(root, "scripts", "site-regression-plan.json"), "utf8"));
if (mode === "--plan") {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(root, ".browserpilot-runs", "site-regression-" + stamp);
fs.mkdirSync(runDir, { recursive: true });

function runNode(script, args, logName) {
  return new Promise((resolve, reject) => {
    const logPath = path.join(runDir, logName);
    const log = fs.createWriteStream(logPath, { flags: "wx" });
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      windowsHide: true,
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on("data", (chunk) => { process.stderr.write(chunk); log.write(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      log.end(() => resolve({ exitCode: code ?? 1, logPath }));
    });
  });
}

const summary = { mode, startedAt: Date.now(), runDir, productSiteCount: plan.productSites.length, stages: [] };

if (mode === "--migrate-builtins") {
  console.log("[site-regression] migrate compiled-in site templates: " + plan.builtinMigrationOrder.join(", "));
  const result = await runNode("scripts/run-adapter-agent-queue.mjs", plan.builtinMigrationOrder, "builtin-migration-agents.log");
  summary.stages.push({ stage: "builtin-migration-agents", ids: plan.builtinMigrationOrder, ...result });
}

if (["--all", "--finance", "--remaining", "--runtime"].includes(mode)) {
  const ids = mode === "--finance"
    ? ["google-finance-search"]
    : mode === "--remaining"
      ? plan.runtimeOrder.filter((id) => id !== "google-finance-search")
      : plan.runtimeOrder;
  console.log("[site-regression] runtime adapters: " + ids.join(", "));
  const result = await runNode("scripts/run-adapter-agent-queue.mjs", ids, "runtime-agents.log");
  summary.stages.push({ stage: "runtime-adapters", ids, ...result });
}

if (["--all", "--remaining", "--builtins"].includes(mode) && plan.builtinOrder.length) {
  console.log("[site-regression] builtin smoke: " + plan.builtinOrder.join(", "));
  const result = await runNode("scripts/smoke-template.mjs", plan.builtinOrder, "builtin-smoke.log");
  summary.stages.push({ stage: "builtin-smoke", ids: plan.builtinOrder, ...result });
}

// 集成门禁兜底：Adapter 在浏览器轮次里改过 template.json 后，catalog 必须重新生成；
// 只看语义结果不看生成物，曾导致"全绿回归"之后 registry:check 仍然变红。
if (mode !== "--plan") {
  console.log("[site-regression] registry check");
  const result = await runNode("scripts/build-registry.mjs", ["--check"], "registry-check.log");
  summary.stages.push({ stage: "registry-check", ...result });
}

summary.finishedAt = Date.now();
summary.ok = summary.stages.length > 0 && summary.stages.every((stage) => stage.exitCode === 0);
fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.ok ? 0 : 1;
