// Browser CLI cookie-import contract v1.
//
// This module is the single source of truth for the wire format between the
// BrowserPilot source extension (running in Chrome/Edge) and the Browser CLI
// native cookie-import target. It is intentionally dependency-free so the exact
// same file can be copied into the extension package.
//
// Canonical copy: scripts/import/contract.mjs
// Extension copy: extensions/import-source/lib/contract.mjs
// Generate/verify with: node scripts/import/sync-extension-contract.mjs [--check]
//
// Hard rules encoded here:
// - every request carries explicit user consent evidence;
// - the target is loopback-only and paired with a per-session code;
// - a job result can say "cookie imported" but never "login verified";
// - errors and public job views contain counts/codes only, never cookie names,
//   values or domains.

export const CONTRACT_ID = "browser-cli.cookie-import/v1";
export const CONTRACT_VERSION = 1;

export const MAX_COOKIES_PER_JOB = 20000;
export const MAX_SELECTED_DOMAINS = 1000;
export const MAX_VALUE_BYTES = 8192;
export const MAX_NAME_BYTES = 4096;
export const MAX_DOMAIN_BYTES = 255;
export const MAX_PATH_BYTES = 1024;
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_PARTITION_SITE_BYTES = 2048;
export const MAX_PROFILE_LABEL_BYTES = 200;

export const SOURCE_BROWSERS = new Set(["chrome", "edge", "brave", "chromium", "firefox"]);
export const SAME_SITE_VALUES = new Set(["no_restriction", "lax", "strict", "unspecified"]);

export const JOB_STATES = new Set(["pending", "applying", "done", "failed", "cancelled"]);
export const TERMINAL_JOB_STATES = new Set(["done", "failed", "cancelled"]);

// Failure codes are the only failure detail that may cross the loopback API.
export const FAILURE_CODES = new Set([
  "invalid-cookie",
  "invalid-domain",
  "invalid-url",
  "partitioned-cookie-rejected",
  "samesite-rejected",
  "expiry-rejected",
  "permission-or-host",
  "cookie-store-unavailable",
  "target-busy",
  "profile-locked",
  "cancelled",
  "timeout",
  "internal",
]);

export const FAILURE_TEXT = {
  "invalid-cookie": "Cookie 字段不合法，已跳过。",
  "invalid-domain": "Cookie 域名不合法，已跳过。",
  "invalid-url": "Cookie 无法映射为目标浏览器的 URL，已跳过。",
  "partitioned-cookie-rejected": "目标 CookieStore 拒绝了分区 Cookie。",
  "samesite-rejected": "目标 CookieStore 拒绝了 SameSite 属性。",
  "expiry-rejected": "目标 CookieStore 拒绝了该过期时间。",
  "permission-or-host": "目标 CookieStore 拒绝写入该主机。",
  "cookie-store-unavailable": "目标 CookieStore 不可用（Profile 未就绪或已锁定）。",
  "target-busy": "目标正在处理另一个导入任务，请稍后重试。",
  "profile-locked": "目标 Profile 正被占用；请先关闭目标浏览器再重试。",
  cancelled: "导入已取消；已经写入的 Cookie 不会自动回滚。",
  timeout: "等待来源扩展发送超时；请确认扩展中的地址与配对码。",
  internal: "目标内部错误；未写入或仅部分写入，请查看目标日志（只含计数）。",
};

export function failureText(code) {
  return FAILURE_TEXT[code] || "未知失败原因。";
}

export function validatePairCode(raw) {
  return /^\d{6}$/.test(String(raw || ""));
}

// The source extension and the CLI may only talk to a literal loopback address.
// No LAN host, no DNS name, no path/query/credentials smuggling.
export function validateLoopbackEndpoint(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return { ok: false, error: "endpoint-invalid" };
  }
  if (url.protocol !== "http:") return { ok: false, error: "endpoint-must-be-http" };
  if (url.hostname !== "127.0.0.1") return { ok: false, error: "endpoint-must-be-loopback" };
  if (!url.port) return { ok: false, error: "endpoint-needs-port" };
  if (url.username || url.password) return { ok: false, error: "endpoint-has-credentials" };
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false, error: "endpoint-has-path" };
  if (url.search || url.hash) return { ok: false, error: "endpoint-has-query-or-hash" };
  return { ok: true, base: `http://127.0.0.1:${url.port}` };
}

// TextEncoder is available in Node >= 11 and in MV3 extension service workers.
const utf8 = new TextEncoder();
function byteLength(value) {
  return utf8.encode(String(value)).length;
}

export function normalizeDomain(domain) {
  return String(domain || "").replace(/^\./, "").trim().toLowerCase();
}

export function isValidDomain(domain) {
  if (typeof domain !== "string" || domain.length === 0 || domain.length > MAX_DOMAIN_BYTES) return false;
  return /^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain);
}

