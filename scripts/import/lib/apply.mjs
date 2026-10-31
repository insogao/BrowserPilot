// Apply a staging bundle to a Chromium/Browser CLI target profile.
//
// Safety model:
// - The target profile must be new/empty by default. Re-import into an
//   existing profile requires --allow-existing, creates a timestamped backup,
//   and refuses when the profile looks in use.
// - Only Bookmarks are written in this MVP. Cookies/passwords/history/autofill
//   are never written into the target; their result is recorded as blocked /
//   official-flow / export-only.
// - Writes are atomic (temp + fsync + rename).
import fs from "node:fs";
import path from "node:path";
import {
  ensureDir,
  fileExists,
  readJsonIfExists,
  writeJsonFile,
  backupFile,
  samePath,
  isPathInside,
} from "./fs-safe.mjs";
import { isInsideRealSourceBrowserRoot, profileInUseByProcess } from "./browsers.mjs";
import {
  newBookmarkFile,
  addImportFolder,
  validateBookmarkFile,
} from "./bookmarks.mjs";

const FORBIDDEN_BUNDLE_FILES = ["Cookies", "Login Data", "Local State", "key4.db", "logins.json", "Web Data", "History"];

export function applyBundle({ bundleDir, targetProfile, allowExisting = false, placement = "other", skipProcessProbe = false }) {
  const manifestPath = path.join(bundleDir, "manifest.json");
  const manifest = readJsonIfExists(manifestPath, 16 * 1024 * 1024);
  if (!manifest || manifest.format !== 1) {
    return fail("invalid-bundle", "manifest.json is missing or has an unsupported format");
  }
  for (const name of FORBIDDEN_BUNDLE_FILES) {
    if (fileExists(path.join(bundleDir, name))) {
      return fail("bundle-contains-forbidden-file", `Refusing to apply: bundle contains ${name}`);
    }
  }

  const target = path.resolve(targetProfile);
  if (!path.isAbsolute(targetProfile)) return fail("target-not-absolute", "Pass an absolute --target-profile");

  const sourcePath = manifest.source && manifest.source.path ? manifest.source.path : null;
  if (sourcePath && (samePath(sourcePath, target) || isPathInside(sourcePath, target))) {
    return fail("target-is-source", "Target profile is the source profile or inside it");
  }
  if (sourcePath && isPathInside(path.dirname(sourcePath), target)) {
    return fail(
      "target-inside-source-user-data",
      `Target is inside the source browser's user data directory (${path.dirname(sourcePath)}); refusing`,
    );
  }
  const real = isInsideRealSourceBrowserRoot(target);
  if (real.inside) {
    return fail(
      "target-inside-source-browser",
      `Refusing to write inside ${real.browserId} user data root ${real.root}. Import into a Browser CLI/Chromium profile instead.`,
    );
  }

  const targetExists = fs.existsSync(target);
  if (targetExists) {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return fail("target-not-directory", target);
    const entries = fs.readdirSync(target);
    if (entries.length > 0 && !allowExisting) {
      return fail("target-not-empty", "Target profile is not empty; re-run with --allow-existing to merge bookmarks");
    }
  } else {
    ensureDir(target);
  }

  // Lock-file detection (POSIX Chromium, Firefox).
  for (const name of ["SingletonLock", "SingletonCookie", "parent.lock"]) {
    if (existsLstat(path.join(target, name))) {
      return fail("target-in-use", `Refusing to write: ${name} exists in the target profile`);
    }
  }

  // Process probe: only on Windows and only when not explicitly skipped by a
  // test harness. null means "could not determine" -> fail closed for existing
  // profiles.
  let processEvidence = null;
  if (process.platform === "win32" && !skipProcessProbe) {
    const probe = profileInUseByProcess(target);
    if (probe.inUse === true) return fail("target-in-use", probe.evidence || "browser process is using the target");
    if (probe.inUse === null) {
      const nonEmpty = fs.readdirSync(target).length > 0;
      if (nonEmpty) {
        return fail(
          "target-use-unknown",
          `Could not determine whether a browser is using the target (${probe.evidence}); refusing to write an existing profile`,
        );
      }
    }
    processEvidence = probe.evidence;
  }

  if (fileExists(path.join(target, "EncryptedBookmarks2")) || fileExists(path.join(target, "EncryptedAccountBookmarks2"))) {
    return fail(
      "target-has-encrypted-bookmarks",
      "Target has encrypted bookmark files; clear-text import would not be authoritative. Import before first run.",
    );
  }

  const result = {
    format: 1,
    appliedAt: new Date().toISOString(),
    targetProfile: target,
    source: manifest.source || null,
    dataCopied: {},
    cookieImported: { status: "blocked", reason: "Cookie import requires the user-authorized extension bridge." },
    loginVerified: {
      status: "not_verified",
      note: "Data copy or cookie set does not prove a site login. Verify by opening the site in the target browser.",
    },
    details: {},
  };

  const bookmarksItem = manifest.items && manifest.items.bookmarks;
  if (bookmarksItem && bookmarksItem.status === "ok") {
    const applied = applyBookmarks(bundleDir, target, manifest, { allowExisting, placement });
    if (!applied.ok) return applied;
    result.dataCopied.bookmarks = applied.detail.status === "applied";
    result.details.bookmarks = applied.detail;
  } else {
    result.dataCopied.bookmarks = false;
    result.details.bookmarks = { status: bookmarksItem ? bookmarksItem.status : "not-requested" };
  }

  for (const [item, info] of Object.entries(manifest.items || {})) {
    if (item === "bookmarks") continue;
    result.dataCopied[item] = false;
    result.details[item] = { status: info.status, note: info.reason || null };
  }

  const resultPath = path.join(bundleDir, "result.json");
  writeJsonFile(resultPath, result);
  return { ok: true, result, resultPath };
}

