# Browser CLI native cookie-import interface (v2)

Status: **BrowserPilot source extension + native host relay implemented and
tested; the Browser CLI native CookieStore endpoint is PROPOSED, not built and
not integrated.** This document is the handoff contract for the target-side
patch. No product closure is claimed.

Canonical implementation: `scripts/import/contract.mjs` (also copied into
`extensions/import-source/lib/contract.mjs`). Native host relay:
`native-host/import-relay.mjs`. Local HTTP test target:
`scripts/import/target/local-target.mjs` (test double only).

Target-side proposed patch:
`D:\work\wt\bc-rc-p1\chromium\patches\proposed\034-browser-cli-cookie-import.patch`.
Target-side contract doc:
`D:\work\wt\bc-rc-p1\docs\p1-cookie-import-native-v2-2026-11-01.md`.

---

## 1. Scope and hard invariants

The source browser (Chrome/Edge) runs `extensions/import-source`. It reads
cookies only through `chrome.cookies`, only after explicit user consent, and
sends only user-selected domains.

The target is Browser CLI. It writes cookies into **its own** CookieStore, in its
own process, under its own Profile lock.

1. Source Profile is never written, deleted, renamed, locked or closed.
2. No source cookie decryption, key extraction, `Local State` use, elevation
   service or path spoofing.
3. The target never writes `Network/Cookies` SQLite. It uses
   `CookieManager::SetCanonicalCookie` (the browser-process mojo front end of
   `net::CookieStore::SetCanonicalCookieAsync` in the network service).
4. Values exist only in source extension memory, native messaging frames, the
   host/pipe buffers, target memory and the target CookieStore. They are never
   logged, uploaded, or written to reports/long-lived files.
5. `cookieImported` and `loginVerified` are independent. The target may report
   the former; only an explicit user action records the latter.
6. One active job at a time; one one-time ticket; no reuse.

---

## 2. Transport: native messaging + named pipe (no product HTTP)

```
source extension
  chrome.runtime.connectNative("com.browserpilot.browseragent")
    -> BrowserPilot native host, import-only relay mode
       (no TCP listener, no auth.json/session file, no generic commands)
    -> Windows named pipe \\\\.\\pipe\\browser-cli-import-<128-bit>
       (DACL owner+SYSTEM, PIPE_REJECT_REMOTE_CLIENTS, first instance)
    -> Browser CLI CookieImportService
       (target-browser approval dialog + CookieManager writes)
```

- The **product path has no localhost HTTP API**. The source extension has no
  HTTP destination at all.
- `scripts/import/target/local-target.mjs` is a test double. It reports
  `native:false`, `transport:"http-test"`, `authorization.simulated:true`, and
  must never be described as the product target.
- The native host is selected by the first message:
  - import extension sends `hello` with `mode:"cookie-import"`; the host enters
    import-only relay mode and does not start the normal loopback command
    listener;
  - the normal BrowserPilot extension sends `get_ready_state`; the host starts
    the existing normal mode (unchanged).

### Frame limits

- Native messaging: 4-byte LE length + UTF-8 JSON.
- Job payload: ≤16 MiB, ≤64 chunks, ≤256 KiB decoded per chunk, ≤512 KiB per
  pipe frame.
- `jobDigest = SHA-256(exact UTF-8 payload bytes)`. The host and target verify it
  before parsing.

---

## 3. One-time ticket and binding

| Property | Value |
| --- | --- |
| Entropy | 160 bits (20 random bytes) |
| Encoding | Crockford base32, 32 chars; display `BCLI-XXXX-…` |
| TTL | 5 minutes |
| Use | first `hello` consumes it; second `hello` → `ticket-consumed` |
| Failure limit | 5 failures / 60 s → 60 s `rate-limited` |
| Session limit | 10 hello attempts / hour |
| Storage | target memory; session descriptor contains only `ticketHash` |
| Hash | `SHA-256("browser-cli-ticket-v2:" + normalized ticket)` |

Bindings:

- **Target process**: target writes PID/start time and pipe name; the target
  compares the pipe client PID (`GetNamedPipeClientProcessId`) with the relay's
  `hostPid` (`host-identity-mismatch` on mismatch).
- **Target Profile**: session descriptor contains a per-process-salted
  `profileHash`; the target only runs in that Profile.
- **Import job**: the ticket's first submit binds `jobNonce`, `jobDigest` and the
  user-selected domain digest; a second job with the same ticket is rejected.
