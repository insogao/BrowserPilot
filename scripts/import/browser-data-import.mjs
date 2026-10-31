#!/usr/bin/env node
// Browser CLI / BrowserPilot browser-data import MVP.
//
// Flow: discover -> plan -> export -> apply -> verify.
// Safety: read-only source access, no browser launching, no process killing,
// no secret decryption, no cookie/password values in logs or bundles.
import path from "node:path";
import readline from "node:readline/promises";
import { discoverProfiles, profileFromPath, browserById } from "./lib/browsers.mjs";
import { inspectProfile } from "./lib/inventory.mjs";
import { buildPlan, normalizeItems } from "./lib/plan.mjs";
import { createBundle } from "./lib/export.mjs";
import { applyBundle } from "./lib/apply.mjs";
import { readResult, recordLoginCheck, formatResult } from "./lib/verify.mjs";
import { listSources, findSource, formatSourceLine, cookieFlowReadiness } from "./lib/sources.mjs";
import { TargetClient } from "./lib/target-client.mjs";
import { createMemoryBackend, startLocalTarget } from "./target/local-target.mjs";
import { createCdpBackend } from "./target/cdp-backend.mjs";
import {
  formatCapabilities,
  formatInstructions,
  formatProgressLine,
  formatThreeState,
  reloginGuidance,
  waitForJob,
  DEFAULT_WAIT_TIMEOUT_MS,
} from "./lib/wizard.mjs";
import {
  createCookieImportReport,
  writeCookieImportReport,
  readReport,
  confirmReportLogin,
  formatCookieImportReport,
} from "./lib/report.mjs";

const HELP = `browser-data-import ${new Date().getFullYear()} MVP + cookie-import product flow

Usage:
  node scripts/import/browser-data-import.mjs sources [--json] [--root <browserId>=<path> ...]
      List Chrome/Edge/Brave/Chromium/Firefox profiles and Cookie-import support.

  node scripts/import/browser-data-import.mjs connect [--source <browserId:profileDir>]
      [--endpoint http://127.0.0.1:<port> --pair <6 digits>]
      [--port <port>] [--cdp-port <port> --allow-test-cdp]
      [--report-dir <dir>] [--timeout-ms N] [--yes] [--json] [--root ...]
      Start (or attach to) a loopback cookie-import target, guide the user
      through the source extension, show progress, and write a count-only
      report. Without --endpoint it starts the local contract target (test
      only; memory backend unless --cdp-port is given).

  node scripts/import/browser-data-import.mjs report --file <report.json> [--json]
  node scripts/import/browser-data-import.mjs confirm-login --file <report.json>
      --domain <domain> --status user_confirmed|failed [--note <text>]
      [--confirm-user-action] [--json]

  node scripts/import/browser-data-import.mjs discover [--inspect] [--json]
      [--root <browserId>=<path> ...]
  node scripts/import/browser-data-import.mjs plan --source <browserId:profileDir>
      [--source-profile <path> --browser <browserId>]
      [--items cookies,bookmarks,history,passwords,autofill,tabs]
      [--target-profile <abs path>] [--allow-existing] [--json]
      [--root <browserId>=<path> ...]
  node scripts/import/browser-data-import.mjs export --source ... --out <dir>
      [--items ...] [--max-history-rows N] [--max-autofill-rows N]
      [--overwrite] [--json] [--root ...]
  node scripts/import/browser-data-import.mjs apply --bundle <dir>
      --target-profile <abs path> [--allow-existing] [--placement other|bar]
      [--json]
  node scripts/import/browser-data-import.mjs verify --bundle <dir>
      [--status not_verified|user_confirmed|failed] [--domain <domain>]
      [--note <text>] [--confirm-user-action] [--json]
  node scripts/import/browser-data-import.mjs migrate --source ... --out <dir>
      --target-profile <abs path> [--items ...] [--allow-existing] [--json]
      [--root ...]

Requires Node.js >= 22.5 (node:sqlite). This tool is read-only on sources and
never launches, focuses, or kills a browser.

Notes:
  - --root overrides the standard user-data root for a browser (repeatable).
    It is intended for tests and non-standard installs; fixtures live outside
    real browser profiles.
  - Cookie values are never read or decrypted by this tool. The source
    extension (extensions/import-source) reads them with chrome.cookies only
    after explicit user consent; the local target is a test implementation of
    the native Browser CLI contract.
  - Three states are always separate: data copied, cookie imported, actual
    login verified. The last one is only ever user-confirmed.
  - Exit codes: 0 ok, 2 usage/validation error, 3 blocked/precondition failure.
`;