function applyBookmarks(bundleDir, target, manifest, { allowExisting, placement }) {
  const bundleBookmarks = readJsonIfExists(path.join(bundleDir, "bookmarks.json"), 256 * 1024 * 1024);
  if (!bundleBookmarks || !bundleBookmarks.roots) {
    return fail("invalid-bookmarks-bundle", "bookmarks.json is missing or invalid");
  }
  const sourceLabel = `Imported from ${manifest.source?.browserName || "browser"} (${manifest.source?.label || "profile"})`;

  const targetBookmarksPath = path.join(target, "Bookmarks");
  let targetFile;
  let backupPath = null;
  if (fileExists(targetBookmarksPath)) {
    if (!allowExisting) {
      return fail("target-not-empty", "Target already has a Bookmarks file; re-run with --allow-existing to merge");
    }
    targetFile = readJsonIfExists(targetBookmarksPath, 256 * 1024 * 1024);
    if (!targetFile) return fail("target-bookmarks-invalid", "Existing target Bookmarks file is not valid JSON");
    const errors = validateBookmarkFile(targetFile);
    if (errors.length) return fail("target-bookmarks-invalid", errors.join(","));
    // Backup is taken only if we actually write (see below).
  } else {
    targetFile = newBookmarkFile();
  }

  const folder = addImportFolder(targetFile, bundleBookmarks.roots, {
    sourceLabel,
    placement,
  });
  const counts = countFolder(folder);
  if (counts.urls === 0 && counts.folders === 0) {
    return { ok: true, detail: { status: "empty", path: null, backupPath, folderName: null, counts } };
  }
  const errors = validateBookmarkFile(targetFile);
  if (errors.length) return fail("built-bookmarks-invalid", errors.join(","));

  if (fileExists(targetBookmarksPath)) backupPath = backupFile(targetBookmarksPath, "bak");
  writeJsonAtomic(targetBookmarksPath, targetFile);
  return {
    ok: true,
    detail: {
      status: "applied",
      path: targetBookmarksPath,
      backupPath,
      folderName: folder.name,
      counts,
    },
  };
}

function writeJsonAtomic(p, value) {
  const dir = path.dirname(p);
  ensureDir(dir);
  const tmp = path.join(dir, `.Bookmarks.tmp-${process.pid}-${Date.now()}`);
  const body = JSON.stringify(value, null, 3) + "\n";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {}
}

function countFolder(folder) {
  let urls = 0;
  let folders = 0;
  const walk = (node) => {
    if (node.type === "url") urls += 1;
    else {
      folders += 1;
      for (const child of node.children || []) walk(child);
    }
  };
  for (const child of folder.children || []) walk(child);
  return { urls, folders };
}

function existsLstat(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function fail(code, message) {
  return { ok: false, error: code, message };
}
