#!/usr/bin/env node
// Product-level tests for the Browser CLI cookie-import flow (contract v2).
//
// Everything is synthetic: temp profile roots, synthetic cookies with canary
// values, no browser launch, no real Chrome/Edge/Firefox profile, no real
// session tokens. The tests assert the three-state model, explicit consent,
// one-time ticket semantics, target-side authorization, loopback test-target
// behavior, no cookie values in logs/reports/views, and the contract between
// the source extension and the native host/target.
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
import { waitForJob, formatThreeState, reloginGuidance, formatCapabilities } from "./import/lib/wizard.mjs";
import {
  createCookieImportReport,
  writeCookieImportReport,
  readReport,
  formatCookieImportReport,
} from "./import/lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(REPO, "scripts", "import", "browser-data-import.mjs");
const EXT = path.join(REPO, "extensions", "import-source");
const SOURCE_EXTENSION_ID = "ljoekiddijnohefaghljlcodgljienoj";
const TEST_TICKET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const CANARY = "COOKIE-PRODUCT-CANARY-4f9d2a";
const CANARY2 = "COOKIE-PRODUCT-CANARY-8b71ce";

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
  const value = {
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
  // Chrome omits expirationDate for session cookies. Tests that deliberately
  // send an inconsistent record pass an explicit expirationDate.
  if (value.session && overrides.expirationDate === undefined) delete value.expirationDate;
  return value;
}

