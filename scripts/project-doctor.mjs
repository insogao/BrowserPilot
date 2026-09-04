import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "docs", "owner", "STRUCTURE.json");
const failures = [];
const warnings = [];

function fail(message) { failures.push(message); }
function warn(message) { warnings.push(message); }
function read(relative) { return fs.readFileSync(path.join(root, relative), "utf8"); }
function exists(relative) { return fs.existsSync(path.join(root, relative)); }

if (!exists("AGENTS.md")) fail("missing owner router: AGENTS.md");
if (!fs.existsSync(manifestPath)) fail("missing docs/owner/STRUCTURE.json");

let structure;
try {
  structure = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail("invalid STRUCTURE.json: " + error.message);
  structure = { docs: [], commands: [], requiredTemplateFiles: [], retiredPhrases: [], ignoredScanDirectories: [] };
}

for (const relative of structure.docs ?? []) {
  if (!exists(relative)) {
    fail("missing declared doc: " + relative);
    continue;
  }
  if (relative.endsWith(".md") && relative !== "registry/templates/README.md" && !read(relative).startsWith("---\n")) {
    fail("missing provenance frontmatter: " + relative);
  }
}

let pkg = { scripts: {} };
try { pkg = JSON.parse(read("package.json")); } catch (error) { fail("invalid package.json: " + error.message); }
for (const command of structure.commands ?? []) {
  if (!pkg.scripts?.[command]) fail("missing package script: " + command);
}

const templatesRoot = path.join(root, "registry", "templates");
if (fs.existsSync(templatesRoot)) {
  for (const entry of fs.readdirSync(templatesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(templatesRoot, entry.name);
    if (!fs.existsSync(path.join(packageRoot, "template.json"))) continue;
    for (const relative of structure.requiredTemplateFiles ?? []) {
      if (!fs.existsSync(path.join(packageRoot, relative))) fail(`template ${entry.name} missing ${relative}`);
    }
  }
}

function walk(directory, ignored) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(absolute, ignored));
    else if (/\.(md|json|mjs|js|ts|html)$/i.test(entry.name)) found.push(absolute);
  }
  return found;
}

const scanFiles = walk(root, new Set(structure.ignoredScanDirectories ?? []));
for (const absolute of scanFiles) {
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  const content = fs.readFileSync(absolute, "utf8");
  for (const phrase of structure.retiredPhrases ?? []) {
    if (content.includes(phrase) && relative !== "docs/owner/STRUCTURE.json") fail(`retired phrase in ${relative}: ${phrase}`);
  }
  if (/github_pat_[A-Za-z0-9_]{20,}/.test(content)) fail("possible GitHub PAT in " + relative);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) fail("possible private key in " + relative);
}

const handoff = "docs/owner/NEXT-SESSION.md";
if (exists(handoff)) {
  const match = read(handoff).match(/stale_after:\s*(\d{4}-\d{2}-\d{2})/);
  if (match && Date.parse(match[1] + "T23:59:59Z") < Date.now()) warn("NEXT-SESSION.md is stale");
}

try {
  const sitePlan = JSON.parse(read("scripts/site-regression-plan.json"));
  const productIds = sitePlan.productSites.map((item) => item.templateId);
  if (new Set(productIds).size !== productIds.length) fail("duplicate product site templateId in site regression plan");
  for (const id of sitePlan.runtimeOrder) {
    if (!exists(`registry/templates/${id}/template.json`)) fail("runtime regression target has no package: " + id);
  }
  for (const id of sitePlan.builtinOrder) {
    if (!exists(`tests/site-smoke/${id}.json`)) fail("builtin regression target has no smoke contract: " + id);
  }
  for (const item of sitePlan.productSites) {
    const scheduled = item.kind === "builtin"
      ? sitePlan.builtinOrder.includes(item.templateId)
      : sitePlan.runtimeOrder.includes(item.templateId);
    if (!scheduled) fail("product site is missing from regression order: " + item.templateId);
  }
} catch (error) {
  fail("invalid site regression plan: " + error.message);
}

for (const message of warnings) console.warn("WARN " + message);
for (const message of failures) console.error("FAIL " + message);
if (failures.length) {
  console.error(`BrowserPilot doctor failed: ${failures.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`BrowserPilot doctor passed: ${structure.docs.length} docs, ${structure.commands.length} commands, ${warnings.length} warning(s)`);
