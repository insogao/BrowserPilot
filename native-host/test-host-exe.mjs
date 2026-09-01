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
const port = 47099;

const child = spawn(exe, { cwd: path.dirname(here) });

let frames = [];
child.stdout.on("data", (chunk) => {
  let buf = Buffer.from(chunk);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const json = buf.slice(4, 4 + len).toString("utf8");
    buf = buf.slice(4 + len);
    frames.push(json);
    console.log("[EXE->frame]", json);
  }
});
child.stderr.on("data", (d) => process.stderr.write("[exe stderr] " + d));

setTimeout(() => {
  // 端口从 ready 帧解析
  const readyIdx = frames.findIndex((f) => f.includes('"ready"'));
  let target = port;
  if (readyIdx >= 0) {
    try {
      target = JSON.parse(frames[readyIdx]).args.port;
    } catch {}
  }
  const sock = net.createConnection({ host: "127.0.0.1", port: target }, () => {
    console.log("\n[TCP] connected to", target);
    sock.write(JSON.stringify({ type: "command", name: "ping", requestId: "r1" }) + "\n");
  });
  sock.on("data", (d) => console.log("[TCP<-]", d.toString().trim()));
  sock.on("error", (e) => console.error("[TCP error]", e.message));
  setTimeout(() => {
    sock.end();
    const ready = frames.some((f) => f.includes('"ready"'));
    console.log("\nready frame received:", ready);
    child.kill();
    process.exit(ready ? 0 : 1);
  }, 2500);
}, 1200);
