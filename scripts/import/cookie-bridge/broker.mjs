#!/usr/bin/env node
// Localhost-only, memory-only cookie bridge broker.
//
// - Binds 127.0.0.1 only.
// - Requires a pairing code printed to the console (x-bp-pair header).
// - Never writes cookie values to disk, never logs names/values/domains.
// - Holds at most one pending job; job TTL defaults to 10 minutes.
//
// Endpoints (all JSON):
//   GET  /v1/health
//   POST /v1/jobs                  (source extension)
//   GET  /v1/jobs/next             (target extension)
//   POST /v1/jobs/<id>/result      (target extension)
//   GET  /v1/jobs/<id>/status      (source extension)
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  validateJobPayload,
  validateResultPayload,
  summarizeJob,
  PROTOCOL_VERSION,
} from "./protocol.mjs";

export const DEFAULT_PORT = 47831;
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
// Fixed via manifest "key" in the two prototype extensions.
export const DEFAULT_ALLOWED_ORIGINS = [
  "chrome-extension://ljoekiddijnohefaghljlcodgljienoj",
  "chrome-extension://apacgmcapfhgbbfbkcbcdlnfgdlfgjen",
];

export function startBroker(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const pair = String(options.pair ?? "");
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const logger = options.log || ((line) => console.log(line));
  const logs = [];

  const log = (line) => {
    const safe = String(line).replace(/[\r\n]+/g, " ");
    logs.push(safe);
    logger(safe);
  };

  let job = null; // {id, payload, delivered, result, createdAt, updatedAt}
  let lastFinished = null;

  const cleanup = setInterval(() => {
    const now = Date.now();
    if (job && now - job.createdAt > ttlMs) {
      log(`job ${job.id}: expired`);
      job = null;
    }
    if (lastFinished && now - lastFinished.updatedAt > ttlMs) lastFinished = null;
  }, 30_000);
  cleanup.unref?.();

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = corsHeaders(origin && allowedOrigins.has(origin) ? origin : null);
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      sendJson(res, 403, { error: "origin-not-allowed" }, cors);
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
    if (url.pathname === "/v1/health" && req.method === "GET") {
      sendJson(
        res,
        200,
        { ok: true, protocol: PROTOCOL_VERSION, pairingRequired: true, pendingJob: !!job },
        cors,
      );
      return;
    }
    if (pair && req.headers["x-bp-pair"] !== pair) {
      sendJson(res, 401, { error: "pairing-required" }, cors);
      return;
    }

    try {
      if (url.pathname === "/v1/jobs" && req.method === "POST") {
        if (job && !job.result) {
          sendJson(res, 409, { error: "job-already-pending" }, cors);
          return;
        }
        const body = await readJsonBody(req, maxBytes);
        const validated = validateJobPayload(body);
        if (!validated.ok) {
          log(`job rejected: ${validated.errors.length} validation error(s)`);
          sendJson(res, 400, { error: "invalid-job", errors: validated.errors.slice(0, 20) }, cors);
          return;
        }
        const id = crypto.randomBytes(12).toString("hex");
        job = {
          id,
          payload: validated.normalized,
          delivered: false,
          result: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        log(`job ${id}: received ${validated.normalized.totals.cookies} cookies / ${validated.normalized.totals.domains} domains`);
        sendJson(res, 200, { ok: true, jobId: id, totals: validated.normalized.totals }, cors);
        return;
      }

      if (url.pathname === "/v1/jobs/next" && req.method === "GET") {
        if (!job || job.delivered) {
          res.writeHead(204, cors);
          res.end();
          return;
        }
        job.delivered = true;
        job.updatedAt = Date.now();
        log(`job ${job.id}: delivered to target (${job.payload.totals.cookies} cookies)`);
        sendJson(res, 200, { jobId: job.id, version: PROTOCOL_VERSION, source: job.payload.source, cookies: job.payload.cookies, totals: job.payload.totals }, cors);
        return;
      }

      const resultMatch = url.pathname.match(/^\/v1\/jobs\/([a-f0-9]{24})\/result$/);
      if (resultMatch && req.method === "POST") {
        if (!job || job.id !== resultMatch[1]) {
          sendJson(res, 404, { error: "job-not-found" }, cors);
          return;
        }
        const body = await readJsonBody(req, maxBytes);
        const checked = validateResultPayload(body, job.payload.cookies.length);
        if (!checked.ok) {
          log(`job ${job.id}: invalid result (${checked.errors.join(",")})`);
          sendJson(res, 400, { error: "invalid-result", errors: checked.errors }, cors);
          return;
        }
        job.result = checked.result;
        job.updatedAt = Date.now();
        lastFinished = job;
        log(`job ${job.id}: applied ${checked.result.applied}, failed ${checked.result.failed}`);
        sendJson(res, 200, { ok: true }, cors);
        return;
      }

      const statusMatch = url.pathname.match(/^\/v1\/jobs\/([a-f0-9]{24})\/status$/);
      if (statusMatch && req.method === "GET") {
        if (!job || job.id !== statusMatch[1]) {
          sendJson(res, 404, { error: "job-not-found" }, cors);
          return;
        }
        sendJson(
          res,
          200,
          {
            jobId: job.id,
            status: job.result ? "done" : job.delivered ? "delivered" : "pending",
            totals: job.payload.totals,
            result: job.result,
            cookieImported: {
              status: job.result ? (job.result.failed === 0 ? "imported" : "partially_imported") : "not_started",
              applied: job.result?.applied ?? 0,
              failed: job.result?.failed ?? 0,
            },
            loginVerified: { status: "not_verified" },
          },
          cors,
        );
        return;
      }

      sendJson(res, 404, { error: "not-found" }, cors);
    } catch (err) {
      if (err && err.code === "body-too-large") {
        sendJson(res, 413, { error: "body-too-large" }, cors);
        res.once("finish", () => req.destroy());
        return;
      }
      log(`request error: ${err && err.message ? err.message : err}`);
      if (!res.headersSent) sendJson(res, 400, { error: "bad-request" }, cors);
    }
  });

  let actualPort = 0;
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      actualPort = server.address().port;
      resolve(actualPort);
    });
  });

  return {
    server,
    logs,
    get port() {
      return actualPort;
    },
    listening,
    log,
    close: () =>
      new Promise((resolve) => {
        clearInterval(cleanup);
        server.close(() => resolve());
      }),
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

async function main() {
  const args = process.argv.slice(2);
  const get = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const port = Number(get("port", DEFAULT_PORT));
  const pair = get("pair", randomPairCode());
  const originsArg = get("allowed-origins", null);
  const origins = originsArg
    ? String(originsArg)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;
  const broker = startBroker({ port, pair, allowedOrigins: origins });
  const actual = await broker.listening;
  console.log(`Browser CLI cookie bridge broker`);
  console.log(`  url:   http://127.0.0.1:${actual}`);
  console.log(`  pair:  ${pair}`);
  console.log(`  ttl:   10 minutes; memory only; no cookie values are logged or written to disk`);
  if (origins.length) console.log(`  allowed origins: ${origins.join(", ")}`);
  console.log(`Press Ctrl+C to stop.`);
  process.on("SIGINT", async () => {
    await broker.close();
    process.exit(0);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`broker failed: ${err && err.message ? err.message : err}`);
    process.exit(2);
  });
}
