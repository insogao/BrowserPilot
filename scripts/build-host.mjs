// 把 native host 打包成单文件 exe（Node SEA，含 postject 注入）。
// 运行：node scripts/build-host.mjs
//
// manifest 不再 tracked 机器绝对路径：本脚本从 host.manifest.template.json 生成
// native-host/host.manifest.json（BOM-free UTF-8），path 指向本次构建的 exe，
// allowed_origins 由 manifest.json 的 key 推导。
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  extensionIdFromRepo,
  generatedManifestPath,
  writeGeneratedManifest,
} from "./lib/host-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "native-host", "dist");
const cjs = path.join(outDir, "host.cjs");
const blob = path.join(outDir, "sea-prep.blob");
// Windows 会锁定正在运行的 native host exe。每次输出版本化文件并原子切换 manifest，
// Chrome 下次自动重连时直接启动新版，无需关闭 Chrome 或人工点击。
const exe = path.join(outDir, "browserpilot-host-" + Date.now() + ".exe");
const seaConfig = path.join(outDir, "sea-config.json");
const authFile = path.join(root, "native-host", "auth.json");
const buildToken = crypto.randomBytes(24).toString("hex");
const extensionId = extensionIdFromRepo(root);

fs.mkdirSync(outDir, { recursive: true });

// 1) bundle -> cjs
await build({
  entryPoints: [path.join(root, "native-host", "host.js")],
  outfile: cjs,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: { __BP_BUILD_TOKEN__: JSON.stringify(buildToken) },
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

if (!fs.existsSync(exe)) throw new Error("构建后找不到 host exe: " + exe);
const { file: manifestFile } = writeGeneratedManifest({ root, hostPath: exe, extensionId });
fs.writeFileSync(authFile, JSON.stringify({ authToken: buildToken, builtAt: Date.now() }, null, 2), { mode: 0o600 });

console.log("[build:host] done -> " + exe);
console.log("[build:host] extensionId -> " + extensionId);
console.log("[build:host] manifest (BOM-free, generated) -> " + manifestFile);
if (!fs.existsSync(generatedManifestPath(root))) throw new Error("manifest 生成失败");
