// Browser CLI cookie-import contract v2.
//
// This module is the single source of truth for the wire format between the
// BrowserPilot source extension (running in Chrome/Edge), the BrowserPilot
// native messaging host relay, and the Browser CLI native cookie-import
// target. It is intentionally dependency-free so the exact same file can be
// copied into the extension package.
//
// Canonical copy: scripts/import/contract.mjs
// Extension copy: extensions/import-source/lib/contract.mjs
// Generate/verify with: node scripts/import/sync-extension-contract.mjs [--check]
//
// Security model (v2):
// - The transport is the existing BrowserPilot native messaging host, not a
//   localhost HTTP API. The host is a stdio-only relay in import mode and
//   connects out to the Browser CLI named pipe.
// - Authorization is a 160-bit one-time ticket with a 5 minute TTL, bound to the
//   target process/profile, one import job and the user-selected domain scope.
//   A 6-digit code or an extension Origin alone is never sufficient.
// - The target browser must independently ask its own user to approve the
//   import scope. The source extension and CLI can never approve it.
// - Failure counts and rate limits are enforced on both the host and the
//   target. A consumed ticket can never authorize a second job.
// - Cookie values and tickets never appear in logs, reports, job views or
//   long-lived files. The session descriptor contains only a ticket hash.
// - "cookie imported" and "login verified" are independent; a target can never
//   claim a verified login. Session cookies are explicitly not guaranteed to
//   survive a browser restart.

export const CONTRACT_ID = "browser-cli.cookie-import/v2";
export const CONTRACT_VERSION = 2;
export const PROTOCOL_VERSION = 2;
export const SESSION_SCHEMA = "browser-cli.cookie-import.session/v2";

export const HOST_NAME = "com.browserpilot.browseragent";
export const SOURCE_EXTENSION_ID = "ljoekiddijnohefaghljlcodgljienoj";

export const MAX_COOKIES_PER_JOB = 20000;
export const MAX_SELECTED_DOMAINS = 1000;
export const MAX_VALUE_BYTES = 8192;
export const MAX_NAME_BYTES = 4096;
export const MAX_DOMAIN_BYTES = 255;
export const MAX_PATH_BYTES = 1024;
export const MAX_PARTITION_SITE_BYTES = 2048;
export const MAX_PROFILE_LABEL_BYTES = 200;

// Transport limits. A native messaging frame is chunked well below the
// smallest Chrome limit so neither direction can be truncated.
export const MAX_FRAME_BYTES = 512 * 1024;
export const MAX_CHUNK_PAYLOAD_BYTES = 256 * 1024;
export const MAX_CHUNKS = 64;
export const MAX_JOB_BYTES = 16 * 1024 * 1024;
export const MAX_DESCRIPTOR_BYTES = 16 * 1024;
export const MAX_DESCRIPTOR_FILES = 32;

// Authorization and lifetime limits.
export const TICKET_TTL_MS = 5 * 60 * 1000;
export const JOB_TTL_MS = 10 * 60 * 1000;
export const CONSENT_MAX_AGE_MS = 10 * 60 * 1000;
export const CLOCK_SKEW_MS = 2 * 60 * 1000;
export const MAX_TICKET_FAILURES = 5;
export const TICKET_FAILURE_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_BLOCK_MS = 60 * 1000;
export const MAX_SESSIONS_PER_HOUR = 10;

export const TICKET_PREFIX = "BCLI";
export const TICKET_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TICKET_BYTES = 20; // 160 bits -> exactly 32 Crockford base32 chars.
export const TICKET_LENGTH = 32;

export const SOURCE_BROWSERS = new Set(["chrome", "edge", "brave", "chromium", "firefox"]);
export const SAME_SITE_VALUES = new Set(["no_restriction", "lax", "strict", "unspecified"]);

export const JOB_STATES = new Set([
  "pending",
  "awaiting_authorization",
  "applying",
  "done",
  "failed",
  "cancelled",
  "denied",
]);
export const TERMINAL_JOB_STATES = new Set(["done", "failed", "cancelled", "denied"]);

// Cookie-level failure codes. These are the only failure details that may
// cross the transport or appear in a report.
export const FAILURE_CODES = new Set([
  "invalid-cookie",
  "invalid-domain",
  "invalid-url",
  "public-suffix-rejected",
  "cookie-prefix-rejected",
  "partitioned-cookie-rejected",
  "samesite-rejected",
  "expiry-rejected",
  "permission-or-host",
  "cookie-store-unavailable",
  "target-busy",
  "profile-locked",
  "authorization-denied",
  "cancelled",
  "timeout",
  "internal",
]);

