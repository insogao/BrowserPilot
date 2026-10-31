// Filesystem helpers for the browser-data import MVP.
//
// Rules enforced here:
// - Source profiles are only ever read (readFile / readdir / stat / read-only
//   SQLite connections). No helper in this module opens a source path for
//   writing.
// - Target writes are atomic: temp file in the same directory, fsync, rename.
// - Personal-data bundle files are created with mode 0600 where the platform
//   supports it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readTextIfExists(p, maxBytes = 32 * 1024 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function readJsonIfExists(p, maxBytes = 32 * 1024 * 1024) {
  const text = readTextIfExists(p, maxBytes);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function sha256File(p) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function writeJsonFile(p, value) {
  writeFileAtomic(p, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export function writeJsonlFile(p, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileAtomic(p, body, { mode: 0o600 });
}

export function writeFileAtomic(p, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(p);
  ensureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(p)}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function backupFile(p, suffix = "bak") {
  if (!fileExists(p)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${p}.${suffix}.${stamp}`;
  fs.copyFileSync(p, target);
  return target;
}

export function uniquePath(baseDir, name) {
  let candidate = path.join(baseDir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${name} (${i})`);
    i += 1;
  }
  return candidate;
}

export function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function samePath(a, b) {
  const norm = (p) => {
    let r = path.resolve(p);
    if (process.platform === "win32") r = r.toLowerCase();
    return r;
  };
  return norm(a) === norm(b);
}
