// 把 native host 打包成单文件 exe（Node SEA，含 postject 注入）。
// 运行：node scripts/build-host.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "native-host", "dist");
const cjs = path.join(outDir, "host.cjs");
const blob = path.join(outDir, "sea-prep.blob");
const exe = path.join(outDir, "egolite-host.exe");
const seaConfig = path.join(outDir, "sea-config.json");

fs.mkdirSync(outDir, { recursive: true });

// 1) bundle -> cjs
await build({
  entryPoints: [path.join(root, "native-host", "host.js")],
  outfile: cjs,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "info",
});

// 2) sea config
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: cjs, output: blob, disableExperimentalSEAWarning: true })
);

// 3) 生成 blob
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 4) 复制 node.exe 作为底座
fs.copyFileSync(process.execPath, exe);

// 5) postject 注入 blob
try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules", "postject", "dist", "cli.js"),
      exe,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { stdio: "inherit" }
  );
} catch (e) {
  // 某些 postject 版本入口位置不同，尝试 npx
  execFileSync("npx", ["postject", exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], {
    stdio: "inherit",
  });
}

console.log("[build:host] done -> " + exe);
