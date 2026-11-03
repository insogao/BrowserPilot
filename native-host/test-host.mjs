// Native host integration test: dynamic port, auth, request routing, host-instance
// result isolation, and explicit HOST_DISCONNECTED errors on native-port EOF.
//
// This is the fast protocol-level gate; the real Chrome/native-messaging E2E lives in
// scripts/test-native-e2e.mjs and scripts/test-native-host-restart-e2e.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Official client (native-host/client.mjs) must surface a closed connection as an
 * explicit JSON error instead of hanging until its 2-minute command timeout.
 * A tiny fake host proves both graceful EOF and hard RST.
 */
async function exerciseClientDisconnect(closeMode) {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "bp-client-disconnect-"));
  const sessionDir = path.join(localAppData, "BrowserPilot", "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.name === "ping") {
          socket.write(JSON.stringify({ type: "result", requestId: message.requestId, ok: true, data: { pong: true } }) + "\n");
        } else if (message.name === "version") {
          if (closeMode === "reset") socket.destroy();
          else socket.end();
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  fs.writeFileSync(path.join(sessionDir, port + ".json"), JSON.stringify({
    port,
    authToken: "fake-token",
    instanceId: "fake-instance",
    pid: process.pid,
    updatedAt: Date.now(),
  }));
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["native-host/client.mjs", "version", "--no-launch"], {
      cwd: process.cwd(),
      env: { ...process.env, LOCALAPPDATA: localAppData },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: "timeout", stdout, stderr, ms: Date.now() - started });
    }, 10000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
  server.close();
  fs.rmSync(localAppData, { recursive: true, force: true });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = undefined; }
  assert.notEqual(result.code, "timeout", "client hung after " + closeMode + " disconnect");
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(parsed?.ok, false, JSON.stringify(result));
  assert.equal(parsed?.errorCode, "HOST_DISCONNECTED", JSON.stringify(result));
  assert.ok(result.ms < 5000, "explicit disconnect took " + result.ms + "ms");
  return { mode: closeMode, code: result.code, ms: result.ms, error: parsed.error, errorCode: parsed.errorCode };
}

function startHost(basePort) {
  const child = spawn(process.execPath, ["native-host/host.js"], {
    cwd: process.cwd(),
    env: { ...process.env, BROWSERPILOT_HOST_BASE_PORT: String(basePort) },
  });
  let nativeBuf = Buffer.alloc(0);
  let stderr = "";
  const frames = [];
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    nativeBuf = Buffer.concat([nativeBuf, chunk]);
    while (nativeBuf.length >= 4) {
      const len = nativeBuf.readUInt32LE(0);
      if (nativeBuf.length < 4 + len) break;
      const msg = JSON.parse(nativeBuf.subarray(4, 4 + len).toString("utf8"));
      nativeBuf = nativeBuf.subarray(4 + len);
      frames.push(msg);
    }
  });
  return { child, frames, stderr: () => stderr };
}

const waitFor = async (fn, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = fn();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("timeout");
};

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function messages(socket) {
  const out = [];
  let buf = "";
  socket.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) out.push(JSON.parse(line));
    }
  });
  return out;
}

function sendNative(host, obj) {
  const json = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  host.child.stdin.write(Buffer.concat([len, json]));
}

