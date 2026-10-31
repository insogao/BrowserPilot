#!/usr/bin/env node
// Product-level tests for the Browser CLI cookie-import flow.
//
// Everything is synthetic: temp profile roots, synthetic cookies with canary
// values, no browser launch, no real Chrome/Edge/Firefox profile, no real
// session tokens. The tests assert the three-state model, consent gating,
// loopback-only transport, no cookie values in logs/reports/views, and the
// contract between the source extension and the local native target.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as contract from "./import/contract.mjs";
import {
  groupCookies,
  selectCookies,
  selectionTotals,
  sanitizeJobView,
} from "../extensions/import-source/lib/selection.mjs";
import { startLocalTarget, createMemoryBackend } from "./import/target/local-target.mjs";
import { TargetClient } from "./import/lib/target-client.mjs";
import { listSources, findSource, cookieFlowReadiness, formatSourceLine } from "./import/lib/sources.mjs";
import { waitForJob, formatThreeState, reloginGuidance } from "./import/lib/wizard.mjs";
import {
  createCookieImportReport,
  writeCookieImportReport,
  readReport,
} from "./import/lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(REPO, "scripts", "import", "browser-data-import.mjs");
const EXT = path.join(REPO, "extensions", "import-source");

const CANARY = "COOKIE-PRODUCT-CANARY-4f9d2a";
const CANARY2 = "COOKIE-PRODUCT-CANARY-8b71ce";
const SOURCE_EXTENSION_ID = "ljoekiddijnohefaghljlcodgljienoj";

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.error(`FAIL ${name}: ${err && err.stack ? err.stack.split("\n")[0] : err}`);
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out[path.relative(root, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function extensionIdFromManifestKey(base64Key) {
  const der = Buffer.from(base64Key, "base64");
  const hash = crypto.createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

function cookie(overrides = {}) {
  return {
    domain: ".example.test",
    hostOnly: false,
    path: "/",
    name: "sid",
    value: CANARY,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    session: false,
    expirationDate: 2000000000,
    ...overrides,
  };
}

function importRequest(overrides = {}) {
  return {
    contract: contract.CONTRACT_ID,
    requestId: "req-12345678",
    source: { browser: "chrome", profileLabel: "Synthetic", extensionVersion: "0.2.0" },
    consent: { kind: "explicit-user-action", at: new Date().toISOString(), extensionVersion: "0.2.0" },
    domains: ["example.test"],
    cookies: [cookie()],
    ...overrides,
  };
}

function makeChromiumRoot(root, label, { running = false } = {}) {
  writeJson(path.join(root, "Local State"), {
    profile: { info_cache: { Default: { name: label } } },
  });
  const profile = path.join(root, "Default");
  writeJson(path.join(profile, "Preferences"), {});
  fs.mkdirSync(path.join(profile, "Network"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Network", "Cookies"), "");
  if (running) fs.writeFileSync(path.join(profile, "SingletonLock"), "synthetic");
  return profile;
}

function makeFirefoxRoot(root) {
  fs.mkdirSync(path.join(root, "Profiles", "ff.default"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "profiles.ini"),
    "[Profile0]\nName=Synthetic Firefox\nIsRelative=1\nPath=Profiles/ff.default\nDefault=1\n",
  );
  return path.join(root, "Profiles", "ff.default");
}

function baseRoots(tmp) {
  const chromeRoot = path.join(tmp, "chrome-root");
  const edgeRoot = path.join(tmp, "edge-root");
  const ffRoot = path.join(tmp, "firefox-root");
  const braveRoot = path.join(tmp, "brave-root");
  const chromiumRoot = path.join(tmp, "chromium-root");
  const chromeProfile = makeChromiumRoot(chromeRoot, "Synthetic Chrome");
  makeChromiumRoot(edgeRoot, "Synthetic Edge");
  makeFirefoxRoot(ffRoot);
  fs.mkdirSync(braveRoot, { recursive: true });
  fs.mkdirSync(chromiumRoot, { recursive: true });
  return {
    chromeRoot,
    edgeRoot,
    ffRoot,
    braveRoot,
    chromiumRoot,
    chromeProfile,
    rootArgs: [
      "--root",
      `chrome=${chromeRoot}`,
      "--root",
      `edge=${edgeRoot}`,
      "--root",
      `firefox=${ffRoot}`,
      "--root",
      `brave=${braveRoot}`,
      "--root",
      `chromium=${chromiumRoot}`,
    ],
    rootOverrides: {
      chrome: chromeRoot,
      edge: edgeRoot,
      firefox: ffRoot,
      brave: braveRoot,
      chromium: chromiumRoot,
    },
  };
}

function runCli(args, { expect = 0, env = {} } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, BP_IMPORT_TEST_MODE: "1", ...env },
    timeout: 120000,
    windowsHide: true,
  });
  if (expect !== null) {
    assert.equal(
      res.status,
      expect,
      `command failed (${res.status}): ${args.join(" ")}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  return { ...res, combined: `${res.stdout || ""}\n${res.stderr || ""}` };
}

// Async variant for tests that run a target server in this process: spawnSync
// would block the event loop and the in-process target could not answer.
function runCliAsync(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, BP_IMPORT_TEST_MODE: "1", ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr, combined: `${stdout}\n${stderr}` }));
  });
}

async function request(base, pathname, { method = "GET", pair, origin, body, contentType } = {}) {
  const headers = {};
  if (pair) headers["x-bp-pair"] = pair;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = contentType || "application/json";
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}

async function main() {
  const tmp = tempDir("bp-import-product-");
  const roots = baseRoots(tmp);
  const sourceHashBefore = {
    chrome: hashTree(roots.chromeRoot),
    edge: hashTree(roots.edgeRoot),
    firefox: hashTree(roots.ffRoot),
  };

  // ---------------------------------------------------------------------
  // A. Contract validation and privacy
  // ---------------------------------------------------------------------
  await check("contract accepts a well-formed request and normalizes counts", () => {
    const res = contract.validateImportRequest(
      importRequest({
        domains: ["example.test", "sub.example.test"],
        cookies: [
          cookie(),
          cookie({ domain: "sub.example.test", value: CANARY2, session: true }),
        ],
      }),
    );
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.deepEqual(res.normalized.totals, { cookies: 2, domains: 2, selectedDomains: 2 });
    assert.equal(res.normalized.cookies[0].value, CANARY);
    assert.equal(res.normalized.cookies[1].session, true);
    assert.equal(res.normalized.cookies[1].expirationDate, undefined);
  });

  await check("contract rejects missing consent, bad ids, empty selection and unselected domains", () => {
    const cases = [
      [{ ...importRequest(), consent: undefined }, "consent.missing"],
      [{ ...importRequest(), consent: { kind: "implicit", at: new Date().toISOString(), extensionVersion: "x" } }, "consent.kind-invalid"],
      [{ ...importRequest(), requestId: "short" }, "requestId-invalid"],
      [{ ...importRequest(), domains: [] }, "domains-empty"],
      [{ ...importRequest(), domains: ["example.test", "example.test"] }, "domains[1]-duplicate"],
      [{ ...importRequest(), cookies: [] }, "cookies-empty"],
      [{ ...importRequest(), domains: ["other.test"] }, "domain-not-selected"],
      [{ ...importRequest(), cookies: [cookie({ value: "x".repeat(9000) })] }, "value-too-long"],
      [{ ...importRequest(), cookies: [cookie({ sameSite: "weird" })] }, "sameSite-invalid"],
      [{ ...importRequest(), cookies: [cookie({ session: false, expirationDate: undefined })] }, "expirationDate-invalid"],
      [{ ...importRequest(), cookies: [cookie({ domain: "bad domain" })] }, "domain-invalid"],
    ];
    for (const [payload, expected] of cases) {
      const res = contract.validateImportRequest(payload);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes(expected)), `${expected} not in ${res.errors.join(",")}`);
      assert.equal(JSON.stringify(res).includes(CANARY), false, "validation result leaked a cookie value");
      assert.equal(JSON.stringify(res).includes("example.test"), false, "validation result leaked a domain");
    }
  });

  await check("domain selection matches registrable domain and subdomains, not parents", () => {
    assert.equal(contract.domainMatchesSelection(".example.test", ["example.test"]), true);
    assert.equal(contract.domainMatchesSelection("sub.example.test", ["example.test"]), true);
    assert.equal(contract.domainMatchesSelection(".example.test", ["sub.example.test"]), false);
    assert.equal(contract.domainMatchesSelection("notexample.test", ["example.test"]), false);
  });

  await check("public job view and sanitizer contain counts only and force not_verified", () => {
    const job = {
      id: "a".repeat(24),
      state: "done",
      totals: { cookies: 2, domains: 1, selectedDomains: 1 },
      progress: { applied: 1, failed: 1 },
      failures: { "partitioned-cookie-rejected": 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const view = contract.createPublicJobView(job);
    const text = JSON.stringify(view);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
    assert.equal(view.loginVerified.status, "not_verified");
    assert.equal(view.cookieImported.status, "partially_imported");

    const hostile = {
      ...view,
      cookies: [{ name: "sid", value: CANARY, domain: "example.test" }],
      loginVerified: { status: "user_confirmed" },
      cookieImported: { ...view.cookieImported, status: "imported" },
      extra: "domain example.test",
    };
    const safe = contract.sanitizePublicJobView(hostile);
    assert.ok(safe);
    assert.equal(JSON.stringify(safe).includes(CANARY), false);
    assert.equal(JSON.stringify(safe).includes("example.test"), false);
    assert.equal(safe.loginVerified.status, "not_verified");
    assert.equal(safe.cookieImported.status, "partially_imported");
    assert.equal(safe.extra, undefined);
    assert.equal(contract.sanitizePublicJobView({ ...view, state: "weird" }), null);
  });

  await check("chrome cookie mapping returns reasons, never values", () => {
    const good = contract.cookieRecordFromChromeCookie({
      domain: ".example.test",
      hostOnly: false,
      path: "/",
      name: "sid",
      value: CANARY,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      session: true,
      partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true },
    });
    assert.equal(good.ok, true);
    assert.equal(good.cookie.session, true);
    assert.deepEqual(good.cookie.partitionKey, {
      topLevelSite: "https://top.test",
      hasCrossSiteAncestor: true,
    });
    const bad = contract.cookieRecordFromChromeCookie({ domain: "bad domain", name: "x", value: CANARY });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "invalid-domain");
    assert.equal(JSON.stringify(bad).includes(CANARY), false);
  });

  // ---------------------------------------------------------------------
  // B. Source extension packaging and static safety
  // ---------------------------------------------------------------------
  const manifest = JSON.parse(readText(path.join(EXT, "manifest.json")));
  await check("source extension manifest is minimal, MV3, and keyed to the product id", () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual([...manifest.permissions].sort(), ["cookies", "storage"]);
    assert.deepEqual(manifest.host_permissions, ["<all_urls>", "http://127.0.0.1/*"]);
    assert.equal(manifest.background.type, "module");
    assert.equal(manifest.action.default_popup, "popup.html");
    for (const forbidden of ["tabs", "history", "bookmarks", "downloads", "nativeMessaging", "webRequest", "management"]) {
      assert.equal(manifest.permissions.includes(forbidden), false, `forbidden permission ${forbidden}`);
    }
    assert.equal(extensionIdFromManifestKey(manifest.key), SOURCE_EXTENSION_ID);
  });

  await check("extension sources contain no logging, persistent cookie storage, or remote URLs", () => {
    const files = [
      "service-worker.js",
      "popup.js",
      "popup.html",
      "lib/selection.mjs",
      "lib/contract.mjs",
      "manifest.json",
    ];
    for (const relative of files) {
      const text = readText(path.join(EXT, relative));
      assert.equal(text.includes("console."), false, `${relative} logs to console`);
      assert.equal(text.includes("storage.local"), false, `${relative} uses persistent storage`);
      assert.equal(text.includes("chrome.tabs"), false, `${relative} uses tabs`);
      assert.equal(text.includes("chrome.history"), false, `${relative} uses history`);
      assert.equal(text.includes("chrome.bookmarks"), false, `${relative} uses bookmarks`);
      assert.equal(text.includes("XMLHttpRequest"), false, `${relative} uses XHR`);
      assert.equal(text.includes("eval("), false, `${relative} uses eval`);
      for (const match of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
        assert.ok(match[0].startsWith("http://127.0.0.1"), `${relative} contains non-loopback URL ${match[0]}`);
      }
    }
    const worker = readText(path.join(EXT, "service-worker.js"));
    assert.ok(worker.includes("consent !== true"));
    assert.ok(worker.includes("acknowledged !== true"));
    assert.ok(worker.includes("validateLoopbackEndpoint"));
    assert.ok(worker.includes("validatePairCode"));
  });

  await check("extension contract copy is byte-identical to the canonical contract", () => {
    const canonical = readText(path.join(REPO, "scripts", "import", "contract.mjs"));
    const copy = readText(path.join(EXT, "lib", "contract.mjs"));
    assert.equal(copy, canonical);
  });

  await check("selection groups metadata only and filters by selected domains", () => {
    const chromeCookies = [
      { domain: ".example.test", name: "sid", value: CANARY, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 2000000000, hostOnly: false },
      { domain: "sub.example.test", name: "token", value: CANARY2, path: "/x", secure: false, httpOnly: false, sameSite: "strict", session: true, hostOnly: true },
      { domain: "other.test", name: "other", value: CANARY, path: "/", secure: true, httpOnly: false, sameSite: "lax", session: true, hostOnly: true },
      { domain: "example.test", name: "broken", value: "x".repeat(9000), path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true, hostOnly: true },
    ];
    const groups = groupCookies(chromeCookies);
    const groupText = JSON.stringify(groups);
    assert.equal(groupText.includes(CANARY), false);
    assert.equal(groupText.includes("sid"), false);
    assert.equal(groupText.includes("token"), false);
    const totals = selectionTotals(groups);
    assert.equal(totals.cookies, 4);
    assert.equal(totals.domains, 3);
    assert.equal(totals.httpOnly, 2);
    assert.equal(totals.session, 3);

    const selected = selectCookies(chromeCookies, ["example.test"]);
    assert.equal(selected.cookies.length, 2);
    assert.ok(selected.cookies.every((c) => contract.domainMatchesSelection(c.domain, ["example.test"])));
    assert.equal(selected.skipped["invalid-cookie"], 1);
    assert.equal(JSON.stringify(selected.skipped).includes(CANARY), false);

    const subOnly = selectCookies(chromeCookies, ["sub.example.test"]);
    assert.equal(subOnly.cookies.length, 1);
    assert.equal(subOnly.cookies[0].domain, "sub.example.test");
  });

  await check("popup sanitizer drops extra fields and refuses a fake login verification", () => {
    const view = contract.createPublicJobView({
      id: "b".repeat(24),
      state: "done",
      totals: { cookies: 1, domains: 1, selectedDomains: 1 },
      progress: { applied: 1, failed: 0 },
      failures: {},
      createdAt: "x",
      updatedAt: "y",
    });
    const sanitized = sanitizeJobView(
      { ...view, cookies: [{ value: CANARY }], loginVerified: { status: "user_confirmed" } },
      contract,
    );
    assert.equal(sanitized.ok, true);
    assert.equal(JSON.stringify(sanitized).includes(CANARY), false);
    assert.equal(sanitized.view.loginVerified.status, "not_verified");
    assert.equal(sanitizedJobExtra(sanitized.view), false);
    assert.equal(sanitizeJobView({ ...view, state: "weird" }, contract).ok, false);
  });

  function sanitizedJobExtra(view) {
    return Object.prototype.hasOwnProperty.call(view, "cookies");
  }

  await check("loopback endpoint validator rejects DNS, LAN, TLS, paths and credentials", () => {
    assert.deepEqual(contract.validateLoopbackEndpoint("http://127.0.0.1:47832"), {
      ok: true,
      base: "http://127.0.0.1:47832",
    });
    for (const bad of [
      "http://localhost:47832",
      "https://127.0.0.1:47832",
      "http://192.168.1.5:47832",
      "http://127.0.0.1",
      "http://127.0.0.1:47832/path",
      "http://127.0.0.1:47832?x=1",
      "http://user:pass@127.0.0.1:47832",
    ]) {
      assert.equal(contract.validateLoopbackEndpoint(bad).ok, false, bad);
    }
    assert.equal(contract.validatePairCode("123456"), true);
    assert.equal(contract.validatePairCode("12345"), false);
    assert.equal(contract.validatePairCode("abcdef"), false);
  });

  // ---------------------------------------------------------------------
  // C. Source profile discovery/selection (synthetic only)
  // ---------------------------------------------------------------------
  await check("sources lists synthetic Chrome/Edge profiles and marks Firefox unsupported", () => {
    const listing = listSources({ rootOverrides: roots.rootOverrides });
    const ids = listing.sources.map((s) => s.id);
    assert.deepEqual(ids.sort(), ["chrome:Default", "edge:Default", "firefox:ff.default"].sort());
    const chrome = findSource(listing.sources, "chrome:Default");
    assert.equal(chrome.cookieImport, "supported");
    assert.equal(chrome.cookieStore.present, true);
    assert.equal(chrome.cookieStore.location, "Network/Cookies");
    assert.equal(chrome.readOnly, true);
    const edge = findSource(listing.sources, "edge:Default");
    assert.equal(edge.cookieImport, "supported");
    const firefox = findSource(listing.sources, "firefox:ff.default");
    assert.equal(firefox.cookieImport, "unsupported");
    assert.equal(cookieFlowReadiness(firefox).ok, false);
    assert.equal(cookieFlowReadiness(chrome).ok, true);
    assert.ok(formatSourceLine(chrome, 1).includes("Synthetic Chrome"));
    assert.equal(JSON.stringify(listing).includes(CANARY), false);
  });

  await check("sources CLI output is JSON-only, contains no canary, and leaves sources byte-identical", () => {
    const res = runCli(["sources", "--json", ...roots.rootArgs]);
    const data = JSON.parse(res.stdout);
    assert.equal(data.sources.length, 3);
    assert.equal(res.combined.includes(CANARY), false);
    assert.deepEqual(hashTree(roots.chromeRoot), sourceHashBefore.chrome);
    assert.deepEqual(hashTree(roots.edgeRoot), sourceHashBefore.edge);
    assert.deepEqual(hashTree(roots.ffRoot), sourceHashBefore.firefox);
  });

  // ---------------------------------------------------------------------
  // D. Local target contract behavior
  // ---------------------------------------------------------------------
  const targetLogs = [];
  const backend = createMemoryBackend();
  const target = startLocalTarget({
    port: 0,
    pair: "123456",
    allowedOrigins: [`chrome-extension://${SOURCE_EXTENSION_ID}`],
    backend,
    log: (line) => targetLogs.push(line),
    ttlMs: 60_000,
  });
  const port = await target.listening;
  const base = `http://127.0.0.1:${port}`;
  const client = new TargetClient({ endpoint: base, pair: "123456" });

  await check("target capabilities are honest about being a non-native test target", async () => {
    const res = await request(base, "/v1/import/capabilities");
    assert.equal(res.status, 200);
    assert.equal(res.body.contract, contract.CONTRACT_ID);
    assert.equal(res.body.native, false);
    assert.equal(res.body.mode, "test");
    assert.equal(res.body.capabilities.cookieStoreWrite, true);
    assert.equal(res.body.capabilities.persistAcrossRestart, false);
    const cap = await client.capabilities();
    assert.equal(cap.ok, true);
    assert.equal(cap.native, false);
    assert.equal(cap.capabilities.persistAcrossRestart, false);
  });

  await check("target enforces pairing and origin while health stays metadata-only", async () => {
    const noPair = await request(base, "/v1/import/status");
    assert.equal(noPair.status, 401);
    const badPair = await request(base, "/v1/import/status", { pair: "000000" });
    assert.equal(badPair.status, 401);
    const badOrigin = await request(base, "/v1/import/cookies", {
      method: "POST",
      pair: "123456",
      origin: "chrome-extension://evil",
      body: importRequest(),
    });
    assert.equal(badOrigin.status, 403);
    const preflight = await request(base, "/v1/import/cookies", {
      method: "OPTIONS",
      origin: `chrome-extension://${SOURCE_EXTENSION_ID}`,
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), `chrome-extension://${SOURCE_EXTENSION_ID}`);
  });

  await check("target applies a job and reports three separate states", async () => {
    const submit = await client.submit(importRequest());
    assert.equal(submit.ok, true);
    const done = await waitForJob({ client, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.view.state, "done");
    assert.equal(done.view.progress.applied, 1);
    assert.equal(done.view.cookieImported.status, "imported");
    assert.equal(done.view.loginVerified.status, "not_verified");
    assert.equal(done.view.dataCopied.cookies, false);
    const text = JSON.stringify(done.view);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
    assert.equal(backend.snapshot().length, 1);
    assert.equal(backend.snapshot()[0].value, CANARY);
  });

  await check("target status is idempotent per requestId", async () => {
    const request = importRequest({ requestId: "req-duplicate-1" });
    const first = await client.submit(request);
    assert.equal(first.ok, true);
    const second = await client.submit(request);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.jobId, first.jobId);
  });

  await check("target rejects a second job while one is applying", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const baseBackend = createMemoryBackend();
    let firstStarted;
    const started = new Promise((resolve) => {
      firstStarted = resolve;
    });
    const slow = {
      ...baseBackend,
      async applyCookie(c) {
        firstStarted();
        await gate;
        return baseBackend.applyCookie(c);
      },
    };
    const tBusy = startLocalTarget({ port: 0, pair: "333444", backend: slow, log: () => {} });
    await tBusy.listening;
    const busyClient = new TargetClient({ endpoint: tBusy.endpoint, pair: "333444" });
    const first = await busyClient.submit(importRequest({ requestId: "req-busy-1" }));
    assert.equal(first.ok, true);
    await started;
    const second = await busyClient.submit(importRequest({ requestId: "req-busy-2" }));
    assert.equal(second.ok, false);
    assert.equal(second.error, "target-busy");
    release();
    const terminal = await waitForJob({ client: busyClient, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(terminal.ok, true);
    await tBusy.close();
  });

  await check("target reports partial and total write failures without leaking values", async () => {
    const failing = createMemoryBackend({
      failWith: (c) => (c.name === "bad" ? "partitioned-cookie-rejected" : null),
    });
    const t2 = startLocalTarget({ port: 0, pair: "654321", backend: failing, log: () => {} });
    await t2.listening;
    const c2 = new TargetClient({ endpoint: t2.endpoint, pair: "654321" });
    const submit = await c2.submit(
      importRequest({
        requestId: "req-partial-1",
        cookies: [cookie({ name: "good" }), cookie({ name: "bad", value: CANARY2 })],
      }),
    );
    assert.equal(submit.ok, true);
    const done = await waitForJob({ client: c2, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(done.ok, true);
    assert.equal(done.view.cookieImported.status, "partially_imported");
    assert.equal(done.view.cookieImported.applied, 1);
    assert.equal(done.view.cookieImported.failed, 1);
    assert.equal(done.view.cookieImported.failures["partitioned-cookie-rejected"], 1);
    assert.equal(JSON.stringify(done.view).includes(CANARY2), false);

    const allBad = createMemoryBackend({ failWith: () => "samesite-rejected" });
    const t3 = startLocalTarget({ port: 0, pair: "654322", backend: allBad, log: () => {} });
    await t3.listening;
    const c3 = new TargetClient({ endpoint: t3.endpoint, pair: "654322" });
    await c3.submit(importRequest({ requestId: "req-allfail-1" }));
    const failed = await waitForJob({ client: c3, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(failed.ok, true);
    assert.equal(failed.view.state, "failed");
    assert.equal(failed.view.cookieImported.status, "failed");
    assert.equal(failed.view.loginVerified.status, "not_verified");
    await t2.close();
    await t3.close();
  });

  await check("target cancel stops future writes and never claims a rollback", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const baseBackend = createMemoryBackend();
    let firstStarted;
    const started = new Promise((resolve) => {
      firstStarted = resolve;
    });
    const slow = {
      ...baseBackend,
      async applyCookie(c) {
        firstStarted();
        await gate;
        return baseBackend.applyCookie(c);
      },
    };
    const t4 = startLocalTarget({ port: 0, pair: "111222", backend: slow, log: () => {} });
    await t4.listening;
    const c4 = new TargetClient({ endpoint: t4.endpoint, pair: "111222" });
    const submit = await c4.submit(
      importRequest({
        requestId: "req-cancel-1",
        cookies: [cookie({ name: "a" }), cookie({ name: "b" }), cookie({ name: "c" })],
      }),
    );
    assert.equal(submit.ok, true);
    await started;
    const cancel = await c4.cancel(submit.jobId);
    assert.equal(cancel.ok, true);
    release();
    const terminal = await waitForJob({ client: c4, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(terminal.ok, true);
    assert.equal(terminal.view.state, "cancelled");
    assert.ok(terminal.view.progress.applied <= 1, JSON.stringify(terminal.view));
    assert.ok(terminal.view.progress.failed === 0);
    await t4.close();
  });

  await check("target rejects oversized bodies, wrong content type, and unknown routes", async () => {
    const tSmall = startLocalTarget({
      port: 0,
      pair: "123456",
      allowedOrigins: [`chrome-extension://${SOURCE_EXTENSION_ID}`],
      backend: createMemoryBackend(),
      maxBytes: 2048,
      log: () => {},
    });
    await tSmall.listening;
    const huge = await request(tSmall.endpoint, "/v1/import/cookies", {
      method: "POST",
      pair: "123456",
      body: importRequest({ cookies: [cookie({ value: "x".repeat(4096) })] }),
    });
    assert.equal(huge.status, 413);
    await tSmall.close();
    const wrongType = await request(base, "/v1/import/cookies", {
      method: "POST",
      pair: "123456",
      body: importRequest({ requestId: "req-wrong-type" }),
      contentType: "text/plain",
    });
    assert.equal(wrongType.status, 415);
    const verifyRoute = await request(base, "/v1/import/verify", { method: "POST", pair: "123456", body: {} });
    assert.equal(verifyRoute.status, 404);
  });

  await check("target logs contain counts/ids only, never values, names or domains", async () => {
    const text = targetLogs.join("\n");
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
    assert.ok(text.includes("accepted"));
  });

  await target.close();

  await check("test-only CDP mapping preserves host-only/domain, session and partition fields", async () => {
    // Imported lazily so the memory-target tests do not depend on CDP.
    const cdp = await import("./import/target/cdp-backend.mjs");
    const hostOnly = cdp.toCdpCookie(
      cookie({ domain: "plain.test", hostOnly: true, session: true, secure: false, path: "/x" }),
    );
    assert.equal(hostOnly.url, "http://plain.test/x");
    assert.equal(hostOnly.domain, undefined);
    assert.equal(hostOnly.expires, undefined);
    assert.equal(hostOnly.path, "/x");
    const domainCookie = cdp.toCdpCookie(cookie());
    assert.equal(domainCookie.domain, ".example.test");
    assert.equal(domainCookie.expires, 2000000000);
    assert.equal(domainCookie.sameSite, "Lax");
    const partitioned = cdp.toCdpCookie(
      cookie({ partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true } }),
    );
    assert.deepEqual(partitioned.partitionKey, {
      topLevelSite: "https://top.test",
      hasCrossSiteAncestor: true,
    });
  });

  // ---------------------------------------------------------------------
  // E. CLI flow, report and explicit login confirmation
  // ---------------------------------------------------------------------
  await check("waitForJob honors retries, timeouts and abort without inventing a login", async () => {
    const fake = {
      calls: 0,
      async status() {
        this.calls += 1;
        if (this.calls === 1) {
          return {
            ok: true,
            idle: false,
            view: contract.sanitizePublicJobView(
              contract.createPublicJobView({
                id: "c".repeat(24),
                state: "done",
                totals: { cookies: 1, domains: 1, selectedDomains: 1 },
                progress: { applied: 1, failed: 0 },
                failures: {},
                createdAt: "x",
                updatedAt: "y",
              }),
            ),
          };
        }
        return { ok: true, idle: true, view: null };
      },
    };
    const ignored = await waitForJob({
      client: fake,
      afterJobId: "c".repeat(24),
      timeoutMs: 60,
      intervalMs: 5,
    });
    assert.equal(ignored.ok, false);
    assert.equal(ignored.error, "timeout");

    const controller = new AbortController();
    controller.abort();
    const aborted = await waitForJob({ client: fake, timeoutMs: 1000, signal: controller.signal });
    assert.equal(aborted.error, "cancelled-by-user");
  });

  await check("reports contain no cookie names/values/domains before user confirmation", () => {
    const view = contract.sanitizePublicJobView(
      contract.createPublicJobView({
        id: "d".repeat(24),
        state: "done",
        totals: { cookies: 2, domains: 1, selectedDomains: 1 },
        progress: { applied: 1, failed: 1 },
        failures: { "partitioned-cookie-rejected": 1 },
        createdAt: "x",
        updatedAt: "y",
      }),
    );
    const report = createCookieImportReport({
      source: { browser: "chrome", browserName: "Chrome", label: "Synthetic", dirName: "Default" },
      target: {
        product: "BrowserPilot local contract target",
        mode: "test",
        native: false,
        capabilities: { persistAcrossRestart: false },
      },
      view,
      startedAt: "2026-01-01T00:00:00.000Z",
      consentAt: "2026-01-01T00:00:01.000Z",
    });
    const text = JSON.stringify(report);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
    assert.equal(report.loginVerified.status, "not_verified");
    assert.equal(report.cookieImported.status, "partially_imported");
    const written = writeCookieImportReport({ reportDir: path.join(tmp, "reports"), report });
    assert.equal(fs.existsSync(written.path), true);
    const read = readReport(written.path);
    assert.equal(read.ok, true);
    assert.equal(read.report.cookieImported.applied, 1);
    assert.equal(formatThreeState(view).includes(CANARY), false);
    assert.equal(formatThreeState(view).includes("example.test"), false);
    assert.ok(reloginGuidance(view).includes("Browser CLI"));
  });

  let reportPath = null;
  await check("CLI connect + external target end-to-end writes a count-only report", async () => {
    const t5 = startLocalTarget({ port: 0, pair: "777888", backend: createMemoryBackend(), log: () => {} });
    await t5.listening;
    const reportDir = path.join(tmp, "cli-reports");
    const child = spawn(
      process.execPath,
      [
        CLI,
        "connect",
        "--source",
        "chrome:Default",
        "--endpoint",
        t5.endpoint,
        "--pair",
        "777888",
        "--report-dir",
        reportDir,
        "--timeout-ms",
        "15000",
        "--json",
        ...roots.rootArgs,
      ],
      {
        env: { ...process.env, BP_IMPORT_TEST_MODE: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const c5 = new TargetClient({ endpoint: t5.endpoint, pair: "777888" });
    const submit = await c5.submit(importRequest({ requestId: "req-cli-1" }));
    assert.equal(submit.ok, true);
    const code = await exited;
    await t5.close();
    assert.equal(code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.report.cookieImported.status, "imported");
    assert.equal(parsed.report.loginVerified.status, "not_verified");
    assert.equal(parsed.report.target.native, false);
    assert.equal(stdout.includes(CANARY), false);
    assert.equal(stdout.includes("example.test"), false);
    reportPath = parsed.reportPath;
    assert.equal(fs.existsSync(reportPath), true);
    const text = readText(reportPath);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
  });

  await check("CLI connect with the local test target prints pairing and completes", async () => {
    const reportDir = path.join(tmp, "local-target-reports");
    const child = spawn(
      process.execPath,
      [
        CLI,
        "connect",
        "--source",
        "chrome:Default",
        "--report-dir",
        reportDir,
        "--timeout-ms",
        "15000",
        "--yes",
        ...roots.rootArgs,
      ],
      {
        env: { ...process.env, BP_IMPORT_TEST_MODE: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let submitted = false;
    let submitPromise = Promise.resolve(null);
    child.stdout.on("data", (d) => {
      stdout += d;
      const m = stdout.match(/地址填 (http:\/\/127\.0\.0\.1:\d+)，配对码填 (\d{6})/);
      if (m && !submitted) {
        submitted = true;
        const client = new TargetClient({ endpoint: m[1], pair: m[2] });
        submitPromise = client.submit(importRequest({ requestId: "req-local-cli-1" }));
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve) => child.on("close", resolve));
    const submit = await submitPromise;
    assert.equal(code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.equal(submitted, true);
    assert.equal(submit.ok, true);
    assert.ok(stdout.includes("这是本地测试目标"));
    assert.ok(stdout.includes("persistAcrossRestart=false"));
    assert.ok(stdout.includes("三态结果"));
    assert.ok(stdout.includes("Cookie 写入：已写入"));
    assert.ok(stdout.includes("实际登录：未验证"));
    assert.equal(stdout.includes(CANARY), false);
    assert.equal(stdout.includes("example.test"), false);
    const reportFile = stdout.match(/report: (.+\.json)/);
    assert.ok(reportFile);
    assert.equal(fs.existsSync(reportFile[1].trim()), true);
    assert.equal(readText(reportFile[1].trim()).includes(CANARY), false);
  });

  await check("CLI refuses an unsupported source browser and a missing pairing code", () => {
    const ff = runCli(
      ["connect", "--source", "firefox:ff.default", "--json", ...roots.rootArgs],
      { expect: 3 },
    );
    const ffJson = JSON.parse(ff.stdout);
    assert.equal(ffJson.ok, false);
    assert.equal(ffJson.error, "source-browser-unsupported");

    const noPair = runCli(
      ["connect", "--source", "chrome:Default", "--endpoint", "http://127.0.0.1:1", "--json", ...roots.rootArgs],
      { expect: 2 },
    );
    assert.ok(noPair.combined.includes("--pair"));

    const badFormat = runCli(
      [
        "connect",
        "--source",
        "chrome:Default",
        "--endpoint",
        "http://127.0.0.1:1",
        "--pair",
        "12345",
        "--json",
        ...roots.rootArgs,
      ],
      { expect: 2 },
    );
    assert.ok(badFormat.combined.includes("6 digits"));
  });

  await check("CLI rejects a wrong pairing code before waiting for a job", async () => {
    const tPair = startLocalTarget({ port: 0, pair: "999999", backend: createMemoryBackend(), log: () => {} });
    await tPair.listening;
    const res = await runCliAsync([
      "connect",
      "--source",
      "chrome:Default",
      "--endpoint",
      tPair.endpoint,
      "--pair",
      "000000",
      "--json",
      ...roots.rootArgs,
    ]);
    await tPair.close();
    assert.equal(res.status, 3, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "pairing-required");
  });

  await check("CLI confirm-login refuses automatic confirmation and never upgrades cookie state", () => {
    assert.ok(reportPath);
    const before = readReport(reportPath).report;
    const refused = runCli(
      ["confirm-login", "--file", reportPath, "--domain", "example.test", "--status", "user_confirmed"],
      { expect: 3 },
    );
    assert.ok(refused.combined.includes("explicit-user-action-required"));
    const unchanged = readReport(reportPath).report;
    assert.deepEqual(unchanged.cookieImported, before.cookieImported);
    assert.equal(unchanged.loginVerified.status, "not_verified");

    const confirmed = runCli(
      [
        "confirm-login",
        "--file",
        reportPath,
        "--domain",
        "example.test",
        "--status",
        "user_confirmed",
        "--confirm-user-action",
        "--json",
      ],
      { expect: 0 },
    );
    const parsed = JSON.parse(confirmed.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.report.loginVerified.status, "user_confirmed");
    assert.equal(parsed.report.loginChecks.length, 1);
    assert.equal(parsed.report.loginChecks[0].domain, "example.test");
    assert.deepEqual(parsed.report.cookieImported, before.cookieImported);
    assert.equal(parsed.report.dataCopied.cookies, false);
    assert.equal(JSON.stringify(parsed.report).includes(CANARY), false);
  });

  await check("CLI report command prints counts and the explicit login check", () => {
    const res = runCli(["report", "--file", reportPath], { expect: 0 });
    assert.ok(res.stdout.includes("cookies: imported"));
    assert.ok(res.stdout.includes("login verified: user_confirmed"));
    assert.ok(res.stdout.includes("example.test"));
    assert.equal(res.stdout.includes(CANARY), false);
  });

  await check("source profiles are byte-identical after the whole product flow", () => {
    assert.deepEqual(hashTree(roots.chromeRoot), sourceHashBefore.chrome);
    assert.deepEqual(hashTree(roots.edgeRoot), sourceHashBefore.edge);
    assert.deepEqual(hashTree(roots.ffRoot), sourceHashBefore.firefox);
  });

  await check("no temporary output contains a canary", () => {
    // Only inspect the temp dir created by this test; never scan real profiles.
    const walk = (dir) => {
      let text = "";
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) text += walk(p);
        else if (ent.isFile()) text += fs.readFileSync(p, "utf8");
      }
      return text;
    };
    const text = walk(tmp);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes(CANARY2), false);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`\n${f.name}\n${f.error && f.error.stack ? f.error.stack : f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
