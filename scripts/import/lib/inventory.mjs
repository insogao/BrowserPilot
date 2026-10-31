// Read-only inventory of one source profile.
//
// Counts and availability only. Cookie values, password values, autofill
// values, bookmark URLs and history URLs never leave this module.
import fs from "node:fs";
import path from "node:path";
import { fileExists, dirExists, readJsonIfExists } from "./fs-safe.mjs";
import { withReadOnlyCopy, tableExists, tableColumns, queryOne } from "./sqlite.mjs";

export function inspectProfile(profile) {
  const result = {
    profile: {
      id: profile.id,
      browserId: profile.browserId,
      browserName: profile.browserName,
      family: profile.family,
      dirName: profile.dirName,
      label: profile.label,
      path: profile.path,
      root: profile.root,
      lastModified: profile.lastModified,
      running: profile.running,
    },
    items: {},
  };

  if (profile.family === "firefox") {
    result.items.bookmarks = inspectFirefoxBookmarks(profile);
    result.items.history = inspectFirefoxHistory(profile);
    result.items.cookies = inspectFirefoxCookies(profile);
    result.items.passwords = inspectFirefoxPasswords(profile);
    result.items.autofill = inspectFirefoxAutofill(profile);
    result.items.extensions = inspectFirefoxExtensions(profile);
    result.items.preferences = inspectFirefoxPreferences(profile);
    result.items.tabs = inspectFirefoxTabs(profile);
  } else {
    const files = profile.files || {};
    result.items.bookmarks = inspectChromiumBookmarks(files);
    result.items.history = inspectChromiumHistory(files);
    result.items.cookies = inspectChromiumCookies(files);
    result.items.passwords = inspectChromiumPasswords(files);
    result.items.autofill = inspectChromiumAutofill(files);
    result.items.extensions = inspectChromiumExtensions(files);
    result.items.preferences = inspectChromiumPreferences(files);
    result.items.tabs = inspectChromiumTabs(files);
  }
  return result;
}

// ---------- Chromium ----------

function inspectChromiumBookmarks(files) {
  const entry = files["Bookmarks"];
  if (!entry) return { available: false, reason: "missing" };
  const data = readJsonIfExists(entry.path, 128 * 1024 * 1024);
  if (!data) return { available: true, readable: false, reason: "invalid-json", path: entry.path };
  const counts = { urls: 0, folders: 0 };
  const roots = data.roots && typeof data.roots === "object" ? data.roots : {};
  for (const key of ["bookmark_bar", "other", "synced"]) {
    const node = roots[key];
    if (node && typeof node === "object") countChromiumNode(node, counts, true);
  }
  return { available: true, readable: true, path: entry.path, count: counts };
}

function countChromiumNode(node, counts, isRoot = false) {
  if (!node || typeof node !== "object") return;
  if (!isRoot) {
    if (node.type === "url") counts.urls += 1;
    else if (node.type === "folder") counts.folders += 1;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) countChromiumNode(child, counts, false);
  }
}

function inspectChromiumHistory(files) {
  const entry = files["History"];
  if (!entry) return { available: false, reason: "missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    const hasUrls = tableExists(db, "urls");
    const hasVisits = tableExists(db, "visits");
    if (!hasUrls) return { error: "urls-table-missing" };
    const urls = queryOne(db, "SELECT COUNT(*) AS n FROM urls");
    const visits = hasVisits ? queryOne(db, "SELECT COUNT(*) AS n FROM visits") : null;
    return {
      urls: urls.ok ? Number(urls.row.n) : null,
      visits: visits && visits.ok ? Number(visits.row.n) : null,
    };
  });
  if (!res.ok) return { available: true, readable: false, path: entry.path, error: res.error };
  return { available: true, readable: true, path: entry.path, count: res.value, schemaKnown: true };
}

