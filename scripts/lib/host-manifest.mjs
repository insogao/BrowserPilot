// Native Messaging host manifest 的唯一 JS 真源工具。
//
// 规则（见 AGENTS.md / docs/p1-native-messaging-2026-10-28.md）：
// - 仓库只 tracked “模板”，不 tracked 任何机器相关的绝对 exe 路径；
// - `native-host/host.manifest.json` 是生成物（.gitignore），由 build-host.mjs
//   或 register.ps1 用实际构建出的 exe 路径重新生成；
// - `allowed_origins` 必须由扩展 manifest.json 的 key 推导，禁止手写第二份 ID。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HOST_NAME = "com.browserpilot.browseragent";
export const HOST_DESCRIPTION = "BrowserPilot native messaging host";
export const TEMPLATE_REL = path.join("native-host", "host.manifest.template.json");
export const GENERATED_REL = path.join("native-host", "host.manifest.json");
export const HOST_EXE_PLACEHOLDER = "__HOST_EXE__";
export const EXTENSION_ID_PLACEHOLDER = "__EXTENSION_ID__";

/** Chrome 扩展 ID 推导：sha256(DER SPKI) 前 32 个 hex 位，0-9a-f 映射为 a-p。 */
export function extensionIdFromKey(key) {
  const hex = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
  return [...hex.slice(0, 32)].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");
}

export function extensionIdFromRepo(root) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof manifest.key !== "string" || !manifest.key) {
    throw new Error("manifest.json 缺少 key，无法推导稳定扩展 ID: " + manifestPath);
  }
  return extensionIdFromKey(manifest.key);
}

export function templatePath(root) {
  return path.join(root, TEMPLATE_REL);
}

export function generatedManifestPath(root) {
  return path.join(root, GENERATED_REL);
}

/** 读取模板并把占位符替换成真实值；不落盘。 */
export function renderHostManifest({ root, hostPath, extensionId }) {
  const file = templatePath(root);
  const template = JSON.parse(fs.readFileSync(file, "utf8"));
  if (template.name !== HOST_NAME) {
    throw new Error("host manifest 模板 name 必须是 " + HOST_NAME + "，实际 " + JSON.stringify(template.name));
  }
  if (template.type !== "stdio") {
    throw new Error("host manifest 模板 type 必须是 stdio，实际 " + JSON.stringify(template.type));
  }
  const resolvedHostPath = path.resolve(hostPath);
  const origins = Array.isArray(template.allowed_origins) ? template.allowed_origins : [];
  if (origins.length !== 1 || origins[0] !== "chrome-extension://" + EXTENSION_ID_PLACEHOLDER + "/") {
    throw new Error(
      "host manifest 模板 allowed_origins 必须是单个占位符 chrome-extension://" +
        EXTENSION_ID_PLACEHOLDER +
        "/，实际 " +
        JSON.stringify(origins),
    );
  }
  return {
    name: HOST_NAME,
    description: typeof template.description === "string" && template.description ? template.description : HOST_DESCRIPTION,
    path: resolvedHostPath,
    type: "stdio",
    allowed_origins: ["chrome-extension://" + extensionId + "/"],
  };
}

/** 校验最终 manifest 的每个硬性字段；返回规范化后的对象。 */
export function validateHostManifest(manifest, { hostPath, extensionId }) {
  if (!manifest || typeof manifest !== "object") throw new Error("host manifest 不是对象");
  if (manifest.name !== HOST_NAME) throw new Error("host manifest name 不匹配: " + JSON.stringify(manifest.name));
  if (manifest.type !== "stdio") throw new Error("host manifest type 必须是 stdio: " + JSON.stringify(manifest.type));
  if (typeof manifest.path !== "string" || !path.isAbsolute(manifest.path)) {
    throw new Error("host manifest path 必须是绝对路径: " + JSON.stringify(manifest.path));
  }
  if (path.resolve(manifest.path) !== path.resolve(hostPath)) {
    throw new Error("host manifest path 与实际 exe 不一致: " + manifest.path + " != " + path.resolve(hostPath));
  }
  const expected = "chrome-extension://" + extensionId + "/";
  if (!Array.isArray(manifest.allowed_origins) || manifest.allowed_origins.length !== 1 || manifest.allowed_origins[0] !== expected) {
    throw new Error("host manifest allowed_origins 与扩展 ID 不一致：期望 " + expected + "，实际 " + JSON.stringify(manifest.allowed_origins));
  }
  return manifest;
}

export function hasUtf8Bom(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(3);
    const read = fs.readSync(fd, buf, 0, 3, 0);
    return read === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  } finally {
    fs.closeSync(fd);
  }
}

/** BOM-free UTF-8 + 原子替换（Windows 上别的进程可能正读 manifest）。 */
export function writeUtf8NoBomAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o644 });
  fs.renameSync(tmp, file);
}

/** 生成 `native-host/host.manifest.json` 并返回 manifest 对象。 */
export function writeGeneratedManifest({ root, hostPath, extensionId }) {
  const manifest = validateHostManifest(renderHostManifest({ root, hostPath, extensionId }), { hostPath, extensionId });
  const file = generatedManifestPath(root);
  writeUtf8NoBomAtomic(file, JSON.stringify(manifest, null, 2) + "\n");
  if (hasUtf8Bom(file)) throw new Error("生成的 host manifest 含 UTF-8 BOM: " + file);
  const reparsed = JSON.parse(fs.readFileSync(file, "utf8"));
  validateHostManifest(reparsed, { hostPath, extensionId });
  return { file, manifest: reparsed };
}

/** 从模板/生成物中读出扩展 ID；占位符或读不到时返回 undefined。 */
export function registeredIdFromHostManifest(root) {
  for (const candidate of [generatedManifestPath(root), templatePath(root)]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const origin = Array.isArray(parsed.allowed_origins) ? parsed.allowed_origins[0] : "";
      const match = String(origin).match(/^chrome-extension:\/\/([a-p]{32})\/$/);
      if (match) return match[1];
    } catch {
      // 尝试下一个来源
    }
  }
  return undefined;
}

/** 找出最新构建的 host exe（build-host.mjs 每次输出版本化文件名）。 */
export function findNewestHostExe(root) {
  const dir = path.join(root, "native-host", "dist");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /^browserpilot-host(?:-\d+)?\.exe$/i.test(entry.name))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file;
}
