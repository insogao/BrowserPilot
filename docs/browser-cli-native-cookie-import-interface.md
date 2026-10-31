# Browser CLI native cookie-import interface (v1)

Status: **contract implemented and tested on the BrowserPilot side; the Browser
CLI native endpoint is NOT implemented.** This document is the handoff
specification for the minimal in-browser patch. No Chromium source was modified
in this worktree.

Canonical implementation of the contract:
`scripts/import/contract.mjs` (also copied into
`extensions/import-source/lib/contract.mjs`). Local test target:
`scripts/import/target/local-target.mjs`.

---

## 1. Scope and invariants

The source browser (Chrome/Edge) runs the BrowserPilot-owned extension
`extensions/import-source`. It reads cookies through the official
`chrome.cookies` API after explicit per-send user consent, and sends only
user-selected domains to a loopback endpoint.

The target is Browser CLI. It writes cookies into **its own** CookieStore, in
its own process, under its own Profile lock.

Hard invariants:

1. Source Profile is never written, deleted, renamed, locked or closed by the
   import flow.
2. No source cookie decryption, no key extraction, no `Local State` key use, no
   elevation service, no path spoofing.
3. The target never writes the Cookies SQLite file directly; it uses the
   browser's CookieStore (which owns schema, encryption and locking).
4. Values exist only in source extension memory, the loopback request, target
   memory and the target CookieStore. They are never logged, uploaded, or
   written to a report.
5. `cookieImported` and `loginVerified` are independent. The target can report
   the former; only an explicit user action can record the latter.
6. One active import job at a time; one session pairing code; loopback only.

---

## 2. Transport

- HTTP/1.1 JSON over `http://127.0.0.1:<port>` only. No TLS, no DNS names, no
  LAN address, no path prefixes.
- Port: chosen by Browser CLI at startup (ephemeral recommended) and printed to
  the terminal. The CLI flow prints the exact endpoint and a per-session
  6-digit pairing code.
- Pairing: every `/v1/import/*` request except `capabilities` must carry
  `x-bp-pair: <6 digits>`. Compare in constant time. Do not persist the code.
- Origin: the source extension sends
  `Origin: chrome-extension://ljoekiddijnohefaghljlcodgljienoj` (the manifest
  key is fixed in `extensions/import-source/manifest.json`). The target must
  allowlist this ID and reject any other `Origin` with 403. Missing `Origin`
  is allowed only for local CLI/test clients.
- `POST` requires `Content-Type: application/json`; otherwise 415.
- Body limit: 16 MiB. Cookie count limit: 20,000. Value limit: 8 KiB per value.
- Job TTL: 10 minutes, then `job-not-found`. One active job; a second different
  request gets 409 `target-busy`.
- No cookie name/value/domain may appear in logs, errors or any response.

CORS preflight is required because the extension sends JSON with a custom
header. Answer `OPTIONS` with the allowlisted origin and
`Access-Control-Allow-Headers: content-type, x-bp-pair`.

---

## 3. Endpoints

### 3.1 `GET /v1/import/capabilities`

No pairing. Returns metadata only:

```json
{
  "contract": "browser-cli.cookie-import/v1",
  "protocolVersion": 1,
  "product": "Browser CLI",
  "mode": "native",
  "native": true,
  "pairingRequired": true,
  "capabilities": {
    "cookieStoreWrite": true,
    "persistAcrossRestart": true,
    "partitionedCookies": true,
    "sessionCookies": true,
    "maxCookiesPerJob": 20000,
    "maxValueBytes": 8192
  }
}
```

The product target must report `native: true` and
`persistAcrossRestart: true`. The local test target reports `native: false`
and (for its memory backend) `persistAcrossRestart: false` — the CLI prints a
warning rather than claiming the product loop.

### 3.2 `POST /v1/import/cookies`

Headers: `x-bp-pair`, `Origin`, `Content-Type: application/json`.

```json
{
  "contract": "browser-cli.cookie-import/v1",
  "requestId": "8f2c... (8-128 chars, [A-Za-z0-9._:-])",
  "source": {
    "browser": "chrome",
    "profileLabel": "Work",
    "extensionVersion": "0.2.0"
  },
  "consent": {
    "kind": "explicit-user-action",
    "at": "2026-10-31T12:00:00.000Z",
    "extensionVersion": "0.2.0"
  },
  "domains": ["example.com", "app.example.com"],
  "cookies": [
    {
      "domain": ".example.com",
      "hostOnly": false,
      "path": "/",
      "name": "sid",
      "value": "<redacted in docs>",
      "secure": true,
      "httpOnly": true,
      "sameSite": "lax",
      "session": false,
      "expirationDate": 2000000000,
      "partitionKey": {
        "topLevelSite": "https://top.example",
        "hasCrossSiteAncestor": true
      }
    }
  ]
}
```

Validation rules:

- `contract` exactly `browser-cli.cookie-import/v1`.
- `requestId` required; retries use a new id. A repeated `requestId` returns the
  existing job with `duplicate: true` (idempotent).
