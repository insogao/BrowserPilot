// Test-only CDP backend for the local contract target.
//
// It writes cookies into an already-running, isolated local Chromium through
// the DevTools protocol (Storage.setCookies). It never launches a browser,
// never uses --no-sandbox, never touches a real user profile by itself, and is
// not the product target: the product target is the Browser CLI native
// CookieStore interface described in
// docs/browser-cli-native-cookie-import-interface.md.
//
// Cookie values are held only in memory and in the browser's own CookieStore;
// this file has no logging calls.
import * as contract from "../contract.mjs";

const CONNECT_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 15_000;

export function createCdpBackend({ port, host = "127.0.0.1", verifyWrites = true } = {}) {
  if (host !== "127.0.0.1") throw new Error("cdp-host-must-be-loopback");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("cdp-port-invalid");

  let socket = null;
  let connecting = null;
  let rpcId = 0;
  const pending = new Map();

  async function versionInfo() {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, CONNECT_TIMEOUT_MS);
    if (!res.ok) throw new Error("cdp-version-failed");
    const body = await res.json();
    if (!body || typeof body.webSocketDebuggerUrl !== "string") throw new Error("cdp-version-invalid");
    const wsUrl = new URL(body.webSocketDebuggerUrl);
    if (wsUrl.hostname !== "127.0.0.1") throw new Error("cdp-websocket-must-be-loopback");
    return body;
  }

  async function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return socket;
    if (connecting) return connecting;
    connecting = (async () => {
      const info = await versionInfo();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("cdp-connect-timeout")), CONNECT_TIMEOUT_MS);
        ws.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        ws.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("cdp-connect-failed"));
          },
          { once: true },
        );
      });
      ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!msg || typeof msg.id !== "number") return;
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message || "cdp-error"));
        else entry.resolve(msg.result);
      });
      ws.addEventListener("close", () => {
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("cdp-closed"));
        }
        pending.clear();
        socket = null;
      });
      socket = ws;
      return ws;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  function rpc(method, params) {
    return new Promise(async (resolve, reject) => {
      let ws;
      try {
        ws = await connect();
      } catch (err) {
        reject(err);
        return;
      }
      const id = ++rpcId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("cdp-rpc-timeout"));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  return {
    kind: "cdp",
    mode: "test-cdp",
    product: "Chromium via local CDP (test only)",
    native: false,
    cookieStoreWrite: true,
    persistAcrossRestart: true,
    async applyCookie(cookie) {
      const cdpCookie = toCdpCookie(cookie);
      try {
        await rpc("Storage.setCookies", { cookies: [cdpCookie] });
      } catch (err) {
        throw normalizeCdpError(err);
      }
      if (!verifyWrites) return;
      let all;
      try {
        all = await rpc("Storage.getCookies", {});
      } catch (err) {
        throw normalizeCdpError(err);
      }
      const expected = cookieKey(cookie);
      const found = (all.cookies || []).some((c) => cookieKey(c) === expected);
      if (!found) {
        const err = new Error("cdp-write-not-visible");
        err.code = "internal";
        throw err;
      }
    },
    async close() {
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
      socket = null;
    },
  };
}

export function toCdpCookie(cookie) {
  const sameSite = {
    no_restriction: "None",
    lax: "Lax",
    strict: "Strict",
    unspecified: undefined,
  }[cookie.sameSite];
  const host = String(cookie.domain || "").replace(/^\./, "");
  const path = cookie.path || "/";
  const url = `${cookie.secure ? "https" : "http"}://${host}${path}`;
  return {
    name: cookie.name,
    value: cookie.value,
    path,
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    // `url` without `domain` creates a host-only cookie; a domain cookie keeps
    // the leading dot exactly as the source reported it.
    ...(cookie.hostOnly ? { url } : { domain: cookie.domain }),
    ...(sameSite ? { sameSite } : {}),
    ...(cookie.session ? {} : { expires: cookie.expirationDate }),
    ...(cookie.partitionKey
      ? {
          partitionKey: {
            topLevelSite: cookie.partitionKey.topLevelSite,
            hasCrossSiteAncestor: !!cookie.partitionKey.hasCrossSiteAncestor,
          },
        }
      : {}),
  };
}

function cookieKey(cookie) {
  return `${cookie.domain}\t${cookie.path || "/"}\t${cookie.name}`;
}

function normalizeCdpError(err) {
  const code = contract.classifySetFailure(err);
  const out = new Error(code);
  out.code = code;
  return out;
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
