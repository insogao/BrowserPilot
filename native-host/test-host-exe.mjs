// 验证打包后的 browserpilot-host.exe 能启动、监听、正确分帧。
// 运行：node native-host/test-host-exe.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "host.manifest.json"), "utf8"));
const exe = manifest.path;
const port = 48101;

const child = spawn(exe, {
  cwd: path.dirname(here),
  env: { ...process.env, BROWSERPILOT_HOST_BASE_PORT: String(port) },
});

let frames = [];
function redactFrame(json) {
  try {
    const msg = JSON.parse(json);
    if (msg?.args?.authToken) msg.args.authToken = "<redacted>";
    return JSON.stringify(msg);
  } catch {
    return json.replace(/"authToken":"[^"]+"/g, '"authToken":"<redacted>"');
  }
}

child.stdout.on("data", (chunk) => {
  let buf = Buffer.from(chunk);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const json = buf.slice(4, 4 + len).toString("utf8");
    buf = buf.slice(4 + len);
    frames.push(json);
    console.log("[EXE->frame]", redactFrame(json));
  }
});
child.stderr.on("data", (d) => process.stderr.write("[exe stderr] " + d));

async function waitFor(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for native host test state");
}

try {
  const readyFrame = await waitFor(() => frames.map((f) => { try { return JSON.parse(f); } catch { return undefined; } })
    .find((msg) => msg?.type === "event" && msg?.name === "ready"));
  const target = readyFrame.args.port;
  const sock = await new Promise((resolve, reject) => {
    const candidate = net.createConnection({ host: "127.0.0.1", port: target }, () => resolve(candidate));
    candidate.once("error", reject);
  });
  console.log("\n[TCP] connected to", target);
  sock.write(JSON.stringify({
    type: "command",
    name: "ping",
    requestId: "r1",
    agentId: "exe-test",
    _clientId: "spoofed",
    _foregroundLeaseToken: "spoofed",
  }) + "\n");

  const forwarded = await waitFor(() => frames.map((f) => { try { return JSON.parse(f); } catch { return undefined; } })
    .find((msg) => msg?.type === "command" && msg?.name === "ping"));
  const identitySafe = forwarded._clientId === "agent:exe-test" && forwarded._foregroundLeaseToken === undefined;
  console.log("\nready frame received:", true);
  console.log("trusted client identity injected:", identitySafe);
  sock.end();
  process.exitCode = identitySafe ? 0 : 1;
} catch (error) {
  console.error("[EXE test error]", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  child.kill();
}
