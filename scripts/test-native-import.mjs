#!/usr/bin/env node
// Native host relay + extension transport + native pipe test-target tests.
//
// No browser is launched. Everything runs against synthetic in-memory cookies
// and a test double that speaks the v2 named-pipe protocol. The test target
// reports native:false and simulated authorization so it can never be mistaken
// for the Browser CLI product target.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as contract from "./import/contract.mjs";
import { createImportRelay, defaultSessionDir } from "../native-host/import-relay.mjs";
import { startNativePipeTestTarget } from "./import/target/native-pipe-target.mjs";
import { createNativeTransport } from "../extensions/import-source/lib/native-transport.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const HOST = path.join(REPO, "native-host", "host.js");

const CANARY = "NATIVE-IMPORT-CANARY-2d7f1c";
const CANARY2 = "NATIVE-IMPORT-CANARY-9a34be";

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
  if (value.session && overrides.expirationDate === undefined) delete value.expirationDate;
  return value;
}

async function makePayload({ jobNonce = "a".repeat(32), domains = ["example.test"], cookies = [cookie()] } = {}) {
  const consent = await contract.buildConsent({ extensionVersion: "0.3.0", domains });
  const payload = {
    contract: contract.CONTRACT_ID,
    protocolVersion: contract.PROTOCOL_VERSION,
    jobNonce,
    source: { browser: "chrome", profileLabel: "Synthetic", extensionVersion: "0.3.0" },
    consent,
    domains,
    cookies,
  };
  const text = JSON.stringify(payload);
  const chunks = contract.chunkJobPayload(text);
  return {
    payload,
    text,
    chunks,
    digest: await contract.jobDigest(text),
    totalBytes: new TextEncoder().encode(text).length,
  };
}

function createInProcessRelay(target) {
  const events = [];
  const logs = [];
  const relay = createImportRelay({
    send: (message) => events.push(message),
    sessionDir: target.sessionDir,
    log: (line) => logs.push(line),
  });
  return { relay, events, logs };
}

async function sendJob(relay, target, payload, { chunks, digest, totalBytes } = {}) {
  const jobChunks = chunks || contract.chunkJobPayload(payload.text || JSON.stringify(payload));
  const jobDigest = digest || (await contract.jobDigest(payload.text || JSON.stringify(payload)));
  const bytes = totalBytes || new TextEncoder().encode(payload.text || JSON.stringify(payload)).length;
  await relay.handle({ type: "hello", protocol: 2, mode: "cookie-import", extensionVersion: "0.3.0" });
  await relay.handle({
    type: "begin",
    ticket: contract.formatTicket(target.ticket),
    jobNonce: payload.payload.jobNonce,
    jobDigest,
    totalBytes: bytes,
    chunkCount: jobChunks.length,
  });
  for (let i = 0; i < jobChunks.length; i += 1) {
    await relay.handle({ type: "chunk", jobNonce: payload.payload.jobNonce, index: i, data: jobChunks[i] });
  }
  await relay.handle({ type: "commit", jobNonce: payload.payload.jobNonce });
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started >= timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function fakeNativePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  let handler = () => {};
  const port = {
    posted: [],
    postMessage(message) {
      port.posted.push(message);
      setTimeout(() => handler(message), 0);
    },
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    disconnect() {
      for (const fn of disconnectListeners) fn();
    },
    emit(message) {
      for (const fn of messageListeners) fn(message);
    },
    setHandler(fn) {
      handler = fn;
    },
  };
  return port;
}

