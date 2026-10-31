// Export a source profile into a local staging bundle.
//
// The bundle never contains cookie values, password values, session tokens,
// form-field values unless the user explicitly requested autofill export.
// Cookies/passwords are represented by counts and blocker status only.
import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonFile, writeJsonlFile, fileExists, dirExists } from "./fs-safe.mjs";
import { withReadOnlyCopy, tableExists, queryAll } from "./sqlite.mjs";
import { readBookmarkTree } from "./bookmarks.mjs";

export const BUNDLE_FORMAT = 1;
export const TOOL_VERSION = "0.1.0-mvp";

export function createBundle({ profile, inventory, items, outDir, options = {} }) {
  if (dirExists(outDir)) {
    const entries = fs.readdirSync(outDir);
    if (entries.length > 0 && !options.overwrite) {
      return { ok: false, error: "bundle-directory-not-empty", detail: outDir };
    }
    if (options.overwrite) {
      for (const name of ["manifest.json", "bookmarks.json", "history.jsonl", "autofill.jsonl", "blocked.json", "result.json"]) {
        const p = path.join(outDir, name);
        try {
          if (fs.statSync(p).isFile()) fs.unlinkSync(p);
        } catch {}
      }
    }
  }
  ensureDir(outDir);

  const requested = new Set(items);
  const manifest = {
    format: BUNDLE_FORMAT,
    tool: "browser-data-import",
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    source: inventory.profile,
    requestedItems: [...requested],
    items: {},
    notes: [],
    warnings: [],
  };
  const blocked = {};
  if (profile.running && profile.running.running) {
    manifest.warnings.push(
      `source profile looks in use (${profile.running.evidence}); exports are read-only snapshots and may be ` +
        `slightly stale. Retry after closing the source browser for a fully consistent copy.`,
    );
  }

  let bookmarksTree = null;
  if (requested.has("bookmarks")) {
    const tree = readBookmarkTree(profile);
    if (!tree.ok) {
      manifest.items.bookmarks = { status: "failed", error: tree.error };
    } else {
      bookmarksTree = tree;
      const out = path.join(outDir, "bookmarks.json");
      writeJsonFile(out, {
        format: 1,
        source: { browserId: profile.browserId, dirName: profile.dirName, label: profile.label },
        exportedAt: manifest.createdAt,
        stats: tree.stats,
        roots: tree.roots,
      });
      manifest.items.bookmarks = {
        status: "ok",
        file: "bookmarks.json",
        counts: tree.stats,
      };
    }
  }

  if (requested.has("history")) {
    const rows = exportHistory(profile, options.maxHistoryRows ?? 20000);
    if (!rows.ok) {
      manifest.items.history = { status: "failed", error: rows.error };
    } else {
      writeJsonlFile(path.join(outDir, "history.jsonl"), rows.rows);
      manifest.items.history = { status: "exported", file: "history.jsonl", counts: { rows: rows.rows.length } };
    }
  }

  if (requested.has("autofill")) {
    const rows = exportAutofill(profile, options.maxAutofillRows ?? 5000);
    if (!rows.ok) {
      manifest.items.autofill = { status: "failed", error: rows.error };
    } else {
      writeJsonlFile(path.join(outDir, "autofill.jsonl"), rows.rows);
      manifest.items.autofill = { status: "exported", file: "autofill.jsonl", counts: { rows: rows.rows.length } };
    }
  }

  if (requested.has("cookies")) {
    blocked.cookies = blockerForCookies(inventory, profile);
    manifest.items.cookies = { status: "blocked", reason: blocked.cookies.reason };
  }
  if (requested.has("passwords")) {
    blocked.passwords = blockerForPasswords(inventory, profile);
    manifest.items.passwords = { status: "official-flow-required", reason: blocked.passwords.reason };
  }
  if (requested.has("tabs")) {
    blocked.tabs = {
      status: "blocked",
      reason:
        "Open tabs are held in internal session files (SNSS / sessionstore.jsonlz4). No supported external " +
        "import path exists; use a user-authorized source extension (chrome.tabs.query) or reopen tabs manually.",
    };
    manifest.items.tabs = { status: "blocked", reason: blocked.tabs.reason };
  }
  if (requested.has("extensions")) {
    blocked.extensions = {
      status: "report-only",
      reason:
        "Extensions are not copied. Copying extension directories/Preferences across browsers or profiles is " +
        "unsupported and bypasses install verification; reinstall from the official store instead.",
      inventory: inventory.items.extensions,
    };
    manifest.items.extensions = { status: "report-only", count: inventory.items.extensions?.count ?? null };
  }
  if (requested.has("preferences")) {
    blocked.preferences = {
      status: "report-only",
      reason: "Only a small read-only summary is inspected; preferences are not copied into the target profile.",
      summary: inventory.items.preferences?.summary ?? null,
    };
    manifest.items.preferences = { status: "report-only" };
  }

  // In-code assertion: the bundle must never contain secret-bearing files.
  for (const name of ["Cookies", "Login Data", "Local State", "key4.db", "logins.json"]) {
    if (fileExists(path.join(outDir, name))) {
      return { ok: false, error: "bundle-contains-forbidden-file", detail: name };
    }
  }

  writeJsonFile(path.join(outDir, "blocked.json"), blocked);
  writeJsonFile(path.join(outDir, "result.json"), {
    format: 1,
    createdAt: manifest.createdAt,
    dataCopied: Object.fromEntries(
      Object.entries(manifest.items).map(([k, v]) => [k, v.status === "ok" || v.status === "exported"]),
    ),
    cookieImported: { status: "blocked", reason: blocked.cookies?.reason || "not-requested" },
    loginVerified: { status: "not_verified", note: "Requires the user to open a site in the target browser and confirm." },
  });
  writeJsonFile(path.join(outDir, "manifest.json"), manifest);

  return {
    ok: true,
    outDir,
    manifest,
    counts: {
      bookmarks: bookmarksTree ? bookmarksTree.stats : null,
    },
  };
}

