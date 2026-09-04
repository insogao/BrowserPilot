import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const browserLeasePath = path.join(os.tmpdir(), "browserpilot-browser-test-lease.json");
export const DEFAULT_BROWSER_LEASE_TTL_MS = 10 * 60 * 1000;

export function readBrowserLease() {
  try {
    return JSON.parse(fs.readFileSync(browserLeasePath, "utf8"));
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isBrowserLeaseActive(lease = readBrowserLease(), at = Date.now()) {
  return Boolean(lease?.token && Number(lease.expiresAt) > at && isProcessAlive(Number(lease.pid)));
}

export function acquireBrowserLease(owner, scope, ttlMs = DEFAULT_BROWSER_LEASE_TTL_MS) {
  if (!owner || !scope || !Number.isFinite(ttlMs) || ttlMs < 30_000) {
    throw new Error("browser lease requires owner, scope, and ttl >= 30 seconds");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = readBrowserLease();
    if (isBrowserLeaseActive(current)) {
      throw new Error(
        "browser lease active: owner=" + current.owner +
        " scope=" + current.scope +
        " expiresAt=" + new Date(current.expiresAt).toISOString(),
      );
    }

    if (current) {
      try { fs.unlinkSync(browserLeasePath); } catch {}
    }

    const startedAt = Date.now();
    const lease = {
      token: crypto.randomBytes(18).toString("hex"),
      owner,
      scope,
      startedAt,
      expiresAt: startedAt + ttlMs,
      pid: process.pid,
    };
    try {
      fs.writeFileSync(browserLeasePath, JSON.stringify(lease, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      return lease;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 1) throw error;
    }
  }
  throw new Error("browser lease unavailable");
}

export function releaseBrowserLease(token) {
  const current = readBrowserLease();
  if (!current || current.token !== token) return false;
  try {
    fs.unlinkSync(browserLeasePath);
    return true;
  } catch {
    return false;
  }
}
