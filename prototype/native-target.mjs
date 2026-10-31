import http from "node:http";
import { randomBytes } from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}
const port = Number(args.get("port") || 18082);
const cdpBase = String(args.get("cdp") || "http://127.0.0.1:9232");
const token = String(args.get("token") || randomBytes(6).toString("hex"));

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function cdpTarget() {
  const list = await (await fetch(`${cdpBase}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no target page");
  return page.webSocketDebuggerUrl;
}

function cdpCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error("cdp timeout")); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === 1) { clearTimeout(timer); ws.close(); resolve(msg); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("cdp error")); };
  });
}

const server = http.createServer(async (req, res) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-bp-token",
    "access-control-allow-methods": "POST,OPTIONS",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (req.method !== "POST" || req.url !== "/import") {
    res.writeHead(404, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (String(req.headers["x-bp-token"] || "") !== token) {
    res.writeHead(403, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad pairing code" }));
    return;
  }
  try {
    const payload = JSON.parse((await readBody(req)).toString("utf8"));
    if (!Array.isArray(payload.cookies) || payload.cookies.length === 0) throw new Error("no cookies");
    const cookies = payload.cookies.slice(0, 2000).map((c) => {
      if (typeof c.name !== "string" || typeof c.value !== "string") throw new Error("bad cookie");
      const out = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        sameSite: ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : "Lax",
      };
      if (!c.session && Number.isFinite(c.expirationDate)) out.expires = c.expirationDate;
      if (c.partitionKey?.topLevelSite) {
        out.partitionKey = {
          topLevelSite: c.partitionKey.topLevelSite,
          hasCrossSiteAncestor: Boolean(c.partitionKey.hasCrossSiteAncestor),
        };
      }
      return out;
    });
    const wsUrl = await cdpTarget();
    const result = await cdpCall(wsUrl, "Storage.setCookies", { cookies });
    if (result.error) throw new Error(result.error.message || "setCookies failed");
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ applied: cookies.length, failed: 0 }));
    console.log(`applied=${cookies.length}`);
  } catch (error) {
    res.writeHead(400, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error.message || error).slice(0, 300) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`native target listening on http://127.0.0.1:${port}`);
  console.log(`pairing code: ${token}`);
});
