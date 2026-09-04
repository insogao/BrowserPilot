// Native host integration test: dynamic port, auth, request routing and no cross-client result leak.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

const child = spawn(process.execPath, ["native-host/host.js"], {
  cwd: process.cwd(),
  env: { ...process.env, BROWSERPILOT_HOST_BASE_PORT: "48001" },
});
let nativeBuf = Buffer.alloc(0);
let ready;
const forwarded = [];

function sendNative(obj) {
  const json = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  child.stdin.write(Buffer.concat([len, json]));
}

child.stdout.on("data", (chunk) => {
  nativeBuf = Buffer.concat([nativeBuf, chunk]);
  while (nativeBuf.length >= 4) {
    const len = nativeBuf.readUInt32LE(0);
    if (nativeBuf.length < 4 + len) break;
    const msg = JSON.parse(nativeBuf.subarray(4, 4 + len).toString("utf8"));
    nativeBuf = nativeBuf.subarray(4 + len);
    if (msg.type === "event" && msg.name === "ready") ready = msg.args;
    if (msg.type === "command") forwarded.push(msg);
  }
});

const waitFor = async (fn, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
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

try {
  await waitFor(() => ready);
  const a = await connect(ready.port);
  const b = await connect(ready.port);
  const am = messages(a);
  const bm = messages(b);

  b.write(JSON.stringify({ type: "command", name: "version", requestId: "denied" }) + "\n");
  await waitFor(() => bm[0]);
  assert.equal(bm[0].error, "authentication_required");

  a.write(JSON.stringify({ type: "command", name: "version", requestId: "client-a", authToken: ready.authToken }) + "\n");
  const command = await waitFor(() => forwarded[0]);
  assert.notEqual(command.requestId, "client-a");
  assert.equal(command.authToken, undefined);
  sendNative({ type: "result", requestId: command.requestId, ok: true, data: { version: "test" } });
  await waitFor(() => am[0]);
  assert.equal(am[0].requestId, "client-a");
  assert.deepEqual(am[0].data, { version: "test" });
  assert.equal(bm.length, 1, "result leaked to another client");

  a.end();
  b.end();
  console.log("PASS host: auth + dynamic port + per-client response routing");
} finally {
  child.kill();
}
