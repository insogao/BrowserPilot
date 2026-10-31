// Browser/profile discovery for the import MVP.
//
// Everything here is metadata-only: directory existence, Local State /
// profiles.ini parsing, and lock-file presence. No cookie/password value is
// read and no browser process is started or stopped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { dirExists, fileExists, readJsonIfExists, isPathInside, samePath } from "./fs-safe.mjs";

const HOME = os.homedir();
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");

function rootsFor(browserId) {
  switch (process.platform) {
    case "win32":
      switch (browserId) {
        case "chrome":
          return [path.join(LOCALAPPDATA, "Google", "Chrome", "User Data")];
        case "edge":
          return [path.join(LOCALAPPDATA, "Microsoft", "Edge", "User Data")];
        case "brave":
          return [path.join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data")];
        case "chromium":
          return [path.join(LOCALAPPDATA, "Chromium", "User Data")];
        case "firefox":
          return [path.join(APPDATA, "Mozilla", "Firefox")];
        default:
          return [];
      }
    case "darwin":
      switch (browserId) {
        case "chrome":
          return [path.join(HOME, "Library", "Application Support", "Google", "Chrome")];
        case "edge":
          return [path.join(HOME, "Library", "Application Support", "Microsoft Edge")];
        case "brave":
          return [path.join(HOME, "Library", "Application Support", "BraveSoftware", "Brave-Browser")];
        case "chromium":
          return [path.join(HOME, "Library", "Application Support", "Chromium")];
        case "firefox":
          return [path.join(HOME, "Library", "Application Support", "Firefox")];
        default:
          return [];
      }
    default:
      switch (browserId) {
        case "chrome":
          return [path.join(HOME, ".config", "google-chrome")];
        case "edge":
          return [path.join(HOME, ".config", "microsoft-edge")];
        case "brave":
          return [path.join(HOME, ".config", "BraveSoftware", "Brave-Browser")];
        case "chromium":
          return [path.join(HOME, ".config", "chromium")];
        case "firefox":
          return [path.join(HOME, ".mozilla", "firefox")];
        default:
          return [];
      }
  }
}

export const BROWSERS = [
  { id: "chrome", name: "Google Chrome", family: "chromium", order: 0 },
  { id: "edge", name: "Microsoft Edge", family: "chromium", order: 1 },
  { id: "brave", name: "Brave", family: "chromium", order: 2 },
  { id: "chromium", name: "Chromium / Browser CLI", family: "chromium", order: 3 },
  { id: "firefox", name: "Mozilla Firefox", family: "firefox", order: 4 },
];

export function browserById(id) {
  return BROWSERS.find((b) => b.id === id) || null;
}

export function defaultRoots(browserId) {
  return rootsFor(browserId);
}

export function allDefaultRoots() {
  const out = [];
  for (const b of BROWSERS) {
    for (const root of rootsFor(b.id)) out.push({ browserId: b.id, root });
  }
  return out;
}

function parseRootOverrides(overrides) {
  // overrides: { browserId: "/abs/path" } from --root chrome=...
  return overrides || {};
}

export function discoverProfiles({ rootOverrides = {}, includeFirefox = true } = {}) {
  const overrides = parseRootOverrides(rootOverrides);
  const browsers = [];
  const warnings = [];

  for (const browser of BROWSERS) {
    if (!includeFirefox && browser.family === "firefox") continue;
    const roots = overrides[browser.id] ? [overrides[browser.id]] : rootsFor(browser.id);
    const found = [];
    for (const root of roots) {
      if (!dirExists(root)) continue;
      let profiles;
      try {
        profiles =
          browser.family === "firefox"
            ? discoverFirefoxProfiles(root, browser)
            : discoverChromiumProfiles(root, browser);
      } catch (err) {
        warnings.push(`${browser.id}: failed to enumerate ${root}: ${err.message}`);
        continue;
      }
      for (const p of profiles) found.push(p);
    }
    browsers.push({
      id: browser.id,
      name: browser.name,
      family: browser.family,
      roots,
      installed: found.length > 0 || roots.some((r) => dirExists(r)),
      overridden: !!overrides[browser.id],
      profiles: found,
    });
  }

  return { generatedAt: new Date().toISOString(), platform: process.platform, browsers, warnings };
}

function discoverChromiumProfiles(root, browser) {
  const out = [];
  const localState = readJsonIfExists(path.join(root, "Local State"));
  const infoCache =
    localState && localState.profile && typeof localState.profile.info_cache === "object"
      ? localState.profile.info_cache
      : null;

  const candidates = [];
  if (infoCache) {
    for (const key of Object.keys(infoCache)) {
      if (!isSafeProfileDirName(key)) continue;
      const info = infoCache[key] && typeof infoCache[key] === "object" ? infoCache[key] : {};
      candidates.push({ dirName: key, label: typeof info.name === "string" && info.name ? info.name : key });
    }
  }
  if (candidates.length === 0) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !isSafeProfileDirName(ent.name)) continue;
      const p = path.join(root, ent.name);
      if (fileExists(path.join(p, "Preferences")) || fileExists(path.join(p, "Bookmarks"))) {
        candidates.push({ dirName: ent.name, label: ent.name });
      }
    }
  }

  for (const candidate of candidates) {
    const profilePath = path.join(root, candidate.dirName);
    if (!dirExists(profilePath)) continue;
    out.push({
      id: `${browser.id}:${candidate.dirName}`,
      browserId: browser.id,
      browserName: browser.name,
      family: browser.family,
      dirName: candidate.dirName,
      label: candidate.label,
      path: profilePath,
      root,
      lastModified: lastModifiedOf(profilePath),
      running: detectChromiumRunning(profilePath),
      files: chromiumProfileFiles(profilePath),
    });
  }
  return out;
}