function inspectChromiumCookies(files) {
  const entry = files["Cookies"];
  if (!entry) return { available: false, reason: "missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "cookies")) return { error: "cookies-table-missing" };
    const cols = new Set(tableColumns(db, "cookies"));
    const total = queryOne(db, "SELECT COUNT(*) AS n FROM cookies");
    const totalN = total.ok ? Number(total.row.n) : null;
    const out = { total: totalN };
    if (cols.has("is_httponly")) out.httpOnly = scalar(db, "SELECT SUM(CASE WHEN is_httponly=1 THEN 1 ELSE 0 END) FROM cookies");
    if (cols.has("is_secure")) out.secure = scalar(db, "SELECT SUM(CASE WHEN is_secure=1 THEN 1 ELSE 0 END) FROM cookies");
    if (cols.has("is_persistent")) out.session = scalar(db, "SELECT SUM(CASE WHEN is_persistent=0 THEN 1 ELSE 0 END) FROM cookies");
    if (cols.has("top_frame_site_key")) {
      out.partitioned = scalar(
        db,
        "SELECT SUM(CASE WHEN top_frame_site_key IS NOT NULL AND top_frame_site_key <> '' THEN 1 ELSE 0 END) FROM cookies",
      );
    }
    if (cols.has("host_key")) out.domains = scalar(db, "SELECT COUNT(DISTINCT host_key) FROM cookies");
    if (cols.has("encrypted_value")) {
      out.encrypted = {
        v10: scalar(db, "SELECT SUM(CASE WHEN substr(encrypted_value,1,3)=x'763130' THEN 1 ELSE 0 END) FROM cookies"),
        v20: scalar(db, "SELECT SUM(CASE WHEN substr(encrypted_value,1,3)=x'763230' THEN 1 ELSE 0 END) FROM cookies"),
        other: scalar(
          db,
          "SELECT SUM(CASE WHEN length(encrypted_value)>0 AND substr(encrypted_value,1,3) NOT IN (x'763130',x'763230') THEN 1 ELSE 0 END) FROM cookies",
        ),
        empty: scalar(db, "SELECT SUM(CASE WHEN length(encrypted_value)=0 THEN 1 ELSE 0 END) FROM cookies"),
      };
    }
    if (cols.has("value")) {
      out.plaintext = scalar(db, "SELECT SUM(CASE WHEN length(value)>0 THEN 1 ELSE 0 END) FROM cookies");
    }
    return out;
  });
  if (!res.ok) return { available: true, readable: false, path: entry.path, error: res.error };
  const value = res.value || {};
  const encrypted = value.encrypted || {};
  const usableWithoutDecryption = Number(value.plaintext || 0);
  return {
    available: true,
    readable: true,
    path: entry.path,
    count: value,
    importableWithoutDecryption: usableWithoutDecryption,
    encryption: {
      appBoundV20: Number(encrypted.v20 || 0),
      dpapiV10: Number(encrypted.v10 || 0),
      other: Number(encrypted.other || 0),
      empty: Number(encrypted.empty || 0),
    },
    note:
      "Encrypted cookie values cannot be decrypted by Browser CLI without crossing the source browser's " +
      "security boundary (DPAPI / App-Bound Encryption). Use the user-authorized source-extension bridge.",
  };
}

function inspectChromiumPasswords(files) {
  const entry = files["Login Data"];
  const account = files["Login Data For Account"];
  if (!entry && !account) return { available: false, reason: "missing" };
  const main = entry ? inspectChromiumLoginDb(entry.path) : null;
  const accountDb = account ? inspectChromiumLoginDb(account.path) : null;
  return {
    available: true,
    readable: !!(main && main.ok) || !!(accountDb && accountDb.ok),
    path: entry ? entry.path : null,
    count: main && main.ok ? main.value : null,
    accountCount: accountDb && accountDb.ok ? accountDb.value : null,
    mainError: main && !main.ok ? main.error : undefined,
    note: "Password values are encrypted (v10/v20) and are never read or decrypted by this tool.",
  };
}

