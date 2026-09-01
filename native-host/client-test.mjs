// 外部 AI 客户端：连 host 的 TCP 端口（换行 JSON），依次发命令并打印结果。
// 用法：node native-host/client-test.mjs [port]
import net from "node:net";

const port = Number(process.argv[2] || 47002);
const commands = [
  { type: "command", name: "ping", args: {}, requestId: "1" },
  { type: "command", name: "version", args: {}, requestId: "2" },
  { type: "command", name: "get_profile", args: {}, requestId: "3" },
  { type: "command", name: "export_guide", args: {}, requestId: "4" },
  { type: "command", name: "snapshot", args: { level: "L0" }, requestId: "5" },
];

const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
  console.log("[client] connected to", port, "\n");
  for (const c of commands) sock.write(JSON.stringify(c) + "\n");
});

let buf = "";
sock.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch (e) { console.log("[raw]", line); continue; }
    if (m.type === "result") {
      console.log(`\n[result ${m.requestId} ok=${m.ok}]`, m.ok ? JSON.stringify(m.data) : m.error);
    } else {
      console.log("[event]", JSON.stringify(m));
    }
  }
});
sock.on("error", (e) => { console.error("[client] error:", e.message); process.exit(1); });

setTimeout(() => {
  sock.end();
  console.log("\n[client] done");
  process.exit(0);
}, 4000);
