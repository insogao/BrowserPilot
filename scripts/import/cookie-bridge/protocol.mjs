// Cookie bridge protocol (MVP).
//
// The bridge exists because Chromium's built-in importer cannot import
// cookies (components/user_data_importer/common/importer_data_types.h:
// `COOKIES = 1 << 2, // Not supported yet.`) and because decrypting v10/v20
// cookie blobs would cross the source browser's encryption boundary.
//
// Instead, the user explicitly installs a small source extension that reads
// cookies through the official chrome.cookies API in the source browser, and a
// target extension that writes them through chrome.cookies.set in the target
// browser. The broker is a localhost-only, memory-only relay; it never writes
// cookie values to disk and never logs them.

export const PROTOCOL_VERSION = 1;
export const MAX_COOKIES = 20000;
export const MAX_VALUE_BYTES = 8192;
export const MAX_NAME_BYTES = 4096;
export const MAX_DOMAIN_BYTES = 255;
export const SAME_SITE_VALUES = new Set(["no_restriction", "lax", "strict", "unspecified"]);

export function validateJobPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") return { ok: false, errors: ["payload-not-object"] };
  if (payload.version !== PROTOCOL_VERSION) errors.push("bad-version");
  const source = payload.source;
  if (!source || typeof source !== "object") errors.push("source-missing");
  else {
    if (typeof source.browser !== "string" || !source.browser) errors.push("source.browser-missing");
    if (source.profileLabel != null && typeof source.profileLabel !== "string") errors.push("source.profileLabel-invalid");
  }
  const cookies = payload.cookies;
  if (!Array.isArray(cookies)) errors.push("cookies-not-array");
  else if (cookies.length === 0) errors.push("cookies-empty");
  else if (cookies.length > MAX_COOKIES) errors.push("cookies-too-many");
  if (Array.isArray(cookies)) {
    for (let i = 0; i < cookies.length && errors.length < 50; i += 1) {
      const errs = validateCookie(cookies[i]);
      for (const e of errs) errors.push(`cookies[${i}].${e}`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, normalized: normalizeJob(payload) };
}

export function validateCookie(c) {
  const errors = [];
  if (!c || typeof c !== "object") return ["not-object"];
  if (typeof c.domain !== "string" || c.domain.length === 0 || c.domain.length > MAX_DOMAIN_BYTES) errors.push("domain-invalid");
  else if (!/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(c.domain)) errors.push("domain-charset");
  if (typeof c.name !== "string" || c.name.length === 0 || Buffer.byteLength(c.name) > MAX_NAME_BYTES) errors.push("name-invalid");
  if (typeof c.value !== "string" || Buffer.byteLength(c.value) > MAX_VALUE_BYTES) errors.push("value-invalid");
  if (typeof c.path !== "string" || !c.path.startsWith("/")) errors.push("path-invalid");
  if (c.path && c.path.length > 1024) errors.push("path-too-long");
  for (const key of ["hostOnly", "secure", "httpOnly", "session"]) {
    if (typeof c[key] !== "boolean") errors.push(`${key}-not-boolean`);
  }
  if (!SAME_SITE_VALUES.has(c.sameSite)) errors.push("sameSite-invalid");
  if (c.session === false) {
    if (typeof c.expirationDate !== "number" || !Number.isFinite(c.expirationDate) || c.expirationDate <= 0) {
      errors.push("expirationDate-invalid");
    }
  }
  if (c.partitionKey !== undefined && c.partitionKey !== null) {
    const pk = c.partitionKey;
    if (typeof pk !== "object") errors.push("partitionKey-not-object");
    else {
      if (typeof pk.topLevelSite !== "string" || pk.topLevelSite.length === 0 || pk.topLevelSite.length > 2048) {
        errors.push("partitionKey.topLevelSite-invalid");
      }
      if (typeof pk.hasCrossSiteAncestor !== "boolean") errors.push("partitionKey.hasCrossSiteAncestor-invalid");
    }
  }
  return errors;
}

function normalizeJob(payload) {
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
            topLevelSite: c.partitionKey.topLevelSite,
            hasCrossSiteAncestor: !!c.partitionKey.hasCrossSiteAncestor,
          },
        }
      : {}),
  }));
  const domains = new Set(cookies.map((c) => c.domain.replace(/^\./, "").toLowerCase()));
  return {
    version: PROTOCOL_VERSION,
    source: {
      browser: String(payload.source.browser),
      profileLabel: payload.source.profileLabel ? String(payload.source.profileLabel) : undefined,
      exportedAt: new Date().toISOString(),
    },
    cookies,
    totals: { cookies: cookies.length, domains: domains.size },
  };
}

// Summary for logs/results: counts only, never names/values/domains.
export function summarizeJob(job) {
  return { cookies: job.cookies.length, domains: job.totals.domains };
}

export function validateResultPayload(payload, expectedCookies) {
  const errors = [];
  if (!payload || typeof payload !== "object") return { ok: false, errors: ["result-not-object"] };
  if (!Number.isInteger(payload.applied) || payload.applied < 0) errors.push("applied-invalid");
  if (!Number.isInteger(payload.failed) || payload.failed < 0) errors.push("failed-invalid");
  if (Number.isInteger(payload.applied) && Number.isInteger(payload.failed)) {
    if (payload.applied + payload.failed > expectedCookies) errors.push("result-exceeds-job");
  }
  if (payload.failures != null) {
    if (typeof payload.failures !== "object") errors.push("failures-not-object");
    else {
      for (const [reason, count] of Object.entries(payload.failures)) {
        if (typeof reason !== "string" || !Number.isInteger(count) || count < 0) errors.push("failures-invalid");
      }
    }
  }
  // The target is never allowed to claim a verified login.
  if (payload.loginVerified !== "not_verified") errors.push("login-verification-must-be-user-confirmed");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    result: {
      applied: payload.applied,
      failed: payload.failed,
      failures: payload.failures || {},
      loginVerified: "not_verified",
      reportedAt: new Date().toISOString(),
    },
  };
}