// Session/transport error codes. They are returned by the host/target but are
// never counted as cookie failures.
export const SESSION_ERROR_CODES = new Set([
  "protocol-mismatch",
  "ticket-invalid",
  "ticket-expired",
  "ticket-consumed",
  "rate-limited",
  "target-not-running",
  "target-disconnected",
  "target-busy",
  "host-identity-mismatch",
  "profile-mismatch",
  "job-binding-mismatch",
  "job-digest-mismatch",
  "chunk-missing",
  "too-many-cookies",
  "too-large",
  "authorization-denied",
  "import-mode-conflict",
  "internal",
]);

export const RATE_LIMITED = "rate-limited";

export const FAILURE_TEXT = {
  "invalid-cookie": "Cookie 字段不合法，已跳过。",
  "invalid-domain": "Cookie 域名不合法，已跳过。",
  "invalid-url": "Cookie 无法映射为目标浏览器的 URL，已跳过。",
  "public-suffix-rejected": "目标是公共后缀，不能写入 Domain Cookie。",
  "cookie-prefix-rejected": "Cookie 前缀（__Host-/__Secure-/__Http-）要求不满足。",
  "partitioned-cookie-rejected": "目标 CookieStore 拒绝了分区 Cookie。",
  "samesite-rejected": "SameSite=None 必须同时是 Secure Cookie。",
  "expiry-rejected": "Cookie 过期时间不合法或已经过期。",
  "permission-or-host": "目标 CookieStore 拒绝写入该主机。",
  "cookie-store-unavailable": "目标 CookieStore 不可用（Profile 未就绪或已锁定）。",
  "target-busy": "目标正在处理另一个导入任务，请稍后重试。",
  "profile-locked": "目标 Profile 正被占用；请先关闭目标浏览器再重试。",
  "authorization-denied": "目标浏览器的用户拒绝了本次导入范围。",
  cancelled: "导入已取消；已经写入的 Cookie 不会自动回滚。",
  timeout: "等待来源扩展发送超时；请确认导入票据和目标会话。",
  internal: "目标内部错误；未写入或仅部分写入，请查看目标日志（只含计数）。",
  "protocol-mismatch": "来源扩展与目标的协议版本不一致。",
  "ticket-invalid": "导入票据格式不正确。",
  "ticket-expired": "导入票据已过期；请在目标浏览器中获取新票据。",
  "ticket-consumed": "导入票据已被使用；一张票据只能授权一次导入。",
  "rate-limited": "失败次数过多，已暂时锁定；请稍后重新启动导入会话。",
  "target-not-running": "没有找到运行中的 Browser CLI 导入会话。",
  "target-disconnected": "与 Browser CLI 的连接中断，导入已停止。",
  "host-identity-mismatch": "目标无法确认本机中转进程的身份。",
  "profile-mismatch": "目标 Profile 与导入票据绑定的 Profile 不一致。",
  "job-binding-mismatch": "导入票据已绑定到另一个任务。",
  "job-digest-mismatch": "导入数据完整性校验失败。",
  "chunk-missing": "导入数据分片不完整。",
  "too-many-cookies": "Cookie 数量超过目标上限。",
  "too-large": "导入数据超过大小上限。",
  "import-mode-conflict": "BrowserPilot 本机中转进程已进入普通模式；请重试以启动新的导入会话。",
};

export function failureText(code) {
  return FAILURE_TEXT[code] || "未知失败原因。";
}

