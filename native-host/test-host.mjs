// 独立自测 host.js：验证 native 分帧 + TCP 命令转发 + ready 上报。
// 运行：node native-host/test-host.mjs  [hostPort]
import { spawn } from "node:child_process";
import net from "node:net";

const port = Number(process.argv[2] || 47001);
const child = spawn(process.execPath, ["native-host/host.js"], { cwd: process.cwd() });

let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});
child.stdout.on("data", (chunk) => {
  // 解码 native messaging 帧
  let buf = Buffer.from(chunk);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const json = buf.slice(4, 4 + len).toString("utf8");
    buf = buf.slice(4 + len);
    console.log("[HOST->EXT frame]", json);
  }
});

// 等 host 监听后连 TCP
setTimeout(() => {
  const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
    console.log("\n[TCP] connected to", port);
    sock.write(JSON.stringify({ type: "command", name: "ping", requestId: "req1" }) + "\n");
    console.log("[TCP] sent {command:ping}");
  });
  sock.on("data", (d) => console.log("[TCP<-STDOUT]", d.toString().trim()));
  sock.on("error", (e) => console.error("[TCP error]", e.message));

  // 3 秒后结束
  setTimeout(() => {
    sock.end();
    console.log("\n[host stderr]\n" + stderrBuf.trim());
    child.kill();
    process.exit(0);
  }, 3000);
}, 1500);