- `consent.kind` must be `explicit-user-action`; `consent.at` must be a parseable
  timestamp; `consent.extensionVersion` required. A request without consent is
  rejected with 400.
- `domains` is the user's explicit selection (1..1000, normalized, unique).
- Every cookie's domain must equal a selected domain or be a subdomain of one
  (`cookieDomain === selected || cookieDomain.endsWith("." + selected)`).
- Cookie fields: domain, name, value, path, hostOnly, secure, httpOnly, session,
  sameSite (`no_restriction|lax|strict|unspecified`), `expirationDate` for
  non-session cookies, optional `partitionKey`.
- Invalid records cause the whole request to be rejected with 400 and a list of
  field paths/reason codes. Never echo a value.

Response `202 Accepted`:

```json
{
  "ok": true,
  "contract": "browser-cli.cookie-import/v1",
  "jobId": "24 lowercase hex chars",
  "state": "pending",
  "totals": { "cookies": 9, "domains": 2, "selectedDomains": 2 }
}
```

The target applies asynchronously and updates the job. `202` means accepted,
not written.

### 3.3 `GET /v1/import/jobs/<jobId>`

Pairing required. Returns the public job view:

```json
{
  "contract": "browser-cli.cookie-import/v1",
  "jobId": "...",
  "state": "applying",
  "totals": { "cookies": 9, "domains": 2, "selectedDomains": 2 },
  "progress": { "applied": 5, "failed": 1, "remaining": 3 },
  "dataCopied": { "cookies": false },
  "cookieImported": {
    "status": "not_started|imported|partially_imported|failed",
    "applied": 5,
    "failed": 1,
    "failures": { "partitioned-cookie-rejected": 1 }
  },
  "loginVerified": {
    "status": "not_verified",
    "note": "Cookie 写入不等于网站登录成功；必须在目标浏览器中由用户本人确认。"
  },
  "error": { "code": "target-busy", "message": "..." },
  "createdAt": "...",
  "updatedAt": "..."
}
```

Rules:

- `state` ∈ `pending|applying|done|failed|cancelled`.
- `failure` keys must be from the failure-code set (see §6). No other detail.
- `dataCopied.cookies` is always `false`: cookies are not a file-copy artifact.
- `loginVerified.status` is always `not_verified`. There is no endpoint that
  accepts a login verification from the source/target; the user confirms via
  `browser-data-import.mjs confirm-login --confirm-user-action`.
- A partial result keeps `state: "done"` with
  `cookieImported.status: "partially_imported"`. If zero writes succeeded,
  `state: "failed"` and `cookieImported.status: "failed"`.

### 3.4 `GET /v1/import/status`

Pairing required. Returns the current/last job view, or:

```json
{ "ok": true, "contract": "browser-cli.cookie-import/v1", "state": "idle", "jobId": null }
```

Used by the CLI to wait for the extension to submit. It never contains values.

### 3.5 `POST /v1/import/jobs/<jobId>/cancel`

Pairing required. Sets a cancel flag; the writer stops before the next cookie.
Already-written cookies are **not** rolled back (CookieStore has no transaction
across cookies). Returns `202 {ok:true,state:"applying"|"cancelled",cancelRequested:true}`
or `{ok:true,state:"done",alreadyTerminal:true}`. The public job view ends in
`state: "cancelled"` and `cookieImported.status` reflects what was written
(partial or not started).

Retry is a new `POST /v1/import/cookies` with a new `requestId` from the source
extension. Setting an identical cookie again is idempotent at the CookieStore
level. The target must accept a new job after the previous one is terminal.

---

## 4. Three-state result (authoritative)

| State | Source of truth | Never inferred from |
| --- | --- | --- |
| `dataCopied` | bundle/apply of bookmarks/history (separate flow) | cookie counts |
| `cookieImported` | target CookieStore callbacks (`applied`/`failed`) | page login |
| `loginVerified` | user action with `--confirm-user-action` | cookie counts, target result |

The local report written by the CLI
(`cookie-import-<timestamp>-<job>.json`) stores counts/codes only. Domains
appear only after the user explicitly confirms a login check.

---

## 5. Native implementation plan (minimal Chromium patch)

This is a proposal; nothing below was applied to shared Chromium source.

### 5.1 Option A (preferred): in-process Browser CLI import service

Files (new):

- `chrome/browser/browser_cli/cookie_import_service.h`
- `chrome/browser/browser_cli/cookie_import_service.cc`
- `chrome/browser/browser_cli/cookie_import_service_unittest.cc`
- `chrome/browser/browser_cli/BUILD.gn`

Files (modified):

- `chrome/browser/BUILD.gn` — depend on the new target.
- `chrome/browser/chrome_browser_main.cc` — start the service after the Profile
  and its CookieStore exist; stop it during shutdown.
- `chrome/common/chrome_switches.h/.cc` — add
  `--browser-cli-cookie-import` (off by default) and optional
  `--browser-cli-cookie-import-port=<port>`.