export function isSessionError(code) {
  return SESSION_ERROR_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Loopback helper (HTTP test target only; never the product transport)
// ---------------------------------------------------------------------------

// The local test target and its client may only talk to a literal loopback
// address. No LAN host, no DNS name, no path/query/credentials smuggling.
// The product source extension does not use HTTP at all.
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

// ---------------------------------------------------------------------------
// Ticket: 160-bit, Crockford base32, one-time, short TTL
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function byteLength(value) {
  return utf8.encode(String(value)).length;
}

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += TICKET_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += TICKET_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function generateTicket() {
  return base32Encode(randomBytes(TICKET_BYTES));
}

export function normalizeTicket(raw) {
  let value = String(raw ?? "").trim().toUpperCase();
  if (value.startsWith(`${TICKET_PREFIX}-`)) value = value.slice(TICKET_PREFIX.length + 1);
  return value
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function isValidTicket(raw) {
  const value = normalizeTicket(raw);
  if (value.length !== TICKET_LENGTH) return false;
  for (const char of value) {
    if (!TICKET_ALPHABET.includes(char)) return false;
  }
  return true;
}

export function formatTicket(raw) {
  const value = normalizeTicket(raw);
  if (!isValidTicket(value)) return "";
  const groups = [];
  for (let i = 0; i < value.length; i += 4) groups.push(value.slice(i, i + 4));
  return `${TICKET_PREFIX}-${groups.join("-")}`;
}

// Constant-time-ish string compare. Ticket values are high entropy, so timing
// is not a practical oracle, but avoid the obvious early-exit pattern anyway.
export function safeEqualString(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? utf8.encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function ticketHash(raw) {
  const normalized = normalizeTicket(raw);
  if (!isValidTicket(normalized)) return "";
  return sha256Hex(`browser-cli-ticket-v2:${normalized}`);
}

export async function ticketMatchesHash(raw, hash) {
  const computed = await ticketHash(raw);
  return computed !== "" && safeEqualString(computed, String(hash ?? "").toLowerCase());
}

// ---------------------------------------------------------------------------
// Domain and cookie record validation
// ---------------------------------------------------------------------------

export function normalizeDomain(domain) {
  return String(domain || "").replace(/^\./, "").trim().toLowerCase();
}

export function isValidDomain(domain) {
  if (typeof domain !== "string" || domain.length === 0 || domain.length > MAX_DOMAIN_BYTES) return false;
  if (!/^[\x00-\x7f]+$/.test(domain)) return false;
  const bare = domain.startsWith(".") ? domain.slice(1) : domain;
  if (!bare || bare.endsWith(".") || bare.includes("..")) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(bare);
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

function hasControlCharacters(value) {
  return /[\0\r\n]/.test(value);
}

function cookiePrefix(name) {
  if (name.startsWith("__Host-Http-")) return "host-http";
  if (name.startsWith("__Host-")) return "host";
  if (name.startsWith("__Secure-")) return "secure";
  if (name.startsWith("__Http-")) return "http";
  return null;
}

export function prefixFailure(cookie) {
  const prefix = cookiePrefix(cookie.name);
  if (!prefix) return null;
  if (prefix === "host") {
    if (!cookie.secure || cookie.path !== "/" || cookie.hostOnly !== true) return "cookie-prefix-rejected";
    return null;
  }
  if (prefix === "host-http") {
    if (!cookie.secure || !cookie.httpOnly || cookie.path !== "/" || cookie.hostOnly !== true) {
      return "cookie-prefix-rejected";
    }
    return null;
  }
  if (prefix === "secure") {
    return cookie.secure ? null : "cookie-prefix-rejected";
  }
  if (prefix === "http") {
    return cookie.secure && cookie.httpOnly ? null : "cookie-prefix-rejected";
  }
  return null;
}

export function validatePartitionKey(partitionKey) {
  if (!partitionKey || typeof partitionKey !== "object" || Array.isArray(partitionKey)) {
    return ["partitionKey-not-object"];
  }
  const errors = [];
  if (typeof partitionKey.topLevelSite !== "string") {
    errors.push("partitionKey.topLevelSite-invalid");
  } else {
    const site = normalizeTopLevelSite(partitionKey.topLevelSite);
    if (!site) errors.push("partitionKey.topLevelSite-invalid");
    else if (byteLength(site) > MAX_PARTITION_SITE_BYTES) errors.push("partitionKey.topLevelSite-too-long");
  }
  if (typeof partitionKey.hasCrossSiteAncestor !== "boolean") {
    errors.push("partitionKey.hasCrossSiteAncestor-invalid");
  }
  return errors;
}

// A partition key is a schemeful site: scheme://host, no path/query/credentials
// and no port. Normalizing here gives JS and C++ one canonical string.
export function normalizeTopLevelSite(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || url.username || url.password) return null;
  if (url.port) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  return `${url.protocol}//${url.hostname}`;
}

export function validateCookieRecord(cookie, { now = Date.now() } = {}) {
  const errors = [];
  if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) return ["not-object"];
  if (!isValidDomain(cookie.domain)) errors.push("domain-invalid");
  else if (cookie.hostOnly === true && String(cookie.domain).startsWith(".")) errors.push("hostOnly-domain-has-dot");
  else if (cookie.hostOnly === false && !String(cookie.domain).startsWith(".")) errors.push("domain-cookie-missing-dot");
  if (typeof cookie.name !== "string" || cookie.name.length === 0) errors.push("name-invalid");
  else if (byteLength(cookie.name) > MAX_NAME_BYTES) errors.push("name-too-long");
  else if (hasControlCharacters(cookie.name)) errors.push("name-control-chars");
  if (typeof cookie.value !== "string") errors.push("value-invalid");
  else if (byteLength(cookie.value) > MAX_VALUE_BYTES) errors.push("value-too-long");
  else if (cookie.value.includes("\0")) errors.push("value-nul");
  if (typeof cookie.path !== "string" || !cookie.path.startsWith("/")) errors.push("path-invalid");
  else if (byteLength(cookie.path) > MAX_PATH_BYTES) errors.push("path-too-long");
  else if (hasControlCharacters(cookie.path)) errors.push("path-control-chars");
  for (const key of ["hostOnly", "secure", "httpOnly", "session"]) {
    if (typeof cookie[key] !== "boolean") errors.push(`${key}-not-boolean`);
  }
  if (!SAME_SITE_VALUES.has(cookie.sameSite)) errors.push("sameSite-invalid");
  if (cookie.session === true) {
    if (cookie.expirationDate !== undefined) errors.push("session-cookie-has-expiration");
  } else if (cookie.session === false) {
    if (
      typeof cookie.expirationDate !== "number" ||
      !Number.isFinite(cookie.expirationDate) ||
      cookie.expirationDate <= 0
    ) {
      errors.push("expirationDate-invalid");
    } else if (cookie.expirationDate * 1000 <= now) {
      errors.push("expirationDate-in-past");
    }
  }
  if (cookie.partitionKey !== undefined && cookie.partitionKey !== null) {
    errors.push(...validatePartitionKey(cookie.partitionKey));
  }
  if (errors.length === 0) {
    const prefix = prefixFailure(cookie);
    if (prefix) errors.push(prefix);
    if (cookie.sameSite === "no_restriction" && cookie.secure !== true) {
      errors.push("samesite-none-requires-secure");
    }
    if (cookie.partitionKey && cookie.secure !== true) {
      errors.push("partitioned-requires-secure");
    }
  }
  return errors;
}

export function failureCodeForCookieError(error) {
  if (error.startsWith("domain") || error === "hostOnly-domain-has-dot" || error === "domain-cookie-missing-dot") {
    return "invalid-domain";
  }
  if (error.startsWith("expirationDate") || error === "session-cookie-has-expiration") return "expiry-rejected";
  if (error.startsWith("sameSite") || error === "samesite-none-requires-secure") return "samesite-rejected";
  if (error.startsWith("partitionKey") || error === "partitioned-requires-secure") {
    return "partitioned-cookie-rejected";
  }
  if (error === "cookie-prefix-rejected") return "cookie-prefix-rejected";
  return "invalid-cookie";
}

export function failureCodeForValidation(error) {
  return failureCodeForCookieError(String(error));
}

// Target-only policy check. `isPublicSuffix` is injected so the JS test target
// can use a small deterministic list while the native target uses Chromium's
// Public Suffix List. A domain cookie on a public suffix is rejected; a
// host-only cookie is allowed (the browser itself enforces the remaining rules
// through CanonicalCookie::CreateSanitizedCookie).
export function cookiePolicyFailure(cookie, selectedDomains, { now = Date.now(), isPublicSuffix = null } = {}) {
  const errors = validateCookieRecord(cookie, { now });
  if (errors.length) return failureCodeForCookieError(errors[0]);
  if (!domainMatchesSelection(cookie.domain, selectedDomains)) return "invalid-domain";
  if (cookie.hostOnly === false && typeof isPublicSuffix === "function") {
    const bare = normalizeDomain(cookie.domain);
    if (isPublicSuffix(bare)) return "public-suffix-rejected";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Consent and request validation
// ---------------------------------------------------------------------------

export function validateConsent(consent, { now = Date.now() } = {}) {
  const errors = [];
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) return ["missing"];
  if (consent.kind !== "explicit-user-action") errors.push("kind-invalid");
  if (typeof consent.at !== "string" || Number.isNaN(Date.parse(consent.at))) errors.push("at-invalid");
  else {
    const at = Date.parse(consent.at);
    if (at > now + CLOCK_SKEW_MS) errors.push("at-in-future");
    else if (at < now - CONSENT_MAX_AGE_MS) errors.push("at-too-old");
  }
  if (typeof consent.extensionVersion !== "string" || consent.extensionVersion.length === 0) {
    errors.push("extensionVersion-invalid");
  } else if (byteLength(consent.extensionVersion) > 64) {
    errors.push("extensionVersion-too-long");
  }
  if (consent.scope !== "selected-domains") errors.push("scope-invalid");
  if (typeof consent.domainsDigest !== "string" || !/^[a-f0-9]{64}$/.test(consent.domainsDigest)) {
    errors.push("domainsDigest-invalid");
  }
  return errors;
}

export async function domainsDigest(domains) {
  const normalized = [...new Set((domains || []).map(normalizeDomain).filter(Boolean))].sort();
  return sha256Hex(`browser-cli-domains-v2:${normalized.join("\n")}`);
}

export async function buildConsent({ extensionVersion, domains, at = new Date().toISOString() }) {
  return {
    kind: "explicit-user-action",
    at,
    extensionVersion,
    scope: "selected-domains",
    domainsDigest: await domainsDigest(domains),
  };
}

export async function validateImportRequest(payload, { now = Date.now(), validateExpiry = true } = {}) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload-not-object"] };
  }
  if (payload.contract !== CONTRACT_ID) errors.push("contract-invalid");
  if (typeof payload.jobNonce !== "string" || !/^[a-f0-9]{32}$/.test(payload.jobNonce)) {
    errors.push("jobNonce-invalid");
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
  errors.push(...validateConsent(payload.consent, { now }).map((e) => `consent.${e}`));

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
      const cookieErrors = validateCookieRecord(cookie, { now: validateExpiry ? now : Date.now() });
      for (const e of cookieErrors) errors.push(`cookies[${i}].${e}`);
      if (cookieErrors.length === 0 && selected.length > 0 && !domainMatchesSelection(cookie.domain, selected)) {
        errors.push(`cookies[${i}].domain-not-selected`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };

  const expectedDigest = await domainsDigest(selected);
  if (!safeEqualString(expectedDigest, payload.consent.domainsDigest.toLowerCase())) {
    return { ok: false, errors: ["consent.domains-digest-mismatch"] };
  }
  return { ok: true, normalized: normalizeImportRequest(payload, selected) };
}

export function normalizeImportRequest(payload, selectedDomains) {
  const selected = selectedDomains || payload.domains.map(normalizeDomain);
  const cookies = payload.cookies.map((c) => {
    const bare = normalizeDomain(c.domain);
    const domain = c.hostOnly ? bare : `.${bare}`;
    return {
      domain,
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
              topLevelSite: normalizeTopLevelSite(c.partitionKey.topLevelSite),
              hasCrossSiteAncestor: !!c.partitionKey.hasCrossSiteAncestor,
            },
          }
        : {}),
    };
  });
  const cookieDomains = new Set(cookies.map((c) => normalizeDomain(c.domain)));
  return {
    contract: CONTRACT_ID,
    protocolVersion: PROTOCOL_VERSION,
    jobNonce: payload.jobNonce,
    source: {
      browser: payload.source.browser,
      profileLabel: payload.source.profileLabel ? String(payload.source.profileLabel) : undefined,
      extensionVersion: payload.source.extensionVersion ? String(payload.source.extensionVersion) : undefined,
    },
    consent: {
      kind: "explicit-user-action",
      at: payload.consent.at,
      extensionVersion: String(payload.consent.extensionVersion),
      scope: "selected-domains",
      domainsDigest: String(payload.consent.domainsDigest).toLowerCase(),
    },
    domains: selected,
    cookies,
    totals: {
      cookies: cookies.length,
      domains: cookieDomains.size,
      selectedDomains: selected.length,
      hostOnlyCookies: cookies.filter((c) => c.hostOnly).length,
      domainCookies: cookies.filter((c) => !c.hostOnly).length,
      sessionCookies: cookies.filter((c) => c.session).length,
      partitionedCookies: cookies.filter((c) => c.partitionKey).length,
    },
  };
}

