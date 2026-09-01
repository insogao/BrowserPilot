// 开发热更新：改 src/ → 自动重建 dist → 自动触发扩展 SW reload。
// 用法：node scripts/dev.mjs [--no-reload]
// 原理：fs.watch src/ → context.rebuild() 精确重建 → 找存活 host → 发 reload。
//       SW reload 后 native messaging 断、host 由 Chrome 重新拉起（端口可能变）；
//       reload 由「当前存活 host」执行，之后 export_guide 会给出最新端口。
import { context } from "esbuild";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "dist");
const srcDir = path.join(root, "src");
const NO_RELOAD = process.argv.includes("--no-reload");

const entries = [
  { src: "src/background/index.ts", out: "background.js" },
  { src: "src/content/bridge.ts", out: "content/bridge.js" },
  { src: "src/popup/index.ts", out: "popup/index.js" },
  { src: "src/onboarding/index.ts", out: "onboarding/index.js" },
  { src: "src/kernel/kernel.ts", out: "kernel/kernel.js" },
  { src: "src/offscreen/offscreen.ts", out: "offscreen/offscreen.js" },
];

function copyStatic(src, dest) {
  const from = path.join(root, src);
  if (!fs.existsSync(from)) return;
  const to = path.join(outdir, dest);
  const st = fs.lstatSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      const s2 = path.join(from, entry);
      const d2 = path.join(to, entry);
      const st2 = fs.lstatSync(s2);
      if (st2.isDirectory()) fs.cpSync(s2, d2, { recursive: true });
      else fs.copyFileSync(s2, d2);
    }
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}
function copyAllStatic() {
  copyStatic("manifest.json", "manifest.json");
  copyStatic("src/popup/index.html", "popup/index.html");
  copyStatic("src/onboarding/index.html", "onboarding/index.html");
  copyStatic("src/kernel/kernel.html", "kernel/kernel.html");
  copyStatic("src/offscreen/offscreen.html", "offscreen/offscreen.html");
  copyStatic("assets/icons", "icons");
}

// 扫描 47001~47060，找能 ping 通的 host 端口。
function findHostPort() {
  return new Promise((resolve) => {
    let port = 47001;
    const tryPing = (p) =>
      new Promise((res) => {
        const sock = net.createConnection({ host: "127.0.0.1", port: p });
        let done = false;
        const fin = (ok) => {
          if (done) return;
          done = true;
          sock.destroy();
          res(ok);
        };
        sock.setTimeout(600, () => fin(false));
        sock.on("connect", () =>
          sock.write('{"type":"command","name":"ping","args":{},"requestId":"scan"}\n')
        );
        sock.on("data", () => fin(true));
        sock.on("error", () => fin(false));
      });
    const step = async () => {
      while (port <= 47060) {
        if (await tryPing(port)) return resolve(port);
        port += 1;
      }
      resolve(null);
    };
    step();
  });
}

function sendReload(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = net.createConnection({ host: "127.0.0.1", port });
    let fin = false;
    const done = () => {
      if (fin) return;
      fin = true;
      try { sock.destroy(); } catch {}
      resolve(true);
    };
    sock.setTimeout(1500, done);
    sock.on("connect", () =>
      sock.write('{"type":"command","name":"reload","args":{},"requestId":"dev-reload"}\n')
    );
    sock.on("data", () => setImmediate(done));
    sock.on("error", done);
  });
}

async function afterRebuild() {
  if (NO_RELOAD) return;
  const port = await findHostPort();
  if (!port) {
    console.log("[dev] 未找到存活 host，跳过自动 reload");
    return;
  }
  await sendReload(port);
  console.log("[dev] 已向 host :" + port + " 发 reload → 扩展 SW 即将重载");
}

async function main() {
  copyAllStatic();
  const ctxs = await Promise.all(
    entries.map((e) =>
      context({
        entryPoints: [path.join(root, e.src)],
        outfile: path.join(outdir, e.out),
        bundle: true,
        format: "esm",
        target: "chrome116",
        sourcemap: false,
        minify: false,
        logLevel: "info",
      })
    )
  );
  // 首次构建
  await Promise.all(ctxs.map((c) => c.rebuild()));
  console.log("[dev] initial build done, watching src/...");

  // fs.watch 监听 src/ 下所有 .ts 变化；debounce 到 200ms 一次 rebuild
  let timer = null;
  const scheduleRebuild = (reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      console.log(`\n[dev] change (${reason}) -> rebuild`);
      try {
        await Promise.all(ctxs.map((c) => c.rebuild()));
        await afterRebuild();
      } catch (e) {
        console.error("[dev] rebuild error:", e.message);
      }
    }, 200);
  };

  fs.watch(srcDir, { recursive: true }, (_evt, filename) => {
    if (filename && /\.tsx?$/.test(String(filename))) scheduleRebuild(String(filename));
  });
  // 也监听 manifest 等静态资源的变更 → 只重建（reload 同样有用）
  fs.watch(path.join(root, "manifest.json"), () => scheduleRebuild("manifest.json"));

  process.on("SIGINT", async () => {
    for (const c of ctxs) await c.dispose();
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
