// 官方单命令客户端：自动扫描 host、读取 build capability token，不需要手写 socket 脚本。
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const name = process.argv[2] || "ping";
let args = {};
try { args = process.argv[3] ? JSON.parse(process.argv[3]) : {}; }
catch { console.error("args 必须是合法 JSON"); process.exit(2); }

const authPath = path.join(import.meta.dirname, "auth.json");
const authToken = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")).authToken : undefined;

function attempt(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buf = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(700, () => finish(undefined));
    socket.on("connect", () => socket.write(JSON.stringify({ type: "command", name, args, requestId: "cli-1", ...(authToken ? { authToken } : {}) }) + "\n"));
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try { finish(JSON.parse(buf.slice(0, nl))); } catch { finish(undefined); }
    });
    socket.on("error", () => finish(undefined));
  });
}

let result;
for (let port = 47001; port <= 47060; port++) {
  const candidate = await attempt(port);
  if (candidate && candidate.error !== "authentication_required") {
    result = { port, ...candidate };
    break;
  }
}
if (!result) {
  console.error("未找到可认证的 BrowserPilot host；请先运行 npm run build:host 并确认扩展已启动。");
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok === false ? 1 : 0);