async function main() {
  // ---------------------------------------------------------------------
  // A. In-process relay against the native pipe test target
  // ---------------------------------------------------------------------
  await check("relay forwards a job, target applies it and reports simulated authorization", async () => {
    const target = startNativePipeTestTarget({ log: () => {} });
    await target.listening;
    const { relay, events, logs } = createInProcessRelay(target);
    const built = await makePayload({
      cookies: [cookie({ name: "persistent" }), cookie({ name: "session", session: true })],
    });
    await sendJob(relay, target, built);
    const done = await waitFor(() => events.find((e) => e.type === "status" && e.view.state === "done"));
    assert.equal(done.view.cookieImported.status, "imported");
    assert.equal(done.view.loginVerified.status, "not_verified");
    assert.equal(done.view.authorization.targetUserConfirmed, true);
    assert.equal(done.view.authorization.simulated, true);
    assert.equal(done.view.sessionCookies.count, 1);
    assert.equal(done.view.sessionCookies.mayNotSurviveRestart, true);
    assert.equal(target.backend.snapshot().length, 2);
    assert.equal(target.backend.snapshot()[0].value, CANARY);
    const output = JSON.stringify(events);
    assert.equal(output.includes(CANARY), false);
    assert.equal(output.includes(CANARY2), false);
    assert.equal(output.includes("example.test"), false);
    assert.equal(output.includes(target.ticket), false);
    const logText = logs.join("\n");
    assert.equal(logText.includes(target.ticket), false);
    assert.equal(logText.includes(CANARY), false);
    assert.ok(logText.includes("accepted"));
    relay.close();
    await target.close();
  });

  await check("relay rejects a consumed ticket and never opens a second job", async () => {
    const target = startNativePipeTestTarget({ log: () => {} });
    await target.listening;
    const first = createInProcessRelay(target);
    await sendJob(first.relay, target, await makePayload({ jobNonce: "b".repeat(32) }));
    await waitFor(() => first.events.find((e) => e.type === "status" && e.view.state === "done"));
    first.relay.close();

    const second = createInProcessRelay(target);
    const built = await makePayload({ jobNonce: "c".repeat(32) });
    await second.relay.handle({ type: "hello", protocol: 2, mode: "cookie-import" });
    await second.relay.handle({
      type: "begin",
      ticket: contract.formatTicket(target.ticket),
      jobNonce: built.payload.jobNonce,
      jobDigest: built.digest,
      totalBytes: built.totalBytes,
      chunkCount: built.chunks.length,
    });
    const error = await waitFor(() => second.events.find((e) => e.type === "error"));
    assert.equal(error.code, "ticket-consumed");
    assert.equal(target.backend.snapshot().length, 1);
    second.relay.close();
    await target.close();
  });

  await check("relay counts invalid tickets and locks after the failure limit", async () => {
    const target = startNativePipeTestTarget({ log: () => {} });
    await target.listening;
    const { relay, events } = createInProcessRelay(target);
    await relay.handle({ type: "hello", protocol: 2, mode: "cookie-import" });
    for (let i = 0; i < contract.MAX_TICKET_FAILURES; i += 1) {
      const built = await makePayload({ jobNonce: `${i}`.repeat(32) });
      await relay.handle({
        type: "begin",
        ticket: "123456",
        jobNonce: built.payload.jobNonce,
        jobDigest: built.digest,
        totalBytes: built.totalBytes,
        chunkCount: built.chunks.length,
      });
    }
    const limited = await waitFor(() => events.find((e) => e.type === "error" && e.code === "rate-limited"));
    assert.equal(limited.code, "rate-limited");
    assert.equal(target.consumed, false);
    relay.close();
    await target.close();
  });

  await check("relay rejects a tampered digest before the target sees a job", async () => {
    const target = startNativePipeTestTarget({ log: () => {} });
    await target.listening;
    const { relay, events } = createInProcessRelay(target);
    const built = await makePayload({ jobNonce: "d".repeat(32) });
    const chunks = [...built.chunks];
    chunks[0] = (chunks[0][0] === "A" ? "B" : "A") + chunks[0].slice(1);
    await relay.handle({ type: "hello", protocol: 2, mode: "cookie-import" });
    await relay.handle({
      type: "begin",
      ticket: contract.formatTicket(target.ticket),
      jobNonce: built.payload.jobNonce,
      jobDigest: built.digest,
      totalBytes: built.totalBytes,
      chunkCount: chunks.length,
    });
    for (let i = 0; i < chunks.length; i += 1) {
      await relay.handle({ type: "chunk", jobNonce: built.payload.jobNonce, index: i, data: chunks[i] });
    }
    await relay.handle({ type: "commit", jobNonce: built.payload.jobNonce });
    const error = await waitFor(() => events.find((e) => e.type === "error"));
    assert.equal(error.code, "job-digest-mismatch");
    // The ticket is consumed when the target accepts the pipe session; a
    // tampered payload never completes the job or writes a cookie.
    assert.equal(target.job.payload, null);
    assert.equal(target.job.state, "pending");
    assert.equal(target.backend.snapshot().length, 0);
    relay.close();
    await target.close();
  });

  await check("relay rejects a missing chunk and an oversized job header", async () => {
    const target = startNativePipeTestTarget({ log: () => {} });
    await target.listening;
    const { relay, events } = createInProcessRelay(target);
    const built = await makePayload({ jobNonce: "e".repeat(32) });
    await relay.handle({ type: "hello", protocol: 2, mode: "cookie-import" });
    await relay.handle({
      type: "begin",
      ticket: contract.formatTicket(target.ticket),
      jobNonce: built.payload.jobNonce,
      jobDigest: built.digest,
      totalBytes: built.totalBytes,
      chunkCount: built.chunks.length + 2,
    });
    await relay.handle({ type: "chunk", jobNonce: built.payload.jobNonce, index: 0, data: built.chunks[0] });
    await relay.handle({ type: "commit", jobNonce: built.payload.jobNonce });
    const missing = await waitFor(() => events.find((e) => e.type === "error"));
    assert.equal(missing.code, "chunk-missing");
    relay.close();
    await target.close();
  });

  await check("target denial is reported honestly and writes nothing", async () => {
    const target = startNativePipeTestTarget({ approve: false, log: () => {} });
    await target.listening;
    const { relay, events } = createInProcessRelay(target);
    await sendJob(relay, target, await makePayload({ jobNonce: "f".repeat(32) }));
    const denied = await waitFor(() => events.find((e) => e.type === "status" && e.view.state === "denied"));
    assert.equal(denied.view.authorization.targetUserConfirmed, false);
    assert.equal(denied.view.authorization.simulated, true);
    assert.equal(denied.view.cookieImported.status, "not_started");
    assert.equal(denied.view.loginVerified.status, "not_verified");
    assert.equal(target.backend.snapshot().length, 0);
    relay.close();
    await target.close();
  });

  await check("expired session descriptors are not usable", async () => {
    const target = startNativePipeTestTarget({ log: () => {} });
    await target.listening;
    const descriptor = JSON.parse(fs.readFileSync(target.descriptorPath, "utf8"));
    fs.writeFileSync(
      target.descriptorPath,
      JSON.stringify({ ...descriptor, createdAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const { relay, events } = createInProcessRelay(target);
    const built = await makePayload({ jobNonce: "1".repeat(32) });
    await relay.handle({ type: "hello", protocol: 2, mode: "cookie-import" });
    await relay.handle({
      type: "begin",
      ticket: contract.formatTicket(target.ticket),
      jobNonce: built.payload.jobNonce,
      jobDigest: built.digest,
      totalBytes: built.totalBytes,
      chunkCount: built.chunks.length,
    });
    const error = await waitFor(() => events.find((e) => e.type === "error"));
    assert.equal(error.code, "target-not-running");
    assert.equal(target.consumed, false);
    relay.close();
    await target.close();
  });

  // ---------------------------------------------------------------------
  // B. Extension native transport against the relay
  // ---------------------------------------------------------------------
  await check("extension native transport submits chunks and receives count-only status", async () => {
    const target = startNativePipeTestTarget({ log: () => {} });
    await target.listening;
    const port = fakeNativePort();
    const relay = createImportRelay({
      send: (message) => port.emit(message),
      sessionDir: target.sessionDir,
      log: () => {},
    });
    port.setHandler((message) => {
      void relay.handle(message);
    });
    // Relay responses are emitted through the same fake port.
    const transport = createNativeTransport({ connectNative: () => port });
    const viewEvents = [];
    const built = await makePayload({ jobNonce: "2".repeat(32) });
    const accepted = await transport.submit({
      ticket: contract.formatTicket(target.ticket),
      payloadText: built.text,
      jobNonce: built.payload.jobNonce,
      digest: built.digest,
      onStatus: (view) => viewEvents.push(view),
    });
    assert.ok(accepted.jobId);
    assert.equal(accepted.totals.cookies, 1);
    const done = await waitFor(() => viewEvents.find((v) => v.state === "done"));
    assert.equal(done.loginVerified.status, "not_verified");
    assert.equal(done.authorization.simulated, true);
    assert.equal(JSON.stringify(viewEvents).includes(CANARY), false);
    // Frames carry base64 chunks, not plaintext values.
    assert.equal(JSON.stringify(port.posted).includes(CANARY), false);
    assert.ok(port.posted.some((message) => message.type === "chunk"));
    assert.equal(target.backend.snapshot()[0].value, CANARY);
    transport.close();
    relay.close();
    await target.close();
  });

  await check("extension native transport rejects an invalid ticket before posting a job", async () => {
    const port = fakeNativePort();
    const transport = createNativeTransport({ connectNative: () => port });
    await assert.rejects(
      () => transport.submit({ ticket: "123456", payloadText: "{}", jobNonce: "3".repeat(32), digest: "0".repeat(64) }),
      (err) => err.code === "ticket-invalid",
    );
    assert.equal(port.posted.length, 0);
    transport.close();
  });

  // ---------------------------------------------------------------------
  // C. Real host process in import mode (stdio-only, no TCP listener)
  // ---------------------------------------------------------------------
  await check("host process enters import-only relay mode without a normal-mode ready event", async () => {
    const target = startNativePipeTestTarget({ log: () => {} });
    await target.listening;
    const authPath = path.join(REPO, "native-host", "auth.json");
    const authBefore = fs.existsSync(authPath) ? fs.readFileSync(authPath) : null;
    const child = spawn(process.execPath, [HOST], {
      cwd: REPO,
      env: {
        ...process.env,
        BROWSER_CLI_IMPORT_SESSION_DIR: target.sessionDir,
        BROWSERPILOT_HOST_BASE_PORT: "48031",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuf = Buffer.alloc(0);
    let stderr = "";
    const frames = [];
    child.stdout.on("data", (chunk) => {
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      while (stdoutBuf.length >= 4) {
        const length = stdoutBuf.readUInt32LE(0);
        if (stdoutBuf.length < 4 + length) return;
        const message = JSON.parse(stdoutBuf.subarray(4, 4 + length).toString("utf8"));
        stdoutBuf = stdoutBuf.subarray(4 + length);
        frames.push(message);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const sendNative = (message) => {
      const json = Buffer.from(JSON.stringify(message), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(json.length, 0);
      child.stdin.write(Buffer.concat([header, json]));
    };
    try {
      const built = await makePayload({ jobNonce: "4".repeat(32) });
      sendNative({ type: "hello", protocol: 2, mode: "cookie-import", extensionVersion: "0.3.0" });
      await waitFor(() => frames.find((f) => f.type === "hello-ok"));
      sendNative({
        type: "begin",
        ticket: contract.formatTicket(target.ticket),
        jobNonce: built.payload.jobNonce,
        jobDigest: built.digest,
        totalBytes: built.totalBytes,
        chunkCount: built.chunks.length,
      });
      await waitFor(() => frames.find((f) => f.type === "ready"));
      for (let i = 0; i < built.chunks.length; i += 1) {
        sendNative({ type: "chunk", jobNonce: built.payload.jobNonce, index: i, data: built.chunks[i] });
      }
      sendNative({ type: "commit", jobNonce: built.payload.jobNonce });
      const done = await waitFor(() => frames.find((f) => f.type === "status" && f.view.state === "done"));
      assert.equal(done.view.loginVerified.status, "not_verified");
      assert.equal(done.view.authorization.simulated, true);
      assert.equal(frames.some((f) => f.type === "event" && f.name === "ready"), false);
      assert.equal(JSON.stringify(frames).includes(CANARY), false);
      assert.equal(JSON.stringify(frames).includes(target.ticket), false);
      assert.equal(stderr.includes(CANARY), false);
      assert.equal(stderr.includes(target.ticket), false);
      assert.ok(stderr.includes("import-only relay"));
      const authAfter = fs.existsSync(authPath) ? fs.readFileSync(authPath) : null;
      assert.equal(authAfter === null ? null : authAfter.toString("base64"), authBefore === null ? null : authBefore.toString("base64"));
    } finally {
      child.kill();
      await target.close();
    }
  });

  await check("BROWSER_CLI_IMPORT_SESSION_DIR override is honored", () => {
    const previous = process.env.BROWSER_CLI_IMPORT_SESSION_DIR;
    const dir = tempDir("bci-session-override-");
    process.env.BROWSER_CLI_IMPORT_SESSION_DIR = dir;
    try {
      assert.equal(defaultSessionDir(), dir);
    } finally {
      if (previous === undefined) delete process.env.BROWSER_CLI_IMPORT_SESSION_DIR;
      else process.env.BROWSER_CLI_IMPORT_SESSION_DIR = previous;
    }
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