function parseArgs(argv) {
  const args = { _: [], roots: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    let key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value = eq >= 0 ? a.slice(eq + 1) : undefined;
    const takeValue = () => {
      if (value !== undefined) return value;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i += 1;
      return next;
    };
    switch (key) {
      case "json":
        args.json = true;
        break;
      case "help":
        args.help = true;
        break;
      case "inspect":
        args.inspect = true;
        break;
      case "allow-existing":
        args.allowExisting = true;
        break;
      case "overwrite":
        args.overwrite = true;
        break;
      case "confirm-user-action":
        args.confirmUserAction = true;
        break;
      case "allow-test-cdp":
        args.allowTestCdp = true;
        break;
      case "yes":
        args.yes = true;
        break;
      case "endpoint":
        args.endpoint = takeValue();
        break;
      case "pair":
        args.pair = takeValue();
        break;
      case "port": {
        const v = takeValue();
        if (v === undefined || !/^\d+$/.test(v)) usageError("--port requires a non-negative integer");
        args.port = Number(v);
        break;
      }
      case "cdp-port": {
        const v = takeValue();
        if (v === undefined || !/^\d+$/.test(v)) usageError("--cdp-port requires a port number");
        args.cdpPort = Number(v);
        break;
      }
      case "report-dir":
        args.reportDir = takeValue();
        break;
      case "timeout-ms": {
        const v = takeValue();
        if (v === undefined || !/^\d+$/.test(v)) usageError("--timeout-ms requires a number");
        args.timeoutMs = Number(v);
        break;
      }
      case "file":
        args.file = takeValue();
        break;
      case "root": {
        const v = takeValue();
        if (!v) usageError("--root requires <browserId>=<path>");
        const sep = v.indexOf("=");
        if (sep <= 0) usageError("--root requires <browserId>=<path>");
        args.roots[v.slice(0, sep)] = v.slice(sep + 1);
        break;
      }
      case "source":
        args.source = takeValue();
        break;
      case "source-profile":
        args.sourceProfile = takeValue();
        break;
      case "browser":
        args.browser = takeValue();
        break;
      case "items":
        args.items = takeValue();
        break;
      case "target-profile":
        args.targetProfile = takeValue();
        break;
      case "out":
        args.out = takeValue();
        break;
      case "bundle":
        args.bundle = takeValue();
        break;
      case "placement":
        args.placement = takeValue();
        break;
      case "max-history-rows":
        args.maxHistoryRows = Number(takeValue());
        break;
      case "max-autofill-rows":
        args.maxAutofillRows = Number(takeValue());
        break;
      case "status":
        args.status = takeValue();
        break;
      case "domain":
        args.domain = takeValue();
        break;
      case "note":
        args.note = takeValue();
        break;
      default:
        usageError(`unknown option --${key}`);
    }
  }
  return args;
}

function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  throw err;
}

function resolveSource(args) {
  if (args.sourceProfile) {
    const browserId = args.browser || inferBrowserFromPath(args.sourceProfile);
    if (!browserId || !browserById(browserId)) {
      throw usageError("--source-profile requires --browser <chrome|edge|brave|chromium|firefox>");
    }
    const profile = profileFromPath(browserId, args.sourceProfile);
    if (!profile) throw usageError(`profile not found: ${args.sourceProfile}`);
    return profile;
  }
  if (!args.source) throw usageError("--source <browserId:profileDir> is required");
  const sep = args.source.indexOf(":");
  if (sep <= 0) throw usageError("--source must look like chrome:Default");
  const browserId = args.source.slice(0, sep);
  const profileId = args.source.slice(sep + 1);
  const discovery = discoverProfiles({ rootOverrides: args.roots });
  for (const browser of discovery.browsers) {
    if (browser.id !== browserId) continue;
    const profile = browser.profiles.find((p) => p.dirName === profileId || p.id === profileId);
    if (profile) return profile;
  }
  throw usageError(`source profile not found: ${args.source} (run discover)`);
}

