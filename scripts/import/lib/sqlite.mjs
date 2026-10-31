// Read-only SQLite access for browser profile databases.
//
// We never open a source profile database in place: the file (plus any -wal /
// -shm / -journal sidecars) is copied into a private temp directory first, and
// the copy is opened with `PRAGMA query_only = ON`. This mirrors Chromium's own
// Firefox importer, which copies places.sqlite before reading it
// (chrome/utility/importer/firefox_importer.cc, GetCopiedSourcePath), and it
// guarantees that a running source browser cannot be disturbed by our reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDir } from "./fs-safe.mjs";

const SIDECARS = ["-wal", "-shm", "-journal"];

export function withReadOnlyCopy(dbPath, fn, { maxBytes = 4 * 1024 * 1024 * 1024 } = {}) {
  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch (err) {
    return { ok: false, error: `not-readable: ${err.code || err.message}` };
  }
  if (!stat.isFile()) return { ok: false, error: "not-a-file" };
  if (stat.size > maxBytes) return { ok: false, error: "database-too-large" };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-import-db-"));
  ensureDir(tmpDir);
  const copyPath = path.join(tmpDir, path.basename(dbPath));
  let db = null;
  try {
    fs.copyFileSync(dbPath, copyPath);
    for (const suffix of SIDECARS) {
      const sidecar = `${dbPath}${suffix}`;
      try {
        if (fs.statSync(sidecar).isFile()) fs.copyFileSync(sidecar, `${copyPath}${suffix}`);
      } catch {}
    }
    db = new DatabaseSync(copyPath);
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 2000");
    return { ok: true, value: fn(db) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    try {
      if (db) db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

export function tableExists(db, table) {
  try {
    const row = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(table);
    return !!row;
  } catch {
    return false;
  }
}

export function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
    return rows.map((r) => String(r.name));
  } catch {
    return [];
  }
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function queryAll(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    // Chromium/Firefox timestamps (microseconds since 1601/1970) exceed
    // Number.MAX_SAFE_INTEGER. Read all integers as BigInt to avoid driver
    // errors, then convert explicitly at the call sites.
    stmt.setReadBigInts(true);
    return { ok: true, rows: stmt.all(...params) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

export function queryOne(db, sql, params = []) {
  const res = queryAll(db, sql, params);
  if (!res.ok || res.rows.length === 0) return res;
  return { ok: true, row: res.rows[0] };
}

export function countRows(db, table) {
  if (!tableExists(db, table)) return null;
  const res = queryOne(db, `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
  return res.ok ? Number(res.row.n) : null;
}
