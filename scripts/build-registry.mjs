import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const templatesRoot = path.join(root, "registry", "templates");
const catalogPath = path.join(root, "registry", "catalog.json");
const detailsRoot = path.join(root, "registry", "details");
const check = process.argv.includes("--check");

const validatorBundle = await build({
  entryPoints: [path.join(root, "src", "shared", "template-schema.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
const schema = await import("data:text/javascript;base64," + Buffer.from(validatorBundle.outputFiles[0].text).toString("base64"));

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function capabilities(template) {
  return template.steps === "commands" ? [...new Set(template.body.map((step) => step.name))].sort() : [template.steps];
}

function fingerprint(template, caps) {
  const semantic = {
    sites: [...(template.scope?.sites ?? [])].sort(),
    intents: [...template.discovery.intents].sort(),
    capabilities: caps,
    inputs: template.inputs.map((item) => item.name + ":" + item.type).sort(),
    outputs: template.discovery.outputs.map((item) => item.name + ":" + item.type).sort(),
  };
  return "sha256:" + crypto.createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

function detailMarkdown(template, entry, packageDir) {
  const readme = path.join(packageDir, "README.md");
  const extra = fs.existsSync(readme) ? fs.readFileSync(readme, "utf8").trim().replace(/^# .+\r?\n+/, "") : "";
  const lines = [
    "# " + template.name,
    "",
    "> " + template.description,
    "",
    "- ID: `" + template.id + "`",
    "- 版本: `" + template.version + "`",
    "- 风险: `" + template.discovery.risk + "`",
    "- 适用站点: " + ((template.scope?.sites ?? []).map((x) => "`" + x + "`").join(", ") || "无站点限制"),
    "- Intents: " + template.discovery.intents.map((x) => "`" + x + "`").join(", "),
    "- Capabilities: " + entry.capabilities.map((x) => "`" + x + "`").join(", "),
    "- 功能指纹: `" + entry.fingerprint + "`",
    "",
    "## 输入",
    "",
    ...(template.inputs.length ? template.inputs.map((x) => "- `" + x.name + "` (" + x.type + (x.required ? ", required" : "") + "): " + (x.description ?? "")) : ["无"]),
    "",
    "## 输出",
    "",
    ...(template.discovery.outputs.length ? template.discovery.outputs.map((x) => "- `" + x.name + "` (" + x.type + "): " + (x.description ?? "")) : ["无"]),
    "",
    "## 发现信息",
    "",
    "- Keywords: " + template.discovery.keywords.join(", "),
    "- Aliases: " + (template.discovery.aliases ?? []).join(", "),
    "- BrowserPilot: `" + (template.discovery.browserpilot ?? "未声明") + "`",
    "",
  ];
  if (extra) lines.push("## 详细说明", "", extra, "");
  lines.push("## 权威定义", "", "[`template.json`](../templates/" + path.basename(packageDir) + "/template.json)", "");
  return lines.join("\n") + "\n";
}

function relationAllowsDuplicate(a, b) {
  const refs = [...(a.discovery.alternatives ?? []), ...(a.discovery.replaces ?? [])];
  const back = [...(b.discovery.alternatives ?? []), ...(b.discovery.replaces ?? [])];
  return refs.includes(b.id) || back.includes(a.id);
}

function setOf(values) {
  return new Set(values.map((x) => String(x).toLowerCase()));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((x) => b.has(x)).length;
  return intersection / (a.size + b.size - intersection || 1);
}

function semanticSimilarity(a, b) {
  const intents = jaccard(setOf(a.intents), setOf(b.intents));
  const sites = jaccard(setOf(a.sites), setOf(b.sites));
  const caps = jaccard(setOf(a.capabilities), setOf(b.capabilities));
  const inputs = jaccard(setOf(a.inputs.map((x) => x.name + ":" + x.type)), setOf(b.inputs.map((x) => x.name + ":" + x.type)));
  const outputs = jaccard(setOf(a.outputs.map((x) => x.name + ":" + x.type)), setOf(b.outputs.map((x) => x.name + ":" + x.type)));
  return intents * 0.35 + sites * 0.2 + caps * 0.25 + ((inputs + outputs) / 2) * 0.2;
}

const manifestPaths = walk(templatesRoot).filter((file) => path.basename(file) === "template.json").sort();
assert.ok(manifestPaths.length, "registry 至少需要一个 template.json");
const ids = new Set();
const packages = [];
for (const manifestPath of manifestPaths) {
  const template = schema.validateTemplate(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  assert.ok(template.version, template.id + " 缺少 version");
  assert.ok(template.discovery, template.id + " 缺少 discovery");
  assert.ok(!ids.has(template.id), "重复模板 id: " + template.id);
  ids.add(template.id);
  const caps = capabilities(template);
  const packageDir = path.dirname(manifestPath);
  const entry = {
    id: template.id,
    name: template.name,
    version: template.version,
    path: slash(path.relative(root, manifestPath)),
    detailsPath: "registry/details/" + template.id + ".md",
    description: template.description,
    category: template.category,
    sites: template.scope?.sites ?? [],
    intents: template.discovery.intents,
    keywords: template.discovery.keywords,
    capabilities: caps,
    inputs: template.inputs.map(({ name, type, required, description }) => ({ name, type, required: !!required, description: description ?? "" })),
    outputs: template.discovery.outputs,
    risk: template.discovery.risk,
    aliases: template.discovery.aliases ?? [],
    deprecated: !!template.discovery.deprecated,
    supersededBy: template.discovery.supersededBy,
    fingerprint: fingerprint(template, caps),
  };
  packages.push({ template, entry, packageDir });
}

for (let i = 0; i < packages.length; i++) {
  for (let j = i + 1; j < packages.length; j++) {
    const similarity = semanticSimilarity(packages[i].entry, packages[j].entry);
    if (similarity >= 0.9 && !relationAllowsDuplicate(packages[i].template, packages[j].template)) {
      throw new Error("检测到未声明关系的高相似模板(" + similarity.toFixed(3) + "): " + packages[i].template.id + " / " + packages[j].template.id);
    }
  }
}

const catalog = JSON.stringify({ schemaVersion: 2, generatorVersion: 1, templates: packages.map((x) => x.entry) }, null, 2) + "\n";
const outputs = new Map([[catalogPath, catalog]]);

function indexMarkdown(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const cat = entry.category || "generic";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(entry);
  }
  const lines = [
    "# 模板一览（自动生成）",
    "",
    "> 由 `npm run registry:build` 生成，**勿手改**。权威定义在各自包内 `template.json`；机器可读目录为 [`registry/catalog.json`](./catalog.json)，逐模板详情在 [`registry/details/`](./details/)。",
    "> 共 " + entries.length + " 个模板。",
    "",
  ];
  for (const [cat, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push("## " + cat, "", "| 模板 ID | 名称 | 版本 | 功能 | 风险 | 包目录 |", "|---|---|---|---|---|---|");
    for (const e of items.sort((a, b) => a.id.localeCompare(b.id))) {
      const dir = "templates/" + e.id + "/";
      lines.push("| `" + e.id + "` | " + e.name + " | " + e.version + " | " + e.description + " | " + e.risk + " | [" + dir + "](" + dir + ") |");
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
outputs.set(path.join(root, "registry", "INDEX.md"), indexMarkdown(packages.map((x) => x.entry)));

for (const item of packages) outputs.set(path.join(detailsRoot, item.template.id + ".md"), detailMarkdown(item.template, item.entry, item.packageDir));

if (check) {
  for (const [file, expected] of outputs) {
    assert.ok(fs.existsSync(file), "缺少生成文件: " + path.relative(root, file));
    assert.equal(fs.readFileSync(file, "utf8"), expected, "生成文件已过期: " + path.relative(root, file));
  }
  console.log("PASS registry: schema + catalog + details + duplicate fingerprints");
} else {
  fs.mkdirSync(detailsRoot, { recursive: true });
  for (const [file, content] of outputs) fs.writeFileSync(file, content, "utf8");
  console.log("[registry] generated " + outputs.size + " files for " + packages.length + " templates");
}
