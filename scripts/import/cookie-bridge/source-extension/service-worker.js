// Source-side cookie bridge (runs in the browser the user wants to migrate
// from). Reads cookies with the official chrome.cookies API and sends them
// only to a user-supplied localhost broker, after an explicit click.
//
// Hard rules:
// - Never log or persist cookie values.
// - Never send anything automatically; only on a popup message caused by a
//   user click.
// - Keep values in service-worker memory only.
const PROTOCOL_VERSION_MAX = 1;

let scanCache = null;

const DEFAULT_STORE = "0";

function normalizeDomain(domain) {
  return String(domain || "").replace(/^\./, "").toLowerCase();
}

async function defaultStoreId() {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const normal = stores.find((s) => s.incognito === false);
    return normal ? normal.id : DEFAULT_STORE;
  } catch {
    return DEFAULT_STORE;
  }
}

async function scan() {
  const storeId = await defaultStoreId();
  const cookies = await chrome.cookies.getAll({ storeId });
  const groups = new Map();
  for (const c of cookies) {
    if (!c || !c.name || !c.domain) continue;
    const key = normalizeDomain(c.domain);
    let g = groups.get(key);
    if (!g) {
      g = { domain: key, count: 0, httpOnly: 0, secure: 0, session: 0, partitioned: 0 };
      groups.set(key, g);
    }
    g.count += 1;
    if (c.httpOnly) g.httpOnly += 1;
    if (c.secure) g.secure += 1;
    if (c.session) g.session += 1;
    if (c.partitionKey) g.partitioned += 1;
  }
  scanCache = { cookies, storeId, scannedAt: new Date().toISOString() };
  const list = [...groups.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  return {
    ok: true,
    totals: {
      cookies: cookies.length,
      domains: list.length,
      httpOnly: list.reduce((n, g) => n + g.httpOnly, 0),
      session: list.reduce((n, g) => n + g.session, 0),
      partitioned: list.reduce((n, g) => n + g.partitioned, 0),
    },
    groups: list,
    scannedAt: scanCache.scannedAt,
    limits: {
      protocol: PROTOCOL_VERSION_MAX,
      note: "chrome.cookies can read HttpOnly cookies with the cookies permission. Partitioned cookies carry partitionKey. Session cookies are included.",
    },
  };
}

function toBridgeCookie(c) {
  return {
    domain: c.domain,
    hostOnly: !!c.hostOnly,
    path: c.path || "/",
    name: c.name,
    value: c.value,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || "unspecified",
    session: !!c.session,
    ...(c.session ? {} : { expirationDate: Math.floor(c.expirationDate) }),
    ...(c.partitionKey
      ? {
          partitionKey: {
            topLevelSite: c.partitionKey.topLevelSite,
            hasCrossSiteAncestor: !!c.partitionKey.hasCrossSiteAncestor,
          },
        }
      : {}),
  };
}

async function send({ brokerUrl, pair, domains, profileLabel }) {
  if (!scanCache) return { ok: false, error: "scan-required" };
  const wanted = new Set((domains || []).map(normalizeDomain));
  if (wanted.size === 0) return { ok: false, error: "no-domains-selected" };
  const selected = scanCache.cookies.filter((c) => wanted.has(normalizeDomain(c.domain)));
  if (selected.length === 0) return { ok: false, error: "no-cookies-selected" };
  const payload = {
    version: PROTOCOL_VERSION_MAX,
    source: {
      browser: navigator.userAgentData?.brands?.map((b) => b.brand).join("/") || "source-browser",
      profileLabel: profileLabel || "default",
    },
    selection: { domains: [...wanted] },
    cookies: selected.map(toBridgeCookie),
  };
  const res = await fetch(`${trimSlash(brokerUrl)}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bp-pair": pair },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return {
    ok: res.ok,
    status: res.status,
    jobId: body && body.jobId,
    totals: body && body.totals,
    error: res.ok ? null : (body && body.error) || `http-${res.status}`,
  };
}

async function status({ brokerUrl, pair, jobId }) {
  const res = await fetch(`${trimSlash(brokerUrl)}/v1/jobs/${encodeURIComponent(jobId)}/status`, {
    headers: { "x-bp-pair": pair },
  });
  if (!res.ok) return { ok: false, error: `http-${res.status}` };
  const body = await res.json();
  return { ok: true, ...body };
}

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === "scan") {
        sendResponse(await scan());
        return;
      }
      if (msg && msg.type === "send") {
        sendResponse(await send(msg.payload || {}));
        return;
      }
      if (msg && msg.type === "status") {
        sendResponse(await status(msg.payload || {}));
        return;
      }
      sendResponse({ ok: false, error: "unknown-message" });
    } catch (err) {
      // Never include cookie data in errors.
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;
});
