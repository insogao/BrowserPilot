import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

async function importTs(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const code = result.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const events = await importTs("src/background/events.ts");
for (let i = 1; i <= 5; i++) events.recordEvent("test", { i });
const first = events.drainEvents({ after_sequence: 0, limit: 2 });
assert.deepEqual(first.events.map((e) => e.sequence), [1, 2]);
assert.equal(first.cursor, 2);
assert.equal(first.hasMore, true);
const second = events.drainEvents({ after_sequence: first.cursor, limit: 2 });
assert.deepEqual(second.events.map((e) => e.sequence), [3, 4]);
const third = events.drainEvents({ after_sequence: second.cursor, limit: 2 });
assert.deepEqual(third.events.map((e) => e.sequence), [5]);
assert.equal(third.hasMore, false);

console.log("PASS core: event cursor pagination is lossless");

const maskBuild = await build({
  stdin: {
    contents: 'export {requestTakeover,isHumanTakeover,maskOff} from "./src/background/mask.ts"',
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  plugins: [{
    name: "mask-test-stubs",
    setup(b) {
      b.onResolve({ filter: /content-bridge$/ }, () => ({ path: "content", namespace: "stub" }));
      b.onResolve({ filter: /native-bridge$/ }, () => ({ path: "native", namespace: "stub" }));
      b.onResolve({ filter: /debugger-bridge$/ }, () => ({ path: "debugger", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
        contents: args.path === "content"
          ? "export const ensureInjected=async()=>{};export const sendToTab=async()=>({ok:true});"
          : args.path === "native"
            ? "export const pushEvent=()=>{};"
            : "export const interruptTab=async()=>{};",
      }));
    },
  }],
});
const mask = await import("data:text/javascript;base64," + Buffer.from(maskBuild.outputFiles[0].text).toString("base64"));
mask.requestTakeover(7);
await Promise.resolve();
assert.equal(mask.isHumanTakeover(7), true, "human takeover lock was cleared while releasing mask");
await mask.maskOff(7);
assert.equal(mask.isHumanTakeover(7), false, "explicit resume did not clear takeover lock");
console.log("PASS core: human takeover lock survives visual mask release");

const boardHtml = fs.readFileSync("dist/onboarding/index.html", "utf8");
for (const id of ["template-list", "install-content", "install-github", "load-catalog", "catalog-template"]) {
  assert.match(boardHtml, new RegExp('id="' + id + '"'), "template board missing #" + id);
}
assert.ok(fs.existsSync("dist/onboarding/index.js"), "template board bundle missing");
console.log("PASS core: template board artifacts are complete");
