// Browser CLI Import (source browser side).
//
// Runs in Chrome/Edge. Reads cookies only through the official chrome.cookies
// API, only after the user explicitly acknowledges what cookies are and clicks
// Send for explicitly selected domains. The only destination is a literal
// 127.0.0.1 endpoint (Browser CLI native target or the local test target).
//
// Hard rules:
// - no upload to any remote host, no telemetry;
// - cookie values stay in this service worker's memory and are sent once;
// - chrome.storage.session (memory-only) holds the endpoint, pairing code and
//   last job id; no cookie values, names or domains of unselected cookies are
//   ever persisted;
// - no console logging of cookie data (this file has no console calls);
// - the target can report "cookie imported", never "login verified".
import * as contract from "./lib/contract.mjs";
import {
  detectBrowserId,
  groupCookies,
  selectCookies,
  selectionTotals,
  sanitizeJobView,
} from "./lib/selection.mjs";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const SESSION_KEYS = ["bp_endpoint", "bp_pair", "bp_last_job", "bp_selected_domains"];

let scanCache = null; // {storeId, scannedAt, domains:Set<string>} — metadata only
let sendInFlight = false;

async function defaultStoreId() {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const normal = stores.find((store) => store.incognito === false);
    return normal ? normal.id : "0";
  } catch {
    return "0";
  }
}

async function scan({ acknowledged }) {
  if (acknowledged !== true) return { ok: false, error: "consent-required" };
  const storeId = await defaultStoreId();
  // Values are returned by the API but immediately reduced to metadata; the
  // cache keeps only domains so a later Send re-reads only selected domains.
  const cookies = await chrome.cookies.getAll({ storeId });
  const groups = groupCookies(cookies);
  scanCache = {
    storeId,
    scannedAt: new Date().toISOString(),
    domains: new Set(groups.map((group) => group.domain)),
  };
  return {
    ok: true,
    groups,
    totals: selectionTotals(groups),
    scannedAt: scanCache.scannedAt,
    storeId,
    note: "Only cookie metadata is kept after scanning. Values for selected domains are read again on Send.",
  };
}

async function send({ endpoint, pair, domains, consent, profileLabel }) {
  if (consent !== true) return { ok: false, error: "consent-required" };
  if (!scanCache) return { ok: false, error: "scan-required" };
  const endpointCheck = contract.validateLoopbackEndpoint(endpoint);
  if (!endpointCheck.ok) return { ok: false, error: endpointCheck.error };
  if (!contract.validatePairCode(pair)) return { ok: false, error: "pair-code-invalid" };
  const selectedDomains = [...new Set((domains || []).map(contract.normalizeDomain).filter(Boolean))];
  if (selectedDomains.length === 0) return { ok: false, error: "no-domains-selected" };
  if (!selectedDomains.every((domain) => scanCache.domains.has(domain))) {
    return { ok: false, error: "domain-not-scanned" };
  }

  // Read only the selected domains (chrome.cookies includes subdomains) and
  // deduplicate cookies that match more than one selected parent domain.
  const raw = [];
  for (const domain of selectedDomains) {
    const list = await chrome.cookies.getAll({ storeId: scanCache.storeId, domain });
    raw.push(...list);
  }
  const seen = new Set();
  const unique = [];
  for (const item of raw) {
    const key = `${item.domain}\t${item.path || "/"}\t${item.name}\t${item.partitionKey?.topLevelSite || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  const selected = selectCookies(unique, selectedDomains);
  if (selected.cookies.length === 0) return { ok: false, error: "no-cookies-selected" };

  const request = {
    contract: contract.CONTRACT_ID,
    requestId: crypto.randomUUID(),
    source: {
      browser: detectBrowserId(navigator.userAgent),
      profileLabel: profileLabel ? String(profileLabel).slice(0, 200) : undefined,
      extensionVersion: EXTENSION_VERSION,
    },
    consent: {
      kind: "explicit-user-action",
      at: new Date().toISOString(),
      extensionVersion: EXTENSION_VERSION,
    },
    domains: selectedDomains,
    cookies: selected.cookies,
  };

  let response;
  try {
    response = await fetch(`${endpointCheck.base}/v1/import/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bp-pair": String(pair) },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, error: "network-error", skipped: selected.skipped };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = body && typeof body.error === "string" && contract.FAILURE_CODES.has(body.error)
      ? body.error
      : /^[a-z0-9-]{1,64}$/.test(body?.error || "")
        ? body.error
        : `http-${response.status}`;
    return { ok: false, error: code, skipped: selected.skipped };
  }
  if (!body || body.contract !== contract.CONTRACT_ID || typeof body.jobId !== "string") {
    return { ok: false, error: "target-response-invalid", skipped: selected.skipped };
  }

  // Values have been handed to the local target; drop the scan cache so a
  // suspended worker does not keep them longer than needed.
  scanCache = null;

  const lastJob = {
    jobId: body.jobId,
    endpoint: endpointCheck.base,
    pair: String(pair),
    totals: {
      cookies: Number(body.totals?.cookies) || 0,
      domains: Number(body.totals?.domains) || 0,
    },
    sentAt: new Date().toISOString(),
  };
  await chrome.storage.session.set({
    bp_last_job: lastJob,
    bp_endpoint: endpointCheck.base,
    bp_pair: String(pair),
    bp_selected_domains: selectedDomains,
  });
  return { ok: true, jobId: body.jobId, totals: lastJob.totals, skipped: selected.skipped };
}