export function tokenizeDomain(domain) {
  return normalizeDomain(domain).split(".").filter(Boolean);
}

// True when a cookie domain belongs to one of the user-selected domains.
// Selecting example.com also matches cookies for sub.example.com; selecting
// sub.example.com does not match a parent-domain cookie for example.com.
export function domainMatchesSelection(cookieDomain, selectedDomains) {
  const cookie = normalizeDomain(cookieDomain);
  if (!cookie) return false;
  for (const raw of selectedDomains || []) {
    const selected = normalizeDomain(raw);
    if (!selected) continue;
    if (cookie === selected || cookie.endsWith(`.${selected}`)) return true;
  }
  return false;
}

export function validateCookieRecord(cookie) {
  const errors = [];
  if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) return ["not-object"];
  if (!isValidDomain(cookie.domain)) errors.push("domain-invalid");
  if (typeof cookie.name !== "string" || cookie.name.length === 0) errors.push("name-invalid");
  else if (byteLength(cookie.name) > MAX_NAME_BYTES) errors.push("name-too-long");
  else if (/[\0\r\n]/.test(cookie.name)) errors.push("name-control-chars");
  if (typeof cookie.value !== "string") errors.push("value-invalid");
  else if (byteLength(cookie.value) > MAX_VALUE_BYTES) errors.push("value-too-long");
  else if (cookie.value.includes("\0")) errors.push("value-nul");
  if (typeof cookie.path !== "string" || !cookie.path.startsWith("/")) errors.push("path-invalid");
  else if (byteLength(cookie.path) > MAX_PATH_BYTES) errors.push("path-too-long");
  for (const key of ["hostOnly", "secure", "httpOnly", "session"]) {
    if (typeof cookie[key] !== "boolean") errors.push(`${key}-not-boolean`);
  }
  if (!SAME_SITE_VALUES.has(cookie.sameSite)) errors.push("sameSite-invalid");
  if (cookie.session === false) {
    if (typeof cookie.expirationDate !== "number" || !Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= 0) {
      errors.push("expirationDate-invalid");
    }
  }
  if (cookie.partitionKey !== undefined && cookie.partitionKey !== null) {
    const pk = cookie.partitionKey;
    if (typeof pk !== "object" || Array.isArray(pk)) errors.push("partitionKey-not-object");
    else {
      if (
        typeof pk.topLevelSite !== "string" ||
        pk.topLevelSite.length === 0 ||
        byteLength(pk.topLevelSite) > MAX_PARTITION_SITE_BYTES
      ) {
        errors.push("partitionKey.topLevelSite-invalid");
      }
      if (typeof pk.hasCrossSiteAncestor !== "boolean") errors.push("partitionKey.hasCrossSiteAncestor-invalid");
    }
  }
  return errors;
}

export function validateConsent(consent) {
  const errors = [];
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) return ["missing"];
  if (consent.kind !== "explicit-user-action") errors.push("kind-invalid");
  if (typeof consent.at !== "string" || Number.isNaN(Date.parse(consent.at))) errors.push("at-invalid");
  if (typeof consent.extensionVersion !== "string" || consent.extensionVersion.length === 0) {
    errors.push("extensionVersion-invalid");
  } else if (byteLength(consent.extensionVersion) > 64) {
    errors.push("extensionVersion-too-long");
  }
  return errors;
}