// chrome.cookies.Cookie -> contract record. Returns a reason instead of
// throwing so the caller can count skips without echoing values.
export function cookieRecordFromChromeCookie(c, { now = Date.now() } = {}) {
  if (!c || typeof c !== "object") return { ok: false, reason: "invalid-cookie" };
  const hostOnly = !!c.hostOnly;
  const bare = normalizeDomain(c.domain);
  if (!bare) return { ok: false, reason: "invalid-domain" };
  const record = {
    domain: hostOnly ? bare : `.${bare}`,
    hostOnly,
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
  const errors = validateCookieRecord(record, { now });
  if (errors.length) return { ok: false, reason: failureCodeForCookieError(errors[0]) };
  return { ok: true, cookie: record };
}

export function summarizeImportRequest(normalized) {
  return {
    cookies: normalized.totals.cookies,
    domains: normalized.totals.domains,
    selectedDomains: normalized.totals.selectedDomains,
    sessionCookies: normalized.totals.sessionCookies,
  };
}

// ---------------------------------------------------------------------------
// Job digest and chunking
// ---------------------------------------------------------------------------

// The digest covers the exact UTF-8 bytes that are chunked, so the target can
// verify integrity before parsing. It is not a canonical-JSON digest.
export async function jobDigest(payloadText) {
  return sha256Hex(String(payloadText));
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += has1 ? BASE64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += has2 ? BASE64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

export function base64ToBytes(text) {
  const clean = String(text || "").replace(/\s+/g, "");
  if (clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(clean)) {
    const err = new Error("invalid-base64");
    err.code = "chunk-missing";
    throw err;
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[i]);
    const c1 = BASE64_ALPHABET.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) {
      const err = new Error("invalid-base64");
      err.code = "chunk-missing";
      throw err;
    }
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (offset < out.length) out[offset++] = (triple >> 16) & 0xff;
    if (offset < out.length) out[offset++] = (triple >> 8) & 0xff;
    if (offset < out.length) out[offset++] = triple & 0xff;
  }
  return out;
}