function isSafeProfileDirName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function chromiumProfileFiles(profilePath) {
  const files = {};
  // Modern Chromium/Chrome/Edge keep cookies under Network/, older builds and
  // some test fixtures keep them at the profile root. The public key stays
  // "Cookies" so inventory/export code has one stable name.
  for (const [relative, label] of [
    [path.join("Network", "Cookies"), "Network/Cookies"],
    ["Cookies", "Cookies"],
  ]) {
    const p = path.join(profilePath, relative);
    if (!fileExists(p)) continue;
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {}
    files.Cookies = { path: p, size, location: label };
    break;
  }
  const names = [
    "Bookmarks",
    "Bookmarks.bak",
    "History",
    "Login Data",
    "Login Data For Account",
    "Web Data",
    "Preferences",
    "Secure Preferences",
    "EncryptedBookmarks2",
    "AccountBookmarks",
    "EncryptedAccountBookmarks2",
  ];
  for (const name of names) {
    const p = path.join(profilePath, name);
    if (!fileExists(p)) continue;
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {}
    files[name] = { path: p, size };
  }
  for (const dirName of ["Extensions", "Sessions", "Local Storage", "IndexedDB", "Network"]) {
    const p = path.join(profilePath, dirName);
    if (dirExists(p)) files[dirName] = { path: p, directory: true };
  }
  return files;
}

function detectChromiumRunning(profilePath) {
  for (const name of ["SingletonLock", "SingletonCookie"]) {
    const p = path.join(profilePath, name);
    try {
      fs.lstatSync(p);
      return { running: true, evidence: name };
    } catch {}
  }
  return { running: false, evidence: null };
}

function discoverFirefoxProfiles(root, browser) {
  const out = [];
  const iniPath = path.join(root, "profiles.ini");
  if (!fileExists(iniPath)) return out;
  const sections = parseIni(fs.readFileSync(iniPath, "utf8"));
  const installDefaults = new Set();
  for (const section of sections) {
    if (section.name.startsWith("Install") && section.values.Default) {
      installDefaults.add(section.values.Default);
    }
  }
  for (const section of sections) {
    if (!section.name.startsWith("Profile")) continue;
    const rel = section.values.Path;
    if (!rel) continue;
    const resolved = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!dirExists(resolved)) continue;
    const dirName = path.basename(resolved);
    out.push({
      id: `firefox:${dirName}`,
      browserId: browser.id,
      browserName: browser.name,
      family: "firefox",
      dirName,
      label: section.values.Name || dirName,
      path: resolved,
      root,
      isDefault: section.values.Default === "1" || installDefaults.has(rel),
      lastModified: lastModifiedOf(resolved),
      running: detectFirefoxRunning(resolved),
      files: firefoxProfileFiles(resolved),
    });
  }
  return out;
}

function parseIni(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = { name: line.slice(1, -1), values: {} };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0 || !current) continue;
    current.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