Behavior:

1. Only start when the switch is present. Bind `127.0.0.1` (never `0.0.0.0`).
2. Generate a 6-digit pairing code; print it once to the terminal (user is
   present). Do not persist it.
3. Validate the request against this contract (size, JSON depth, fields,
   domain selection, consent).
4. For each cookie, build a `net::CanonicalCookie` and call
   `CookieStore::SetCanonicalCookieAsync` on the Profile's CookieStore. Use the
   callback result, not a SQLite write, for `applied`/`failed`.
   - Host-only: pass `url` and no `domain`.
   - Domain cookie: pass `domain` (leading dot preserved).
   - Session cookie: no expiration.
   - Partitioned: build `net::CookiePartitionKey` from `topLevelSite` /
     `hasCrossSiteAncestor`; reject malformed keys.
5. Count successes/failures; map failures to the fixed code set. Log counts
   only, never names/values/domains.
6. The target CookieStore encrypts and persists values with the target's own
   OSCrypt keys. No source key or source profile is touched. Restart
   persistence follows from the CookieStore; ensure a flush on shutdown.
7. One active job, 10-minute TTL, cancel flag checked between cookies.
8. Stop the server and flush the CookieStore on shutdown.

Sketch:

```cc
auto cookie = net::CanonicalCookie::CreateSanitizedCookie(
    url, name, value, domain, path, creation_time, expiration_time,
    last_access_time, secure, http_only, same_site, priority, partition_key,
    &status);
if (!cookie) {
  // count a failure by a fixed code; never log the value
  return;
}
cookie_store->SetCanonicalCookieAsync(
    std::move(cookie), url, options,
    base::BindOnce([](net::CookieAccessResult result) {
      // applied++ or failed++ by result.status
    }));
```

Notes:

- Do not write `Network/Cookies` / `Cookies` SQLite directly.
- Do not use `OSCrypt`/DPAPI on the source profile.
- Do not call the elevation service or relax App-Bound Encryption.
- Do not start the endpoint unless the user launched Browser CLI with the
  explicit switch.
- Keep the service out of the extension API surface unless a future target UI
  needs it; the loopback contract is sufficient.

Estimated size: ~400-600 LOC service, ~200 LOC tests, switch/BUILD changes.
No third-party dependency.

### 5.2 Option B (test/stopgap only): local CDP helper

`scripts/import/target/cdp-backend.mjs` implements `Storage.setCookies` against
an already-running local Chromium. It is useful for isolated end-to-end tests,
but it is **not** the product target:

- requires the target to be started with a DevTools endpoint;
- Chrome 156 may require per-connection user approval for remote debugging;
- exposes a debugging surface that a product should not depend on;
- still does not launch a browser or use `--no-sandbox`.

Use it only with a disposable test profile and `--allow-test-cdp`. It reports
`native: false` and the CLI warns.

### 5.3 Rejected approaches

- Decrypting v10/v20 source cookies (DPAPI, App-Bound, elevation service).
- Copying source `Local State`/Cookies into the target.
- Writing the target Cookies SQLite file from an external process.
- Repointing Windows Known Folders or the default user-data directory.
- Killing/closing the source browser automatically.

---

## 6. Failure codes

| Code | Meaning |
| --- | --- |
| `invalid-cookie` | A record failed validation. |
| `invalid-domain` | Domain syntax/selection failure. |
| `invalid-url` | Could not build a valid URL for the CookieStore. |
| `partitioned-cookie-rejected` | Target rejected the partition key. |
| `samesite-rejected` | Target rejected SameSite. |
| `expiry-rejected` | Target rejected the expiration. |
| `permission-or-host` | Target refused the host. |
| `cookie-store-unavailable` | Profile/CookieStore not ready or locked. |
| `target-busy` | Another job is active. |
| `profile-locked` | Target profile is in use. |
| `cancelled` | The user cancelled; no rollback. |
| `timeout` | No job arrived in time (CLI-side). |
| `internal` | Any other target failure. |

Unknown details must be collapsed to a code; never return raw exception text
that could contain a value.

---

## 7. Native acceptance tests

1. Start Browser CLI with the import switch and a **disposable** target profile.
2. Submit a synthetic request containing one session cookie, one persistent
   host-only cookie, one partition-key cookie, and one deliberately invalid
   cookie.
3. Assert `applied=2/3`, the invalid one fails with a code, and
   `loginVerified=not_verified`.
4. Read the target CookieStore; assert values/metadata match. Restart Browser
   CLI with the same profile; assert the cookies still exist.
5. Assert the source profile tree is byte-identical before/after.
6. Assert no log line or report contains a cookie value, name or domain.
7. Cancel during a multi-cookie job; assert no further writes and an honest
   `partially_imported`/`not_started` status.
8. Test pairing/origin/body-limit/`target-busy`/idempotent-requestId behavior.

The Node contract tests in `scripts/test-import-product.mjs` cover the same
semantics at the HTTP/contract level and can be reused as the reference.
