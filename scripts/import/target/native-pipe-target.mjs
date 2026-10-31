#!/usr/bin/env node
// Native pipe test target for the v2 cookie-import protocol.
//
// This is a TEST DOUBLE, not the Browser CLI native target. It exists so the
// BrowserPilot import relay, the wire protocol, ticket/one-shot semantics and
// the no-values-in-output rules can be exercised without building Chromium.
// It reports native:false and authorization.simulated:true so no caller can
// mistake it for the product loop. The real target is the proposed Chromium
// patch in the browser-cli repository.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as contract from "../contract.mjs";
import { createFrameReader, encodeFrame } from "../frame.mjs";

export const TEST_PUBLIC_SUFFIXES = new Set(["com", "net", "org", "test", "co.uk", "github.io"]);

export function createMemoryCookieBackend({ failWith = null } = {}) {
  const store = new Map();
  return {
    kind: "memory",
    async applyCookie(cookie) {
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

function pipePathForTest() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\browser-cli-import-test-${process.pid}-${randomHex(8)}`;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bci-import-test-"));
  fs.chmodSync(dir, 0o700);
  return path.join(dir, "target.sock");
}

function normalizeView(job) {
  return contract.createPublicJobView(job);
}

export function startNativePipeTestTarget(options = {}) {
  const ticket = options.ticket ? String(options.ticket) : contract.generateTicket();
  const sessionDir = options.sessionDir || fs.mkdtempSync(path.join(os.tmpdir(), "bci-import-sessions-"));
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const backend = options.backend || createMemoryCookieBackend();
  const log = options.log || (() => {});
  const logs = [];
  const logSafe = (line) => {
    const safe = String(line).replace(/[\r\n]+/g, " ");
    logs.push(safe);
    log(safe);
  };
  const approve = options.approve !== undefined ? options.approve : true;
  const isPublicSuffix = options.isPublicSuffix || ((domain) => TEST_PUBLIC_SUFFIXES.has(domain));
  const now = options.now || (() => Date.now());
  const pipePath = options.pipePath || pipePathForTest();
  const targetInstanceId = randomHex(16);
  const targetPid = process.pid;
  const targetStartTimeMs = Math.floor(Date.now() - process.uptime() * 1000);

  let consumed = false;
  let activeJob = null;
  let socket = null;
  let closed = false;
  let descriptorPath = "";
  const failures = [];
  let rateLimitedUntil = 0;

  const server = net.createServer((client) => {
    if (socket) {
      client.write(encodeFrame({ type: "error", code: "target-busy" }));
      client.destroy();
      return;
    }
    socket = client;
    let job = null;
    const chunks = [];
    let nextChunk = 0;
    const reader = createFrameReader((frame) => {
      void onFrame(frame);
    });
    client.on("data", (chunk) => {
      try {
        reader(chunk);
      } catch {
        client.write(encodeFrame({ type: "error", code: "protocol-mismatch" }));
        client.destroy();
      }
    });
    client.on("error", () => {});
    client.on("close", () => {
      if (socket === client) socket = null;
      if (job && !contract.TERMINAL_JOB_STATES.has(job.state)) {
        job.state = "cancelled";
        job.updatedAt = new Date().toISOString();
        logSafe(`test target: job ${job.id} cancelled because the relay disconnected`);
      }
    });

    async function send(message) {
      if (!client.destroyed) client.write(encodeFrame(message));
    }

    async function fail(code) {
      await send({ type: "error", code });
    }

    function recordFailure() {
      failures.push(now());
      while (failures.length && now() - failures[0] > contract.TICKET_FAILURE_WINDOW_MS) failures.shift();
      if (failures.length >= contract.MAX_TICKET_FAILURES) {
        rateLimitedUntil = now() + contract.RATE_LIMIT_BLOCK_MS;
      }
    }

    async function onFrame(frame) {
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "hello") {
        if (now() < rateLimitedUntil) return fail("rate-limited");
        if (frame.protocol !== contract.PROTOCOL_VERSION) return fail("protocol-mismatch");
        if (consumed) return fail("ticket-consumed");
        if (!contract.isValidTicket(frame.ticket)) {
          recordFailure();
          return fail("ticket-invalid");
        }
        if (!(await contract.ticketMatchesHash(frame.ticket, await contract.ticketHash(ticket)))) {
          recordFailure();
          return fail("ticket-invalid");
        }
        if (now() > descriptorExpiresAt()) {
          recordFailure();
          return fail("ticket-expired");
        }
        if (job) return fail("target-busy");
        consumed = true;
        job = {
          id: randomHex(12),
          state: "pending",
          jobNonce: frame.jobNonce,
          jobDigest: frame.jobDigest,
          totalBytes: frame.totalBytes,
          chunkCount: frame.chunkCount,
          payload: null,
          totals: null,
          progress: { applied: 0, failed: 0 },
          failures: {},
          authorization: { targetUserConfirmed: false, simulated: false, source: "none" },
          error: null,
          cancelRequested: false,
          transport: "named-pipe",
          native: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        activeJob = job;
        await send({
          type: "ready",
          protocol: contract.PROTOCOL_VERSION,
          sessionId: targetInstanceId,
          targetPid,
          targetProduct: "BrowserPilot native pipe test target",
          targetVersion: "test",
          native: false,
          capabilities: {
            cookieStoreWrite: true,
            persistAcrossRestart: false,
            partitionedCookies: true,
            sessionCookies: true,
          },
        });
        return;
      }
      if (!job) return fail("protocol-mismatch");
      if (frame.jobNonce !== job.jobNonce) return fail("job-binding-mismatch");
      if (frame.type === "job-begin") {
        if (frame.totalBytes !== job.totalBytes || frame.chunkCount !== job.chunkCount) {
          return fail("protocol-mismatch");
        }
        return;
      }
      if (frame.type === "job-chunk") {
        if (!Number.isInteger(frame.index) || frame.index !== nextChunk) return fail("chunk-missing");
        if (typeof frame.data !== "string" || frame.data.length > contract.MAX_FRAME_BYTES) {
          return fail("too-large");
        }
        chunks.push(frame.data);
        nextChunk += 1;
        return;
      }
      if (frame.type === "job-commit") {
        if (chunks.length !== job.chunkCount) return fail("chunk-missing");
        let bytes;
        try {
          bytes = contract.assembleChunks(chunks, { maxBytes: job.totalBytes });
        } catch (err) {
          return fail(err && err.code ? err.code : "too-large");
        }
        if (bytes.length !== job.totalBytes) return fail("chunk-missing");
        if (!contract.safeEqualString(await contract.sha256Hex(bytes), job.jobDigest)) {
          return fail("job-digest-mismatch");
        }
        let payload;
        try {
          payload = JSON.parse(contract.decodeUtf8(bytes));
        } catch {
          return fail("protocol-mismatch");
        }
        const checked = await contract.validateImportRequest(payload, { now: now() });
        if (!checked.ok || checked.normalized.jobNonce !== job.jobNonce) {
          return fail("protocol-mismatch");
        }
        job.payload = checked.normalized;
        job.totals = checked.normalized.totals;
        job.state = "awaiting_authorization";
        job.updatedAt = new Date().toISOString();
        await send({
          type: "accepted",
          jobId: job.id,
          state: job.state,
          totals: job.totals,
          native: false,
          authorization: job.authorization,
        });
        await send({ type: "status", view: normalizeView(job) });
        await runJob(job);
        return;
      }
      if (frame.type === "cancel") {
        job.cancelRequested = true;
        await send({ type: "cancel-ok", state: job.state });
        if (!contract.TERMINAL_JOB_STATES.has(job.state)) {
          job.state = "cancelled";
          job.updatedAt = new Date().toISOString();
          await send({ type: "status", view: normalizeView(job) });
        }
        return;
      }
      if (frame.type === "close") {
        client.destroy();
        return;
      }
      return fail("protocol-mismatch");
    }

    async function runJob(currentJob) {
      let approved;
      try {
        approved = typeof approve === "function" ? await approve(currentJob) : approve;
      } catch {
        approved = false;
      }
      if (currentJob.cancelRequested) {
        currentJob.state = "cancelled";
        currentJob.updatedAt = new Date().toISOString();
        await send({ type: "status", view: normalizeView(currentJob) });
        return;
      }
      if (!approved) {
        currentJob.state = "denied";
        currentJob.error = { code: "authorization-denied" };
        currentJob.authorization = {
          targetUserConfirmed: false,
          simulated: true,
          source: "test-auto-deny",
        };
        currentJob.updatedAt = new Date().toISOString();
        await send({ type: "status", view: normalizeView(currentJob) });
        return;
      }
      currentJob.authorization = {
        targetUserConfirmed: true,
        simulated: true,
        source: "test-auto-approve",
        scopeDigest: currentJob.payload.consent.domainsDigest,
        confirmedAt: new Date().toISOString(),
      };
      currentJob.state = "applying";
      currentJob.updatedAt = new Date().toISOString();
      await send({ type: "status", view: normalizeView(currentJob) });
      for (const cookie of currentJob.payload.cookies) {
        if (currentJob.cancelRequested) break;
        const policyFailure = contract.cookiePolicyFailure(cookie, currentJob.payload.domains, {
          now: now(),
          isPublicSuffix,
        });
        if (policyFailure) {
          currentJob.failures[policyFailure] = (currentJob.failures[policyFailure] || 0) + 1;
          currentJob.progress.failed += 1;
          continue;
        }
        try {
          await backend.applyCookie(cookie);
          currentJob.progress.applied += 1;
        } catch (err) {
          const code = contract.classifySetFailure(err);
          currentJob.failures[code] = (currentJob.failures[code] || 0) + 1;
          currentJob.progress.failed += 1;
        }
      }
      if (currentJob.cancelRequested) {
        currentJob.state = "cancelled";
      } else if (currentJob.progress.applied === 0 && currentJob.progress.failed > 0) {
        currentJob.state = "failed";
        currentJob.error = { code: Object.keys(currentJob.failures)[0] || "internal" };
      } else {
        currentJob.state = "done";
      }
      currentJob.updatedAt = new Date().toISOString();
      logSafe(
        `test target: job ${currentJob.id} ${currentJob.state} ` +
          `applied=${currentJob.progress.applied} failed=${currentJob.progress.failed}`,
      );
      await send({ type: "status", view: normalizeView(currentJob) });
    }
  });

  function descriptorExpiresAt() {
    return Date.parse(descriptor.expiresAt);
  }

  let descriptor = contract.createSessionDescriptor({
    targetProduct: "BrowserPilot native pipe test target",
    targetVersion: "test",
    targetPid,
    targetStartTimeMs,
    targetInstanceId,
    profileHash: "0".repeat(64),
    ticketHash: "0".repeat(64),
    transport: "named-pipe",
    pipeName: pipePath,
  });

  const listening = (async () => {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipePath, () => resolve());
    });
    descriptor = contract.createSessionDescriptor({
      targetProduct: "BrowserPilot native pipe test target",
      targetVersion: "test",
      targetPid,
      targetStartTimeMs,
      targetInstanceId,
      profileHash: "0".repeat(64),
      ticketHash: await contract.ticketHash(ticket),
      transport: "named-pipe",
      pipeName: pipePath,
      createdAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + contract.TICKET_TTL_MS).toISOString(),
    });
    descriptorPath = path.join(sessionDir, `session-${targetInstanceId}.json`);
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
    logSafe("test target: listening; ticket written to session descriptor hash only");
    return { pipePath, descriptorPath };
  })();

  async function close() {
    if (closed) return;
    closed = true;
    if (socket) {
      try {
        socket.destroy();
      } catch {}
    }
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      if (descriptorPath) fs.unlinkSync(descriptorPath);
    } catch {}
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(pipePath);
      } catch {}
    }
    await backend.close();
  }

  return {
    ticket,
    sessionDir,
    pipePath,
    backend,
    logs,
    listening,
    get descriptorPath() {
      return descriptorPath;
    },
    get descriptor() {
      return descriptor;
    },
    get job() {
      return activeJob;
    },
    get view() {
      return activeJob ? normalizeView(activeJob) : null;
    },
    get consumed() {
      return consumed;
    },
    close,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const target = startNativePipeTestTarget();
  const info = await target.listening;
  console.log(`ticket: ${contract.formatTicket(target.ticket)} (test double; native=false)`);
  console.log(`session descriptor: ${info.descriptorPath}`);
  console.log(`pipe: ${info.pipePath}`);
  const shutdown = async () => {
    await target.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