export function chunkJobPayload(payloadText, maxChunkBytes = MAX_CHUNK_PAYLOAD_BYTES) {
  const bytes = utf8.encode(String(payloadText));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += maxChunkBytes) {
    chunks.push(bytesToBase64(bytes.subarray(i, Math.min(i + maxChunkBytes, bytes.length))));
  }
  return chunks;
}

export function assembleChunks(chunks, { maxBytes = MAX_JOB_BYTES } = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    const err = new Error("chunk-missing");
    err.code = "chunk-missing";
    throw err;
  }
  const parts = [];
  let total = 0;
  for (const chunk of chunks) {
    const bytes = base64ToBytes(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      const err = new Error("too-large");
      err.code = "too-large";
      throw err;
    }
    parts.push(bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function decodeUtf8(bytes) {
  return utf8Decoder.decode(bytes);
}

// ---------------------------------------------------------------------------
// Session descriptor (target -> host discovery aid; never contains the ticket)
// ---------------------------------------------------------------------------

export function validateSessionDescriptor(descriptor, { now = Date.now() } = {}) {
  const errors = [];
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    return { ok: false, errors: ["descriptor-not-object"] };
  }
  if (descriptor.schema !== SESSION_SCHEMA) errors.push("schema-invalid");
  if (descriptor.protocolVersion !== PROTOCOL_VERSION) errors.push("protocol-invalid");
  if (typeof descriptor.targetProduct !== "string" || descriptor.targetProduct.length === 0) {
    errors.push("targetProduct-invalid");
  }
  if (!Number.isInteger(descriptor.targetPid) || descriptor.targetPid <= 0) errors.push("targetPid-invalid");
  if (!Number.isInteger(descriptor.targetStartTimeMs) || descriptor.targetStartTimeMs <= 0) {
    errors.push("targetStartTime-invalid");
  }
  if (typeof descriptor.targetInstanceId !== "string" || !/^[a-f0-9]{32}$/.test(descriptor.targetInstanceId)) {
    errors.push("targetInstanceId-invalid");
  }
  if (typeof descriptor.profileHash !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.profileHash)) {
    errors.push("profileHash-invalid");
  }
  if (typeof descriptor.ticketHash !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.ticketHash)) {
    errors.push("ticketHash-invalid");
  }
  if (descriptor.transport !== "named-pipe" && descriptor.transport !== "unix-socket") {
    errors.push("transport-invalid");
  }
  if (descriptor.transport === "named-pipe" && typeof descriptor.pipeName !== "string") {
    errors.push("pipeName-invalid");
  }
  if (descriptor.transport === "unix-socket" && typeof descriptor.socketPath !== "string") {
    errors.push("socketPath-invalid");
  }
  const created = Date.parse(descriptor.createdAt);
  const expires = Date.parse(descriptor.expiresAt);
  if (Number.isNaN(created) || Number.isNaN(expires)) errors.push("timestamps-invalid");
  else {
    if (created > now + CLOCK_SKEW_MS) errors.push("createdAt-in-future");
    if (expires <= now) errors.push("expired");
    if (expires - created > TICKET_TTL_MS + CLOCK_SKEW_MS) errors.push("ttl-too-long");
  }
  return { ok: errors.length === 0, errors };
}