function inspectChromiumLoginDb(dbPath) {
  return withReadOnlyCopy(dbPath, (db) => {
    if (!tableExists(db, "logins")) return { error: "logins-table-missing" };
    const cols = new Set(tableColumns(db, "logins"));
    const total = queryOne(db, "SELECT COUNT(*) AS n FROM logins");
    const out = { logins: total.ok ? Number(total.row.n) : null };
    if (cols.has("password_value")) {
      out.withSecret = scalar(db, "SELECT SUM(CASE WHEN length(password_value)>0 THEN 1 ELSE 0 END) FROM logins");
      out.v10 = scalar(db, "SELECT SUM(CASE WHEN substr(password_value,1,3)=x'763130' THEN 1 ELSE 0 END) FROM logins");
      out.v20 = scalar(db, "SELECT SUM(CASE WHEN substr(password_value,1,3)=x'763230' THEN 1 ELSE 0 END) FROM logins");
    }
    return out;
  });
}

function inspectChromiumAutofill(files) {
  const entry = files["Web Data"];
  if (!entry) return { available: false, reason: "missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    const out = {};
    out.fields = tableExists(db, "autofill") ? scalar(db, "SELECT COUNT(*) FROM autofill") : null;
    if (tableExists(db, "addresses")) out.addresses = scalar(db, "SELECT COUNT(*) FROM addresses");
    else if (tableExists(db, "autofill_profiles")) out.addresses = scalar(db, "SELECT COUNT(*) FROM autofill_profiles");
    else out.addresses = null;
    return out;
  });
  if (!res.ok) return { available: true, readable: false, path: entry.path, error: res.error };
  return { available: true, readable: true, path: entry.path, count: res.value };
}

