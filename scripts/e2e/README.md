# Browser CLI native cookie-import E2E

This directory drives the real v2 import loop:

```
source Browser CLI (extensions/import-source, popup consent)
  -> chrome.runtime.connectNative
  -> native-host/host.js (import-only relay)
  -> target Browser CLI named pipe (patch 037)
  -> target-browser approval dialog
  -> target CookieManager
  -> local synthetic test site
  -> target restart persistence
```

It is **Windows-only** and uses a real desktop session because the target
browser's approval dialog and the source extension popup are part of what is
being tested.

## Safety

- Every browser gets a fresh `--user-data-dir` under a `mkdtemp` run root.
  No real Chrome/Edge/Browser CLI profile is opened.
- The test site is a synthetic `127.0.0.1` HTTP server. Its cookies are random
  canaries; the site returns only `LOGIN_OK`/`LOGIN_MISSING`,
  `SESSION_PRESENT`/`SESSION_MISSING` and `VALUE_MATCH`/`VALUE_MISMATCH`.
  Cookie values are never printed.
- The native host is registered only for the duration of the run under
  `HKCU\Software\Chromium\NativeMessagingHosts\com.browserpilot.browseragent`
  (a test-only key for the Chromium-branded build) and the previous value is
  restored in a `finally` block. The Google Chrome and Edge keys are not
  touched.
- The host executable is built into the run root; `native-host/host.manifest.json`
  and `native-host/auth.json` are not modified.
- Logs and the report are scanned for every ticket and cookie canary before the
  run root is removed. Temporary profiles, the host build and logs stay only
  when `--keep` is passed.

## Prerequisites

- Windows x64 with a desktop session.
- Browser CLI build including `chromium/patches/proposed/037-browser-cli-cookie-import.patch`
  (`out/WinDev/chrome.exe` by default).
- Node.js 22+ (`node --version`).
- PowerShell 5.1+ (the harness uses UI Automation and Win32 handle enumeration).
- No other run of this harness at the same time: the native messaging host name
  is per-user global.

## Run

```sh
node scripts/e2e/p1-native-cookie-import-e2e.mjs \
  --chrome D:/c/src/out/WinDev/chrome.exe \
  --root D:/work/.tmp-browsercli/e2e-all \
  --report D:/work/.tmp-browsercli/e2e-all-report.json \
  --keep
```

`--scenarios` accepts a comma-separated subset:

| name | what it proves |
| --- | --- |
| `approve` | source consent -> host -> pipe -> target dialog -> CookieManager write -> site login -> restart persistence |
| `deny` | target user denies; no cookie is written |
| `cancel` | source cancel; a later Allow cannot write |
| `host` | native host killed mid-approval; target cancels, no write |
| `source` | source browser killed/replaced; no replay, no write |
| `duplicate` | same ticket submitted twice: product `target-not-running`, raw replay `ticket-consumed` |
| `cross` | target A's ticket against target B's pipe: `ticket-invalid`; no write |
| `audit` | live pipe DACL, wrong/correct host PID |
| `expired` | target's five-minute ticket timer and stale-descriptor relay rejection |

`all` starts `expired` first so its five-minute wait overlaps the other
scenarios. The process exits `0` for all PASS, `1` for a FAIL, `3` for a
BLOCKED result.

## User gesture path

- **Source**: the extension popup is opened as
  `chrome-extension://<id>/popup.html` in a tab. The harness clicks the
  acknowledgement checkbox, Scan, the domain checkbox, types the ticket, checks
  the send-consent checkbox and clicks Send through the CDP input pipeline.
  The service worker independently requires `acknowledged === true` for scan and
  `consent === true` for send.
- **Target**: the harness reads the ticket from the target's own session dialog
  through UI Automation. The approval dialog is a real top-level widget. The
  approve scenario performs a physical `SendInput` click on the Allow button
  after making the target dialog topmost; deny/cancel/late-allow use
  `UIAutomation.Invoke`. `authorization.simulated` must be `false` and
  `authorization.source` must be `target-browser-dialog`; a test approval
  callback is never installed.

## Build blocker

The committed patch 037, built as `out/WinDev/chrome.dll`, crashes the target
browser on the first `hello` because `RemoveDescriptor()` calls
`base::DeleteFile()` on the UI thread. A second UI-thread DCHECK appears in
`CookieImportPipeServer::Stop()` (`SimpleThread::Join`) once the first is
worked around. The report in the browser-cli repository
(`docs/p1-native-cookie-import-e2e-2026-11-02.md`) records both stacks and the
local, non-committed build hotfix used to exercise the rest of the loop.