- **User-confirmed domain scope**: `consent.domainsDigest =
  SHA-256("browser-cli-domains-v2:" + sorted normalized selected domains joined
  by "\n")`; the target's own approval dialog covers the same list; the target
  writes only cookies matching it.

A 6-digit code or the extension Origin alone is never sufficient. The native
messaging manifest `allowed_origins` (main BrowserPilot ID + import-source ID)
is an additional control enforced by Chrome, not the authorization.

---

## 4. Independent authorization inside the target browser

After a complete, digest-verified job:

1. target state = `awaiting_authorization`; it returns `accepted` + a count-only
   status to the extension;
2. target shows `CookieImportApprovalDialog` in the target browser process:
   source browser/profile label, cookie count, session-cookie warning, and the
   selected domain list;
3. only **Allow** sets `authorization.targetUserConfirmed=true` and starts
   writes; **Deny**/close sets `state:"denied"`, `error:"authorization-denied"`,
   and writes nothing;
4. there is no pipe/HTTP/CLI approval message. The source extension, host and
   CLI cannot approve.
5. `authorization.simulated` is `false` for the product target. Test doubles set
   it to `true`; the popup/CLI warn.

Target authorization is **not** login verification.

---

## 5. Cookie rules enforced by the target

1. HostOnly/Domain:
   - `hostOnly=true`: domain has no leading dot; URL host = domain; pass empty
     domain to `CreateSanitizedCookie` → host-only cookie.
   - `hostOnly=false`: domain starts with "."; pass the dotted domain → Domain
     cookie.
   - mismatch → `invalid-domain`.
2. Public Suffix List: Domain cookie whose registrable domain is empty (`com`,
   `co.uk`, `github.io`, …) → `public-suffix-rejected`. Host-only cookies are not
   rejected solely for being on a public suffix host.
3. Prefixes (longest first): `__Host-Http-` (Secure+HttpOnly+Path=/+host-only),
   `__Host-` (Secure+Path=/+host-only), `__Secure-` (Secure), `__Http-`
   (Secure+HttpOnly); violation → `cookie-prefix-rejected`.
4. SameSite/Secure: `no_restriction` requires Secure → else `samesite-rejected`;
   `lax`/`strict`/`unspecified` map directly.
5. Partitioned: `topLevelSite` must be `http(s)://host` schemeful site with no
   port/path/query/credentials; bool ancestor bit; must be Secure;
   `CookiePartitionKey::FromStorage` failure → `partitioned-cookie-rejected`.
6. Expiry: persistent cookies need a finite future `expirationDate`; session
   cookies must not have one → `expiry-rejected`.
7. Name/value/path size and control characters → `invalid-cookie`.
8. Cookie domain must equal or be a subdomain of a selected domain.

Failures are counted per cookie with fixed codes only; no raw exception text,
cookie name, value or domain is returned.

---

## 6. Three-state result (authoritative)

| State | Source of truth | Never inferred from |
| --- | --- | --- |
| `dataCopied` | bundle/apply of bookmarks/history | cookie counts |
| `cookieImported` | target CookieManager callbacks applied/failed | page login |
| `loginVerified` | user action with `--confirm-user-action` | cookie counts, target authorization, target result |

Public job view includes:

- `authorization` (target user confirmation + `simulated` + `scopeDigest`);
- `sessionCookies: {count, mayNotSurviveRestart: true}`;
- `loginVerified.status` always `not_verified`;
- no cookie values/names/domains.

---

## 7. Wire protocol

### 7.1 Extension ↔ native host

- `hello` `{type,protocol:2,mode:"cookie-import",extensionVersion}` → `hello-ok`
- `begin` `{ticket,jobNonce,jobDigest,totalBytes,chunkCount}` → `ready`
- `chunk` `{jobNonce,index,data:<base64>}` (no response)
- `commit` `{jobNonce}` → `accepted`
- host → extension: `status` (sanitized public view), `cancel-ok`, `error`
- `cancel` `{jobNonce}`, `close`

### 7.2 Host ↔ Browser CLI named pipe

Same frames, plus:

- relay `hello` includes `hostPid`; target → `ready` includes `sessionId`,
  `targetPid`, `targetProduct`, `targetVersion`, `native`, `capabilities`;
- relay `job-begin` / `job-chunk` / `job-commit`;
- target → `accepted`, `status`, `error`, `cancel-ok`.

