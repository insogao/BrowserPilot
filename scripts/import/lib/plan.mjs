// Build a migration plan for one source profile. The plan is data-only; it does
// not touch the target.
import fs from "node:fs";
import path from "node:path";
import { dirExists, fileExists, samePath, isPathInside } from "./fs-safe.mjs";
import { isInsideRealSourceBrowserRoot } from "./browsers.mjs";

export const ITEM_IDS = ["cookies", "bookmarks", "history", "passwords", "autofill", "tabs", "extensions", "preferences"];
export const DEFAULT_ITEMS = ["cookies", "bookmarks", "history", "passwords", "autofill", "tabs"];

export function normalizeItems(raw) {
  const parts = String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const list = parts.length ? parts : DEFAULT_ITEMS.slice();
  const unknown = list.filter((i) => !ITEM_IDS.includes(i));
  return { items: [...new Set(list)], unknown };
}

export function buildPlan({ profile, inventory, targetProfile, requestedItems, allowExisting = false }) {
  const items = {};
  const preconditions = [];
  const warnings = [];
  const inv = inventory.items || {};

  items.bookmarks = planBookmarks(profile, inv.bookmarks, requestedItems.has("bookmarks"), {
    targetProfile,
    allowExisting,
  });
  items.history = planExportOnly(inv.history, requestedItems.has("history"), {
    method: "bundle-jsonl",
    reason:
      "History can be exported to a local JSONL bundle, but writing Chromium's History SQLite database from " +
      "outside the target browser is version-sensitive and unsupported. Target-side import needs a Chromium " +
      "importer/native command (patch plan) or an official browser API.",
  });
  items.cookies = planCookies(profile, inv.cookies, requestedItems.has("cookies"));
  items.passwords = planPasswords(profile, inv.passwords, requestedItems.has("passwords"));
  items.autofill = planExportOnly(inv.autofill, requestedItems.has("autofill"), {
    method: "bundle-jsonl",
    reason:
      "Autofill rows can be exported to a local bundle, but there is no official target write API; direct Web Data " +
      "writes are not supported.",
  });
  items.tabs = {
    requested: requestedItems.has("tabs"),
    status: "blocked",
    method: "source-extension-or-manual",
    reason:
      "Open tabs live in internal session files and cannot be imported by file copy. Use a user-authorized source " +
      "extension (chrome.tabs.query) or reopen tabs manually.",
  };
  items.extensions = {
    requested: requestedItems.has("extensions"),
    status: "report-only",
    method: "reinstall-from-store",
    count: inv.extensions?.count ?? null,
    reason:
      "Extension directories/Preferences are not copied. Reinstalling from the official store is the supported path; " +
      "extension local data is not migrated.",
  };
  items.preferences = {
    requested: requestedItems.has("preferences"),
    status: "report-only",
    method: "inspect-only",
    summary: inv.preferences?.summary ?? null,
    reason: "Only a small read-only summary is inspected; arbitrary Preferences are not copied.",
  };

  // Target checks (only when a target was supplied; `plan` alone is data-only).
  if (targetProfile && !path.isAbsolute(targetProfile)) {
    preconditions.push({ name: "target-profile-absolute", ok: false, detail: "Pass an absolute --target-profile." });
  } else if (targetProfile) {
    preconditions.push({ name: "target-not-source", ok: !samePath(targetProfile, profile.path) && !isPathInside(profile.path, targetProfile), detail: profile.path });
    const real = isInsideRealSourceBrowserRoot(targetProfile);
    preconditions.push({
      name: "target-not-a-real-source-browser-profile",
      ok: !real.inside,
      detail: real.inside ? `refusing to write inside ${real.browserId} user data root ${real.root}` : null,
    });
    if (dirExists(targetProfile)) {
      let entries = [];
      try {
        entries = fs.readdirSync(targetProfile);
      } catch {}
      const empty = entries.length === 0;
      preconditions.push({
        name: "target-new-or-empty",
        ok: empty || allowExisting,
        detail: empty ? null : `profile is not empty (${entries.length} entries); re-run with --allow-existing to merge`,
      });
      if (fileExists(path.join(targetProfile, "EncryptedBookmarks2")) || fileExists(path.join(targetProfile, "EncryptedAccountBookmarks2"))) {
        preconditions.push({
          name: "target-no-encrypted-bookmarks",
          ok: false,
          detail:
            "Target has encrypted bookmark files. This build writes clear-text Bookmarks; writing beside an " +
            "encrypted source of truth is refused. Import before first run, or disable bookmark encryption.",
        });
      }
    } else {
      preconditions.push({ name: "target-new-or-empty", ok: true, detail: "profile directory does not exist yet" });
    }
  }

  if (profile.running && profile.running.running) {
    warnings.push(
      `Source profile looks in use (${profile.running.evidence}). Read-only snapshots are still safe, but closing ` +
        `the source browser gives a fully consistent copy. This tool never closes or kills it.`,
    );
  }
  const hardFail = preconditions.some((p) => !p.ok);
  return {
    source: inventory.profile,
    targetProfile: targetProfile ? path.resolve(targetProfile) : null,
    items,
    preconditions,
    warnings,
    ready: !hardFail,
    blocked: Object.entries(items)
      .filter(([, v]) => v.requested && v.status === "blocked")
      .map(([k]) => k),
  };
}

