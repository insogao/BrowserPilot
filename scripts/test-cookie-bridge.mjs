#!/usr/bin/env node
// Tests for the localhost cookie bridge protocol/broker and cookie mapping.
// No browser is started. The extension service workers are prototypes and are
// NOT verified against a real browser in this environment.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBroker } from "./import/cookie-bridge/broker.mjs";
import {
  validateJobPayload,
  validateResultPayload,
  summarizeJob,
} from "./import/cookie-bridge/protocol.mjs";
import { cookieToSetDetails, classifySetError } from "./import/cookie-bridge/target-extension/lib/apply-cookie.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SOURCE_DIR = path.join(REPO, "scripts", "import", "cookie-bridge", "source-extension");
const TARGET_DIR = path.join(REPO, "scripts", "import", "cookie-bridge", "target-extension");

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
  }
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
    value: "COOKIE-BRIDGE-CANARY",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    session: false,
    expirationDate: 2000000000,
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    version: 1,
    source: { browser: "Chrome", profileLabel: "Person 1" },
    cookies: [cookie(), cookie({ domain: "plain.test", hostOnly: true, secure: false, session: true })],
    ...overrides,
  };
}

function request(base, pathname, { method = "GET", pair, origin, body } = {}) {
  const headers = {};
  if (pair) headers["x-bp-pair"] = pair;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function main() {
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, "manifest.json"), "utf8"));
  const targetManifest = JSON.parse(fs.readFileSync(path.join(TARGET_DIR, "manifest.json"), "utf8"));
  const sourceId = extensionIdFromManifestKey(sourceManifest.key);
  const targetId = extensionIdFromManifestKey(targetManifest.key);

  await check("extension manifest keys produce stable IDs matching the broker allowlist", () => {
    assert.equal(sourceId, "ljoekiddijnohefaghljlcodgljienoj");
    assert.equal(targetId, "apacgmcapfhgbbfbkcbcdlnfgdlfgjen");
    assert.equal(sourceManifest.manifest_version, 3);
    assert.equal(targetManifest.manifest_version, 3);
    assert.ok(sourceManifest.permissions.includes("cookies"));
    assert.ok(targetManifest.permissions.includes("cookies"));
  });

  await check("payload validation accepts the normal case and normalizes counts", () => {
    const res = validateJobPayload(job());
    assert.equal(res.ok, true);
    assert.deepEqual(res.normalized.totals, { cookies: 2, domains: 2 });
    assert.deepEqual(summarizeJob(res.normalized), { cookies: 2, domains: 2 });
  });

  await check("payload validation rejects malformed fields without echoing values", () => {
    const cases = [
      [job({ version: 2 }), "bad-version"],
      [job({ cookies: [] }), "cookies-empty"],
      [job({ cookies: [cookie({ domain: "bad domain" })] }), "cookies[0].domain-charset"],
      [job({ cookies: [cookie({ sameSite: "weird" })] }), "cookies[0].sameSite-invalid"],
      [job({ cookies: [cookie({ session: false, expirationDate: undefined })] }), "cookies[0].expirationDate-invalid"],
      [job({ cookies: [cookie({ value: "x".repeat(9000) })] }), "cookies[0].value-invalid"],
      [job({ cookies: [cookie({ partitionKey: { topLevelSite: "", hasCrossSiteAncestor: 1 } })] }), "partitionKey"],
    ];
    for (const [payload, expected] of cases) {
      const res = validateJobPayload(payload);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes(expected)), `${expected} not in ${res.errors.join(",")}`);
      assert.equal(JSON.stringify(res).includes("COOKIE-BRIDGE-CANARY"), false);
    }
  });

  await check("cookieToSetDetails maps host-only, domain, session and partition fields", () => {
    const hostOnly = cookieToSetDetails(
      cookie({ domain: "plain.test", hostOnly: true, secure: true, path: "/x", session: true }),
    );
    assert.equal(hostOnly.ok, true);
    assert.equal(hostOnly.details.url, "https://plain.test/x");
    assert.equal(hostOnly.details.domain, undefined);
    assert.equal(hostOnly.details.expirationDate, undefined);
    assert.equal(hostOnly.details.httpOnly, true);
    assert.equal(hostOnly.details.sameSite, "lax");

    const domainCookie = cookieToSetDetails(cookie());
    assert.equal(domainCookie.ok, true);
    assert.equal(domainCookie.details.url, "https://example.test/");
    assert.equal(domainCookie.details.domain, ".example.test");
    assert.equal(domainCookie.details.expirationDate, 2000000000);

    const partitioned = cookieToSetDetails(
      cookie({ partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true } }),
    );
    assert.deepEqual(partitioned.details.partitionKey, {
      topLevelSite: "https://top.test",
      hasCrossSiteAncestor: true,
    });

    const http = cookieToSetDetails(cookie({ secure: false, domain: "http.test", hostOnly: true }));
    assert.equal(http.details.url, "http://http.test/");

    const bad = cookieToSetDetails(cookie({ domain: "bad domain" }));
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "invalid-domain");
  });

  await check("error classification does not include cookie values", () => {
    assert.equal(classifySetError(new Error("Partitioned cookie requires partitionKey")), "partitioned-cookie-rejected");
    assert.equal(classifySetError(new Error("Invalid url")), "invalid-url");
    assert.equal(classifySetError(new Error("COOKIE-BRIDGE-CANARY leaked?")), "other");
  });

  const broker = startBroker({
    port: 0,
    pair: "123456",
    allowedOrigins: [`chrome-extension://${sourceId}`, `chrome-extension://${targetId}`],
    log: () => {},
    maxBytes: 4096,
  });
  const port = await broker.listening;
  const base = `http://127.0.0.1:${port}`;

  await check("health works without pairing and never exposes job data", async () => {
    const res = await request(base, "/v1/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.pairingRequired, true);
  });

  await check("pairing and origin checks are enforced", async () => {
    const noPair = await request(base, "/v1/jobs", { method: "POST", body: job() });
    assert.equal(noPair.status, 401);
    const badOrigin = await request(base, "/v1/jobs", {
      method: "POST",
      pair: "123456",
      origin: "chrome-extension://evil",
      body: job(),
    });
    assert.equal(badOrigin.status, 403);
  });

  let jobId = null;
  await check("source can post a job; duplicate pending job is rejected", async () => {
    const res = await request(base, "/v1/jobs", {
      method: "POST",
      pair: "123456",
      origin: `chrome-extension://${sourceId}`,
      body: job(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    jobId = body.jobId;
    assert.match(jobId, /^[a-f0-9]{24}$/);
    assert.deepEqual(body.totals, { cookies: 2, domains: 2 });

    const dup = await request(base, "/v1/jobs", {
      method: "POST",
      pair: "123456",
      origin: `chrome-extension://${sourceId}`,
      body: job(),
    });
    assert.equal(dup.status, 409);
  });

  await check("target fetches once (204 afterwards) and status reports delivered", async () => {
    const first = await request(base, "/v1/jobs/next", {
      pair: "123456",
      origin: `chrome-extension://${targetId}`,
    });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.jobId, jobId);
    assert.equal(body.cookies.length, 2);
    const second = await request(base, "/v1/jobs/next", {
      pair: "123456",
      origin: `chrome-extension://${targetId}`,
    });
    assert.equal(second.status, 204);
    const st = await request(base, `/v1/jobs/${jobId}/status`, { pair: "123456" });
    const status = await st.json();
    assert.equal(status.status, "delivered");
    assert.equal(status.loginVerified.status, "not_verified");
  });

  await check("target cannot claim a verified login", async () => {
    const res = await request(base, `/v1/jobs/${jobId}/result`, {
      method: "POST",
      pair: "123456",
      body: { applied: 2, failed: 0, loginVerified: "user_confirmed" },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.errors.includes("login-verification-must-be-user-confirmed"));
  });

  await check("result is recorded as counts only; status distinguishes cookie import from login", async () => {
    const res = await request(base, `/v1/jobs/${jobId}/result`, {
      method: "POST",
      pair: "123456",
      origin: `chrome-extension://${targetId}`,
      body: { applied: 1, failed: 1, failures: { "api-returned-null": 1 }, loginVerified: "not_verified" },
    });
    assert.equal(res.status, 200);
    const st = await request(base, `/v1/jobs/${jobId}/status`, { pair: "123456" });
    const status = await st.json();
    assert.equal(status.status, "done");
    assert.equal(status.cookieImported.status, "partially_imported");
    assert.equal(status.cookieImported.applied, 1);
    assert.equal(status.cookieImported.failed, 1);
    assert.equal(status.loginVerified.status, "not_verified");
  });

  await check("oversized bodies are rejected", async () => {
    const huge = job({ cookies: [cookie({ value: "x".repeat(8000) })] });
    const res = await request(base, "/v1/jobs", {
      method: "POST",
      pair: "123456",
      origin: `chrome-extension://${sourceId}`,
      body: huge,
    });
    assert.equal(res.status, 413);
  });

  await check("broker logs contain counts/IDs only, never cookie values or domains", () => {
    const text = broker.logs.join("\n");
    assert.equal(text.includes("COOKIE-BRIDGE-CANARY"), false);
    assert.equal(text.includes("example.test"), false);
    assert.equal(text.includes("plain.test"), false);
    assert.ok(text.includes(jobId));
  });

  await check("result validation rejects impossible counts", () => {
    const bad = validateResultPayload({ applied: 5, failed: 5, loginVerified: "not_verified" }, 2);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.includes("result-exceeds-job"));
  });

  await broker.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`\n${f.name}\n${f.error && f.error.stack ? f.error.stack : f.error}`);
    process.exitCode = 1;
  }
}

main();