export function createSessionDescriptor({
  targetProduct,
  targetVersion = "",
  targetPid,
  targetStartTimeMs,
  targetInstanceId,
  profileHash,
  ticketHash: hash,
  transport,
  pipeName = undefined,
  socketPath = undefined,
  createdAt = new Date().toISOString(),
  expiresAt,
}) {
  return {
    schema: SESSION_SCHEMA,
    protocolVersion: PROTOCOL_VERSION,
    targetProduct,
    targetVersion,
    targetPid,
    targetStartTimeMs,
    targetInstanceId,
    profileHash,
    ticketHash: hash,
    transport,
    ...(transport === "named-pipe" ? { pipeName } : { socketPath }),
    createdAt,
    expiresAt: expiresAt || new Date(Date.parse(createdAt) + TICKET_TTL_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Failure classification and public job view
// ---------------------------------------------------------------------------

// Map an exception/API error to a stable, non-sensitive failure code.
export function classifySetFailure(err) {
  const code = typeof err === "string" ? err : String(err && err.code ? err.code : err && err.message ? err.message : err);
  if (FAILURE_CODES.has(code) || SESSION_ERROR_CODES.has(code)) return code;
  if (/public.?suffix/i.test(code)) return "public-suffix-rejected";
  if (/prefix/i.test(code)) return "cookie-prefix-rejected";
  if (/partition/i.test(code)) return "partitioned-cookie-rejected";
  if (/same.?site|samesite/i.test(code)) return "samesite-rejected";
  if (/expir/i.test(code)) return "expiry-rejected";
  if (/permission|host/i.test(code)) return "permission-or-host";
  if (/url|scheme/i.test(code)) return "invalid-url";
  if (/domain/i.test(code)) return "invalid-domain";
  return "internal";
}

export function computeCookieImported({ state, applied, failed }) {
  const ok = Number.isInteger(applied) ? applied : 0;
  const bad = Number.isInteger(failed) ? failed : 0;
  if (state === "pending" || state === "awaiting_authorization") return "not_started";
  if (state === "denied") return "not_started";
  if (ok > 0 && bad === 0 && (state === "done" || state === "applying")) return "imported";
  if (ok > 0 && bad > 0) return "partially_imported";
  if (ok > 0 && state === "cancelled") return "partially_imported";
  if (ok === 0 && bad > 0) return "failed";
  if (state === "failed") return "failed";
  return "not_started";
}

function safeAuthorization(value) {
  if (!value || typeof value !== "object") return null;
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

// Internal job -> public (safe) view. The public view is what the source
// extension, host relay and CLI see; it never contains cookie records, cookie
// values or domains.
export function createPublicJobView(job) {
  const applied = Number.isInteger(job.progress?.applied) ? job.progress.applied : 0;
  const failed = Number.isInteger(job.progress?.failed) ? job.progress.failed : 0;
  const total = Number.isInteger(job.totals?.cookies) ? job.totals.cookies : applied + failed;
  const status = computeCookieImported({ state: job.state, applied, failed });
  const sessionCookies = Number.isInteger(job.totals?.sessionCookies) ? job.totals.sessionCookies : 0;
  const view = {
    contract: CONTRACT_ID,
    protocolVersion: PROTOCOL_VERSION,
    jobId: job.id,
    state: job.state,
    transport: typeof job.transport === "string" ? job.transport : "unknown",
    native: job.native === true,
    totals: {
      cookies: total,
      domains: job.totals?.domains || 0,
      selectedDomains: job.totals?.selectedDomains || 0,
      sessionCookies,
      partitionedCookies: job.totals?.partitionedCookies || 0,
    },
    progress: {
      applied,
      failed,
      remaining: Math.max(0, total - applied - failed),
    },
    authorization: safeAuthorization(job.authorization) || {
      targetUserConfirmed: false,
      simulated: false,
      source: "unknown",
    },
    dataCopied: { cookies: false },
    cookieImported: {
      status,
      applied,
      failed,
      failures: { ...(job.failures || {}) },
    },
    sessionCookies: {
      count: sessionCookies,
      mayNotSurviveRestart: true,
      note: "会话 Cookie 不保证在浏览器重启后保留；持久 Cookie 由目标 CookieStore 决定。",
    },
    loginVerified: {
      status: "not_verified",
      note: "Cookie 写入不等于网站登录成功；必须在目标浏览器中由用户本人确认。",
    },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.error && (FAILURE_CODES.has(job.error.code) || SESSION_ERROR_CODES.has(job.error.code))) {
    view.error = { code: job.error.code, message: failureText(job.error.code) };
  }
  return view;
}

export function validatePublicJobView(view) {
  const errors = [];
  if (!view || typeof view !== "object") return { ok: false, errors: ["view-not-object"] };
  if (view.contract !== CONTRACT_ID) errors.push("contract-invalid");
  if (typeof view.jobId !== "string" || !/^[a-f0-9]{24}$/.test(view.jobId)) errors.push("jobId-invalid");
  if (!JOB_STATES.has(view.state)) errors.push("state-invalid");
  if (view.loginVerified?.status !== "not_verified") errors.push("login-verification-must-be-not_verified");
  if (!view.progress || typeof view.progress.applied !== "number" || typeof view.progress.failed !== "number") {
    errors.push("progress-invalid");
  }
  if (view.cookieImported && typeof view.cookieImported.status !== "string") errors.push("cookieImported-invalid");
  if (!view.authorization || typeof view.authorization.targetUserConfirmed !== "boolean") {
    errors.push("authorization-invalid");
  }
  return { ok: errors.length === 0, errors };
}

// Defense in depth for clients: copy only the fields the contract allows, so a
// compromised or buggy target cannot smuggle cookie names/values/domains or a
// fake login verification into the CLI/UI.
export function sanitizePublicJobView(view) {
  if (!view || typeof view !== "object") return null;
  if (view.contract !== CONTRACT_ID || typeof view.jobId !== "string" || !JOB_STATES.has(view.state)) return null;
  if (!/^[a-f0-9]{24}$/.test(view.jobId)) return null;
  const num = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  if (!view.progress || !Number.isInteger(view.progress.applied) || !Number.isInteger(view.progress.failed)) {
    return null;
  }
  const applied = num(view.progress.applied);
  const failed = num(view.progress.failed);
  const total = num(view.totals?.cookies) || applied + failed;
  const failures = {};
  if (view.cookieImported?.failures && typeof view.cookieImported.failures === "object") {
    for (const [code, count] of Object.entries(view.cookieImported.failures)) {
      if (FAILURE_CODES.has(code) && Number.isInteger(count) && count >= 0) failures[code] = count;
    }
  }
  const authorization = safeAuthorization(view.authorization);
  const sessionCount = Number.isInteger(view.totals?.sessionCookies) && view.totals.sessionCookies >= 0
    ? view.totals.sessionCookies
    : Number.isInteger(view.sessionCookies?.count) && view.sessionCookies.count >= 0
      ? view.sessionCookies.count
      : 0;
  const safe = {
    contract: CONTRACT_ID,
    protocolVersion: PROTOCOL_VERSION,
    jobId: view.jobId,
    state: view.state,
    transport: typeof view.transport === "string" && /^[a-z0-9-]{1,32}$/.test(view.transport)
      ? view.transport
      : "unknown",
    native: view.native === true,
    totals: {
      cookies: total,
      domains: num(view.totals?.domains),
      selectedDomains: num(view.totals?.selectedDomains),
      sessionCookies: sessionCount,
      partitionedCookies: num(view.totals?.partitionedCookies),
    },
    progress: { applied, failed, remaining: Math.max(0, total - applied - failed) },
    authorization: authorization || {
      targetUserConfirmed: false,
      simulated: false,
      source: "unknown",
    },
    dataCopied: { cookies: false },
    cookieImported: {
      status: computeCookieImported({ state: view.state, applied, failed }),
      applied,
      failed,
      failures,
    },
    sessionCookies: {
      count: sessionCount,
      mayNotSurviveRestart: true,
    },
    loginVerified: { status: "not_verified" },
    createdAt: typeof view.createdAt === "string" ? view.createdAt : undefined,
    updatedAt: typeof view.updatedAt === "string" ? view.updatedAt : undefined,
  };
  if (view.error && (FAILURE_CODES.has(view.error.code) || SESSION_ERROR_CODES.has(view.error.code))) {
    safe.error = { code: view.error.code, message: failureText(view.error.code) };
  }
  return safe;
}
