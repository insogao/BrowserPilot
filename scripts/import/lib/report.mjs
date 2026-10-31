// Local audit report for a cookie-import session.
//
// The report contains counts and codes only: no cookie names, values, domains
// or per-site URLs. Domains appear only after the user explicitly confirms a
// login check (loginChecks), mirroring the existing bundle result model.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonIfExists, writeJsonFile } from "./fs-safe.mjs";
import { applyLoginCheck, LOGIN_STATES } from "./verify.mjs";
import { CONTRACT_ID } from "../contract.mjs";

export const REPORT_KIND = "cookie-import";
export const REPORT_FORMAT = 1;

export function defaultReportDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "BrowserPilot", "import-reports");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "BrowserPilot", "import-reports");
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "BrowserPilot",
    "import-reports",
  );
}

export function createCookieImportReport({
  source,
  target,
  view = null,
  outcome = null,
  startedAt = null,
  consentAt = null,
  now = new Date(),
}) {
  const createdAt = now instanceof Date ? now.toISOString() : String(now);
  const cookieImported = view
    ? {
        status: view.cookieImported.status,
        applied: view.cookieImported.applied,
        failed: view.cookieImported.failed,
        failures: { ...view.cookieImported.failures },
      }
    : { status: "not_started", applied: 0, failed: 0, failures: {} };
  return {
    format: REPORT_FORMAT,
    kind: REPORT_KIND,
    contract: CONTRACT_ID,
    createdAt,
    startedAt,
    consentAt,
    source: {
      browser: source?.browser || "unknown",
      browserName: source?.browserName || "unknown",
      label: source?.label || null,
      dirName: source?.dirName || null,
    },
    target: {
      product: target?.product || "unknown",
      mode: target?.mode || "unknown",
      native: target?.native === true,
      persistAcrossRestart: target?.capabilities?.persistAcrossRestart === true,
    },
    job: {
      jobId: view?.jobId || null,
      state: view?.state || outcome || "unknown",
      totals: view
        ? {
            cookies: view.totals.cookies,
            domains: view.totals.domains,
            selectedDomains: view.totals.selectedDomains,
          }
        : { cookies: 0, domains: 0, selectedDomains: 0 },
      progress: view ? { applied: view.progress.applied, failed: view.progress.failed } : { applied: 0, failed: 0 },
    },
    dataCopied: { cookies: false },
    cookieImported,
    loginVerified: {
      status: "not_verified",
      confirmedDomains: 0,
      failedDomains: 0,
      note: "Cookie 写入不等于登录成功；只有用户本人在目标浏览器中确认后才能记录。",
    },
    loginChecks: [],
  };
}

export function writeCookieImportReport({ reportDir, report }) {
  const dir = reportDir ? path.resolve(reportDir) : defaultReportDir();
  ensureDir(dir);
  const stamp = String(report.createdAt || new Date().toISOString()).replace(/[:.]/g, "-");
  const jobPart = report.job?.jobId ? report.job.jobId.slice(0, 12) : crypto.randomBytes(4).toString("hex");
  const file = path.join(dir, `cookie-import-${stamp}-${jobPart}.json`);
  writeJsonFile(file, report);
  return { ok: true, path: file };
}

export function readReport(file) {
  const resolved = path.resolve(file);
  const report = readJsonIfExists(resolved, 4 * 1024 * 1024);
  if (!report) return { ok: false, error: "report-missing-or-invalid", path: resolved };
  return { ok: true, report, path: resolved };
}

export function confirmReportLogin({ reportPath, domain, status, note = "", confirmUserAction = false }) {
  if (!LOGIN_STATES.includes(status)) return { ok: false, error: "invalid-status" };
  const read = readReport(reportPath);
  if (!read.ok) return read;
  const applied = applyLoginCheck(read.report, { domain, status, note, confirmUserAction });
  if (!applied.ok) return applied;
  writeJsonFile(read.path, applied.result);
  return { ok: true, report: applied.result, path: read.path };
}

export function formatCookieImportReport(report) {
  const lines = [];
  lines.push(`source: ${report.source?.browserName || "?"} / ${report.source?.label || "?"}`);
  lines.push(
    `target: ${report.target?.product || "?"} (mode=${report.target?.mode || "?"}, ` +
      `native=${report.target?.native === true}, persistAcrossRestart=${report.target?.persistAcrossRestart === true})`,
  );
  lines.push(`job: ${report.job?.state || "unknown"}${report.job?.jobId ? ` (${report.job.jobId})` : ""}`);
  lines.push("data copied:");
  for (const [item, copied] of Object.entries(report.dataCopied || {})) {
    lines.push(`  ${item}: ${copied ? "copied" : "not copied"}`);
  }
  const c = report.cookieImported || {};
  lines.push(`cookies: ${c.status || "unknown"} (applied=${c.applied ?? 0}, failed=${c.failed ?? 0})`);
  for (const [code, count] of Object.entries(c.failures || {})) {
    lines.push(`  ${code}: ${count}`);
  }
  lines.push(`login verified: ${report.loginVerified?.status || "not_verified"}`);
  for (const check of report.loginChecks || []) {
    lines.push(`  ${check.domain}: ${check.status} (${check.at})`);
  }
  return lines.join("\n");
}
