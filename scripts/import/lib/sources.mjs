// Product source selection for cookie import.
//
// The CLI can enumerate Chrome/Edge profiles and let the user pick the profile
// they will open for the source extension. It cannot cryptographically bind the
// extension to that path: the extension runs in whatever profile the user
// actually opened. The selection is therefore an onboarding/confirmation step,
// not an authorization check. The extension's own consent + domain selection is
// the authoritative scope.
import path from "node:path";
import { discoverProfiles } from "./browsers.mjs";

export const COOKIE_SUPPORT = {
  chrome: "supported",
  edge: "supported",
  brave: "experimental",
  chromium: "experimental",
  firefox: "unsupported",
};

export function listSources({ rootOverrides = {} } = {}) {
  const discovery = discoverProfiles({ rootOverrides });
  const sources = [];
  for (const browser of discovery.browsers) {
    for (const profile of browser.profiles) {
      const support = COOKIE_SUPPORT[browser.id] || "unsupported";
      sources.push({
        id: `${browser.id}:${profile.dirName}`,
        browser: browser.id,
        browserName: browser.name,
        family: browser.family,
        label: profile.label,
        dirName: profile.dirName,
        path: profile.path,
        lastModified: profile.lastModified,
        running: !!(profile.running && profile.running.running),
        runningEvidence: profile.running ? profile.running.evidence : null,
        cookieStore: cookieStoreInfo(profile),
        cookieImport: support,
        readOnly: true,
      });
    }
  }
  const order = new Map([
    ["chrome", 0],
    ["edge", 1],
    ["brave", 2],
    ["chromium", 3],
    ["firefox", 4],
  ]);
  sources.sort(
    (a, b) =>
      (order.get(a.browser) ?? 99) - (order.get(b.browser) ?? 99) ||
      String(a.label).localeCompare(String(b.label)),
  );
  return {
    generatedAt: discovery.generatedAt,
    platform: discovery.platform,
    sources,
    warnings: discovery.warnings,
  };
}

function cookieStoreInfo(profile) {
  const entry = profile.files && profile.files.Cookies;
  if (!entry) return { present: false, path: null, location: null, size: 0 };
  return {
    present: true,
    path: entry.path,
    location: entry.location || path.basename(entry.path),
    size: entry.size || 0,
  };
}

export function findSource(sources, token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  return (
    sources.find((s) => s.id === raw) ||
    sources.find((s) => `${s.browser}:${s.dirName}` === raw) ||
    sources.find((s) => s.path === raw) ||
    null
  );
}

// Cookie-import readiness. Running is not a blocker: the source extension is
// how we read cookies, so the source browser normally is running.
export function cookieFlowReadiness(source) {
  if (!source) return { ok: false, code: "source-not-found", warnings: [] };
  if (source.cookieImport === "unsupported") {
    return {
      ok: false,
      code: "source-browser-unsupported",
      message: `${source.browserName} 的 Cookie 不能通过本流程迁移；请改用 Chrome/Edge 登录后重试，或在目标浏览器重新登录。`,
      warnings: [],
    };
  }
  const warnings = [];
  if (source.cookieImport === "experimental") {
    warnings.push(`${source.browserName} 未做产品级验证；本流程只保证 Chrome/Edge 的扩展路径。`);
  }
  if (!source.cookieStore.present) {
    warnings.push(
      "没有在常见位置发现 Cookies 数据库；这不影响扩展读取（扩展由浏览器自己解密），但请确认来源 Profile 正确。",
    );
  }
  if (source.running) {
    warnings.push("来源浏览器正在运行：这是运行来源扩展所必需的；本工具不会关闭或重启它。");
  }
  return { ok: true, warnings };
}

export function formatSourceLine(source, index) {
  const support = {
    supported: "支持",
    experimental: "实验性",
    unsupported: "不支持 Cookie",
  }[source.cookieImport] || source.cookieImport;
  const running = source.running ? "运行中" : "未运行";
  return `${index}. [${support}] ${source.browserName} / ${source.label} (${source.dirName}) — ${running} — ${source.path}`;
}
