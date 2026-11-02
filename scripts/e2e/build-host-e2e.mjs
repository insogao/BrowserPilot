#!/usr/bin/env node
// Build the BrowserPilot native messaging host into an isolated directory for
// E2E runs. Unlike scripts/build-host.mjs this never touches the repository's
// native-host/host.manifest.json or auth.json: the E2E harness writes its own
// temporary host manifest and registers it under a test-only registry key.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.out) {
  console.error("usage: build-host-e2e.mjs --out <dir>");
  process.exit(2);
}
const outDir = path.resolve(String(args.out));
fs.mkdirSync(outDir, { recursive: true });
const cjs = path.join(outDir, "host.cjs");
const blob = path.join(outDir, "sea-prep.blob");
const exe = path.join(outDir, "browserpilot-host-e2e.exe");
const seaConfig = path.join(outDir, "sea-config.json");

await build({
  entryPoints: [path.join(REPO, "native-host", "host.js")],
  outfile: cjs,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: { __BP_BUILD_TOKEN__: JSON.stringify("e2e-temporary-token") },
  logLevel: "silent",
});
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: cjs, output: blob, disableExperimentalSEAWarning: true }),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "ignore" });
fs.copyFileSync(process.execPath, exe);
execFileSync(
  process.execPath,
  [
    path.join(REPO, "node_modules", "postject", "dist", "cli.js"),
    exe,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "ignore" },
);
process.stdout.write(exe + "\n");