export function blockerForCookies(inventory, profile) {
  const c = inventory.items.cookies || {};
  if (!c.available) {
    return { status: "blocked", reason: "Source profile has no Cookies database.", encryption: null };
  }
  if (profile.family === "firefox") {
    return {
      status: "blocked",
      reason:
        "Firefox cookies.sqlite stores values unencrypted, but writing them into the target requires a target " +
        "browser cookie writer (official cookies API or a Chromium patch). This tool does not write cookie stores.",
      encryption: { note: "Firefox cookies are not App-Bound/DPAPI encrypted." },
      counts: c.count || null,
    };
  }
  return {
    status: "blocked",
    reason:
      "Chromium cookie values are encrypted (v10 DPAPI or v20 App-Bound). Browser CLI must not decrypt the " +
      "source browser's keys or bypass App-Bound Encryption; direct cookie-store copying is forbidden. " +
      "Use the user-authorized source-extension bridge (official chrome.cookies API) instead.",
    encryption: c.encryption || null,
    counts: c.count || null,
  };
}

export function blockerForPasswords(inventory, profile) {
  const p = inventory.items.passwords || {};
  if (!p.available) return { status: "blocked", reason: "No password database found in the source profile." };
  return {
    status: "official-flow-required",
    reason:
      "Passwords are never read or decrypted. Use the source browser's own password export (user-initiated CSV) " +
      "and the target browser's official import UI (or the supported --import-passwords=<csv> startup switch in " +
      "this Chromium build). Device-bound / passkey credentials cannot be migrated by file copy.",
    counts: profile.family === "firefox" ? p.count || null : { logins: p.count, accountLogins: p.accountCount },
  };
}

function exportHistory(profile, limit) {
  if (profile.family === "firefox") return exportFirefoxHistory(profile, limit);
  return exportChromiumHistory(profile, limit);
}

