// Extension-side selection helpers. Pure functions only: the service worker
// passes chrome.cookies.Cookie objects in, and only metadata (domain/counts) or
// contract records leave. No cookie value is ever logged.
import {
  normalizeDomain,
  domainMatchesSelection,
  cookieRecordFromChromeCookie,
  computeCookieImported,
  FAILURE_CODES,
  failureText,
  JOB_STATES,
  TERMINAL_JOB_STATES,
} from "./contract.mjs";

export function detectBrowserId(userAgent) {
  const ua = String(userAgent || "");
  if (/\bEdg\//.test(ua)) return "edge";
  if (/\bBrave\//.test(ua) || /\bBrave\b/.test(ua)) return "brave";
  if (/\bChromium\//.test(ua)) return "chromium";
  return "chrome";
}

// Group cookie metadata by registrable domain string as returned by Chrome.
// Values and names are deliberately not copied into the group.
export function groupCookies(cookies) {
  const groups = new Map();
  for (const cookie of cookies || []) {
    if (!cookie || !cookie.domain) continue;
    const domain = normalizeDomain(cookie.domain);
    if (!domain) continue;
    // Extension cookies use a 32-char id as their host; they are never a
    // meaningful import target.
    if (/^[a-p]{32}$/.test(domain)) continue;
    let group = groups.get(domain);
    if (!group) {
      group = { domain, count: 0, httpOnly: 0, secure: 0, session: 0, partitioned: 0 };
      groups.set(domain, group);
    }
    group.count += 1;
    if (cookie.httpOnly) group.httpOnly += 1;
    if (cookie.secure) group.secure += 1;
    if (cookie.session) group.session += 1;
    if (cookie.partitionKey) group.partitioned += 1;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

export function selectionTotals(groups) {
  const totals = { cookies: 0, domains: 0, httpOnly: 0, secure: 0, session: 0, partitioned: 0 };
  for (const group of groups || []) {
    totals.cookies += group.count;
    totals.domains += 1;
    totals.httpOnly += group.httpOnly;
    totals.secure += group.secure;
    totals.session += group.session;
    totals.partitioned += group.partitioned;
  }
  return totals;
}

// Filter to user-selected domains and map to contract records. Invalid records
// are counted by reason and never echoed.
export function selectCookies(cookies, selectedDomains, { now = Date.now() } = {}) {
  const selected = [];
  const skipped = {};
  for (const cookie of cookies || []) {
    if (!cookie || !cookie.domain) continue;
    if (!domainMatchesSelection(cookie.domain, selectedDomains)) continue;
    const mapped = cookieRecordFromChromeCookie(cookie, { now });
    if (!mapped.ok) {
      skipped[mapped.reason] = (skipped[mapped.reason] || 0) + 1;
      continue;
    }
    selected.push(mapped.cookie);
  }
  return { cookies: selected, skipped };
}

function safeAuthorization(value) {
  if (!value || typeof value !== "object") {
    return { targetUserConfirmed: false, simulated: false, source: "unknown" };
  }
  const source = typeof value.source === "string" && /^[a-z0-9-]{1,64}$/.test(value.source)
    ? value.source
    : "unknown";
  const confirmedAt = typeof value.confirmedAt === "string" && !Number.isNaN(Date.parse(value.confirmedAt))
    ? value.confirmedAt
    : undefined;
  const scopeDigest = typeof value.scopeDigest === "string" && /^[a-f0-9]{64}$/.test(value.scopeDigest)
    ? value.scopeDigest
    : undefined;
  return {
    targetUserConfirmed: value.targetUserConfirmed === true,
    simulated: value.simulated === true,
    source,
    ...(scopeDigest ? { scopeDigest } : {}),
    ...(confirmedAt ? { confirmedAt } : {}),
  };
}

// Only a fixed, count-only subset of a target response may reach the popup.
export function sanitizeJobView(view, contract) {
  if (!view || typeof view !== "object") return { ok: false, error: "target-response-invalid" };
  if (view.contract !== contract.CONTRACT_ID) return { ok: false, error: "target-contract-mismatch" };
  const state = JOB_STATES.has(view.state) ? view.state : null;
  if (!state) return { ok: false, error: "target-response-invalid" };
  const jobId = typeof view.jobId === "string" && /^[a-f0-9]{24}$/.test(view.jobId) ? view.jobId : null;
  if (!jobId) return { ok: false, error: "target-response-invalid" };
  const progress = view.progress || {};
  const total = Number(view.totals?.cookies);
  const applied = Number(progress.applied);
  const failed = Number(progress.failed);
  if (![total, applied, failed].every((n) => Number.isInteger(n) && n >= 0)) {
    return { ok: false, error: "target-response-invalid" };
  }
  const failures = {};
  if (view.cookieImported?.failures && typeof view.cookieImported.failures === "object") {
    for (const [code, count] of Object.entries(view.cookieImported.failures)) {
      if (FAILURE_CODES.has(code) && Number.isInteger(count) && count >= 0) failures[code] = count;
    }
  }
  const sessionCount = Number.isInteger(view.totals?.sessionCookies) && view.totals.sessionCookies >= 0
    ? view.totals.sessionCookies
    : Number.isInteger(view.sessionCookies?.count) && view.sessionCookies.count >= 0
      ? view.sessionCookies.count
      : 0;
  return {
    ok: true,
    view: {
      contract: contract.CONTRACT_ID,
      protocolVersion: contract.PROTOCOL_VERSION,
      jobId,
      state,
      transport: typeof view.transport === "string" && /^[a-z0-9-]{1,32}$/.test(view.transport)
        ? view.transport
        : "unknown",
      native: view.native === true,
      totals: {
        cookies: total,
        domains: Number.isInteger(view.totals?.domains) ? view.totals.domains : 0,
        selectedDomains: Number.isInteger(view.totals?.selectedDomains) ? view.totals.selectedDomains : 0,
        sessionCookies: sessionCount,
        partitionedCookies: Number.isInteger(view.totals?.partitionedCookies)
          ? view.totals.partitionedCookies
          : 0,
      },
      progress: { applied, failed, remaining: Math.max(0, total - applied - failed) },
      authorization: safeAuthorization(view.authorization),
      cookieImported: {
        // Recompute from counts/state instead of trusting the target's label.
        status: computeCookieImported({ state, applied, failed }),
        applied,
        failed,
        failures,
      },
      sessionCookies: {
        count: sessionCount,
        mayNotSurviveRestart: true,
      },
      // A target can never claim a verified login; this field is forced.
      loginVerified: { status: "not_verified" },
      ...(view.error && (FAILURE_CODES.has(view.error.code) || contract.SESSION_ERROR_CODES.has(view.error.code))
        ? { error: { code: view.error.code, message: failureText(view.error.code) } }
        : {}),
    },
  };
}
