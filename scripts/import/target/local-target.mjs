#!/usr/bin/env node
// Local HTTP implementation of the Browser CLI cookie-import contract v2.
//
// This is the development/test double for the source extension, host relay and
// CLI wire format. It is NOT the product target and it never claims otherwise:
// it reports native:false, transport:"http-test" and
// authorization.simulated:true. The product target is the proposed Chromium
// patch in the browser-cli repository.
//
// Two backends exist:
// - memory (default): stores cookies in process memory only.
// - cdp (--cdp-port, test only): writes into a disposable local Chromium via
//   CDP Storage.setCookies. It never launches a browser and must be pointed at
//   an isolated test profile.
//
// The target never writes cookie values to disk, never logs names/values/
// domains, and never accepts a login verification claim or a client-side
// authorization approval.
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import * as contract from "../contract.mjs";
import { createCdpBackend } from "./cdp-backend.mjs";

export const DEFAULT_PORT = 47832;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const PRODUCT_SOURCE_ORIGIN = `chrome-extension://${contract.SOURCE_EXTENSION_ID}`;
export const DEFAULT_ALLOWED_ORIGINS = [PRODUCT_SOURCE_ORIGIN];

export const TEST_PUBLIC_SUFFIXES = new Set(["com", "net", "org", "test", "co.uk", "github.io"]);