async function importRequest(overrides = {}) {
  const domains = overrides.domains || ["example.test"];
  const consent = overrides.consent !== undefined
    ? overrides.consent
    : await contract.buildConsent({ extensionVersion: "0.3.0", domains });
  return {
    contract: contract.CONTRACT_ID,
    protocolVersion: contract.PROTOCOL_VERSION,
    jobNonce: "a".repeat(32),
    source: { browser: "chrome", profileLabel: "Synthetic", extensionVersion: "0.3.0" },
    consent,
    domains,
    cookies: [cookie()],
    ...overrides,
    consent,
    domains,
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

async function request(base, pathname, { method = "GET", ticket, origin, body, rawBody, digest, contentType } = {}) {
  const headers = {};
  if (ticket) headers["x-bp-ticket"] = ticket;
  if (origin) headers.origin = origin;
  if (digest) headers["x-bp-job-digest"] = digest;
  if (body !== undefined || rawBody !== undefined) headers["content-type"] = contentType || "application/json";
  const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${base}${pathname}`, { method, headers, body: payload });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}

async function submitRequest(base, requestBody, ticket) {
  const text = JSON.stringify(requestBody);
  const digest = await contract.jobDigest(text);
  return request(base, "/v2/import/cookies", {
    method: "POST",
    ticket,
    rawBody: text,
    digest,
  });
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
  // A. Contract v2: ticket, consent, cookie policy, public views
  // ---------------------------------------------------------------------
  await check("contract accepts a well-formed v2 request and normalizes counts", async () => {
    const res = await contract.validateImportRequest(
      await importRequest({
        domains: ["example.test", "sub.example.test"],
        cookies: [
          cookie(),
          cookie({ domain: "sub.example.test", hostOnly: true, value: CANARY2, session: true }),
        ],
      }),
    );
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.deepEqual(res.normalized.totals, {
      cookies: 2,
      domains: 2,
      selectedDomains: 2,
      hostOnlyCookies: 1,
      domainCookies: 1,
      sessionCookies: 1,
      partitionedCookies: 0,
    });
    assert.equal(res.normalized.cookies[0].value, CANARY);
    assert.equal(res.normalized.cookies[1].session, true);
    assert.equal(res.normalized.cookies[1].expirationDate, undefined);
  });

  await check("contract rejects missing consent, stale consent, bad nonce and unselected domains", async () => {
    const cases = [
      [{ ...(await importRequest()), consent: undefined }, "consent.missing"],
      [
        await importRequest({
          consent: {
            kind: "implicit",
            at: new Date().toISOString(),
            extensionVersion: "x",
            scope: "selected-domains",
            domainsDigest: "0".repeat(64),
          },
        }),
        "consent.kind-invalid",
      ],
      [await importRequest({ jobNonce: "short" }), "jobNonce-invalid"],
      [await importRequest({ domains: [] }), "domains-empty"],
      [await importRequest({ domains: ["example.test", "example.test"] }), "domains[1]-duplicate"],
      [await importRequest({ cookies: [] }), "cookies-empty"],
      [await importRequest({ domains: ["other.test"] }), "domain-not-selected"],
      [await importRequest({ cookies: [cookie({ value: "x".repeat(9000) })] }), "value-too-long"],
      [await importRequest({ cookies: [cookie({ sameSite: "weird" })] }), "sameSite-invalid"],
      [await importRequest({ cookies: [cookie({ session: false, expirationDate: undefined })] }), "expirationDate-invalid"],
      [await importRequest({ cookies: [cookie({ domain: "bad domain" })] }), "domain-invalid"],
      [await importRequest({ cookies: [cookie({ hostOnly: true })] }), "hostOnly-domain-has-dot"],
      [await importRequest({ cookies: [cookie({ domain: "example.test", hostOnly: false })] }), "domain-cookie-missing-dot"],
      [await importRequest({ cookies: [cookie({ session: true, expirationDate: 2000000000 })] }), "session-cookie-has-expiration"],
    ];
    for (const [payload, expected] of cases) {
      const res = await contract.validateImportRequest(payload);
      assert.equal(res.ok, false, `${expected} unexpectedly accepted`);
      assert.ok(res.errors.some((e) => e.includes(expected)), `${expected} not in ${res.errors.join(",")}`);
      assert.equal(JSON.stringify(res).includes(CANARY), false, "validation result leaked a cookie value");
      assert.equal(JSON.stringify(res).includes("example.test"), false, "validation result leaked a domain");
    }
  });

  await check("contract rejects consent that is not bound to the exact domain scope", async () => {
    const payload = await importRequest({ domains: ["example.test"] });
    const wrong = { ...payload, consent: { ...payload.consent, domainsDigest: "f".repeat(64) } };
    const res = await contract.validateImportRequest(wrong);
    assert.equal(res.ok, false);
    assert.ok(res.errors.includes("consent.domains-digest-mismatch"));

    const old = {
      ...payload,
      consent: {
        ...payload.consent,
        at: new Date(Date.now() - contract.CONSENT_MAX_AGE_MS - 60_000).toISOString(),
      },
    };
    const stale = await contract.validateImportRequest(old);
    assert.equal(stale.ok, false);
    assert.ok(stale.errors.includes("consent.at-too-old"));
  });

  await check("cookie prefix, SameSite, partitioned and expiry policy is enforced", async () => {
    const cases = [
      [{ name: "__Host-sid", hostOnly: false }, "cookie-prefix-rejected"],
      [{ name: "__Host-sid", path: "/x" }, "cookie-prefix-rejected"],
      [{ name: "__Secure-sid", secure: false }, "cookie-prefix-rejected"],
      [{ name: "__Http-sid", httpOnly: false }, "cookie-prefix-rejected"],
      [{ sameSite: "no_restriction", secure: false }, "samesite-none-requires-secure"],
      [{ secure: false, partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true } }, "partitioned-requires-secure"],
      [{ partitionKey: { topLevelSite: "https://top.test/path", hasCrossSiteAncestor: true } }, "partitionKey.topLevelSite-invalid"],
      [{ partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: "yes" } }, "partitionKey.hasCrossSiteAncestor-invalid"],
      [{ expirationDate: Math.floor(Date.now() / 1000) - 60 }, "expirationDate-in-past"],
    ];
    for (const [overrides, expected] of cases) {
      const payload = await importRequest({ cookies: [cookie(overrides)] });
      const res = await contract.validateImportRequest(payload);
      assert.equal(res.ok, false, `${expected} unexpectedly accepted`);
      assert.ok(res.errors.some((e) => e.includes(expected)), `${expected} not in ${res.errors.join(",")}`);
    }
    const good = await contract.validateImportRequest(
      await importRequest({ cookies: [cookie({ name: "__Host-sid", hostOnly: true, domain: "example.test" })] }),
    );
    assert.equal(good.ok, true, JSON.stringify(good.errors));
  });

  await check("domain selection matches the selected domain and subdomains, not parents", () => {
    assert.equal(contract.domainMatchesSelection(".example.test", ["example.test"]), true);
    assert.equal(contract.domainMatchesSelection("sub.example.test", ["example.test"]), true);
    assert.equal(contract.domainMatchesSelection(".example.test", ["sub.example.test"]), false);
    assert.equal(contract.domainMatchesSelection("notexample.test", ["example.test"]), false);
  });

  await check("ticket is 160-bit, formatted, normalized and hashed one-way", async () => {
    const ticket = contract.generateTicket();
    assert.equal(ticket.length, 32);
    assert.equal(contract.isValidTicket(ticket), true);
    const formatted = contract.formatTicket(ticket);
    assert.ok(formatted.startsWith("BCLI-"));
    assert.equal(contract.normalizeTicket(formatted), ticket);
    assert.equal(contract.isValidTicket("123456"), false);
    assert.equal(contract.isValidTicket("BCLI-0000-0000-0000-0000-0000-0000-0000-0000"), true);
    const hash = await contract.ticketHash(ticket);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(await contract.ticketMatchesHash(formatted, hash), true);
    assert.equal(await contract.ticketMatchesHash(contract.generateTicket(), hash), false);
    assert.equal(hash.includes(ticket), false);
  });

  await check("session descriptor is short-lived, bound to target/profile/job surface and excludes the ticket", async () => {
    const ticket = contract.generateTicket();
    const descriptor = contract.createSessionDescriptor({
      targetProduct: "Browser CLI",
      targetVersion: "156.0.8067.0",
      targetPid: process.pid,
      targetStartTimeMs: Date.now() - 1000,
      targetInstanceId: "1".repeat(32),
      profileHash: "2".repeat(64),
      ticketHash: await contract.ticketHash(ticket),
      transport: "named-pipe",
      pipeName: `\\\\.\\pipe\\browser-cli-import-${"3".repeat(32)}`,
    });
    assert.equal(contract.validateSessionDescriptor(descriptor).ok, true);
    assert.equal(JSON.stringify(descriptor).includes(ticket), false);
    assert.equal(JSON.stringify(descriptor).includes(CANARY), false);
    const expired = { ...descriptor, expiresAt: new Date(Date.now() - 1000).toISOString() };
    assert.equal(contract.validateSessionDescriptor(expired).ok, false);
    const tooLong = {
      ...descriptor,
      createdAt: new Date(Date.now() - contract.TICKET_TTL_MS * 2).toISOString(),
      expiresAt: new Date(Date.now() + contract.TICKET_TTL_MS).toISOString(),
    };
    assert.equal(contract.validateSessionDescriptor(tooLong).ok, false);
  });

  await check("chunking preserves bytes and detects a tampered digest", async () => {
    const text = JSON.stringify({ hello: "world", value: CANARY, nested: { a: 1, b: [1, 2, 3] } });
    const chunks = contract.chunkJobPayload(text);
    assert.ok(chunks.length >= 1);
    assert.equal(contract.decodeUtf8(contract.assembleChunks(chunks)), text);
    const digest = await contract.jobDigest(text);
    const tampered = contract.decodeUtf8(contract.assembleChunks([chunks[0].slice(0, -4) + "AAAA"]));
    assert.notEqual(await contract.jobDigest(tampered), digest);
  });

  await check("public job view and sanitizer contain counts only and force not_verified", async () => {
    const consent = await contract.buildConsent({ extensionVersion: "0.3.0", domains: ["example.test"] });
    const job = {
      id: "a".repeat(24),
      state: "done",
      transport: "named-pipe",
      native: true,
      totals: {
        cookies: 2,
        domains: 1,
        selectedDomains: 1,
        sessionCookies: 1,
        partitionedCookies: 0,
      },
      progress: { applied: 1, failed: 1 },
      failures: { "partitioned-cookie-rejected": 1 },
      authorization: {
        targetUserConfirmed: true,
        simulated: false,
        source: "target-browser-dialog",
        scopeDigest: consent.domainsDigest,
        confirmedAt: new Date().toISOString(),
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const view = contract.createPublicJobView(job);
    const text = JSON.stringify(view);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
    assert.equal(view.loginVerified.status, "not_verified");
    assert.equal(view.authorization.targetUserConfirmed, true);
    assert.equal(view.authorization.simulated, false);
    assert.equal(view.sessionCookies.mayNotSurviveRestart, true);
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
    assert.equal(contract.sanitizePublicJobView({ ...view, jobId: "not-hex" }), null);
  });

  await check("target authorization never becomes login verification", async () => {
    const view = contract.createPublicJobView({
      id: "e".repeat(24),
      state: "done",
      transport: "named-pipe",
      native: true,
      totals: { cookies: 1, domains: 1, selectedDomains: 1 },
      progress: { applied: 1, failed: 0 },
      failures: {},
      authorization: {
        targetUserConfirmed: true,
        simulated: false,
        source: "target-browser-dialog",
        scopeDigest: "a".repeat(64),
      },
      createdAt: "x",
      updatedAt: "y",
    });
    assert.equal(view.authorization.targetUserConfirmed, true);
    assert.equal(view.loginVerified.status, "not_verified");
    const report = createCookieImportReport({
      source: { browser: "chrome", browserName: "Chrome", label: "Synthetic" },
      target: { product: "Browser CLI", mode: "native", native: true, capabilities: { persistAcrossRestart: true } },
      view,
    });
    assert.equal(report.authorization.targetUserConfirmed, true);
    assert.equal(report.loginVerified.status, "not_verified");
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
  await check("source extension manifest is minimal, MV3, native-messaging-only and keyed to the product id", () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual([...manifest.permissions].sort(), ["cookies", "nativeMessaging", "storage"]);
    assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
    assert.equal(manifest.background.type, "module");
    assert.equal(manifest.action.default_popup, "popup.html");
    for (const forbidden of ["tabs", "history", "bookmarks", "downloads", "webRequest", "management"]) {
      assert.equal(manifest.permissions.includes(forbidden), false, `forbidden permission ${forbidden}`);
    }
    assert.equal(extensionIdFromManifestKey(manifest.key), SOURCE_EXTENSION_ID);
    assert.equal(manifest.version, "0.3.0");
  });

  await check("extension sources contain no logging, persistent storage, HTTP or history APIs", () => {
    const files = [
      "service-worker.js",
      "popup.js",
      "popup.html",
      "lib/selection.mjs",
      "lib/contract.mjs",
      "lib/native-transport.mjs",
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
      // The shared contract keeps a literal-loopback validator for the test
      // target; it is not a destination and the service worker never calls it.
      if (relative !== "lib/contract.mjs") {
        for (const match of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
          assert.fail(`${relative} contains HTTP URL ${match[0]}; the source extension must use native messaging only`);
        }
      }
    }
    const worker = readText(path.join(EXT, "service-worker.js"));
    assert.ok(worker.includes("consent !== true"));
    assert.ok(worker.includes("acknowledged !== true"));
    assert.ok(worker.includes("createNativeTransport"));
    assert.ok(worker.includes("isValidTicket"));
    assert.ok(worker.includes("buildConsent"));
    assert.equal(worker.includes("validatePairCode"), false);
    assert.equal(worker.includes("127.0.0.1"), false);
    const transport = readText(path.join(EXT, "lib/native-transport.mjs"));
    assert.ok(transport.includes("connectNative"));
    assert.ok(transport.includes("connectNative(hostName)"));
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
      transport: "named-pipe",
      native: true,
      totals: { cookies: 1, domains: 1, selectedDomains: 1, sessionCookies: 0 },
      progress: { applied: 1, failed: 0 },
      failures: {},
      authorization: { targetUserConfirmed: true, simulated: false, source: "target-browser-dialog" },
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
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized.view, "cookies"), false);
    assert.equal(sanitizeJobView({ ...view, state: "weird" }, contract).ok, false);
    assert.equal(sanitizeJobView({ ...view, jobId: "bad" }, contract).ok, false);
  });

  await check("loopback endpoint validator is test-only and rejects DNS, LAN, TLS, paths and credentials", () => {
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
  // D. Local HTTP test target: one-time ticket, authorization, jobs
  // ---------------------------------------------------------------------
  const targetLogs = [];
  const backend = createMemoryBackend();
  const target = startLocalTarget({
    port: 0,
    ticket: TEST_TICKET,
    allowedOrigins: [`chrome-extension://${SOURCE_EXTENSION_ID}`],
    backend,
    log: (line) => targetLogs.push(line),
  });
  const port = await target.listening;
  const base = `http://127.0.0.1:${port}`;
  const client = new TargetClient({ endpoint: base, ticket: TEST_TICKET });

  await check("test target capabilities are honest: native=false, http-test, simulated authorization", async () => {
    const res = await request(base, "/v2/import/capabilities");
    assert.equal(res.status, 200);
    assert.equal(res.body.contract, contract.CONTRACT_ID);
    assert.equal(res.body.native, false);
    assert.equal(res.body.mode, "test");
    assert.equal(res.body.transport, "http-test");
    assert.equal(res.body.authorization.independentTargetConfirmation, false);
    assert.equal(res.body.capabilities.cookieStoreWrite, true);
    assert.equal(res.body.capabilities.persistAcrossRestart, false);
    assert.equal(res.body.capabilities.sessionCookiePersistence, "not_guaranteed");
    const cap = await client.capabilities();
    assert.equal(cap.ok, true);
    assert.equal(cap.native, false);
    assert.equal(cap.capabilities.persistAcrossRestart, false);
    assert.ok(formatCapabilities(cap).includes("不是 Browser CLI 原生目标"));
  });

  await check("test target requires the one-time ticket and does not expose an approval endpoint", async () => {
    const noTicket = await request(base, "/v2/import/status");
    assert.equal(noTicket.status, 401);
    const badTicket = await request(base, "/v2/import/status", { ticket: "0".repeat(32) });
    assert.equal(badTicket.status, 401);
    // A valid ticket with no job digest is rejected before it is consumed.
    const noDigest = await request(base, "/v2/import/cookies", {
      method: "POST",
      ticket: TEST_TICKET,
      rawBody: JSON.stringify(await importRequest()),
    });
    assert.equal(noDigest.status, 400);
    assert.equal(noDigest.body.error, "job-digest-required");
    // No Origin is allowed for local test clients; a hostile Origin is not.
    const hostile = await request(base, "/v2/import/cookies", {
      method: "POST",
      ticket: TEST_TICKET,
      origin: "chrome-extension://evil",
      rawBody: "{}",
      digest: "0".repeat(64),
    });
    assert.equal(hostile.status, 403);
    const approve = await request(base, "/v2/import/approve", { method: "POST", ticket: TEST_TICKET, body: {} });
    assert.equal(approve.status, 404);
    const preflight = await request(base, "/v2/import/cookies", {
      method: "OPTIONS",
      origin: `chrome-extension://${SOURCE_EXTENSION_ID}`,
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), `chrome-extension://${SOURCE_EXTENSION_ID}`);
  });

  await check("test target applies a job, reports target authorization and three separate states", async () => {
    const requestBody = await importRequest({
      jobNonce: "b".repeat(32),
      cookies: [
        cookie({ name: "persistent" }),
        cookie({ name: "session", session: true }),
        cookie({
          name: "partitioned",
          partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true },
        }),
      ],
    });
    const submit = await client.submit(requestBody);
    assert.equal(submit.ok, true, JSON.stringify(submit));
    const done = await waitForJob({ client, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.view.state, "done");
    assert.equal(done.view.progress.applied, 3);
    assert.equal(done.view.cookieImported.status, "imported");
    assert.equal(done.view.loginVerified.status, "not_verified");
    assert.equal(done.view.dataCopied.cookies, false);
    assert.equal(done.view.authorization.targetUserConfirmed, true);
    assert.equal(done.view.authorization.simulated, true);
    assert.equal(done.view.sessionCookies.count, 1);
    assert.equal(done.view.sessionCookies.mayNotSurviveRestart, true);
    const text = JSON.stringify(done.view);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
    assert.equal(backend.snapshot().length, 3);
    assert.equal(backend.snapshot()[0].value, CANARY);
    assert.equal(formatThreeState(done.view).includes("实际登录：未验证"), true);
    assert.equal(formatThreeState(done.view).includes("测试目标模拟"), true);
  });

  await check("test target rejects a second submit with the consumed ticket", async () => {
    const res = await submitRequest(base, await importRequest({ jobNonce: "c".repeat(32) }), TEST_TICKET);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "ticket-consumed");
  });

  await check("test target enforces the job digest and content type before accepting", async () => {
    const t = startLocalTarget({ port: 0, ticket: "11111111111111111111111111111111", backend: createMemoryBackend(), log: () => {} });
    await t.listening;
    const c = new TargetClient({ endpoint: t.endpoint, ticket: "11111111111111111111111111111111" });
    const text = JSON.stringify(await importRequest({ jobNonce: "d".repeat(32) }));
    const noDigest = await request(t.endpoint, "/v2/import/cookies", {
      method: "POST",
      ticket: t.ticket,
      rawBody: text,
    });
    assert.equal(noDigest.status, 400);
    assert.equal(noDigest.body.error, "job-digest-required");
    const badDigest = await request(t.endpoint, "/v2/import/cookies", {
      method: "POST",
      ticket: t.ticket,
      rawBody: text,
      digest: "f".repeat(64),
    });
    assert.equal(badDigest.status, 400);
    assert.equal(badDigest.body.error, "job-digest-mismatch");
    const wrongType = await request(t.endpoint, "/v2/import/cookies", {
      method: "POST",
      ticket: t.ticket,
      rawBody: text,
      digest: await contract.jobDigest(text),
      contentType: "text/plain",
    });
    assert.equal(wrongType.status, 415);
    const submit = await c.submit(await importRequest({ jobNonce: "e".repeat(32) }));
    assert.equal(submit.ok, true);
    await t.close();
  });

  await check("test target reports partial and total write failures without leaking values", async () => {
    const failing = createMemoryBackend({
      failWith: (c) => (c.name === "bad" ? "partitioned-cookie-rejected" : null),
    });
    const t2 = startLocalTarget({ port: 0, ticket: "22222222222222222222222222222222", backend: failing, log: () => {} });
    await t2.listening;
    const c2 = new TargetClient({ endpoint: t2.endpoint, ticket: t2.ticket });
    const submit = await c2.submit(
      await importRequest({
        jobNonce: "f".repeat(32),
        cookies: [cookie({ name: "good" }), cookie({ name: "bad", value: CANARY2 })],
      }),
    );
    assert.equal(submit.ok, true);
    const done = await waitForJob({ client: c2, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(done.ok, true);
    assert.equal(done.view.state, "done");
    assert.equal(done.view.cookieImported.status, "partially_imported");
    assert.equal(done.view.cookieImported.applied, 1);
    assert.equal(done.view.cookieImported.failed, 1);
    assert.equal(done.view.cookieImported.failures["partitioned-cookie-rejected"], 1);
    assert.equal(JSON.stringify(done.view).includes(CANARY2), false);

    const allBad = createMemoryBackend({ failWith: () => "samesite-rejected" });
    const t3 = startLocalTarget({ port: 0, ticket: "33333333333333333333333333333333", backend: allBad, log: () => {} });
    await t3.listening;
    const c3 = new TargetClient({ endpoint: t3.endpoint, ticket: t3.ticket });
    await c3.submit(await importRequest({ jobNonce: "9".repeat(32) }));
    const failed = await waitForJob({ client: c3, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(failed.ok, true);
    assert.equal(failed.view.state, "failed");
    assert.equal(failed.view.cookieImported.status, "failed");
    assert.equal(failed.view.loginVerified.status, "not_verified");
    await t2.close();
    await t3.close();
  });

  await check("test target rejects public-suffix domain cookies and invalid prefixes", async () => {
    const t = startLocalTarget({ port: 0, ticket: "44444444444444444444444444444444", backend: createMemoryBackend(), log: () => {} });
    await t.listening;
    const c = new TargetClient({ endpoint: t.endpoint, ticket: t.ticket });
    // `test` is a public suffix in the test list; a host-only cookie on it is
    // allowed, a Domain cookie is not.
    await c.submit(
      await importRequest({
        jobNonce: "1".repeat(32),
        domains: ["test"],
        cookies: [cookie({ domain: ".test", hostOnly: false })],
      }),
    );
    const view = await waitForJob({ client: c, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(view.ok, true);
    assert.equal(view.view.state, "failed");
    assert.equal(view.view.cookieImported.failures["public-suffix-rejected"], 1);
    await t.close();
  });

  await check("test target can deny the import and writes nothing", async () => {
    const t = startLocalTarget({
      port: 0,
      ticket: "55555555555555555555555555555555",
      backend: createMemoryBackend(),
      approve: false,
      log: () => {},
    });
    await t.listening;
    const c = new TargetClient({ endpoint: t.endpoint, ticket: t.ticket });
    await c.submit(await importRequest({ jobNonce: "2".repeat(32) }));
    const view = await waitForJob({ client: c, timeoutMs: 5000, intervalMs: 25 });
    assert.equal(view.ok, true);
    assert.equal(view.view.state, "denied");
    assert.equal(view.view.authorization.targetUserConfirmed, false);
    assert.equal(view.view.authorization.simulated, true);
    assert.equal(view.view.cookieImported.status, "not_started");
    assert.equal(t.backend.snapshot().length, 0);
    await t.close();
  });

  await check("test target cancel stops future writes and never claims a rollback", async () => {
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
      async applyCookie(cookieValue) {
        firstStarted();
        await gate;
        return baseBackend.applyCookie(cookieValue);
      },
    };
    const t4 = startLocalTarget({ port: 0, ticket: "66666666666666666666666666666666", backend: slow, log: () => {} });
    await t4.listening;
    const c4 = new TargetClient({ endpoint: t4.endpoint, ticket: t4.ticket });
    const submit = await c4.submit(
      await importRequest({
        jobNonce: "3".repeat(32),
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

  await check("test target enforces failure count and rate limit", async () => {
    const t = startLocalTarget({ port: 0, ticket: "77777777777777777777777777777777", backend: createMemoryBackend(), log: () => {} });
    await t.listening;
    for (let i = 0; i < contract.MAX_TICKET_FAILURES; i += 1) {
      const res = await request(t.endpoint, "/v2/import/status", { ticket: "0".repeat(32) });
      assert.equal(res.status, 401, `attempt ${i}`);
    }
    const limited = await request(t.endpoint, "/v2/import/status", { ticket: "0".repeat(32) });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate-limited");
    await t.close();
  });

  await check("test target rejects oversized bodies and unknown routes", async () => {
    const tSmall = startLocalTarget({
      port: 0,
      ticket: "88888888888888888888888888888888",
      backend: createMemoryBackend(),
      maxBytes: 2048,
      log: () => {},
    });
    await tSmall.listening;
    const text = JSON.stringify(await importRequest({ jobNonce: "4".repeat(32), cookies: [cookie({ value: "x".repeat(4096) })] }));
    const huge = await request(tSmall.endpoint, "/v2/import/cookies", {
      method: "POST",
      ticket: tSmall.ticket,
      rawBody: text,
      digest: await contract.jobDigest(text),
    });
    assert.equal(huge.status, 413);
    await tSmall.close();
    const unknown = await request(base, "/v2/import/verify", { method: "POST", ticket: TEST_TICKET, body: {} });
    assert.equal(unknown.status, 404);
  });

  await check("test target logs contain counts/ids only, never values, names, domains or ticket", async () => {
    const text = targetLogs.join("\n");
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
    assert.equal(text.includes(TEST_TICKET), false);
    assert.ok(text.includes("accepted"));
  });

  await target.close();

  await check("test-only CDP mapping preserves host-only/domain, session and partition fields", async () => {
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
  await check("waitForJob honors retries, timeouts, denial and abort without inventing a login", async () => {
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
                transport: "named-pipe",
                native: true,
                totals: { cookies: 1, domains: 1, selectedDomains: 1 },
                progress: { applied: 1, failed: 0 },
                failures: {},
                authorization: { targetUserConfirmed: true, simulated: false, source: "target-browser-dialog" },
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

    const denied = {
      async status() {
        return {
          ok: true,
          idle: false,
          view: contract.sanitizePublicJobView(
            contract.createPublicJobView({
              id: "d".repeat(24),
              state: "denied",
              transport: "named-pipe",
              native: true,
              totals: { cookies: 1, domains: 1, selectedDomains: 1 },
              progress: { applied: 0, failed: 0 },
              failures: {},
              authorization: { targetUserConfirmed: false, simulated: false, source: "target-browser-dialog" },
              error: { code: "authorization-denied" },
              createdAt: "x",
              updatedAt: "y",
            }),
          ),
        };
      },
    };
    const deniedResult = await waitForJob({ client: denied, timeoutMs: 1000, intervalMs: 5 });
    assert.equal(deniedResult.ok, true);
    assert.equal(deniedResult.view.state, "denied");
    assert.equal(deniedResult.view.loginVerified.status, "not_verified");
  });

  await check("reports contain no cookie names/values/domains before user confirmation", async () => {
    const view = contract.sanitizePublicJobView(
      contract.createPublicJobView({
        id: "d".repeat(24),
        state: "done",
        transport: "named-pipe",
        native: true,
        totals: { cookies: 2, domains: 1, selectedDomains: 1, sessionCookies: 1 },
        progress: { applied: 1, failed: 1 },
        failures: { "partitioned-cookie-rejected": 1 },
        authorization: {
          targetUserConfirmed: true,
          simulated: false,
          source: "target-browser-dialog",
          scopeDigest: "a".repeat(64),
        },
        createdAt: "x",
        updatedAt: "y",
      }),
    );
    const report = createCookieImportReport({
      source: { browser: "chrome", browserName: "Chrome", label: "Synthetic", dirName: "Default" },
      target: {
        product: "Browser CLI",
        mode: "native",
        transport: "named-pipe",
        native: true,
        capabilities: { persistAcrossRestart: true },
        authorization: { mode: "target-browser-dialog", independentTargetConfirmation: true },
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
    assert.equal(report.authorization.targetUserConfirmed, true);
    assert.equal(report.sessionCookies.count, 1);
    const written = writeCookieImportReport({ reportDir: path.join(tmp, "reports"), report });
    assert.equal(fs.existsSync(written.path), true);
    const read = readReport(written.path);
    assert.equal(read.ok, true);
    assert.equal(read.report.cookieImported.applied, 1);
    assert.equal(formatThreeState(view).includes(CANARY), false);
    assert.equal(formatThreeState(view).includes("example.test"), false);
    assert.ok(reloginGuidance(view).includes("Browser CLI"));
    assert.ok(formatCookieImportReport(read.report).includes("target authorization: confirmed"));
  });

  let reportPath = null;
  await check("CLI connect + external test target end-to-end writes a count-only report", async () => {
    const t5 = startLocalTarget({
      port: 0,
      ticket: "99999999999999999999999999999999",
      backend: createMemoryBackend(),
      log: () => {},
    });
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
        "--ticket",
        t5.ticketFormatted,
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
    const c5 = new TargetClient({ endpoint: t5.endpoint, ticket: t5.ticket });
    const submit = await c5.submit(await importRequest({ jobNonce: "5".repeat(32) }));
    assert.equal(submit.ok, true);
    const code = await exited;
    await t5.close();
    assert.equal(code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.report.cookieImported.status, "imported");
    assert.equal(parsed.report.loginVerified.status, "not_verified");
    assert.equal(parsed.report.target.native, false);
    assert.equal(parsed.report.target.transport, "http-test");
    assert.equal(parsed.report.authorization.simulated, true);
    assert.equal(stdout.includes(CANARY), false);
    assert.equal(stdout.includes("example.test"), false);
    reportPath = parsed.reportPath;
    assert.equal(fs.existsSync(reportPath), true);
    const text = readText(reportPath);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("sid"), false);
    assert.equal(text.includes(t5.ticket), false);
  });

  await check("CLI connect with the local test target prints a ticket and completes", async () => {
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
      const m = stdout.match(/导入票据填 (BCLI-[A-Z0-9-]+)/);
      if (m && !submitted) {
        submitted = true;
        const ticket = m[1];
        // The CLI's local target is an in-process target; the ticket is the
        // only credential this test needs.
        submitPromise = (async () => {
          const portMatch = stdout.match(/端点|endpoint|http:\/\/127\.0\.0\.1:\d+/);
          if (!portMatch) return null;
          const base = (stdout.match(/http:\/\/127\.0\.0\.1:\d+/) || [])[0];
          if (!base) return null;
          const t = new TargetClient({ endpoint: base, ticket });
          return t.submit(await importRequest({ jobNonce: "6".repeat(32) }));
        })();
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve) => child.on("close", resolve));
    const submit = await submitPromise;
    assert.equal(code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.equal(submitted, true);
    assert.ok(submit && submit.ok, JSON.stringify(submit));
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

  await check("CLI refuses an unsupported source browser and a missing or invalid ticket", () => {
    const ff = runCli(
      ["connect", "--source", "firefox:ff.default", "--json", ...roots.rootArgs],
      { expect: 3 },
    );
    const ffJson = JSON.parse(ff.stdout);
    assert.equal(ffJson.ok, false);
    assert.equal(ffJson.error, "source-browser-unsupported");

    const noTicket = runCli(
      ["connect", "--source", "chrome:Default", "--endpoint", "http://127.0.0.1:1", "--json", ...roots.rootArgs],
      { expect: 2 },
    );
    assert.ok(noTicket.combined.includes("--ticket"));

    const badFormat = runCli(
      [
        "connect",
        "--source",
        "chrome:Default",
        "--endpoint",
        "http://127.0.0.1:1",
        "--ticket",
        "123456",
        "--json",
        ...roots.rootArgs,
      ],
      { expect: 2 },
    );
    assert.ok(badFormat.combined.includes("BCLI-"));
  });

  await check("CLI rejects a wrong ticket before waiting for a job", async () => {
    const tPair = startLocalTarget({
      port: 0,
      ticket: "ABCDEFGHJKMNPQRSTVWXYZ0123456789",
      backend: createMemoryBackend(),
      log: () => {},
    });
    await tPair.listening;
    const res = await runCliAsync([
      "connect",
      "--source",
      "chrome:Default",
      "--endpoint",
      tPair.endpoint,
      "--ticket",
      "00000000000000000000000000000000",
      "--json",
      ...roots.rootArgs,
    ]);
    await tPair.close();
    assert.equal(res.status, 3, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "ticket-invalid");
  });

  await check("CLI confirm-login refuses automatic confirmation and never upgrades cookie or authorization state", () => {
    assert.ok(reportPath);
    const before = readReport(reportPath).report;
    const refused = runCli(
      ["confirm-login", "--file", reportPath, "--domain", "example.test", "--status", "user_confirmed"],
      { expect: 3 },
    );
    assert.ok(refused.combined.includes("explicit-user-action-required"));
    const unchanged = readReport(reportPath).report;
    assert.deepEqual(unchanged.cookieImported, before.cookieImported);
    assert.deepEqual(unchanged.authorization, before.authorization);
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
    assert.deepEqual(parsed.report.authorization, before.authorization);
    assert.equal(parsed.report.dataCopied.cookies, false);
    assert.equal(JSON.stringify(parsed.report).includes(CANARY), false);
  });

  await check("CLI report command prints counts, target authorization and the explicit login check", () => {
    const res = runCli(["report", "--file", reportPath], { expect: 0 });
    assert.ok(res.stdout.includes("cookies: imported"));
    assert.ok(res.stdout.includes("target authorization: confirmed"));
    assert.ok(res.stdout.includes("login verified: user_confirmed"));
    assert.ok(res.stdout.includes("example.test"));
    assert.equal(res.stdout.includes(CANARY), false);
  });

  await check("source profiles are byte-identical after the whole product flow", () => {
    assert.deepEqual(hashTree(roots.chromeRoot), sourceHashBefore.chrome);
    assert.deepEqual(hashTree(roots.edgeRoot), sourceHashBefore.edge);
    assert.deepEqual(hashTree(roots.ffRoot), sourceHashBefore.firefox);
  });

  await check("no temporary output contains a canary or the test ticket", () => {
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
    assert.equal(text.includes(TEST_TICKET), false);
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
