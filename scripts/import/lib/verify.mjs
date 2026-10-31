// Record the third state: "actual page login verified".
//
// The tool never checks a website itself and never infers a login from cookie
// counts. Only an explicit user action may mark a domain as verified; the CLI
// requires both --confirm-user-action and --status user_confirmed.
import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, writeJsonFile } from "./fs-safe.mjs";

export const LOGIN_STATES = ["not_verified", "user_confirmed", "failed"];

export function readResult(bundleDir) {
  const resultPath = path.join(bundleDir, "result.json");
  const result = readJsonIfExists(resultPath, 4 * 1024 * 1024);
  if (!result) return { ok: false, error: "result-missing" };
  return { ok: true, result, resultPath };
}

export function recordLoginCheck({ bundleDir, domain, status, note = "", confirmUserAction = false }) {
  if (!LOGIN_STATES.includes(status)) return { ok: false, error: "invalid-status" };
  if (!domain || typeof domain !== "string" || domain.length > 255) return { ok: false, error: "invalid-domain" };
  if (status === "user_confirmed" && !confirmUserAction) {
    return {
      ok: false,
      error: "explicit-user-action-required",
      message:
        "Refusing to claim a verified login automatically. Re-run with --confirm-user-action after you personally " +
        "opened the site in the target browser and confirmed the session.",
    };
  }
  const read = readResult(bundleDir);
  if (!read.ok) return read;
  const result = read.result;
  result.loginChecks = Array.isArray(result.loginChecks) ? result.loginChecks : [];
  result.loginChecks.push({
    domain,
    status,
    note: note ? String(note).slice(0, 500) : undefined,
    at: new Date().toISOString(),
    by: "user",
  });
  const confirmed = result.loginChecks.filter((c) => c.status === "user_confirmed").length;
  const failed = result.loginChecks.filter((c) => c.status === "failed").length;
  result.loginVerified = {
    status: confirmed > 0 ? (failed > 0 ? "partially_verified" : "user_confirmed") : failed > 0 ? "failed" : "not_verified",
    confirmedDomains: confirmed,
    failedDomains: failed,
    note:
      "Only domains explicitly confirmed by the user are counted. 'Cookie imported' and 'data copied' are never " +
      "treated as proof of a working login.",
  };
  writeJsonFile(read.resultPath, result);
  return { ok: true, result, resultPath: read.resultPath };
}

export function formatResult(result) {
  const lines = [];
  lines.push(`target: ${result.targetProfile || "(not applied)"}`);
  lines.push("data copied:");
  for (const [item, copied] of Object.entries(result.dataCopied || {})) {
    lines.push(`  ${item}: ${copied ? "copied" : "not copied"}`);
  }
  lines.push(`cookies: ${result.cookieImported?.status || "unknown"}`);
  lines.push(`login verified: ${result.loginVerified?.status || "not_verified"}`);
  for (const check of result.loginChecks || []) {
    lines.push(`  ${check.domain}: ${check.status} (${check.at})`);
  }
  return lines.join("\n");
}