function inspectChromiumExtensions(files) {
  const entry = files["Extensions"];
  if (!entry || !entry.directory) return { available: false, reason: "missing" };
  const list = [];
  let ids = [];
  try {
    ids = fs.readdirSync(entry.path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { available: true, readable: false, path: entry.path };
  }
  for (const id of ids) {
    const versionDirs = safeReaddir(path.join(entry.path, id)).filter((e) => e.isDirectory());
    let picked = null;
    for (const v of versionDirs) {
      const manifestPath = path.join(entry.path, id, v.name, "manifest.json");
      if (fileExists(manifestPath)) {
        picked = { versionDir: v.name, manifestPath };
        break;
      }
    }
    if (!picked) continue;
    const manifest = readJsonIfExists(picked.manifestPath, 2 * 1024 * 1024);
    if (!manifest) continue;
    list.push({
      id,
      name: resolveExtensionName(manifest, path.dirname(picked.manifestPath)),
      version: typeof manifest.version === "string" ? manifest.version : picked.versionDir,
      manifestVersion: manifest.manifest_version ?? null,
    });
  }
  return { available: true, readable: true, path: entry.path, count: list.length, list };
}

function resolveExtensionName(manifest, extensionDir) {
  const raw = typeof manifest.name === "string" ? manifest.name : "";
  const msg = raw.match(/^__MSG_(.+)__$/i);
  if (!msg) return raw;
  const locale = typeof manifest.default_locale === "string" ? manifest.default_locale : "en";
  const messages = readJsonIfExists(path.join(extensionDir, "_locales", locale, "messages.json"), 2 * 1024 * 1024);
  if (!messages) return raw;
  const key = msg[1].toLowerCase();
  for (const [k, v] of Object.entries(messages)) {
    if (k.toLowerCase() === key && v && typeof v.message === "string") return v.message;
  }
  return raw;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function inspectChromiumPreferences(files) {
  const entry = files["Preferences"];
  if (!entry) return { available: false, reason: "missing" };
  const prefs = readJsonIfExists(entry.path, 64 * 1024 * 1024);
  if (!prefs) return { available: true, readable: false, path: entry.path };
  const startupUrls = prefs.session && Array.isArray(prefs.session.startup_urls) ? prefs.session.startup_urls : [];
  return {
    available: true,
    readable: true,
    path: entry.path,
    summary: {
      homepageConfigured: typeof prefs.homepage === "string" && prefs.homepage.length > 0,
      homepageIsNewTab: prefs.homepage_is_newtabpage === true,
      restoreOnStartup: typeof prefs.session?.restore_on_startup === "number" ? prefs.session.restore_on_startup : null,
      startupUrlCount: startupUrls.length,
      hasEncryptedBookmarks:
        !!(files["EncryptedBookmarks2"] && files["EncryptedBookmarks2"].size > 0) ||
        !!(files["EncryptedAccountBookmarks2"] && files["EncryptedAccountBookmarks2"].size > 0),
    },
  };
}

function inspectChromiumTabs(files) {
  const sessions = files["Sessions"];
  if (!sessions || !sessions.directory) return { available: false, reason: "missing" };
  let filesCount = 0;
  try {
    filesCount = fs.readdirSync(sessions.path).length;
  } catch {}
  return {
    available: true,
    readable: false,
    path: sessions.path,
    files: filesCount,
    reason:
      "Open tabs live in Chromium's internal SNSS session files; no supported external reader/import path exists. " +
      "Use a user-authorized source extension (chrome.tabs.query) or reopen tabs manually.",
  };
}

// ---------- Firefox ----------

function inspectFirefoxBookmarks(profile) {
  const entry = profile.files["places.sqlite"];
  if (!entry) return { available: false, reason: "missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "moz_bookmarks")) return { error: "moz_bookmarks-missing" };
    const urls = scalar(db, "SELECT COUNT(*) FROM moz_bookmarks WHERE type=1");
    const folders = scalar(db, "SELECT COUNT(*) FROM moz_bookmarks WHERE type=2");
    return { urls, folders };
  });
  if (!res.ok) return { available: true, readable: false, path: entry.path, error: res.error };
  return { available: true, readable: true, path: entry.path, count: res.value };
}

function inspectFirefoxHistory(profile) {
  const entry = profile.files["places.sqlite"];
  if (!entry) return { available: false, reason: "missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "moz_places")) return { error: "moz_places-missing" };
    return {
      urls: scalar(db, "SELECT COUNT(*) FROM moz_places"),
      visits: tableExists(db, "moz_historyvisits") ? scalar(db, "SELECT COUNT(*) FROM moz_historyvisits") : null,
    };
  });
  if (!res.ok) return { available: true, readable: false, path: entry.path, error: res.error };
  return { available: true, readable: true, path: entry.path, count: res.value };
}

function inspectFirefoxCookies(profile) {
  const entry = profile.files["cookies.sqlite"];
  if (!entry) return { available: false, reason: "missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "moz_cookies")) return { error: "moz_cookies-missing" };
    const cols = new Set(tableColumns(db, "moz_cookies"));
    const out = { total: scalar(db, "SELECT COUNT(*) FROM moz_cookies") };
    if (cols.has("isHttpOnly")) out.httpOnly = scalar(db, "SELECT SUM(CASE WHEN isHttpOnly=1 THEN 1 ELSE 0 END) FROM moz_cookies");
    if (cols.has("isSecure")) out.secure = scalar(db, "SELECT SUM(CASE WHEN isSecure=1 THEN 1 ELSE 0 END) FROM moz_cookies");
    if (cols.has("expiry")) out.session = scalar(db, "SELECT SUM(CASE WHEN expiry=0 THEN 1 ELSE 0 END) FROM moz_cookies");
    if (cols.has("host")) out.domains = scalar(db, "SELECT COUNT(DISTINCT host) FROM moz_cookies");
    if (cols.has("value")) out.plaintext = scalar(db, "SELECT SUM(CASE WHEN length(value)>0 THEN 1 ELSE 0 END) FROM moz_cookies");
    if (cols.has("originAttributes")) {
      out.partitioned = scalar(db, "SELECT SUM(CASE WHEN originAttributes LIKE '%^partitionKey%' THEN 1 ELSE 0 END) FROM moz_cookies");
    }
    return out;
  });
  if (!res.ok) return { available: true, readable: false, path: entry.path, error: res.error };
  const value = res.value || {};
  return {
    available: true,
    readable: true,
    path: entry.path,
    count: value,
    importableWithoutDecryption: Number(value.plaintext || 0),
    note:
      "Firefox cookie values are stored unencrypted in cookies.sqlite, but importing them still requires a " +
      "write path inside the target browser (or the official cookies API). This tool does not write cookie stores.",
  };
}

