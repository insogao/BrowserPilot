import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { isBrowserLeaseActive, readBrowserLease } from "./browser-lease-lib.mjs";

const root = process.cwd();
const templateIds = process.argv.slice(2);
const model = process.env.BROWSERPILOT_ADAPTER_MODEL || "opencode-go/mimo-v2.5";
const sitePlanPath = path.join(root, "scripts", "site-regression-plan.json");
const sitePlan = fs.existsSync(sitePlanPath)
  ? JSON.parse(fs.readFileSync(sitePlanPath, "utf8"))
  : {};
const agentFeedback = sitePlan.agentFeedback ?? {};
const knownSiteTemplateIds = new Set((sitePlan.productSites ?? []).map((item) => item.templateId));

if (!templateIds.length) {
  console.error("Usage: npm run agents:queue -- <template-id> [template-id...]");
  process.exit(2);
}

for (const id of templateIds) {
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) throw new Error("invalid template id: " + id);
  if (!fs.existsSync(path.join(root, "registry", "templates", id, "template.json")) && !knownSiteTemplateIds.has(id)) {
    throw new Error("template package not found: " + id);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(root, ".browserpilot-runs", stamp);
fs.mkdirSync(runDir, { recursive: true });
const results = [];

function resolveOpencodeExecutable() {
  if (process.env.BROWSERPILOT_OPENCODE_BIN) return process.env.BROWSERPILOT_OPENCODE_BIN;
  if (process.platform !== "win32") return "opencode";
  const shim = execFileSync("where.exe", ["opencode.cmd"], { encoding: "utf8", windowsHide: true })
    .split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!shim) throw new Error("opencode.cmd not found on PATH");
  const executable = path.join(path.dirname(shim), "node_modules", "opencode-ai", "bin", "opencode.exe");
  if (!fs.existsSync(executable)) throw new Error("opencode executable not found: " + executable);
  return executable;
}

const opencodeExecutable = resolveOpencodeExecutable();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBrowserTurn(maxMs = 10 * 60_000) {
  const deadline = Date.now() + maxMs;
  while (isBrowserLeaseActive(readBrowserLease())) {
    if (Date.now() >= deadline) throw new Error("browser lease remained active for 10 minutes");
    await sleep(5000);
  }
}