function exportChromiumHistory(profile, limit) {
  const entry = (profile.files || {})["History"];
  if (!entry) return { ok: false, error: "history-missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "urls")) return { error: "urls-table-missing" };
    const q = queryAll(
      db,
      "SELECT url, title, visit_count, typed_count, last_visit_time FROM urls " +
        "WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?",
      [Math.max(1, Math.min(Number(limit) || 20000, 200000))],
    );
    if (!q.ok) return { error: q.error };
    return {
      rows: q.rows.map((r) => ({
        url: String(r.url),
        title: r.title == null ? "" : String(r.title),
        visitCount: Number(r.visit_count) || 0,
        typedCount: Number(r.typed_count) || 0,
        lastVisit: chromeTimeToIso(r.last_visit_time),
      })),
    };
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.value.error) return { ok: false, error: res.value.error };
  return { ok: true, rows: res.value.rows };
}

function exportFirefoxHistory(profile, limit) {
  const entry = (profile.files || {})["places.sqlite"];
  if (!entry) return { ok: false, error: "places-missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "moz_places")) return { error: "moz_places-missing" };
    const q = queryAll(
      db,
      "SELECT url, title, visit_count, typed, last_visit_date FROM moz_places " +
        "WHERE hidden = 0 ORDER BY last_visit_date DESC LIMIT ?",
      [Math.max(1, Math.min(Number(limit) || 20000, 200000))],
    );
    if (!q.ok) return { error: q.error };
    return {
      rows: q.rows.map((r) => ({
        url: String(r.url),
        title: r.title == null ? "" : String(r.title),
        visitCount: Number(r.visit_count) || 0,
        typedCount: Number(r.typed) || 0,
        lastVisit: firefoxTimeToIso(r.last_visit_date),
      })),
    };
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.value.error) return { ok: false, error: res.value.error };
  return { ok: true, rows: res.value.rows };
}

function exportAutofill(profile, limit) {
  if (profile.family === "firefox") return exportFirefoxAutofill(profile, limit);
  return exportChromiumAutofill(profile, limit);
}

function exportChromiumAutofill(profile, limit) {
  const entry = (profile.files || {})["Web Data"];
  if (!entry) return { ok: false, error: "web-data-missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "autofill")) return { error: "autofill-table-missing" };
    const q = queryAll(
      db,
      "SELECT name, value, count, date_created, date_last_used FROM autofill ORDER BY date_last_used DESC LIMIT ?",
      [Math.max(1, Math.min(Number(limit) || 5000, 100000))],
    );
    if (!q.ok) return { error: q.error };
    return {
      rows: q.rows.map((r) => ({
        name: String(r.name),
        value: String(r.value),
        timesUsed: Number(r.count) || 0,
        firstUsed: chromeTimeToIso(r.date_created),
        lastUsed: chromeTimeToIso(r.date_last_used),
      })),
    };
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.value.error) return { ok: false, error: res.value.error };
  return { ok: true, rows: res.value.rows };
}

function exportFirefoxAutofill(profile, limit) {
  const entry = (profile.files || {})["formhistory.sqlite"];
  if (!entry) return { ok: false, error: "formhistory-missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "moz_formhistory")) return { error: "moz_formhistory-missing" };
    const q = queryAll(
      db,
      "SELECT fieldname, value, timesUsed, firstUsed, lastUsed FROM moz_formhistory ORDER BY lastUsed DESC LIMIT ?",
      [Math.max(1, Math.min(Number(limit) || 5000, 100000))],
    );
    if (!q.ok) return { error: q.error };
    return {
      rows: q.rows.map((r) => ({
        name: String(r.fieldname),
        value: String(r.value),
        timesUsed: Number(r.timesUsed) || 0,
        firstUsed: firefoxTimeToIso(r.firstUsed),
        lastUsed: firefoxTimeToIso(r.lastUsed),
      })),
    };
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.value.error) return { ok: false, error: res.value.error };
  return { ok: true, rows: res.value.rows };
}

function chromeTimeToIso(micros) {
  const n = Number(micros);
  if (!Number.isFinite(n)) return null;
  const ms = Math.round(n / 1000) - 11644473600000;
  if (ms <= 0) return null;
  return new Date(ms).toISOString();
}

function firefoxTimeToIso(micros) {
  const n = Number(micros);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Math.round(n / 1000)).toISOString();
}
