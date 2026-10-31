# One-source-extension prototype (superseded)

> **Status: superseded (2026-10-31).** The product source extension is
> `extensions/import-source/`; the loopback contract is
> `scripts/import/contract.mjs`; the local test target is
> `scripts/import/target/local-target.mjs`. The old `prototype/native-target.mjs`
> referenced below does not exist in this branch; use the local target instead.
> This directory is kept only as design history.

This was the minimal "source side only" design:

1. The user installs this extension in the source browser (Chrome/Edge).
2. The user clicks the toolbar button on the site whose login should move.
3. `chrome.cookies.getAll({domain})` returns HttpOnly, SameSite, session and
   partitioned cookies.
4. The extension POSTs them to a one-shot loopback endpoint owned by the target
   Browser CLI native importer (pairing code printed by the importer, loopback
   only, memory only, no disk, no logs).
5. The target writes them with its own CookieStore (native interface), not by
   editing the SQLite file and not via a second extension.

For the productized flow, see:

- `extensions/import-source/README.md`
- `docs/browser-data-import-product-2026-10-31.md`
- `docs/browser-cli-native-cookie-import-interface.md`