function inferBrowserFromPath(p) {
  const s = String(p).toLowerCase();
  if (s.includes("firefox")) return "firefox";
  if (s.includes("brave")) return "brave";
  if (s.includes("edge")) return "edge";
  if (s.includes("chromium")) return "chromium";
  if (s.includes("chrome")) return "chrome";
  return null;
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function cmdDiscover(args) {
  const discovery = discoverProfiles({ rootOverrides: args.roots });
  const payload = { ...discovery, profiles: [] };
  for (const browser of discovery.browsers) {
    for (const profile of browser.profiles) {
      let inventory = null;
      if (args.inspect) inventory = inspectProfile(profile).items;
      payload.profiles.push({
        id: profile.id,
        browser: browser.id,
        browserName: browser.name,
        family: browser.family,
        label: profile.label,
        dirName: profile.dirName,
        path: profile.path,
        lastModified: profile.lastModified,
        running: profile.running,
        files: Object.fromEntries(
          Object.entries(profile.files || {}).map(([k, v]) => [k, v.directory ? "dir" : v.size]),
        ),
        inventory,
      });
    }
  }
  if (args.json) {
    printJson(payload);
    return 0;
  }
  console.log(`Browsers discovered on ${payload.platform}:`);
  for (const profile of payload.profiles) {
    const run = profile.running?.running ? ` [running: ${profile.running.evidence}]` : "";
    console.log(`  ${profile.id}`);
    console.log(`    name: ${profile.label}${run}`);
    console.log(`    path: ${profile.path}`);
    console.log(`    data: ${describeFiles(profile.files)}`);
    if (profile.inventory) {
      for (const [item, info] of Object.entries(profile.inventory)) {
        console.log(`      ${item}: ${describeInventory(info)}`);
      }
    }
  }
  if (payload.profiles.length === 0) console.log("  (none)");
  for (const w of payload.warnings) console.log(`warning: ${w}`);
  return 0;
}

function describeFiles(files) {
  const names = Object.keys(files || {});
  return names.length ? names.join(", ") : "(no known data files)";
}

function describeInventory(info) {
  if (!info) return "n/a";
  if (info.available === false) return `unavailable (${info.reason || "missing"})`;
  if (info.readable === false) return `unreadable (${info.error || "unknown"})`;
  const c = info.count || {};
  const bits = Object.entries(c)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  if (info.encryption) bits.push(`v20=${info.encryption.appBoundV20}, v10=${info.encryption.dpapiV10}`);
  return bits.join(", ") || "present";
}

function cmdPlan(args) {
  const profile = resolveSource(args);
  const inventory = inspectProfile(profile);
  const { items, unknown } = normalizeItems(args.items);
  if (unknown.length) throw usageError(`unknown items: ${unknown.join(", ")}`);
  const plan = buildPlan({
    profile,
    inventory,
    targetProfile: args.targetProfile || null,
    requestedItems: new Set(items),
    allowExisting: !!args.allowExisting,
  });
  if (args.json && !args.silent) {
    printJson(plan);
  } else if (!args.silent) {
    console.log(`source: ${profile.browserName} / ${profile.label} (${profile.path})`);
    if (plan.targetProfile) console.log(`target: ${plan.targetProfile}`);
    console.log("items:");
    for (const [item, info] of Object.entries(plan.items)) {
      if (!info.requested) continue;
      const counts = info.counts ? ` ${JSON.stringify(info.counts)}` : "";
      console.log(`  ${item}: ${info.status}${counts}`);
      if (info.reason) console.log(`    ${info.reason}`);
    }
    const bad = plan.preconditions.filter((p) => !p.ok);
    if (bad.length) {
      console.log("preconditions:");
      for (const p of bad) console.log(`  FAIL ${p.name}${p.detail ? `: ${p.detail}` : ""}`);
    }
  }
  return plan.ready ? 0 : 3;
}

function cmdExport(args) {
  const profile = resolveSource(args);
  if (!args.out) throw usageError("--out <bundle dir> is required");
  const { items, unknown } = normalizeItems(args.items);
  if (unknown.length) throw usageError(`unknown items: ${unknown.join(", ")}`);
  const inventory = inspectProfile(profile);
  const bundle = createBundle({
    profile,
    inventory,
    items,
    outDir: path.resolve(args.out),
    options: {
      overwrite: !!args.overwrite,
      maxHistoryRows: args.maxHistoryRows,
      maxAutofillRows: args.maxAutofillRows,
    },
  });
  if (!bundle.ok) {
    if (args.json) printJson(bundle);
    else console.error(`export failed: ${bundle.error}${bundle.detail ? ` (${bundle.detail})` : ""}`);
    return 2;
  }
  if (args.json && !args.silent) {
    printJson({ ok: true, ...bundle });
  } else if (!args.silent) {
    console.log(`bundle: ${bundle.outDir}`);
    for (const [item, info] of Object.entries(bundle.manifest.items)) {
      console.log(`  ${item}: ${info.status}${info.file ? ` -> ${info.file}` : ""}`);
    }
    console.log("note: cookies/passwords are never written into the bundle.");
    console.log("note: this bundle contains personal data (bookmarks/history). Keep it local.");
  }
  return 0;
}

function cmdApply(args) {
  if (!args.bundle) throw usageError("--bundle <dir> is required");
  if (!args.targetProfile) throw usageError("--target-profile <abs path> is required");
  if (args.placement && !["other", "bar"].includes(args.placement)) {
    throw usageError("--placement must be other or bar");
  }
  const skipProcessProbe = process.env.BP_IMPORT_TEST_MODE === "1";
  const res = applyBundle({
    bundleDir: path.resolve(args.bundle),
    targetProfile: args.targetProfile,
    allowExisting: !!args.allowExisting,
    placement: args.placement || "other",
    skipProcessProbe,
  });
  if (!res.ok) {
    if (args.json) printJson(res);
    else console.error(`apply failed: ${res.error}${res.message ? `: ${res.message}` : ""}`);
    return res.error === "target-in-use" || res.error === "target-inside-source-browser" ? 3 : 2;
  }
  if (args.json) printJson({ ok: true, ...res });
  else {
    console.log(`applied to: ${res.result.targetProfile}`);
    for (const [item, copied] of Object.entries(res.result.dataCopied)) {
      console.log(`  ${item}: ${copied ? "copied" : "not copied"}`);
    }
    if (res.result.details.bookmarks?.backupPath) {
      console.log(`  backup: ${res.result.details.bookmarks.backupPath}`);
    }
    console.log(`cookies: ${res.result.cookieImported.status}`);
    console.log(`login verified: ${res.result.loginVerified.status}`);
    console.log(`result: ${res.resultPath}`);
  }
  return 0;
}

function cmdVerify(args) {
  if (!args.bundle) throw usageError("--bundle <dir> is required");
  if (args.status) {
    if (!args.domain) throw usageError("--domain <domain> is required with --status");
    const res = recordLoginCheck({
      bundleDir: path.resolve(args.bundle),
      domain: args.domain,
      status: args.status,
      note: args.note || "",
      confirmUserAction: !!args.confirmUserAction,
    });
    if (!res.ok) {
      if (args.json) printJson(res);
      else console.error(`verify failed: ${res.error}${res.message ? `: ${res.message}` : ""}`);
      return res.error === "explicit-user-action-required" ? 3 : 2;
    }
    if (args.json) printJson({ ok: true, result: res.result });
    else console.log(formatResult(res.result));
    return 0;
  }
  const res = readResult(path.resolve(args.bundle));
  if (!res.ok) {
    console.error("verify failed: result.json not found (run apply first)");
    return 2;
  }
  if (args.json) printJson(res.result);
  else console.log(formatResult(res.result));
  return 0;
}

function cmdSources(args) {
  const listing = listSources({ rootOverrides: args.roots });
  if (args.json) {
    printJson(listing);
    return 0;
  }
  console.log(`Browser profiles on ${listing.platform}:`);
  if (listing.sources.length === 0) console.log("  (no profiles found)");
  listing.sources.forEach((source, index) => console.log(`  ${formatSourceLine(source, index + 1)}`));
  for (const warning of listing.warnings) console.log(`warning: ${warning}`);
  console.log("");
  console.log("Cookie import support: Chrome/Edge = supported, Brave/Chromium = experimental, Firefox = unsupported.");
  console.log("Picking a profile in `connect` is onboarding/guidance only: the source extension scans the profile it runs in.");
  return 0;
}

function isInteractive(args) {
  return !!(process.stdin.isTTY && process.stdout.isTTY) && !args.json;
}

async function chooseSourceInteractive(prompter, sources) {
  if (sources.length === 0) throw usageError("no source profiles found (run sources)");
  console.log("");
  sources.forEach((source, index) => console.log(`  ${formatSourceLine(source, index + 1)}`));
  const answer = (await prompter.question("选择来源 Profile 编号（q 取消）：")).trim();
  if (!answer || answer.toLowerCase() === "q") return null;
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= sources.length) return sources[index - 1];
  const found = findSource(sources, answer);
  if (!found) throw usageError(`source profile not found: ${answer} (run sources)`);
  return found;
}

