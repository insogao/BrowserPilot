// Browser CLI Import (source browser side).
//
// Runs in Chrome/Edge. Reads cookies only through the official chrome.cookies
// API, only after the user explicitly acknowledges what cookies are and clicks
// Send for explicitly selected domains. The job is sent through the existing
// BrowserPilot native messaging host in import-only relay mode; no HTTP server
// or loopback HTTP endpoint is used by this extension.
//
// Hard rules:
// - no upload to any remote host, no telemetry, no HTTP destination;
// - cookie values stay in this service worker's memory and are sent once;
// - the one-time import ticket is held in memory for the duration of the send
//   and is never written to storage;
// - chrome.storage.session (memory-only) holds only the last job metadata and
//   the selected domains; no cookie values, names or ticket;
// - no console logging of cookie data (this file has no console calls);
// - the target can report "cookie imported" and its own user authorization,
//   never a verified login.
import * as contract from "./lib/contract.mjs";
import {
  detectBrowserId,
  groupCookies,
  selectCookies,
  selectionTotals,
  sanitizeJobView,
} from "./lib/selection.mjs";
import { createNativeTransport } from "./lib/native-transport.mjs";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const SESSION_KEYS = ["bp_last_job", "bp_selected_domains"];

let scanCache = null; // {storeId, scannedAt, domains:Set<string>, } — metadata only
let sendInFlight = false;
let activeTransport = null;
let activeJobNonce = null;
let lastView = null;

async function defaultStoreId() {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const normal = stores.find((store) => store.incognito === false);
    return normal ? normal.id : "0";
  } catch {
    return "0";
  }
}

function randomHex(bytes) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
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

function closeActiveTransport() {
  if (activeTransport) {
    try {
      activeTransport.close();
    } catch {
      // ignored
    }
  }
  activeTransport = null;
  activeJobNonce = null;
}

async function persistLastJob(view) {
  if (!view) return;
  lastView = view;
  const stored = (await chrome.storage.session.get("bp_last_job")).bp_last_job || {};
  await chrome.storage.session.set({
    bp_last_job: {
      ...stored,
      jobId: view.jobId,
      state: view.state,
      totals: view.totals,
      lastView: view,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function send({ ticket, domains, consent, profileLabel }) {
  if (consent !== true) return { ok: false, error: "consent-required" };
  if (!scanCache) return { ok: false, error: "scan-required" };
  if (!contract.isValidTicket(ticket)) return { ok: false, error: "ticket-invalid" };
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
  if (selected.cookies.length > contract.MAX_COOKIES_PER_JOB) {
    return { ok: false, error: "too-many-cookies" };
  }

  const jobNonce = randomHex(16);
  const payload = {
    contract: contract.CONTRACT_ID,
    protocolVersion: contract.PROTOCOL_VERSION,
    jobNonce,
    source: {
      browser: detectBrowserId(navigator.userAgent),
      profileLabel: profileLabel ? String(profileLabel).slice(0, contract.MAX_PROFILE_LABEL_BYTES) : undefined,
      extensionVersion: EXTENSION_VERSION,
    },
    consent: await contract.buildConsent({ extensionVersion: EXTENSION_VERSION, domains: selectedDomains }),
    domains: selectedDomains,
    cookies: selected.cookies,
  };
  const payloadText = JSON.stringify(payload);
  const digest = await contract.jobDigest(payloadText);

  closeActiveTransport();
  const transport = createNativeTransport();
  activeTransport = transport;
  activeJobNonce = jobNonce;
  lastView = null;
  let result;
  try {
    result = await transport.submit({
      ticket,
      payloadText,
      jobNonce,
      digest,
      onStatus: (view) => {
        void persistLastJob(view);
      },
    });
  } catch (err) {
    closeActiveTransport();
    return { ok: false, error: err && err.code ? err.code : "internal-error", skipped: selected.skipped };
  }

  // Values have been handed to the local target; drop the scan cache so a
  // suspended worker does not keep them longer than needed.
  scanCache = null;

  const lastJob = {
    jobId: result.jobId,
    jobNonce,
    transport: "native",
    state: result.state,
    totals: {
      cookies: Number(result.totals?.cookies) || 0,
      domains: Number(result.totals?.domains) || 0,
      sessionCookies: Number(result.totals?.sessionCookies) || 0,
    },
    targetNative: result.targetNative === true,
    sentAt: new Date().toISOString(),
  };
  await chrome.storage.session.set({
    bp_last_job: lastJob,
    bp_selected_domains: selectedDomains,
  });
  return {
    ok: true,
    jobId: result.jobId,
    state: result.state,
    totals: lastJob.totals,
    targetNative: result.targetNative === true,
    targetAuthorization: result.targetAuthorization,
    skipped: selected.skipped,
  };
}

async function status({ jobId } = {}) {
  if (lastView && (!jobId || lastView.jobId === jobId)) return { ok: true, view: lastView };
  const job = (await chrome.storage.session.get("bp_last_job")).bp_last_job;
  if (!job) return { ok: false, error: "no-job" };
  if (jobId && job.jobId !== jobId) return { ok: false, error: "job-not-found" };
  if (job.lastView) {
    const sanitized = sanitizeJobView(job.lastView, contract);
    if (sanitized.ok) return { ok: true, view: sanitized.view };
  }
  return {
    ok: false,
    error: "job-not-observable",
    note: "浏览器的后台页面可能已休眠；请查看 Browser CLI 的导入窗口获取最终结果。",
  };
}

async function cancel({ jobId } = {}) {
  if (!activeTransport || !activeJobNonce) {
    return {
      ok: false,
      error: "job-not-observable",
      note: "无法连接当前导入任务；请在 Browser CLI 导入窗口中取消。",
    };
  }
  const job = (await chrome.storage.session.get("bp_last_job")).bp_last_job;
  if (jobId && job && job.jobId !== jobId) return { ok: false, error: "job-not-found" };
  try {
    await activeTransport.cancel(activeJobNonce);
  } catch (err) {
    return { ok: false, error: err && err.code ? err.code : "internal-error" };
  }
  return {
    ok: true,
    state: "cancelling",
    note: "已请求取消。已写入的 Cookie 不会回滚；可在目标浏览器中退出登录。",
  };
}

async function settings() {
  const stored = await chrome.storage.session.get(SESSION_KEYS);
  return {
    ok: true,
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