async function status({ jobId, endpoint, pair } = {}) {
  const job = jobId
    ? { jobId, endpoint, pair }
    : (await chrome.storage.session.get("bp_last_job")).bp_last_job;
  if (!job || !job.jobId) return { ok: false, error: "no-job" };
  const endpointCheck = contract.validateLoopbackEndpoint(job.endpoint);
  if (!endpointCheck.ok) return { ok: false, error: endpointCheck.error };
  if (!contract.validatePairCode(job.pair)) return { ok: false, error: "pair-code-invalid" };

  let response;
  try {
    response = await fetch(`${endpointCheck.base}/v1/import/jobs/${encodeURIComponent(job.jobId)}`, {
      headers: { "x-bp-pair": String(job.pair) },
    });
  } catch {
    return { ok: false, error: "network-error" };
  }
  if (response.status === 404) return { ok: false, error: "job-not-found" };
  if (!response.ok) return { ok: false, error: `http-${response.status}` };
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const sanitized = sanitizeJobView(body, contract);
  if (!sanitized.ok) return sanitized;
  return { ok: true, view: sanitized.view };
}

async function cancel({ jobId, endpoint, pair } = {}) {
  const job = jobId
    ? { jobId, endpoint, pair }
    : (await chrome.storage.session.get("bp_last_job")).bp_last_job;
  if (!job || !job.jobId) return { ok: false, error: "no-job" };
  const endpointCheck = contract.validateLoopbackEndpoint(job.endpoint);
  if (!endpointCheck.ok) return { ok: false, error: endpointCheck.error };
  if (!contract.validatePairCode(job.pair)) return { ok: false, error: "pair-code-invalid" };
  let response;
  try {
    response = await fetch(`${endpointCheck.base}/v1/import/jobs/${encodeURIComponent(job.jobId)}/cancel`, {
      method: "POST",
      headers: { "x-bp-pair": String(job.pair) },
    });
  } catch {
    return { ok: false, error: "network-error" };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) return { ok: false, error: `http-${response.status}` };
  return {
    ok: true,
    state: body && body.state ? String(body.state) : "cancelled",
    note: "Already-written cookies are not rolled back. Sign out in the target browser if needed.",
  };
}

async function settings() {
  const stored = await chrome.storage.session.get(SESSION_KEYS);
  return {
    ok: true,
    endpoint: stored.bp_endpoint || "",
    pair: stored.bp_pair || "",
    lastJob: stored.bp_last_job || null,
    selectedDomains: stored.bp_selected_domains || [],
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "untrusted-sender" });
    return false;
  }
  const type = message && message.type;
  if (!["scan", "send", "status", "cancel", "settings"].includes(type)) {
    sendResponse({ ok: false, error: "unknown-message" });
    return false;
  }
  if (type === "send" && sendInFlight) {
    sendResponse({ ok: false, error: "busy" });
    return false;
  }
  if (type === "send") sendInFlight = true;
  (async () => {
    try {
      if (type === "scan") return await scan(message.payload || {});
      if (type === "send") return await send(message.payload || {});
      if (type === "status") return await status(message.payload || {});
      if (type === "cancel") return await cancel(message.payload || {});
      return await settings();
    } catch (err) {
      // Never echo cookie data or the raw exception text.
      return { ok: false, error: "internal-error" };
    } finally {
      if (type === "send") sendInFlight = false;
    }
  })().then(
    (result) => sendResponse(result),
    () => sendResponse({ ok: false, error: "internal-error" }),
  );
  return true;
});