async function cmdConnect(args) {
  const interactive = isInteractive(args);
  const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const listing = listSources({ rootOverrides: args.roots });
  const prompter = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  let localTarget = null;
  try {
    let source = null;
    if (args.source) {
      source = findSource(listing.sources, args.source);
      if (!source) throw usageError(`source profile not found: ${args.source} (run sources)`);
    } else if (interactive) {
      source = await chooseSourceInteractive(prompter, listing.sources);
    }
    if (!source) {
      if (interactive) {
        console.log("已取消。");
        return 0;
      }
      throw usageError("--source <browserId:profileDir> is required when stdin is not a TTY (run sources)");
    }
    const readiness = cookieFlowReadiness(source);
    if (!readiness.ok) {
      if (args.json) printJson({ ok: false, error: readiness.code, message: readiness.message });
      else {
        console.error(`source not usable: ${readiness.code}`);
        if (readiness.message) console.error(readiness.message);
      }
      return 3;
    }
    if (!args.json) {
      for (const warning of readiness.warnings) console.log(`warning: ${warning}`);
    }
    if (interactive && !args.yes) {
      const answer = (
        await prompter.question(`确认使用 ${source.browserName} / ${source.label} 作为来源 Profile? [y/N] `)
      )
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log("已取消。");
        return 0;
      }
    }
    const consentAt = new Date().toISOString();
    let endpoint;
    let pair;
    let capabilities;

    if (args.endpoint) {
      if (!args.pair) throw usageError("--pair <6 digits> is required with --endpoint");
      if (!/^\d{6}$/.test(String(args.pair))) throw usageError("--pair must be exactly 6 digits");
      let client;
      try {
        client = new TargetClient({ endpoint: args.endpoint, pair: args.pair });
      } catch (err) {
        throw usageError(`invalid target: ${err.message}`);
      }
      capabilities = await client.capabilities();
      if (!capabilities.ok) {
        if (args.json) printJson({ ok: false, error: capabilities.error });
        else console.error(`target unavailable: ${capabilities.error}`);
        return 3;
      }
      endpoint = client.endpoint;
      pair = args.pair;
      return await runConnectLoop({
        args,
        source,
        client,
        capabilities,
        endpoint,
        pair,
        startedAt,
        consentAt,
        timeoutMs,
        interactive,
        prompter,
      });
    }

    if (args.cdpPort !== undefined && !args.allowTestCdp) {
      throw usageError("--cdp-port requires --allow-test-cdp (test-only backend; use an isolated profile)");
    }
    if (args.cdpPort !== undefined && (!Number.isInteger(args.cdpPort) || args.cdpPort < 1 || args.cdpPort > 65535)) {
      throw usageError("--cdp-port must be an integer between 1 and 65535");
    }
    if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)) {
      throw usageError("--port must be an integer between 0 and 65535");
    }
    const backend = args.cdpPort !== undefined ? createCdpBackend({ port: args.cdpPort }) : createMemoryBackend();
    localTarget = startLocalTarget({
      port: args.port !== undefined ? args.port : 0,
      backend,
      log: () => {},
    });
    await localTarget.listening;
    const client = new TargetClient({ endpoint: localTarget.endpoint, pair: localTarget.pair });
    capabilities = await client.capabilities();
    if (!capabilities.ok) {
      if (args.json) printJson({ ok: false, error: capabilities.error });
      else console.error(`local target unavailable: ${capabilities.error}`);
      return 3;
    }
    endpoint = client.endpoint;
    pair = localTarget.pair;
    return await runConnectLoop({
      args,
      source,
      client,
      capabilities,
      endpoint,
      pair,
      startedAt,
      consentAt,
      timeoutMs,
      interactive,
      prompter,
    });
  } finally {
    if (prompter) prompter.close();
    if (localTarget) await localTarget.close();
  }
}