function planBookmarks(profile, inv, requested, { targetProfile, allowExisting }) {
  if (!requested) return { requested: false, status: "skipped" };
  if (!inv || !inv.available) return { requested: true, status: "unavailable", reason: "Source has no bookmark store." };
  if (inv.readable === false) {
    return { requested: true, status: "failed", reason: inv.error || "Bookmark store is not readable." };
  }
  return {
    requested: true,
    status: "ready",
    method: "bookmarks-json",
    counts: inv.count,
    reason:
      "Writes a Chromium Bookmarks JSON file atomically into a target profile that is not running. Existing " +
      "bookmarks are merged under a new folder after a timestamped backup.",
    targetProfile: targetProfile || null,
    allowExisting,
  };
}

function planCookies(profile, inv, requested) {
  if (!requested) return { requested: false, status: "skipped" };
  if (!inv || !inv.available) return { requested: true, status: "unavailable", reason: "Source has no cookie store." };
  if (profile.family === "firefox") {
    return {
      requested: true,
      status: "blocked",
      method: "extension-bridge",
      counts: inv.count || null,
      reason:
        "Firefox cookies are stored unencrypted, but importing them still needs a cookie writer inside the target " +
        "browser. Direct SQLite writes are forbidden (concurrent profile access + encryption/schema ownership). " +
        "Use the official cookies API bridge.",
    };
  }
  return {
    requested: true,
    status: "blocked",
    method: "source-extension-bridge",
    counts: inv.count || null,
    encryption: inv.encryption || null,
    reason:
      "Cookie values are encrypted (v10 DPAPI and/or v20 App-Bound). Decrypting them or using the source browser's " +
      "keys is out of bounds. The only compliant path is a user-authorized extension in the source browser using " +
      "the official chrome.cookies API, paired locally with a target-side writer.",
  };
}

function planPasswords(profile, inv, requested) {
  if (!requested) return { requested: false, status: "skipped" };
  if (!inv || !inv.available) return { requested: true, status: "unavailable", reason: "No password store found." };
  return {
    requested: true,
    status: "official-flow-required",
    method: "source-export-csv + target-import",
    counts: profile.family === "firefox" ? inv.count || null : { logins: inv.count?.logins ?? null, account: inv.accountCount?.logins ?? null },
    reason:
      "Passwords are never read or decrypted here. Use the source browser's own user-initiated export, then the " +
      "target browser's official import (settings UI or --import-passwords=<csv> in this Chromium build). " +
      "Device-bound credentials/passkeys cannot be migrated by file copy.",
  };
}

function planExportOnly(inv, requested, { method, reason }) {
  if (!requested) return { requested: false, status: "skipped" };
  if (!inv || !inv.available) return { requested: true, status: "unavailable", reason: "Source data not found." };
  if (inv.readable === false) return { requested: true, status: "failed", reason: inv.error || "Store is not readable." };
  return { requested: true, status: "export-only", method, counts: inv.count, reason };
}