function inspectFirefoxPasswords(profile) {
  const logins = profile.files["logins.json"];
  if (!logins) return { available: false, reason: "missing" };
  const data = readJsonIfExists(logins.path, 64 * 1024 * 1024);
  if (!data || !Array.isArray(data.logins)) return { available: true, readable: false, path: logins.path };
  let encrypted = 0;
  for (const entry of data.logins) {
    if (entry && typeof entry.encrypted === "string" && entry.encrypted.length > 0) encrypted += 1;
  }
  return {
    available: true,
    readable: true,
    path: logins.path,
    count: { logins: data.logins.length, encrypted },
    key4Present: !!profile.files["key4.db"],
    note: "NSS-encrypted passwords (key4.db) are not decrypted by this tool.",
  };
}

function inspectFirefoxAutofill(profile) {
  const entry = profile.files["formhistory.sqlite"];
  if (!entry) return { available: false, reason: "missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "moz_formhistory")) return { error: "moz_formhistory-missing" };
    return { fields: scalar(db, "SELECT COUNT(*) FROM moz_formhistory") };
  });
  if (!res.ok) return { available: true, readable: false, path: entry.path, error: res.error };
  return { available: true, readable: true, path: entry.path, count: res.value };
}

function inspectFirefoxExtensions(profile) {
  const entry = profile.files["extensions"];
  if (!entry || !entry.directory) return { available: false, reason: "missing" };
  let list = [];
  try {
    list = fs.readdirSync(entry.path).map((name) => ({ file: name }));
  } catch {
    return { available: true, readable: false, path: entry.path };
  }
  return { available: true, readable: true, path: entry.path, count: list.length, list: list.slice(0, 200) };
}

function inspectFirefoxPreferences(profile) {
  const entry = profile.files["prefs.js"];
  if (!entry) return { available: false, reason: "missing" };
  let text = "";
  try {
    const st = fs.statSync(entry.path);
    if (st.size > 64 * 1024 * 1024) return { available: true, readable: false, path: entry.path };
    text = fs.readFileSync(entry.path, "utf8");
  } catch {
    return { available: true, readable: false, path: entry.path };
  }
  const homepage = /user_pref\("browser\.startup\.homepage",\s*"([^"]*)"\)/.exec(text);
  const page = /user_pref\("browser\.startup\.page",\s*(\d+)\)/.exec(text);
  return {
    available: true,
    readable: true,
    path: entry.path,
    summary: {
      homepageConfigured: !!(homepage && homepage[1]),
      restoreOnStartup: page ? Number(page[1]) : null,
    },
  };
}

function inspectFirefoxTabs(profile) {
  const entry = profile.files["sessionstore.jsonlz4"];
  const backups = profile.files["sessionstore-backups"];
  if (!entry && !backups) return { available: false, reason: "missing" };
  return {
    available: true,
    readable: false,
    path: entry ? entry.path : backups.path,
    reason:
      "Firefox session data is compressed (mozlz4) and internal; no supported external import path. " +
      "Use a user-authorized source extension or reopen tabs manually.",
  };
}

function scalar(db, sql) {
  const res = queryOne(db, sql);
  if (!res.ok || !res.row) return null;
  const v = Object.values(res.row)[0];
  return v == null ? 0 : Number(v);
}
