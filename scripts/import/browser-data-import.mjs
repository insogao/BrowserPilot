#!/usr/bin/env node
// Browser CLI / BrowserPilot browser-data import MVP.
//
// Flow: discover -> plan -> export -> apply -> verify.
// Safety: read-only source access, no browser launching, no process killing,
// no secret decryption, no cookie/password values in logs or bundles.
import path from "node:path";
import { discoverProfiles, profileFromPath, browserById } from "./lib/browsers.mjs";
import { inspectProfile } from "./lib/inventory.mjs";
import { buildPlan, normalizeItems } from "./lib/plan.mjs";
import { createBundle } from "./lib/export.mjs";
import { applyBundle } from "./lib/apply.mjs";
import { readResult, recordLoginCheck, formatResult } from "./lib/verify.mjs";

const HELP = `browser-data-import ${new Date().getFullYear()} MVP

Usage:
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
  - This tool never launches, focuses, or kills a browser. It never reads or
    decrypts cookie/password values. Cookie import is BLOCKED in this MVP and
    requires the user-authorized extension bridge.
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

function cmdMigrate(args) {
  const rcPlan = cmdPlan({ ...args, json: false, silent: true });
  if (rcPlan !== 0) return rcPlan;
  const rcExport = cmdExport({ ...args, silent: true });
  if (rcExport !== 0) return rcExport;
  return cmdApply({ ...args, bundle: args.out });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    console.log(HELP);
    return 0;
  }
  const command = args._[0];
  try {
    switch (command) {
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

process.exitCode = main();
