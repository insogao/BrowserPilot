// Import cookies from a source-browser extension export (stdin only).
//
// Security contract:
// - cookie values are read from stdin, never written to disk or stdout;
// - only counts/domains/names are logged;
// - the target is a local Browser CLI CDP endpoint, not a remote service.
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.BP_TARGET_CDP_PORT || 9333);
const raw = fs.readFileSync(0, "utf8");

function parseNetscape(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const [domain, , cookiePath, secure, expiry, name, ...rest] = fields;
    const value = rest.join("\t");
    if (!name) continue;
    const cookie = { name, value, domain, path: cookiePath || "/", secure: secure === "TRUE" };
    const expires = Number(expiry);
    if (Number.isFinite(expires) && expires > 0) cookie.expires = expires;
    out.push(cookie);
  }
  return out;
}

function parseJson(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error("JSON export is not an array");
  return arr
    .filter((c) => c && typeof c.name === "string" && typeof c.value === "string" && typeof c.domain === "string")
    .map((c) => {
      const cookie = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
      };
      if (typeof c.expirationDate === "number" && c.expirationDate > 0) cookie.expires = c.expirationDate;
      if (c.sameSite) {
        const map = { no_restriction: "None", lax: "Lax", strict: "Strict", unspecified: "Lax" };
        if (map[c.sameSite]) cookie.sameSite = map[c.sameSite];
      }
      if (c.partitionKey?.topLevelSite) cookie.partitionKey = { topLevelSite: c.partitionKey.topLevelSite };
      return cookie;
    });
}

let cookies;
try {
  cookies = raw.trimStart().startsWith("[") ? parseJson(raw) : parseNetscape(raw);
} catch (err) {
  console.error("parse-failed:", err.message);
  process.exit(2);
}
if (cookies.length === 0) {
  console.error("no-cookies-parsed");
  process.exit(2);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

try {
  await rpc(ws, 1, "Storage.setCookies", { cookies });
  const after = await rpc(ws, 2, "Storage.getCookies", {});
  const imported = new Set(cookies.map((c) => `${c.domain}\t${c.name}`));
  const present = (after.cookies || []).filter((c) => imported.has(`${c.domain}\t${c.name}`));
  const domains = [...new Set(cookies.map((c) => c.domain))];
  console.log(
    JSON.stringify({
      parsed: cookies.length,
      domains,
      names: cookies.map((c) => c.name),
      verifiedPresent: present.length,
    }),
  );
  process.exitCode = present.length > 0 ? 0 : 3;
} finally {
  try {
    ws.close();
  } catch {}
}
