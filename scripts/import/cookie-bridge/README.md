# Cookie bridge (legacy prototype)

Status: **legacy prototype, not the product path (2026-10-31).**

This directory contains the two-extension + loopback broker design:

- `source-extension/` reads cookies in the source browser;
- `target-extension/` writes them into the target browser with
  `chrome.cookies.set`;
- `broker.mjs` relays one job in memory on 127.0.0.1;
- `protocol.mjs` validates payloads and forces `loginVerified: not_verified`.

The product flow no longer uses a target extension. It uses:

- `extensions/import-source/` (BrowserPilot-owned source extension), and
- the Browser CLI native CookieStore target contract in
  `docs/browser-cli-native-cookie-import-interface.md`.

`scripts/import/target/local-target.mjs` implements the new contract for tests;
`scripts/import/contract.mjs` is the canonical schema.

The broker/protocol tests (`scripts/test-cookie-bridge.mjs`) still run and the
protocol remains a useful reference, but new work must target the product
contract instead of this bridge.
