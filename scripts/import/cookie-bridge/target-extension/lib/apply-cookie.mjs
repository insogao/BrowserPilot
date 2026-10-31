// Convert a bridge cookie record into chrome.cookies.set() details, and map
// errors into non-sensitive reason codes.
//
// Limits of the official cookies API that this code cannot work around:
// - The target extension can only set cookies for hosts covered by its host
//   permissions.
// - http:// and https:// URLs are the only supported schemes.
// - Cookies cannot be written while the target profile is not the one the
//   extension runs in. The extension always writes into its own profile.
// - A partitioned cookie must carry partitionKey; an unpartitioned cookie must
//   not. We pass through exactly what the source reported.
// - Session cookies are created by omitting expirationDate.

const SAME_SITE = new Set(["no_restriction", "lax", "strict", "unspecified"]);

export function cookieToSetDetails(cookie) {
  if (!cookie || typeof cookie !== "object") return { ok: false, reason: "invalid-cookie" };
  const host = String(cookie.domain || "").replace(/^\./, "");
  if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) {
    return { ok: false, reason: "invalid-domain" };
  }
  const path = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
  const scheme = cookie.secure ? "https" : "http";
  const url = `${scheme}://${host}${path}`;
  const details = {
    url,
    name: String(cookie.name),
    value: String(cookie.value),
    path,
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (SAME_SITE.has(cookie.sameSite)) details.sameSite = cookie.sameSite;
  if (!cookie.session && typeof cookie.expirationDate === "number") {
    details.expirationDate = cookie.expirationDate;
  }
  if (cookie.partitionKey && cookie.partitionKey.topLevelSite) {
    details.partitionKey = {
      topLevelSite: String(cookie.partitionKey.topLevelSite),
      hasCrossSiteAncestor: !!cookie.partitionKey.hasCrossSiteAncestor,
    };
  }
  return { ok: true, details };
}

export function classifySetError(err) {
  const message = String(err && err.message ? err.message : err);
  if (/partition/i.test(message)) return "partitioned-cookie-rejected";
  if (/permission|host/i.test(message)) return "permission-or-host";
  if (/url|scheme/i.test(message)) return "invalid-url";
  if (/same.?site/i.test(message)) return "samesite-rejected";
  if (/expiration|expiry/i.test(message)) return "expiry-rejected";
  return "other";
}
