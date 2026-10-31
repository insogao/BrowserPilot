# Browser CLI Import — source extension (contract v2)

BrowserPilot-owned minimal source extension for Chrome/Edge. It reads cookies
through the official `chrome.cookies` API and hands a user-selected subset to
Browser CLI through the existing BrowserPilot native messaging host. The host
runs in an import-only relay mode: it opens no loopback TCP listener and
forwards the job to the Browser CLI named pipe.

This extension replaces the earlier two-extension + broker prototype
(`scripts/import/cookie-bridge/`). It never uses an HTTP endpoint.

## Install (unpacked, development)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this directory (`extensions/import-source`).
4. Register the native host with both allowed extension IDs:
   `powershell -NoProfile -ExecutionPolicy Bypass -File native-host/register.ps1`
   (macOS: `node scripts/register-host-mac.mjs`).
5. Pin the extension, then open it on the source browser.

Branded Chrome 156 disables unpacked extensions while Developer mode is off
(`kExtensionDisableUnsupportedDeveloper`). A product release should ship
through the Web Store or enterprise policy.

## User flow

1. The user starts Browser CLI with `--browser-cli-cookie-import`. Browser CLI
   shows a one-time ticket (`BCLI-XXXX-…`, 160-bit, 5-minute TTL, single use).
2. The user opens the extension popup and checks the explicit authorization box.
3. **Scan** reads only cookie metadata (domain, counts, HttpOnly/Session/
   Partitioned flags). No value is displayed.
4. The user selects the domains to migrate. Nothing is selected by default.
5. The user pastes the ticket, re-checks the send consent, and clicks **Send**.
6. The extension connects to `com.browserpilot.browseragent`, which finds the
   Browser CLI session by ticket hash and connects to its named pipe.
7. Browser CLI shows **its own** approval dialog with the source/profile and the
   selected domains. Only the target browser's user can approve; the extension
   and host cannot approve.
8. The popup shows progress and the separate states:
   - data copied (not applicable to cookies; cookies are not written to a file);
   - cookie imported (counts from the target CookieStore);
   - target authorization (the target browser's own user confirmation);
   - actual login verified — always **not verified**; only the user can confirm
     it in the target browser.
9. Session cookies are explicitly marked as not guaranteed across a restart.
10. The user can cancel (stops future writes; already-written cookies remain) or
    retry with a **new** ticket (one ticket authorizes one import).

## Permissions

| Permission | Why |
| --- | --- |
| `cookies` | Read cookies through the official API. |
| `storage` | Keep the last job metadata and selected domains in `chrome.storage.session` only (memory, cleared on browser restart). The ticket is never stored. |
| `nativeMessaging` | Talk to the BrowserPilot import-only native host relay. |
| `<all_urls>` (host) | Required by `chrome.cookies` to read cookies for user-selected domains. |

There is no `tabs`, `history`, `bookmarks`, `downloads`, `webRequest` or
`management` permission, no remote host permission, and no HTTP endpoint.

## Hard guarantees enforced by code

- No fetch destination at all; the only transport is native messaging.
- Scanning requires an explicit checkbox acknowledgement.
- Sending requires a second, per-send consent checkbox, a valid one-time ticket,
  and at least one selected domain.
- After a scan only domain metadata is retained; **Send re-reads only the
  selected domains** (subdomains included) and never keeps unselected values.
- Cookies are filtered by selected domain and converted to the versioned
  contract; invalid records are counted by reason, never echoed.
- No `console` calls and no cookie values/ticket in any message returned to the
  popup or stored in session storage.
- The popup only displays domain metadata and sanitized counts from the target.
- The target's `loginVerified` field is forced to `not_verified`; target
  authorization is shown separately and can never be treated as login.
- The job is chunked (≤256 KiB raw per chunk, ≤64 chunks, ≤16 MiB) and the host
  and target verify the SHA-256 `jobDigest` before parsing.

## Limits

- The source extension cannot verify a login. It never infers login from cookie
  counts or target authorization.
- Device-bound / risk-controlled sessions may not survive the transfer even when
  the cookie writes succeed.
- Partitioned cookies are passed through; the target may reject some of them
  (reported by failure code).
- Session cookies are not guaranteed across a browser restart.
- The Browser CLI native endpoint is a **proposed** Chromium patch in
  `D:\work\wt\bc-rc-p1\chromium\patches\proposed/034-browser-cli-cookie-import.patch`;
  it is not built or integrated. The local HTTP target remains a test double
  (`native:false`, `authorization.simulated:true`).