### 7.3 Session descriptor

Path (default): `%LOCALAPPDATA%\BrowserCLI\import\sessions\session-<id>.json`
(or `BROWSER_CLI_IMPORT_SESSION_DIR` for tests).

```json
{
  "schema": "browser-cli.cookie-import.session/v2",
  "protocolVersion": 2,
  "targetProduct": "Browser CLI",
  "targetVersion": "156.0.8067.0",
  "targetPid": 1234,
  "targetStartTimeMs": 1790000000000,
  "targetInstanceId": "32 hex",
  "profileHash": "64 hex",
  "ticketHash": "64 hex",
  "transport": "named-pipe",
  "pipeName": "\\\\.\\pipe\\browser-cli-import-<32 hex>",
  "createdAt": "ISO8601",
  "expiresAt": "ISO8601"
}
```

No plaintext ticket, cookie value or domain. Short TTL; deleted on consume,
terminal state or exit.

---

## 8. Proposed target implementation (not built)

The target-side patch adds:

- `chrome/browser/browser_cli/cookie_import/cookie_import_policy.{h,cc}`:
  ticket/digest/field policy, PSL/prefix/partition, `CreateSanitizedCookie`.
- `.../cookie_import_service.{h,cc}`: singleton, ticket/TTL/failure limits, job
  state machine, target dialog callback, sequential CookieManager writes,
  flush, public view.
- `.../cookie_import_pipe_server_win.{h,cc}`: Win32 named pipe, DACL, first
  instance, remote-client rejection, client PID.
- `.../cookie_import_dialog.{h,cc}`: ticket window + target approval dialog.
- `.../cookie_import_policy_unittest.cc`: unit tests.
- `chrome_browser_main.cc`: start only with
  `--browser-cli-cookie-import` for the initial profile; stop on shutdown.
- `chrome/browser/BUILD.gn`: Windows dependency.

Status: **proposed, not in `chromium/patch-manifest.json`, not compiled, not
integrated.** A read-only `git apply --check` against the post-033 checkout
passes; this is not build/runtime evidence.

---

## 9. Failure codes

Cookie failures: `invalid-cookie`, `invalid-domain`, `invalid-url`,
`public-suffix-rejected`, `cookie-prefix-rejected`,
`partitioned-cookie-rejected`, `samesite-rejected`, `expiry-rejected`,
`permission-or-host`, `cookie-store-unavailable`, `target-busy`,
`profile-locked`, `authorization-denied`, `cancelled`, `timeout`, `internal`.

Session/transport errors: `protocol-mismatch`, `ticket-invalid`,
`ticket-expired`, `ticket-consumed`, `rate-limited`, `target-not-running`,
`target-disconnected`, `target-busy`, `host-identity-mismatch`,
`profile-mismatch`, `job-binding-mismatch`, `job-digest-mismatch`,
`chunk-missing`, `too-many-cookies`, `too-large`, `import-mode-conflict`.

Unknown details collapse to a code; never return raw exception text.

---

## 10. Tests

BrowserPilot side:

- `node scripts/import/sync-extension-contract.mjs --check`
- `node scripts/test-import-product.mjs` — 42 v2 contract/target/CLI/report tests
- `node scripts/test-native-import.mjs` — 11 native host relay/extension
  transport/pipe-target tests
- `node scripts/test-browser-data-import.mjs` — 15 file-import tests
- `node native-host/test-host.mjs` — normal host mode regression

All use synthetic profiles/cookies, no browser launch, no real tokens.

Browser CLI side (test-only, no browser):

- `node tests/tools/cookie-import/test_reference_target.mjs`
- `python tests/tools/test_cookie_import_native.py`

These prove the protocol/security semantics and the proposed patch's static
contents; they do **not** prove the Chromium patch compiles or writes cookies.

---

## 11. Remaining work

1. Build 034 on Windows, fix compile/unit tests, add to manifest/CI.
2. Isolated Windows test machine + disposable Profile + synthetic cookies:
   source extension → native host → target pipe → target CookieManager;
   approve/deny; attribute mapping; restart persistence; source profile
   byte-identical.
3. Register/verify the native host for both extension IDs; Web Store/enterprise
   distribution; Chrome 156 unpacked-extension limitation.
4. Runtime tests for cancel/disconnect/long approval/rate limit; target dialog
   behavior; pipe ACL.
5. Real login verification remains a user-only action; never inferred.
