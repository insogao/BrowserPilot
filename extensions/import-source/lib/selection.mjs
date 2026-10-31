// Extension-side selection helpers. Pure functions only: the service worker
// passes chrome.cookies.Cookie objects in, and only metadata (domain/counts) or
// contract records leave. No cookie value is ever logged.
import {
  normalizeDomain,
  domainMatchesSelection,
  cookieRecordFromChromeCookie,
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
export function selectCookies(cookies, selectedDomains) {
  const selected = [];
  const skipped = {};
  for (const cookie of cookies || []) {
    if (!cookie || !cookie.domain) continue;
    if (!domainMatchesSelection(cookie.domain, selectedDomains)) continue;
    const mapped = cookieRecordFromChromeCookie(cookie);
    if (!mapped.ok) {
      skipped[mapped.reason] = (skipped[mapped.reason] || 0) + 1;
      continue;
    }
    selected.push(mapped.cookie);
  }
  return { cookies: selected, skipped };
}

// Only a fixed, count-only subset of a target response may reach the popup.
export function sanitizeJobView(view, contract) {
  const states = ["pending", "applying", "done", "failed", "cancelled"];
  if (!view || typeof view !== "object") return { ok: false, error: "target-response-invalid" };
  if (view.contract !== contract.CONTRACT_ID) return { ok: false, error: "target-contract-mismatch" };
  const state = states.includes(view.state) ? view.state : null;
  if (!state) return { ok: false, error: "target-response-invalid" };
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
      if (contract.FAILURE_CODES.has(code) && Number.isInteger(count) && count >= 0) failures[code] = count;
    }
  }
  return {
    ok: true,
    view: {
      contract: contract.CONTRACT_ID,
      jobId: String(view.jobId || ""),
      state,
      totals: {
        cookies: total,
        domains: Number.isInteger(view.totals?.domains) ? view.totals.domains : 0,
        selectedDomains: Number.isInteger(view.totals?.selectedDomains) ? view.totals.selectedDomains : 0,
      },
      progress: { applied, failed, remaining: Math.max(0, total - applied - failed) },
      cookieImported: {
        // Recompute from counts/state instead of trusting the target's label.
        status: contract.computeCookieImported({ state, applied, failed }),
        applied,
        failed,
        failures,
      },
      // A target can never claim a verified login; this field is forced.
      loginVerified: { status: "not_verified" },
      ...(view.error && contract.FAILURE_CODES.has(view.error.code)
        ? { error: { code: view.error.code, message: contract.failureText(view.error.code) } }
        : {}),
    },
  };
}
