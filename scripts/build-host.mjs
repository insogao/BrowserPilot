// 把 native host 打包成单文件 exe（Node SEA，含 postject 注入）。
// 运行：node scripts/build-host.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "native-host", "dist");
const cjs = path.join(outDir, "host.cjs");
const blob = path.join(outDir, "sea-prep.blob");
// Windows 会锁定正在运行的 native host exe。每次输出版本化文件并原子切换 manifest，
// Chrome 下次自动重连时直接启动新版，无需关闭 Chrome 或人工点击。
const exe = path.join(outDir, "browserpilot-host-" + Date.now() + ".exe");
const seaConfig = path.join(outDir, "sea-config.json");
const hostManifest = path.join(root, "native-host", "host.manifest.json");
const authFile = path.join(root, "native-host", "auth.json");
const buildToken = crypto.randomBytes(24).toString("hex");

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

const manifest = fs.existsSync(hostManifest)
  ? JSON.parse(fs.readFileSync(hostManifest, "utf8"))
  : {
      name: "com.browserpilot.browseragent",
      description: "BrowserPilot native messaging host",
      type: "stdio",
      allowed_origins: ["chrome-extension://nnollghpaggbcdkkgoieneffnlijinio/"],
    };
manifest.path = exe;
const tmpManifest = hostManifest + ".tmp";
fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), "utf8");
fs.renameSync(tmpManifest, hostManifest);
fs.writeFileSync(authFile, JSON.stringify({ authToken: buildToken, builtAt: Date.now() }, null, 2), { mode: 0o600 });
console.log("[build:host] done -> " + exe);
console.log("[build:host] manifest switched -> " + hostManifest);
