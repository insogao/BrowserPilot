#!/usr/bin/env node
// Keep the extension's copy of the cookie-import contract byte-identical to
// the canonical Node module. The extension cannot import files outside its
// package root, so the contract is copied instead of symlinked.
//
// Usage:
//   node scripts/import/sync-extension-contract.mjs          # copy
//   node scripts/import/sync-extension-contract.mjs --check  # verify only
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SOURCE = path.join(HERE, "contract.mjs");
const TARGET = path.join(REPO, "extensions", "import-source", "lib", "contract.mjs");
const checkOnly = process.argv.includes("--check");

const sourceText = fs.readFileSync(SOURCE, "utf8");

if (checkOnly) {
  let targetText = null;
  try {
    targetText = fs.readFileSync(TARGET, "utf8");
  } catch {
    console.error(`contract copy missing: ${TARGET}`);
    console.error("run: node scripts/import/sync-extension-contract.mjs");
    process.exit(1);
  }
  if (targetText !== sourceText) {
    console.error(`contract copy is out of date: ${TARGET}`);
    console.error("run: node scripts/import/sync-extension-contract.mjs");
    process.exit(1);
  }
  console.log("contract copy is in sync");
} else {
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, sourceText);
  console.log(`contract copied -> ${path.relative(REPO, TARGET)}`);
}