function firefoxProfileFiles(profilePath) {
  const files = {};
  for (const name of [
    "places.sqlite",
    "cookies.sqlite",
    "logins.json",
    "logins-backup.json",
    "key4.db",
    "formhistory.sqlite",
    "prefs.js",
    "sessionstore.jsonlz4",
  ]) {
    const p = path.join(profilePath, name);
    if (!fileExists(p)) continue;
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {}
    files[name] = { path: p, size };
  }
  for (const dirName of ["extensions", "sessionstore-backups"]) {
    const p = path.join(profilePath, dirName);
    if (dirExists(p)) files[dirName] = { path: p, directory: true };
  }
  return files;
}

function detectFirefoxRunning(profilePath) {
  const lock = path.join(profilePath, "parent.lock");
  try {
    fs.lstatSync(lock);
    return { running: true, evidence: "parent.lock" };
  } catch {}
  return { running: false, evidence: null };
}

function lastModifiedOf(p) {
  try {
    const st = fs.statSync(p);
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

// Best-effort Windows process probe. Read-only: it enumerates process command
// lines and never signals/kills anything.
export function probeBrowserProcesses({ timeoutMs = 5000 } = {}) {
  if (process.platform !== "win32") return { ok: false, error: "unsupported-platform", processes: [] };
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe' or Name='firefox.exe'\" | " +
    "Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    ).trim();
    if (!out) return { ok: true, processes: [] };
    const parsed = JSON.parse(out);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, processes: arr };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), processes: [] };
  }
}

function defaultRootsForExecutable(exePath) {
  const p = String(exePath || "").toLowerCase();
  if (p.includes("brave")) return rootsFor("brave");
  if (p.includes("microsoft\\edge") || p.includes("microsoft edge")) return rootsFor("edge");
  if (p.includes("google\\chrome")) return rootsFor("chrome");
  if (p.includes("chromium")) return rootsFor("chromium");
  if (p.includes("firefox")) return rootsFor("firefox");
  return [];
}

// Returns {inUse: true|false|null, evidence}. null means "could not determine".
export function profileInUseByProcess(targetProfile) {
  const probe = probeBrowserProcesses();
  if (!probe.ok) return { inUse: null, evidence: probe.error };
  for (const proc of probe.processes) {
    const cmd = String(proc.CommandLine || "");
    const m = cmd.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/i);
    if (m) {
      const udd = m[1] || m[2];
      if (isPathInside(udd, targetProfile) || samePath(udd, path.dirname(targetProfile))) {
        return { inUse: true, evidence: `pid ${proc.ProcessId} --user-data-dir` };
      }
      continue;
    }
    // Conservative fallback: a chrome.exe without --user-data-dir may be a
    // Chromium/Browser CLI build whose install path we cannot map. If the
    // target lives under the default Chromium user data root, treat it as in
    // use rather than risk a concurrent write.
    if (/chrome\.exe$/i.test(String(proc.ExecutablePath || ""))) {
      for (const root of rootsFor("chromium")) {
        if (isPathInside(root, targetProfile)) {
          return { inUse: true, evidence: `pid ${proc.ProcessId} default Chromium user data dir` };
        }
      }
    }
    for (const root of defaultRootsForExecutable(proc.ExecutablePath)) {
      if (isPathInside(root, targetProfile)) {
        return { inUse: true, evidence: `pid ${proc.ProcessId} default user data dir` };
      }
    }
  }
  return { inUse: false, evidence: null };
}

export function isInsideRealSourceBrowserRoot(targetProfile) {
  for (const { browserId, root } of allDefaultRoots()) {
    if (browserId === "chromium") continue; // Browser CLI's own default root is a valid target.
    if (isPathInside(root, targetProfile)) return { inside: true, browserId, root };
  }
  return { inside: false };
}

// Build a profile descriptor for an explicitly supplied profile path.
// Used by --source-profile to support fixtures and non-standard installs.
export function profileFromPath(browserId, profilePath) {
  const browser = browserById(browserId);
  if (!browser) return null;
  const resolved = path.resolve(profilePath);
  if (!dirExists(resolved)) return null;
  const family = browser.family;
  return {
    id: `${browserId}:custom:${path.basename(resolved)}`,
    browserId,
    browserName: browser.name,
    family,
    dirName: path.basename(resolved),
    label: path.basename(resolved),
    path: resolved,
    root: path.dirname(resolved),
    lastModified: lastModifiedOf(resolved),
    running: family === "firefox" ? detectFirefoxRunning(resolved) : detectChromiumRunning(resolved),
    files: family === "firefox" ? firefoxProfileFiles(resolved) : chromiumProfileFiles(resolved),
  };
}