function promptFor(id) {
  const agentName = "adapter-" + id;
  const packageExists = fs.existsSync(path.join(root, "registry", "templates", id, "template.json"));
  const prompt = [
    "You are the dedicated BrowserPilot adapter for " + id + ".",
    "Read registry/templates/README.md completely before acting.",
    "Your write scope is strictly registry/templates/" + id + "/ and no other path.",
    packageExists
      ? "The runtime package already exists; preserve its public intent and improve it only from live evidence."
      : "This site currently exists only as a compiled-in fallback. Create the complete runtime package in your write scope (template.json, README.md, CHANGELOG.md, examples/basic.json, tests/smoke.json) so future site fixes install dynamically without rebuilding the extension.",
    "This queue gives you the only live-browser turn. You must inspect the real page yourself; do not write selectors from another agent's prose summary.",
    "Start with: npm run smoke:template -- " + id + ".",
    "If it fails, inspect the live site with the safe per-command form: npm run browser:lease -- client " + agentName + " " + id + " <command> '<args-json>'.",
    "For a manual investigation, first create your own maximized window with open_space and state=maximized, then use the same owner name for snapshots, screenshots, DOM js probes, and actions; close it with complete_space when finished.",
    "Responsive sites may expose a clickable search launcher before they mount an input. Inspect a screenshot and L0 click targets as well as input, textarea, contenteditable, and role=searchbox; do not conclude that search is absent from an input-only probe.",
    "Preserve the template's declared user intent and output contract. Do not replace query-specific search with homepage trending data or an unrelated-site workaround merely to make smoke pass.",
    "Never read, write, forge, delete, or copy a lease token/file. Never use naked page-affecting client commands, auto-start Chrome, open chrome-extension:// pages, rebuild the extension, run registry:build, or edit core/generated files.",
    "Fix only problems supported by your own live evidence, rerun smoke, and report files changed, commands run, observations, cleanup, and runtime status passed/failed/blocked.",
    "Do not claim completion unless the final real smoke passes.",
    'End your response with exactly one machine-readable line. Replace <status> with exactly one of passed, failed, or blocked: BROWSERPILOT_ADAPTER_RESULT {"status":"<status>","smokeCommand":"...","evidence":"...","nextAction":"..."}.',
  ];
  if (typeof agentFeedback[id] === "string" && agentFeedback[id].trim()) {
    prompt.push("Task-specific evidence and constraints: " + agentFeedback[id].trim());
  }
  return prompt.join(" ");
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function parseAdapterResult(logText) {
  const lines = logText.split(/\r?\n/).reverse();
  for (const line of lines) {
    const marker = line.match(/BROWSERPILOT_ADAPTER_RESULT\s+(\{.*\})\s*$/);
    if (!marker) continue;
    try {
      const report = JSON.parse(marker[1]);
      if (["passed", "failed", "blocked"].includes(report.status)) return report;
    } catch {
      return { status: "invalid-report", evidence: "Adapter result marker was not valid JSON." };
    }
  }
  return { status: "missing-report", evidence: "Adapter did not emit BROWSERPILOT_ADAPTER_RESULT." };
}

async function browserClient(agentName, scope, command, args = {}) {
  await waitForBrowserTurn();
  const result = await runProcess(process.execPath, [
    path.join(root, "scripts", "browser-lease.mjs"),
    "client",
    agentName,
    scope,
    command,
    JSON.stringify(args),
  ]);
  const payloadStart = result.stdout.indexOf("{");
  const payload = payloadStart >= 0 ? JSON.parse(result.stdout.slice(payloadStart)) : undefined;
  return { ...result, payload };
}

async function cleanupAgentSpaces(id) {
  const agentName = "adapter-" + id;
  const cleanup = { closed: [], preserved: [], errors: [] };
  try {
    const listed = await browserClient(agentName, id, "list_spaces");
    if (listed.code !== 0 || listed.payload?.ok !== true || !Array.isArray(listed.payload?.data)) {
      cleanup.errors.push(listed.stderr || listed.stdout || "list_spaces failed");
      return cleanup;
    }
    for (const space of listed.payload.data) {
      if (space.ownership === "user") {
        cleanup.preserved.push(space.spaceId);
        continue;
      }
      if (space.ownership !== "agent") continue;
      const closed = await browserClient(agentName, id, "complete_space", { spaceId: space.spaceId, keep: false });
      if (closed.code === 0 && closed.payload?.ok === true) cleanup.closed.push(space.spaceId);
      else cleanup.errors.push(closed.stderr || closed.stdout || "complete_space failed: " + space.spaceId);
    }
  } catch (error) {
    cleanup.errors.push(error instanceof Error ? error.message : String(error));
  }
  return cleanup;
}

async function runAgent(id) {
  await waitForBrowserTurn();
  const startedAt = Date.now();
  const logPath = path.join(runDir, id + ".log");
  const log = fs.createWriteStream(logPath, { flags: "wx" });
  console.log("[agent-queue] starting " + id);

  const child = spawn(opencodeExecutable, ["run", "-m", model, promptFor(id)], {
    cwd: root,
    windowsHide: true,
    shell: false,
    env: { ...process.env, BROWSERPILOT_QUEUE_TEMPLATE_ID: id },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { process.stdout.write(chunk); log.write(chunk); });
  child.stderr.on("data", (chunk) => { process.stderr.write(chunk); log.write(chunk); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  await new Promise((resolve, reject) => {
    log.once("close", resolve);
    log.once("error", reject);
    log.end();
  });
  const report = parseAdapterResult(fs.readFileSync(logPath, "utf8"));
  const cleanup = await cleanupAgentSpaces(id);
  const result = { id, exitCode, semanticStatus: report.status, report, cleanup, startedAt, finishedAt: Date.now(), logPath };
  results.push(result);
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ model, results }, null, 2));
  console.log("[agent-queue] finished " + id + " exit=" + exitCode);
}

for (const id of templateIds) {
  try {
    await runAgent(id);
  } catch (error) {
    const failed = { id, exitCode: -1, startedAt: Date.now(), finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
    results.push(failed);
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ model, results }, null, 2));
    console.error("[agent-queue] failed to launch " + id + ": " + failed.error);
  }
}

const ok = results.every((item) =>
  item.exitCode === 0 &&
  item.semanticStatus === "passed" &&
  !item.cleanup?.errors?.length &&
  !item.cleanup?.preserved?.length
);
console.log(JSON.stringify({ ok, runDir, results }, null, 2));
process.exitCode = ok ? 0 : 1;
