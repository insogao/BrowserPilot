#!/usr/bin/env node
// Local implementation of the Browser CLI cookie-import contract.
//
// This is the development/test target for the source extension. It implements
// the exact loopback contract that the Browser CLI native target must provide
// (docs/browser-cli-native-cookie-import-interface.md). Two backends exist:
//
// - memory (default): stores cookies in process memory only; reports
//   persistAcrossRestart=false and native=false. Used by tests.
// - cdp (--cdp-port, test only): writes into a disposable local Chromium via
//   CDP Storage.setCookies; reports persistAcrossRestart=true but native=false.
//   It never launches a browser and must be pointed at an isolated test profile.
//
// The target never writes cookie values to disk, never logs names/values/
// domains, and never accepts a login verification claim.
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import * as contract from "../contract.mjs";
import { createCdpBackend } from "./cdp-backend.mjs";

export const DEFAULT_PORT = 47832;
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const PRODUCT_SOURCE_ORIGIN = "chrome-extension://ljoekiddijnohefaghljlcodgljienoj";
export const DEFAULT_ALLOWED_ORIGINS = [PRODUCT_SOURCE_ORIGIN];

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

export function startLocalTarget(options = {}) {
  const pair = String(options.pair ?? randomPairCode());
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const logger = options.log || ((line) => console.log(line));
  const backend = options.backend || createMemoryBackend();
  const logs = [];

  const log = (line) => {
    const safe = String(line).replace(/[\r\n]+/g, " ");
    logs.push(safe);
    logger(safe);
  };

  const jobs = new Map();
  const requestIds = new Map();
  let currentJobId = null;
  let activeJobId = null;

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (id === activeJobId) continue;
      if (now - job.updatedAt > ttlMs) {
        jobs.delete(id);
        requestIds.delete(job.requestId);
        if (currentJobId === id) currentJobId = null;
      }
    }
  }, 30_000);
  cleanup.unref?.();

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
      if (url.pathname === "/v1/import/capabilities" && req.method === "GET") {
        sendJson(
          res,
          200,
          {
            contract: contract.CONTRACT_ID,
            protocolVersion: contract.CONTRACT_VERSION,
            product: backend.product,
            mode: backend.mode,
            native: backend.native === true,
            pairingRequired: true,
            capabilities: {
              cookieStoreWrite: backend.cookieStoreWrite === true,
              persistAcrossRestart: backend.persistAcrossRestart === true,
              partitionedCookies: true,
              sessionCookies: true,
              maxCookiesPerJob: contract.MAX_COOKIES_PER_JOB,
              maxValueBytes: contract.MAX_VALUE_BYTES,
            },
          },
          cors,
        );
        return;
      }

      if (!url.pathname.startsWith("/v1/import/")) {
        sendJson(res, 404, { error: "not-found" }, cors);
        return;
      }
      if (!safeEqual(req.headers["x-bp-pair"], pair)) {
        sendJson(res, 401, { error: "pairing-required" }, cors);
        return;
      }

      if (url.pathname === "/v1/import/cookies" && req.method === "POST") {
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
          sendJson(res, 415, { error: "content-type-required" }, cors);
          return;
        }
        const body = await readJsonBody(req, maxBytes);
        const checked = contract.validateImportRequest(body);
        if (!checked.ok) {
          log(`job rejected: ${checked.errors.length} validation error(s)`);
          sendJson(res, 400, { error: "invalid-job", errors: checked.errors.slice(0, 20) }, cors);
          return;
        }
        const normalized = checked.normalized;
        const existingId = requestIds.get(normalized.requestId);
        if (existingId && jobs.has(existingId)) {
          const existing = contract.createPublicJobView(jobs.get(existingId));
          sendJson(res, 200, { ok: true, duplicate: true, ...existing }, cors);
          return;
        }
        if (activeJobId && jobs.has(activeJobId)) {
          sendJson(res, 409, { error: "target-busy" }, cors);
          return;
        }
        const id = crypto.randomBytes(12).toString("hex");
        const now = new Date().toISOString();
        const job = {
          id,
          requestId: normalized.requestId,
          state: "pending",
          payload: normalized,
          totals: normalized.totals,
          progress: { applied: 0, failed: 0 },
          failures: {},
          error: null,
          cancelRequested: false,
          createdAt: now,
          updatedAt: now,
        };
        jobs.set(id, job);
        requestIds.set(normalized.requestId, id);
        currentJobId = id;
        activeJobId = id;
        log(
          `job ${id}: accepted ${normalized.totals.cookies} cookies / ${normalized.totals.domains} domains ` +
            `(${normalized.totals.selectedDomains} selected)`,
        );
        sendJson(
          res,
          202,
          {
            ok: true,
            contract: contract.CONTRACT_ID,
            jobId: id,
            state: "pending",
            totals: normalized.totals,
          },
          cors,
        );
        setTimeout(() => void runJob(job), 0);
        return;
      }

      if (url.pathname === "/v1/import/status" && req.method === "GET") {
        if (!currentJobId || !jobs.has(currentJobId)) {
          sendJson(res, 200, { ok: true, contract: contract.CONTRACT_ID, state: "idle", jobId: null }, cors);
          return;
        }
        sendJson(res, 200, { ok: true, ...contract.createPublicJobView(jobs.get(currentJobId)) }, cors);
        return;
      }

      const jobMatch = url.pathname.match(/^\/v1\/import\/jobs\/([a-f0-9]{24})$/);
      if (jobMatch && req.method === "GET") {
        const job = jobs.get(jobMatch[1]);
        if (!job) {
          sendJson(res, 404, { error: "job-not-found" }, cors);
          return;
        }
        sendJson(res, 200, contract.createPublicJobView(job), cors);
        return;
      }

      const cancelMatch = url.pathname.match(/^\/v1\/import\/jobs\/([a-f0-9]{24})\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const job = jobs.get(cancelMatch[1]);
        if (!job) {
          sendJson(res, 404, { error: "job-not-found" }, cors);
          return;
        }
        if (contract.TERMINAL_JOB_STATES.has(job.state)) {
          sendJson(res, 200, { ok: true, state: job.state, alreadyTerminal: true }, cors);
          return;
        }
        job.cancelRequested = true;
        job.updatedAt = new Date().toISOString();
        if (job.state === "pending") {
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
      log(`request error: ${err && err.message ? err.message : "unknown"}`);
      if (!res.headersSent) sendJson(res, 400, { error: "bad-request" }, cors);
    }
  });

  async function runJob(job) {
    if (job.cancelRequested || job.state === "cancelled") {
      job.state = "cancelled";
      job.updatedAt = new Date().toISOString();
      activeJobId = null;
      return;
    }
    job.state = "applying";
    job.updatedAt = new Date().toISOString();
    log(`job ${job.id}: applying`);
    try {
      for (const cookie of job.payload.cookies) {
        if (job.cancelRequested) break;
        try {
          await backend.applyCookie(cookie);
          job.progress.applied += 1;
        } catch (err) {
          const code = contract.classifySetFailure(err);
          job.failures[code] = (job.failures[code] || 0) + 1;
          job.progress.failed += 1;
        }
        job.updatedAt = new Date().toISOString();
      }
    } catch (err) {
      job.error = { code: "internal" };
      job.updatedAt = new Date().toISOString();
    } finally {
      if (job.cancelRequested) {
        job.state = "cancelled";
      } else if (job.progress.applied === 0 && job.progress.failed > 0) {
        job.state = "failed";
        job.error = { code: Object.keys(job.failures)[0] || "internal" };
      } else {
        job.state = "done";
      }
      job.updatedAt = new Date().toISOString();
      activeJobId = null;
      log(
        `job ${job.id}: ${job.state} applied=${job.progress.applied} failed=${job.progress.failed}`,
      );
    }
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
    pair,
    listening,
    get port() {
      return actualPort;
    },
    get endpoint() {
      return `http://127.0.0.1:${actualPort}`;
    },
    capabilities() {
      return {
        contract: contract.CONTRACT_ID,
        protocolVersion: contract.CONTRACT_VERSION,
        product: backend.product,
        mode: backend.mode,
        native: backend.native === true,
        capabilities: {
          cookieStoreWrite: backend.cookieStoreWrite === true,
          persistAcrossRestart: backend.persistAcrossRestart === true,
          partitionedCookies: true,
          sessionCookies: true,
          maxCookiesPerJob: contract.MAX_COOKIES_PER_JOB,
          maxValueBytes: contract.MAX_VALUE_BYTES,
        },
      };
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
    "Access-Control-Allow-Headers": "content-type, x-bp-pair",
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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function randomPairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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
    pair: get("pair", null),
    allowedOrigins,
    backend,
  });
  await target.listening;
  console.log("Browser CLI cookie-import local target");
  console.log(`  endpoint: ${target.endpoint}`);
  console.log(`  pair:     ${target.pair}`);
  console.log(`  mode:     ${target.backend.mode} (native=${target.backend.native === true})`);
  console.log(`  persist across restart: ${target.backend.persistAcrossRestart === true}`);
  if (target.backend.native !== true) {
    console.log("  note: this is a test target, not the Browser CLI native contract.");
  }
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