export function validateImportRequest(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, errors: ["payload-not-object"] };
  if (payload.contract !== CONTRACT_ID) errors.push("contract-invalid");
  if (typeof payload.requestId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(payload.requestId)) {
    errors.push("requestId-invalid");
  } else if (payload.requestId.length > MAX_REQUEST_ID_LENGTH) {
    errors.push("requestId-too-long");
  }
  const source = payload.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) errors.push("source-missing");
  else {
    if (!SOURCE_BROWSERS.has(source.browser)) errors.push("source.browser-invalid");
    if (source.profileLabel != null) {
      if (typeof source.profileLabel !== "string" || byteLength(source.profileLabel) > MAX_PROFILE_LABEL_BYTES) {
        errors.push("source.profileLabel-invalid");
      }
    }
    if (source.extensionVersion != null && typeof source.extensionVersion !== "string") {
      errors.push("source.extensionVersion-invalid");
    }
  }
  errors.push(...validateConsent(payload.consent).map((e) => `consent.${e}`));

  const domains = payload.domains;
  let selected = [];
  if (!Array.isArray(domains)) errors.push("domains-not-array");
  else if (domains.length === 0) errors.push("domains-empty");
  else if (domains.length > MAX_SELECTED_DOMAINS) errors.push("domains-too-many");
  else {
    const seen = new Set();
    for (let i = 0; i < domains.length && errors.length < 50; i += 1) {
      if (!isValidDomain(domains[i])) {
        errors.push(`domains[${i}]-invalid`);
        continue;
      }
      const normalized = normalizeDomain(domains[i]);
      if (seen.has(normalized)) {
        errors.push(`domains[${i}]-duplicate`);
        continue;
      }
      seen.add(normalized);
      selected.push(normalized);
    }
  }

  const cookies = payload.cookies;
  if (!Array.isArray(cookies)) errors.push("cookies-not-array");
  else if (cookies.length === 0) errors.push("cookies-empty");
  else if (cookies.length > MAX_COOKIES_PER_JOB) errors.push("cookies-too-many");
  if (Array.isArray(cookies)) {
    for (let i = 0; i < cookies.length && errors.length < 50; i += 1) {
      const cookie = cookies[i];
      const cookieErrors = validateCookieRecord(cookie);
      for (const e of cookieErrors) errors.push(`cookies[${i}].${e}`);
      if (cookieErrors.length === 0 && selected.length > 0 && !domainMatchesSelection(cookie.domain, selected)) {
        errors.push(`cookies[${i}].domain-not-selected`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, normalized: normalizeImportRequest(payload, selected) };
}

export function normalizeImportRequest(payload, selectedDomains) {
  const selected = selectedDomains || payload.domains.map(normalizeDomain);
  const cookies = payload.cookies.map((c) => ({
    domain: c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    name: c.name,
    value: c.value,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: c.session,
    ...(c.session === false ? { expirationDate: Math.floor(c.expirationDate) } : {}),
    ...(c.partitionKey
      ? {
          partitionKey: {
            topLevelSite: String(c.partitionKey.topLevelSite),
            hasCrossSiteAncestor: !!c.partitionKey.hasCrossSiteAncestor,
          },
        }
      : {}),
  }));
  const cookieDomains = new Set(cookies.map((c) => normalizeDomain(c.domain)));
  return {
    contract: CONTRACT_ID,
    requestId: payload.requestId,
    source: {
      browser: payload.source.browser,
      profileLabel: payload.source.profileLabel ? String(payload.source.profileLabel) : undefined,
      extensionVersion: payload.source.extensionVersion ? String(payload.source.extensionVersion) : undefined,
    },
    consent: {
      kind: "explicit-user-action",
      at: payload.consent.at,
      extensionVersion: String(payload.consent.extensionVersion),
    },
    domains: selected,
    cookies,
    totals: {
      cookies: cookies.length,
      domains: cookieDomains.size,
      selectedDomains: selected.length,
    },
  };
}

// chrome.cookies.Cookie -> contract record. Returns a reason instead of
// throwing so the caller can count skips without echoing values.
export function cookieRecordFromChromeCookie(c) {
  if (!c || typeof c !== "object") return { ok: false, reason: "invalid-cookie" };
  const record = {
    domain: c.domain,
    hostOnly: !!c.hostOnly,
    path: c.path || "/",
    name: c.name,
    value: c.value,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || "unspecified",
    session: !!c.session,
    ...(c.session ? {} : { expirationDate: Math.floor(Number(c.expirationDate)) }),
    ...(c.partitionKey
      ? {
          partitionKey: {
            topLevelSite: c.partitionKey.topLevelSite,
            hasCrossSiteAncestor: !!c.partitionKey.hasCrossSiteAncestor,
          },
        }
      : {}),
  };
  const errors = validateCookieRecord(record);
  if (errors.length) return { ok: false, reason: failureCodeForValidation(errors[0]) };
  return { ok: true, cookie: record };
}

function failureCodeForValidation(error) {
  if (error.startsWith("domain")) return "invalid-domain";
  if (error.includes("expirationDate")) return "expiry-rejected";
  if (error.includes("sameSite")) return "samesite-rejected";
  if (error.includes("partitionKey")) return "partitioned-cookie-rejected";
  return "invalid-cookie";
}

export function summarizeImportRequest(normalized) {
  return {
    cookies: normalized.totals.cookies,
    domains: normalized.totals.domains,
    selectedDomains: normalized.totals.selectedDomains,
  };
}

// Map an exception/API error to a stable, non-sensitive failure code.
export function classifySetFailure(err) {
  const code = typeof err === "string" ? err : String(err && err.code ? err.code : err && err.message ? err.message : err);
  if (FAILURE_CODES.has(code)) return code;
  if (/partition/i.test(code)) return "partitioned-cookie-rejected";
  if (/same.?site/i.test(code)) return "samesite-rejected";
  if (/expir/i.test(code)) return "expiry-rejected";
  if (/permission|host/i.test(code)) return "permission-or-host";
  if (/url|scheme/i.test(code)) return "invalid-url";
  if (/domain/i.test(code)) return "invalid-domain";
  return "internal";
}

export function computeCookieImported({ state, applied, failed }) {
  const ok = Number.isInteger(applied) ? applied : 0;
  const bad = Number.isInteger(failed) ? failed : 0;
  if (state === "pending" || (state === "applying" && ok + bad === 0)) return "not_started";
  if (ok > 0 && bad === 0 && state === "done") return "imported";
  if (ok > 0 && bad > 0) return "partially_imported";
  if (ok > 0 && state === "cancelled") return "partially_imported";
  if (ok === 0 && bad > 0) return "failed";
  if (state === "failed") return "failed";
  return "not_started";
}

// Internal job -> public (safe) view. The public view is what the source
// extension and the CLI see; it never contains cookie records or domains.
export function createPublicJobView(job) {
  const applied = Number.isInteger(job.progress?.applied) ? job.progress.applied : 0;
  const failed = Number.isInteger(job.progress?.failed) ? job.progress.failed : 0;
  const total = Number.isInteger(job.totals?.cookies) ? job.totals.cookies : applied + failed;
  const status = computeCookieImported({ state: job.state, applied, failed });
  const view = {
    contract: CONTRACT_ID,
    jobId: job.id,
    state: job.state,
    totals: {
      cookies: total,
      domains: job.totals?.domains || 0,
      selectedDomains: job.totals?.selectedDomains || 0,
    },
    progress: {
      applied,
      failed,
      remaining: Math.max(0, total - applied - failed),
    },
    dataCopied: { cookies: false },
    cookieImported: {
      status,
      applied,
      failed,
      failures: { ...(job.failures || {}) },
    },
    loginVerified: {
      status: "not_verified",
      note: "Cookie 写入不等于网站登录成功；必须在目标浏览器中由用户本人确认。",
    },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.error && FAILURE_CODES.has(job.error.code)) {
    view.error = { code: job.error.code, message: failureText(job.error.code) };
  }
  return view;
}

export function validatePublicJobView(view) {
  const errors = [];
  if (!view || typeof view !== "object") return { ok: false, errors: ["view-not-object"] };
  if (view.contract !== CONTRACT_ID) errors.push("contract-invalid");
  if (typeof view.jobId !== "string") errors.push("jobId-invalid");
  if (!JOB_STATES.has(view.state)) errors.push("state-invalid");
  if (view.loginVerified?.status !== "not_verified") errors.push("login-verification-must-be-not_verified");
  if (!view.progress || typeof view.progress.applied !== "number" || typeof view.progress.failed !== "number") {
    errors.push("progress-invalid");
  }
  if (view.cookieImported && typeof view.cookieImported.status !== "string") errors.push("cookieImported-invalid");
  return { ok: errors.length === 0, errors };
}

// Defense in depth for clients: copy only the fields the contract allows, so a
// compromised or buggy target cannot smuggle cookie names/values/domains or a
// fake login verification into the CLI/UI.
export function sanitizePublicJobView(view) {
  if (!view || typeof view !== "object") return null;
  if (view.contract !== CONTRACT_ID || typeof view.jobId !== "string" || !JOB_STATES.has(view.state)) return null;
  const num = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  if (!view.progress || !Number.isInteger(view.progress.applied) || !Number.isInteger(view.progress.failed)) {
    return null;
  }
  const applied = num(view.progress.applied);
  const failed = num(view.progress.failed);
  const total = num(view.totals?.cookies) || applied + failed;
  // A target (or a compromised local process) may claim anything here; the
  // public view recomputes the status from counts and forces the only honest
  // login value.
  const failures = {};
  if (view.cookieImported?.failures && typeof view.cookieImported.failures === "object") {
    for (const [code, count] of Object.entries(view.cookieImported.failures)) {
      if (FAILURE_CODES.has(code) && Number.isInteger(count) && count >= 0) failures[code] = count;
    }
  }
  const safe = {
    contract: CONTRACT_ID,
    jobId: view.jobId,
    state: view.state,
    totals: {
      cookies: total,
      domains: num(view.totals?.domains),
      selectedDomains: num(view.totals?.selectedDomains),
    },
    progress: { applied, failed, remaining: Math.max(0, total - applied - failed) },
    dataCopied: { cookies: false },
    cookieImported: {
      status: computeCookieImported({ state: view.state, applied, failed }),
      applied,
      failed,
      failures,
    },
    loginVerified: { status: "not_verified" },
    createdAt: typeof view.createdAt === "string" ? view.createdAt : undefined,
    updatedAt: typeof view.updatedAt === "string" ? view.updatedAt : undefined,
  };
  if (view.error && FAILURE_CODES.has(view.error.code)) {
    safe.error = { code: view.error.code, message: failureText(view.error.code) };
  }
  return safe;
}