async function runConnectLoop({
  args,
  source,
  client,
  capabilities,
  endpoint,
  pair,
  startedAt,
  consentAt,
  timeoutMs,
  interactive,
  prompter,
}) {
  if (!args.json) {
    console.log("");
    console.log(formatCapabilities(capabilities));
    console.log("");
    console.log(formatInstructions({ source, endpoint, pair, native: capabilities.native }));
  }
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  let currentJobId = null;
  let afterJobId = null;
  try {
    for (;;) {
      const wait = await waitForJob({
        client,
        afterJobId,
        timeoutMs,
        signal: controller.signal,
        onProgress: (view) => {
          currentJobId = view.jobId;
          if (!args.json) console.log(formatProgressLine(view));
        },
      });
      if (!wait.ok) {
        if (wait.error === "cancelled-by-user") {
          if (currentJobId) await client.cancel(currentJobId).catch(() => {});
          if (args.json) printJson({ ok: false, error: "cancelled-by-user" });
          else console.log("已取消当前导入任务；已写入的 Cookie 不会回滚。");
          return 130;
        }
        if (wait.error === "timeout") {
          const report = createCookieImportReport({
            source,
            target: capabilities,
            view: null,
            outcome: "timeout",
            startedAt,
            consentAt,
          });
          const written = writeCookieImportReport({ reportDir: args.reportDir, report });
          if (args.json) printJson({ ok: false, error: "timeout", report, reportPath: written.path });
          else {
            console.log(`等待超时（${Math.round(timeoutMs / 1000)}s）。请确认扩展中的地址/配对码。`);
            console.log(`report: ${written.path}`);
          }
          return 3;
        }
        if (args.json) printJson({ ok: false, error: wait.error });
        else console.error(`import failed: ${wait.error}`);
        return 3;
      }
      const view = wait.view;
      currentJobId = view.jobId;
      const report = createCookieImportReport({ source, target: capabilities, view, startedAt, consentAt });
      const written = writeCookieImportReport({ reportDir: args.reportDir, report });
      if (args.json) {
        printJson({ ok: true, report, reportPath: written.path });
      } else {
        console.log("");
        console.log(formatThreeState(view));
        console.log("");
        console.log(reloginGuidance(view));
        console.log(`report: ${written.path}`);
      }
      if (!interactive) return 0;
      const answer = (await prompter.question("按 r 等待扩展重试并重新发送，按 q 退出 [q]: ")).trim().toLowerCase();
      if (answer !== "r") return 0;
      afterJobId = view.jobId;
      if (!args.json) console.log("等待来源扩展重新发送…");
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function cmdReport(args) {
  if (!args.file) throw usageError("--file <report.json> is required");
  const read = readReport(args.file);
  if (!read.ok) {
    if (args.json) printJson(read);
    else console.error(`report failed: ${read.error}`);
    return 2;
  }
  if (args.json) printJson(read.report);
  else if (read.report.kind === "cookie-import") console.log(formatCookieImportReport(read.report));
  else console.log(formatResult(read.report));
  return 0;
}

function cmdConfirmLogin(args) {
  if (!args.file) throw usageError("--file <report.json> is required");
  if (!args.domain) throw usageError("--domain <domain> is required");
  if (!args.status) throw usageError("--status is required");
  const res = confirmReportLogin({
    reportPath: args.file,
    domain: args.domain,
    status: args.status,
    note: args.note || "",
    confirmUserAction: !!args.confirmUserAction,
  });
  if (!res.ok) {
    if (args.json) printJson(res);
    else console.error(`confirm-login failed: ${res.error}${res.message ? `: ${res.message}` : ""}`);
    return res.error === "explicit-user-action-required" ? 3 : 2;
  }
  if (args.json) printJson({ ok: true, report: res.report, path: res.path });
  else console.log(formatCookieImportReport(res.report));
  return 0;
}

function cmdMigrate(args) {
  const rcPlan = cmdPlan({ ...args, json: false, silent: true });
  if (rcPlan !== 0) return rcPlan;
  const rcExport = cmdExport({ ...args, silent: true });
  if (rcExport !== 0) return rcExport;
  return cmdApply({ ...args, bundle: args.out });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    console.log(HELP);
    return 0;
  }
  const command = args._[0];
  try {
    switch (command) {
      case "sources":
        return cmdSources(args);
      case "connect":
        return await cmdConnect(args);
      case "report":
        return cmdReport(args);
      case "confirm-login":
        return cmdConfirmLogin(args);
      case "discover":
        return cmdDiscover(args);
      case "plan":
        return cmdPlan(args);
      case "export":
        return cmdExport(args);
      case "apply":
        return cmdApply(args);
      case "verify":
        return cmdVerify(args);
      case "migrate":
        return cmdMigrate(args);
      default:
        throw usageError(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err.usage) {
      console.error(`error: ${err.message}`);
      console.error("run with --help for usage");
      return 2;
    }
    console.error(`error: ${err && err.message ? err.message : err}`);
    return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`error: ${err && err.message ? err.message : err}`);
    process.exitCode = 2;
  },
);
