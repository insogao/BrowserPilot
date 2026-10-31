# Browser CLI Import — source extension

BrowserPilot-owned minimal source extension for Chrome/Edge. It reads cookies
through the official `chrome.cookies` API and hands a user-selected subset to a
local Browser CLI native cookie-import endpoint on `127.0.0.1`.

This extension replaces the earlier two-extension + broker prototype
(`scripts/import/cookie-bridge/`). The target no longer needs an extension: the
Browser CLI writes cookies through its own CookieStore. Until that native
endpoint exists, use the local contract target
(`scripts/import/target/local-target.mjs`) for development and tests.

## Install (unpacked, development)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this directory (`extensions/import-source`).
4. Pin the extension, then open it on the source browser.

Branded Chrome 156 disables unpacked extensions while Developer mode is off
(`kExtensionDisableUnsupportedDeveloper`). Enabling Developer mode and loading
unpacked is acceptable for testing; a product release should ship through the
Web Store or enterprise policy.

## User flow

1. The user starts the Browser CLI import flow (or the local test target). The
   CLI prints `http://127.0.0.1:<port>` and a 6-digit pairing code.
2. The user opens the extension popup and checks the explicit authorization box.
3. **Scan** reads only cookie metadata (domain, counts, HttpOnly/Session/
   Partitioned flags). No value is displayed.
4. The user selects the domains to migrate. Nothing is selected by default.
5. The user enters the address + pairing code, re-checks the send consent, and
   clicks **Send**.
6. The popup polls the local job and shows progress, failure reasons, and the
   three separate states:
   - data copied (not applicable to cookies; cookies are not written to a file);
   - cookie imported (counts from the target CookieStore);
   - actual login verified — always **not verified**; only the user can confirm
     it in the target browser.
7. The user can cancel (stops future writes; already-written cookies remain) or
   retry (re-scan and send a fresh job).

## Permissions

| Permission | Why |
| --- | --- |
| `cookies` | Read cookies through the official API. |
| `storage` | Keep the loopback address, pairing code and last job id in `chrome.storage.session` only (memory, cleared on browser restart). |
| `<all_urls>` (host) | Required by `chrome.cookies` to read cookies for user-selected domains. |
| `http://127.0.0.1/*` | POST to the local Browser CLI endpoint. No remote host is allowed. |

There is no `tabs`, `history`, `bookmarks`, `downloads`, `nativeMessaging` or
remote-host permission. `storage.local` is never used.

## Hard guarantees enforced by code

- No fetch destination other than literal `http://127.0.0.1:<port>`.
- Scanning requires an explicit checkbox acknowledgement.
- Sending requires a second, per-send consent checkbox and at least one selected
  domain.
- After a scan only domain metadata is retained; **Send re-reads only the
  selected domains** (subdomains included) and never keeps unselected values.
- Cookies are filtered by selected domain and converted to the versioned
  contract; invalid records are counted by reason, never echoed.
- No `console` calls and no cookie values in any message returned to the popup.
- The popup only displays domain metadata and sanitized counts from the target.
- The target's `loginVerified` field is forced to `not_verified` on display.

## Limits

- The source extension cannot verify a login. It never infers login from cookie
  counts.
- Device-bound / risk-controlled sessions may not survive the transfer even when
  the cookie writes succeed.
- Partitioned cookies are passed through; the target may reject some of them
  (reported by failure code).
- The native Browser CLI endpoint is not implemented in this repository. See
  `docs/browser-cli-native-cookie-import-interface.md` for the exact contract
  and the minimal in-browser patch proposal.