export function createMemoryBackend({ failWith = null, delayMs = 0 } = {}) {
  const store = new Map();
  return {
    kind: "memory",
    mode: "test",
    product: "BrowserPilot local contract target",
    native: false,
    cookieStoreWrite: true,
    persistAcrossRestart: false,
    async applyCookie(cookie) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const failure = typeof failWith === "function" ? failWith(cookie) : null;
      if (failure) {
        const err = new Error(failure);
        err.code = failure;
        throw err;
      }
      store.set(`${cookie.domain}\t${cookie.path}\t${cookie.name}`, { ...cookie });
    },
    snapshot() {
      return [...store.values()];
    },
    async close() {},
  };
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function startLocalTarget(options = {}) {
  const ticket = options.ticket ? String(options.ticket) : contract.generateTicket();
  const normalizedTicket = contract.normalizeTicket(ticket);
  if (!contract.isValidTicket(normalizedTicket)) throw new Error("ticket-invalid");
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const ttlMs = options.ttlMs ?? contract.TICKET_TTL_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now || (() => Date.now());
  const logger = options.log || ((line) => console.log(line));
  const backend = options.backend || createMemoryBackend();
  const approve = options.approve !== undefined ? options.approve : true;
  const isPublicSuffix = options.isPublicSuffix || ((domain) => TEST_PUBLIC_SUFFIXES.has(domain));
  const logs = [];
  const createdAt = now();
  const expiresAt = createdAt + ttlMs;

  const log = (line) => {
    const safe = String(line).replace(/[\r\n]+/g, " ");
    logs.push(safe);
    logger(safe);
  };

  const jobs = new Map();
  let currentJobId = null;
  let activeJobId = null;
  let consumedAt = null;
  let consumedJobId = null;
  const failures = [];
  let rateLimitedUntil = 0;

  const cleanup = setInterval(() => {
    const current = now();
    for (const [id, job] of jobs) {
      if (id === activeJobId) continue;
      if (current - job.updatedAtMs > contract.JOB_TTL_MS) {
        jobs.delete(id);
        if (currentJobId === id) currentJobId = null;
      }
    }
  }, 30_000);
  cleanup.unref?.();

  function recordFailure() {
    const current = now();
    failures.push(current);
    while (failures.length && current - failures[0] > contract.TICKET_FAILURE_WINDOW_MS) failures.shift();
    if (failures.length >= contract.MAX_TICKET_FAILURES) {
      rateLimitedUntil = current + contract.RATE_LIMIT_BLOCK_MS;
    }
  }

  function ticketAuthorized(req) {
    const current = now();
    if (current < rateLimitedUntil) return { ok: false, status: 429, error: "rate-limited" };
    if (current > expiresAt) return { ok: false, status: 410, error: "ticket-expired" };
    const supplied = contract.normalizeTicket(req.headers["x-bp-ticket"]);
    if (!contract.isValidTicket(supplied) || !contract.safeEqualString(supplied, normalizedTicket)) {
      recordFailure();
      return { ok: false, status: 401, error: "ticket-invalid" };
    }
    return { ok: true };
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : null;
    const cors = corsHeaders(allowedOrigin);
    if (req.method === "OPTIONS") {
      if (origin && !allowedOrigin) {
        sendJson(res, 403, { error: "origin-not-allowed" }, cors);
        return;
      }
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (origin && !allowedOrigin) {
      sendJson(res, 403, { error: "origin-not-allowed" }, cors);
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);

    try {
      if (url.pathname === "/v2/import/capabilities" && req.method === "GET") {
        sendJson(res, 200, capabilitiesPayload(), cors);
        return;
      }
      if (!url.pathname.startsWith("/v2/import/")) {
        sendJson(res, 404, { error: "not-found" }, cors);
        return;
      }
      const auth = ticketAuthorized(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error }, cors);
        return;
      }

      if (url.pathname === "/v2/import/cookies" && req.method === "POST") {
        if (now() < rateLimitedUntil) {
          sendJson(res, 429, { error: "rate-limited" }, cors);
          return;
        }
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
          sendJson(res, 415, { error: "content-type-required" }, cors);
          return;
        }
        const digestHeader = String(req.headers["x-bp-job-digest"] || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(digestHeader)) {
          sendJson(res, 400, { error: "job-digest-required" }, cors);
          return;
        }
        if (consumedAt !== null) {
          sendJson(res, 409, { error: "ticket-consumed" }, cors);
          return;
        }
        if (activeJobId && jobs.has(activeJobId)) {
          sendJson(res, 409, { error: "target-busy" }, cors);
          return;
        }
        const body = await readJsonBody(req, maxBytes);
        if (!contract.safeEqualString(await contract.sha256Hex(body.text), digestHeader)) {
          recordFailure();
          sendJson(res, 400, { error: "job-digest-mismatch" }, cors);
          return;
        }
        const checked = await contract.validateImportRequest(body.json, { now: now() });
        if (!checked.ok) {
          log(`job rejected: ${checked.errors.length} validation error(s)`);
          sendJson(res, 400, { error: "invalid-job", errors: checked.errors.slice(0, 20) }, cors);
          return;
        }
        const normalized = checked.normalized;
        const id = randomHex(12);
        consumedAt = now();
        consumedJobId = id;
        const job = {
          id,
          jobNonce: normalized.jobNonce,
          state: "pending",
          transport: "http-test",
          native: false,
          payload: normalized,
          totals: normalized.totals,
          progress: { applied: 0, failed: 0 },
          failures: {},
          authorization: { targetUserConfirmed: false, simulated: false, source: "none" },
          error: null,
          cancelRequested: false,
          createdAt: new Date(now()).toISOString(),
          updatedAt: new Date(now()).toISOString(),
          updatedAtMs: now(),
        };
        jobs.set(id, job);
        currentJobId = id;
        activeJobId = id;
        log(
          `job ${id}: accepted ${normalized.totals.cookies} cookies / ${normalized.totals.domains} domains ` +
            `(${normalized.totals.selectedDomains} selected, ${normalized.totals.sessionCookies} session)`,
        );
        sendJson(
          res,
          202,
          {
            ok: true,
            contract: contract.CONTRACT_ID,
            protocolVersion: contract.PROTOCOL_VERSION,
            jobId: id,
            state: job.state,
            transport: "http-test",
            native: false,
            totals: normalized.totals,
          },
          cors,
        );
        setTimeout(() => void runJob(job), 0);
        return;
      }

      if (url.pathname === "/v2/import/status" && req.method === "GET") {
        if (!currentJobId || !jobs.has(currentJobId)) {
          sendJson(res, 200, { ok: true, contract: contract.CONTRACT_ID, state: "idle", jobId: null }, cors);
          return;
        }
        sendJson(res, 200, { ok: true, ...contract.createPublicJobView(jobs.get(currentJobId)) }, cors);
        return;
      }

      const jobMatch = url.pathname.match(/^\/v2\/import\/jobs\/([a-f0-9]{24})$/);
      if (jobMatch && req.method === "GET") {
        const job = jobs.get(jobMatch[1]);
        if (!job) {
          sendJson(res, 404, { error: "job-not-found" }, cors);
          return;
        }
        // The ticket can read only the job it authorized.
        if (consumedJobId && consumedJobId !== job.id) {
          sendJson(res, 409, { error: "job-binding-mismatch" }, cors);
          return;
        }
        sendJson(res, 200, contract.createPublicJobView(job), cors);
        return;
      }

      const cancelMatch = url.pathname.match(/^\/v2\/import\/jobs\/([a-f0-9]{24})\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const job = jobs.get(cancelMatch[1]);
        if (!job) {
          sendJson(res, 404, { error: "job-not-found" }, cors);
          return;
        }
        if (consumedJobId && consumedJobId !== job.id) {
          sendJson(res, 409, { error: "job-binding-mismatch" }, cors);
          return;
        }
        if (contract.TERMINAL_JOB_STATES.has(job.state)) {
          sendJson(res, 200, { ok: true, state: job.state, alreadyTerminal: true }, cors);
          return;
        }
        job.cancelRequested = true;
        job.updatedAt = new Date(now()).toISOString();
        job.updatedAtMs = now();
        if (job.state === "pending" || job.state === "awaiting_authorization") {
          job.state = "cancelled";
          activeJobId = null;
          log(`job ${job.id}: cancelled before writing`);
        } else {
          log(`job ${job.id}: cancel requested`);
        }
        sendJson(res, 202, { ok: true, state: job.state, cancelRequested: true }, cors);
        return;
      }

      sendJson(res, 404, { error: "not-found" }, cors);
    } catch (err) {
      if (err && err.code === "body-too-large") {
        sendJson(res, 413, { error: "body-too-large" }, cors);
        res.once("finish", () => req.destroy());
        return;
      }
      log(`request error: ${err && err.code ? err.code : "bad-request"}`);
      if (!res.headersSent) sendJson(res, 400, { error: "bad-request" }, cors);
    }
  });

  async function runJob(job) {
    if (job.cancelRequested || job.state === "cancelled") {
      job.state = "cancelled";
      job.updatedAt = new Date(now()).toISOString();
      job.updatedAtMs = now();
      activeJobId = null;
      return;
    }
    job.state = "awaiting_authorization";
    job.updatedAt = new Date(now()).toISOString();
    job.updatedAtMs = now();
    let approved;
    try {
      approved = typeof approve === "function" ? await approve(job) : approve;
    } catch {
      approved = false;
    }
    if (job.cancelRequested) {
      job.state = "cancelled";
      job.updatedAt = new Date(now()).toISOString();
      job.updatedAtMs = now();
      activeJobId = null;
      return;
    }
    if (!approved) {
      job.state = "denied";
      job.error = { code: "authorization-denied" };
      job.authorization = {
        targetUserConfirmed: false,
        simulated: true,
        source: "test-auto-deny",
      };
      job.updatedAt = new Date(now()).toISOString();
      job.updatedAtMs = now();
      activeJobId = null;
      log(`job ${job.id}: denied by test authorization`);
      return;
    }
    job.authorization = {
      targetUserConfirmed: true,
      simulated: true,
      source: "test-auto-approve",
      scopeDigest: job.payload.consent.domainsDigest,
      confirmedAt: new Date(now()).toISOString(),
    };
    job.state = "applying";
    job.updatedAt = new Date(now()).toISOString();
    job.updatedAtMs = now();
    log(`job ${job.id}: applying`);
    try {
      for (const cookie of job.payload.cookies) {
        if (job.cancelRequested) break;
        const policyFailure = contract.cookiePolicyFailure(cookie, job.payload.domains, {
          now: now(),
          isPublicSuffix,
        });
        if (policyFailure) {
          job.failures[policyFailure] = (job.failures[policyFailure] || 0) + 1;
          job.progress.failed += 1;
          continue;
        }
        try {
          await backend.applyCookie(cookie);
          job.progress.applied += 1;
        } catch (err) {
          const code = contract.classifySetFailure(err);
          job.failures[code] = (job.failures[code] || 0) + 1;
          job.progress.failed += 1;
        }
      }
    } catch (err) {
      job.error = { code: "internal" };
    } finally {
      if (job.cancelRequested) {
        job.state = "cancelled";
      } else if (job.progress.applied === 0 && job.progress.failed > 0) {
        job.state = "failed";
        job.error = { code: Object.keys(job.failures)[0] || "internal" };
      } else {
        job.state = "done";
      }
      job.updatedAt = new Date(now()).toISOString();
      job.updatedAtMs = now();
      activeJobId = null;
      log(
        `job ${job.id}: ${job.state} applied=${job.progress.applied} failed=${job.progress.failed}`,
      );
    }
  }

  function capabilitiesPayload() {
    return {
      contract: contract.CONTRACT_ID,
      protocolVersion: contract.PROTOCOL_VERSION,
      product: backend.product,
      mode: "test",
      transport: "http-test",
      native: false,
      authorization: {
        mode: "test-simulated",
        independentTargetConfirmation: false,
        note: "测试目标自动批准；真实目标必须在 Browser CLI 内由用户本人确认。",
      },
      capabilities: {
        cookieStoreWrite: backend.cookieStoreWrite === true,
        persistAcrossRestart: backend.persistAcrossRestart === true,
        partitionedCookies: true,
        sessionCookies: true,
        sessionCookiePersistence: "not_guaranteed",
        maxCookiesPerJob: contract.MAX_COOKIES_PER_JOB,
        maxValueBytes: contract.MAX_VALUE_BYTES,
        ticketTtlSeconds: Math.floor(ttlMs / 1000),
      },
    };
  }

  let actualPort = 0;
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      actualPort = server.address().port;
      resolve(actualPort);
    });
  });

  return {
    server,
    logs,
    backend,
    ticket: normalizedTicket,
    ticketFormatted: contract.formatTicket(normalizedTicket),
    listening,
    get port() {
      return actualPort;
    },
    get endpoint() {
      return `http://127.0.0.1:${actualPort}`;
    },
    get expiresAt() {
      return expiresAt;
    },
    get view() {
      return currentJobId && jobs.has(currentJobId) ? contract.createPublicJobView(jobs.get(currentJobId)) : null;
    },
    capabilities() {
      return capabilitiesPayload();
    },
    async close() {
      clearInterval(cleanup);
      await backend.close();
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
    log,
  };
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-bp-ticket, x-bp-job-digest",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        const err = new Error("body too large");
        err.code = "body-too-large";
        req.pause();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve({ text, json: JSON.parse(text) });
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const get = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const cdpPortArg = get("cdp-port", null);
  if (cdpPortArg && !args.includes("--allow-test-cdp")) {
    console.error("refusing --cdp-port without --allow-test-cdp (test-only backend; isolated profile required)");
    process.exit(2);
  }
  const backend = cdpPortArg ? createCdpBackend({ port: Number(cdpPortArg) }) : createMemoryBackend();
  const originsArg = get("allowed-origins", null);
  const allowedOrigins = originsArg
    ? String(originsArg)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;
  const target = startLocalTarget({
    port: Number(get("port", DEFAULT_PORT)),
    ticket: get("ticket", null),
    allowedOrigins,
    backend,
  });
  await target.listening;
  console.log("Browser CLI cookie-import local target (v2 test double)");
  console.log(`  endpoint: ${target.endpoint}`);
  console.log(`  ticket:   ${target.ticketFormatted}  (one-time, 5 min)`);
  console.log(`  mode:     test (native=false, transport=http-test)`);
  console.log(`  persist across restart: ${target.backend.persistAcrossRestart === true}`);
  console.log("  note: this is a test target, not the Browser CLI native contract.");
  console.log("  memory only for cookie values; logs contain counts only. Press Ctrl+C to stop.");
  const shutdown = async () => {
    await target.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`local target failed: ${err && err.message ? err.message : err}`);
    process.exit(2);
  });
}