const host = startHost(48000 + Math.floor(Math.random() * 200));
let a;
let b;
try {
  const ready = await waitFor(() => host.frames.find((m) => m.type === "event" && m.name === "ready")?.args).catch(() => {
    throw new Error("host did not become ready" + (host.stderr().trim() ? "; stderr=" + host.stderr().trim() : ""));
  });
  assert.equal(typeof ready.instanceId, "string");
  assert.match(ready.instanceId, /^[0-9a-f]{16}$/);

  a = await connect(ready.port);
  b = await connect(ready.port);
  const am = messages(a);
  const bm = messages(b);

  b.write(JSON.stringify({ type: "command", name: "version", requestId: "denied" }) + "\n");
  await waitFor(() => bm[0]);
  assert.equal(bm[0].error, "authentication_required");

  // 1) auth + per-client routing (existing contract).
  a.write(JSON.stringify({ type: "command", name: "version", requestId: "client-a", authToken: ready.authToken }) + "\n");
  const command = await waitFor(() => host.frames.find((m) => m.type === "command" && m.name === "version"));
  assert.notEqual(command.requestId, "client-a");
  assert.equal(command.authToken, undefined);
  assert.ok(command.requestId.startsWith("bp:" + ready.instanceId + ":"), command.requestId);
  sendNative(host, { type: "result", requestId: command.requestId, ok: true, data: { version: "test" } });
  await waitFor(() => am[0]);
  assert.equal(am[0].requestId, "client-a");
  assert.deepEqual(am[0].data, { version: "test" });
  assert.equal(bm.length, 1, "result leaked to another client");

  // 2) A result tagged with a stale (old host instance) id must never match a live
  //    pending request, even when client/sequence segments are identical.
  a.write(JSON.stringify({ type: "command", name: "version", requestId: "client-a2", authToken: ready.authToken }) + "\n");
  const command2 = await waitFor(() => host.frames.find((m) => m.type === "command" && m.name === "version" && m.requestId !== command.requestId));
  const staleId = command2.requestId.replace("bp:" + ready.instanceId + ":", "bp:0000000000000000:");
  assert.notEqual(staleId, command2.requestId);
  sendNative(host, { type: "result", requestId: staleId, ok: true, data: { version: "stale-result" } });
  await sleep(150);
  assert.equal(am.length, 1, "stale host-instance result was routed to a live client");
  sendNative(host, { type: "result", requestId: command2.requestId, ok: true, data: { version: "fresh-result" } });
  await waitFor(() => am.length === 2);
  assert.equal(am[1].requestId, "client-a2");
  assert.deepEqual(am[1].data, { version: "fresh-result" });

  // 3) Native-port EOF must fail a pending TCP request explicitly, then exit.
  a.write(JSON.stringify({ type: "command", name: "version", requestId: "client-pending", authToken: ready.authToken }) + "\n");
  await waitFor(() => host.frames.filter((m) => m.type === "command" && m.name === "version").length >= 3);
  const exitPromise = new Promise((resolve) => host.child.once("exit", (code) => resolve(code)));
  host.child.stdin.end();
  const pending = await waitFor(() => am.find((m) => m.requestId === "client-pending"));
  assert.equal(pending.ok, false);
  assert.equal(pending.error, "host_disconnected");
  assert.equal(pending.errorCode, "HOST_DISCONNECTED");
  const code = await Promise.race([exitPromise, sleep(5000).then(() => "timeout")]);
  assert.notEqual(code, "timeout", "host did not exit after native-port EOF");
  console.log("PASS host: auth + dynamic port + per-client routing + instance isolation + explicit HOST_DISCONNECTED");

  a.end();
  b.end();
  a = undefined;
  b = undefined;

  // 4) Two host starts must produce distinct instance ids.
  const second = startHost(48200 + Math.floor(Math.random() * 100));
  try {
    const ready2 = await waitFor(() => second.frames.find((m) => m.type === "event" && m.name === "ready")?.args);
    assert.notEqual(ready2.instanceId, ready.instanceId);
    console.log("PASS host: restarted host instance id differs (" + ready.instanceId + " -> " + ready2.instanceId + ")");
  } finally {
    second.child.kill();
  }

  // 5) Official client: graceful EOF and hard reset are explicit, prompt errors.
  const graceful = await exerciseClientDisconnect("eof");
  const reset = await exerciseClientDisconnect("reset");
  console.log("PASS client: disconnect errors are explicit and prompt " + JSON.stringify({ graceful, reset }));
} catch (error) {
  console.error("FAIL host: " + (error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
} finally {
  if (a) a.destroy();
  if (b) b.destroy();
  if (host.child.exitCode === null) host.child.kill();
}
