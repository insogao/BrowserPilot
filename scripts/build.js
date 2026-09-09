import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "dist");
const watch = process.argv.includes("--watch");

// Service worker / content script / sandbox kernel must each be a self-contained bundle.
const entries = [
  { src: "src/background/index.ts", out: "background.js" },
  { src: "src/content/bridge.ts", out: "content/bridge.js" },
  { src: "src/popup/index.ts", out: "popup/index.js" },
  { src: "src/onboarding/index.ts", out: "onboarding/index.js" },
  { src: "src/kernel/kernel.ts", out: "kernel/kernel.js" },
  { src: "src/offscreen/offscreen.ts", out: "offscreen/offscreen.js" },
  { src: "src/offscreen/audio.ts", out: "offscreen/audio.js" },
];

function cleanDist() {
  if (fs.existsSync(outdir)) fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });
}

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

function buildOnce(overrides = {}) {
  cleanDist();
  copyAllStatic();
  return Promise.all(
    entries.map((e) =>
      build({
        entryPoints: [path.join(root, e.src)],
        outfile: path.join(outdir, e.out),
        bundle: true,
        format: "esm",
        target: "chrome116",
        sourcemap: false,
        minify: false,
        logLevel: "warning",
        ...overrides,
      })
    )
  );
}

if (watch) {
  cleanDist();
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
        logLevel: "warning",
      })
    )
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[build] watching... (dist/ reflects src/)");
} else {
  await buildOnce();
  console.log("[build] done -> dist/");
}
