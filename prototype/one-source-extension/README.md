# One-source-extension prototype

This is the minimal "source side only" design:

1. The user installs this extension in the source browser (Chrome/Edge).
2. The user clicks the toolbar button on the site whose login should move.
3. `chrome.cookies.getAll({domain})` returns HttpOnly, SameSite, session and
   partitioned cookies.
4. The extension POSTs them to a one-shot loopback endpoint owned by the target
   Browser CLI native importer (pairing code printed by the importer, loopback
   only, memory only, no disk, no logs).
5. The target writes them with its own CookieStore (native interface), not by
   editing the SQLite file and not via a second extension.

Prototype status: extension files and the loopback contract are provided. The
target side in this prototype is `prototype/native-target.mjs`, which uses CDP
`Storage.setCookies` against a Chromium test profile as a stand-in for the
not-yet-implemented Browser CLI native command.
