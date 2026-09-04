import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

// chrome.storage.session mock：mask 持久化与 spaces 测试共用同一份内存存储。
let storedSession = {};
globalThis.chrome = {
  storage: {
    session: {
      async get(key) { return { [key]: storedSession[key] }; },
      async set(values) { storedSession = { ...storedSession, ...values }; },
    },
  },
};

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
    contents: 'export {requestTakeover,isHumanTakeover,maskOff,restoreMaskState} from "./src/background/mask.ts"',
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
      b.onResolve({ filter: /spaces$/ }, () => ({ path: "spaces", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
        contents: args.path === "content"
          ? "export const ensureInjected=async()=>{};export const sendToTab=async()=>({ok:true});"
          : args.path === "native"
            ? "export const pushEvent=()=>{};"
            : args.path === "spaces"
              ? "export const handoffSpaceForTab=async()=>{};"
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

// SW 重启模拟：requestTakeover 落盘 → 全新内存 Set 从 storage.session 恢复。
mask.requestTakeover(9);
await new Promise((r) => setTimeout(r, 0));
const persisted = storedSession["browserpilot.state.v1"].humanTakeoverTabIds;
assert.deepEqual(persisted, [9], "takeover lock was not persisted for SW restart");
await mask.restoreMaskState();
assert.equal(mask.isHumanTakeover(9), true, "takeover lock did not survive simulated SW restart");
await mask.maskOff(9);
console.log("PASS core: human takeover lock survives visual mask release and SW restart");

const mockTabs = new Map([
  [11, { id: 11, windowId: 1, index: 0, active: true, title: "one", url: "https://one.test" }],
  [22, { id: 22, windowId: 2, index: 0, active: true, title: "two", url: "https://two.test" }],
]);
let nextWindowId = 2;
let nextTabId = 22;
let lastCreatedWindowState;
Object.assign(globalThis.chrome, {
  windows: {
    async getLastFocused() { return { id: 1 }; },
    async create({ url, state }) {
      lastCreatedWindowState = state;
      const windowId = ++nextWindowId;
      const tab = { id: ++nextTabId, windowId, index: 0, active: true, title: "new", url };
      mockTabs.set(tab.id, tab);
      return { id: windowId, tabs: [tab] };
    },
    async update(windowId) { return { id: windowId, state: "normal", focused: true }; },
    async get(windowId) { return { id: windowId, state: "normal", focused: true }; },
    async remove(windowId) {
      for (const [id, tab] of mockTabs) if (tab.windowId === windowId) mockTabs.delete(id);
    },
    onRemoved: { addListener() {} },
  },
  tabs: {
    async query(query) {
      return [...mockTabs.values()].filter((tab) =>
        (query.windowId === undefined || tab.windowId === query.windowId) &&
        (query.active === undefined || tab.active === query.active));
    },
    async get(tabId) {
      const tab = mockTabs.get(tabId);
      if (!tab) throw new Error("tab not found");
      return tab;
    },
    async create({ windowId, url, active }) {
      const tab = { id: ++nextTabId, windowId, index: 1, active, title: "created", url };
      mockTabs.set(tab.id, tab);
      return tab;
    },
    async update(tabId, patch) {
      const tab = { ...mockTabs.get(tabId), ...patch };
      mockTabs.set(tabId, tab);
      return tab;
    },
    async remove(tabId) { mockTabs.delete(tabId); },
  },
});

const spaces = await importTs("src/background/spaces.ts");
const aList = await spaces.list_tabs({ type: "command", name: "list_tabs", requestId: "a1", _clientId: "agent:a" });
assert.deepEqual(aList.tabs.map((tab) => tab.tabId), [11]);
await assert.rejects(
  () => spaces.list_tabs({ type: "command", name: "list_tabs", requestId: "b1", _clientId: "agent:b" }),
  (error) => error.code === "SPACE_NOT_OWNED",
);
await assert.rejects(
  () => spaces.assertTabInCommandSpace({ type: "command", name: "snapshot", requestId: "a2", _clientId: "agent:a" }, 22),
  (error) => error.code === "TAB_OUTSIDE_SPACE",
);
const bSpace = await spaces.open_space({ type: "command", name: "open_space", requestId: "b2", _clientId: "agent:b", args: { name: "B" } });
assert.equal(bSpace.ownerClientId, "agent:b");
assert.equal(lastCreatedWindowState, "maximized", "agent task space did not use the stable maximized viewport");
await spaces.handoff_space({ type: "command", name: "handoff_space", requestId: "b3", _clientId: "agent:b", space: bSpace.spaceId });
await assert.rejects(
  () => spaces.ensureCommandSpace({ type: "command", name: "snapshot", requestId: "b4", _clientId: "agent:b", space: bSpace.spaceId }),
  (error) => error.code === "SPACE_USER_IN_CONTROL",
);
console.log("PASS core: task spaces enforce client ownership, tab boundaries, and human handoff");

const cSpace = await spaces.open_space({ type: "command", name: "open_space", requestId: "c1", _clientId: "agent:c", args: { name: "C" } });
await spaces.complete_space({ type: "command", name: "complete_space", requestId: "c2", _clientId: "agent:c", space: cSpace.spaceId });
const stateAfterComplete = storedSession["browserpilot.state.v1"];
assert.equal(stateAfterComplete.activeSpaceIds?.["agent:c"], undefined, "completed space remained active for its agent");
assert.equal(stateAfterComplete.activeSpaceId === cSpace.spaceId, false, "completed space remained globally active");
console.log("PASS core: completing a task space clears stale active routing");

const foreground = await importTs("src/background/foreground-lease.ts");
const outer = { type: "command", name: "open_space", requestId: "lease-a", _clientId: "agent:a" };
const outerLease = await foreground.acquireForegroundLease(outer);
await assert.rejects(
  () => foreground.acquireForegroundLease({ type: "command", name: "open_space", requestId: "lease-b", _clientId: "agent:b" }),
  (error) => error.code === "FOREGROUND_BUSY",
);
await assert.rejects(
  () => foreground.acquireForegroundLease({ type: "command", name: "open_space", requestId: "lease-a2", _clientId: "agent:a" }),
  (error) => error.code === "FOREGROUND_BUSY" && /同一 Agent/.test(error.message),
  "same-client concurrent acquire must report self-ownership, not another agent",
);
const nestedLease = await foreground.acquireForegroundLease({
  type: "command",
  name: "snapshot",
  requestId: "lease-a:nested",
  _clientId: "agent:a",
  _foregroundLeaseToken: outer._foregroundLeaseToken,
});
await nestedLease.release();
await outerLease.release();
const afterRelease = await foreground.acquireForegroundLease({ type: "command", name: "open_space", requestId: "lease-b2", _clientId: "agent:b" });
await afterRelease.release();
console.log("PASS core: foreground lease is exclusive, reentrant for templates, self-releasing, and distinguishes self-concurrency");

const boardHtml = fs.readFileSync("dist/onboarding/index.html", "utf8");
for (const id of ["template-list", "install-content", "install-github", "load-catalog", "catalog-template", "template-search", "search-registry", "sync-registry"]) {
  assert.match(boardHtml, new RegExp('id="' + id + '"'), "template board missing #" + id);
}
assert.ok(fs.existsSync("dist/onboarding/index.js"), "template board bundle missing");
console.log("PASS core: template board artifacts are complete");

const popupHtml = fs.readFileSync("dist/popup/index.html", "utf8");
for (const id of ["host", "connection", "profile", "hostPort", "takeover", "guide", "manage"]) {
  assert.match(popupHtml, new RegExp('id="' + id + '"'), "popup missing #" + id);
}
for (const removed of ["use-current", "stop", "允许 Agent 操作本页", "停止全部操作"]) {
  assert.equal(popupHtml.includes(removed), false, "popup resurrected legacy control/text: " + removed);
}
assert.match(popupHtml, /Host 状态/, "popup should show native host readiness separately");
assert.match(popupHtml, /Agent 状态/, "popup should show remote agent activity separately");
assert.match(popupHtml, /Host 端口/, "popup should show dynamic native host port when available");
assert.match(popupHtml, /Copy Skill/, "popup copy action should say Copy Skill");

const manifest = JSON.parse(fs.readFileSync("dist/manifest.json", "utf8"));
assert.equal((manifest.permissions || []).includes("contextMenus"), false, "contextMenus permission should not be requested");
console.log("PASS core: popup exposes only connection/takeover and compact utilities");

const templateSource = fs.readFileSync("src/background/templates.ts", "utf8");
assert.match(templateSource, /stepArgs\.selectors/, "template runner should honor @focus selectors");
assert.match(templateSource, /stepArgs\.rootSelectors/, "template runner should honor @results rootSelectors");
assert.match(templateSource, /ensure_visible/, "template runner should restore visible tabs before page observation");
assert.match(templateSource, /if \(record && \(includeDisabled \|\| record\.enabled\)\) return record\.template;\s*return BUILTINS\[id\]/, "installed templates should override same-id builtins");
assert.doesNotMatch(templateSource, /不能覆盖内置模板/, "runtime packages should be allowed to override builtins");
console.log("PASS core: template runner keeps declaration-driven selectors and visibility guard");

// ---------- debugger attach 自愈（SW 回收后 Set 与 Chrome 实际状态脱钩） ----------
globalThis.chrome.debugger = {
  onEvent: { addListener() {} },
  onDetach: { addListener() {} },
  async attach({ tabId }) {
    // 42/43 模拟「Chrome 侧仍处于 attach」；43 额外模拟被外部调试器占用（探针也不可控）。
    if (tabId === 42 || tabId === 43) throw new Error("Another debugger already attached to the tab with id: " + tabId);
  },
  async sendCommand({ tabId }) {
    if (tabId === 43) throw new Error("Cannot attach to this target");
    return { result: { value: 1 } };
  },
  async detach() {},
};

const dbgBuild = await build({
  stdin: {
    contents: 'export {attach,isAttached} from "./src/background/debugger-bridge.ts"',
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  plugins: [{
    name: "debugger-stub-spaces",
    setup(b) {
      b.onResolve({ filter: /spaces$/ }, () => ({ path: "spaces", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const syncSpaceForTab=async()=>{};" }));
    },
  }],
});
const dbg = await import("data:text/javascript;base64," + Buffer.from(dbgBuild.outputFiles[0].text).toString("base64"));

await dbg.attach(42);
assert.equal(dbg.isAttached(42), true, "orphaned attach after SW restart was not re-adopted");
await assert.rejects(() => dbg.attach(43), /already attached/);
assert.equal(dbg.isAttached(43), false, "foreign debugger target must not be adopted");
await dbg.attach(44);
assert.equal(dbg.isAttached(44), true, "fresh attach failed");
console.log("PASS core: debugger attach self-heals orphaned SW-restart state and refuses foreign debuggers");

// ---------- 模板结构化断言（checkStepExpect） ----------
const schema = await importTs("src/shared/template-schema.ts");
assert.equal(schema.checkStepExpect({ count: 5 }, undefined, [{ path: "count", min: 3 }]), null, "min assertion should pass");
assert.match(
  schema.checkStepExpect({ count: 0 }, undefined, [{ path: "count", min: 3 }]),
  /数值未达到 3/,
  "min assertion should fail with reason",
);
assert.equal(schema.checkStepExpect({ results: [{ url: "https://x.test/a" }] }, undefined, [{ path: "results[0].url", includes: "x.test" }]), null);
assert.match(
  schema.checkStepExpect({ ok: true }, undefined, [{ path: "ok", equals: false }]),
  /不等于 false.*实际 true/s,
  "弱子串断言的误判场景必须被 equals 拦住",
);
assert.match(
  // expect:"true" 的经典误判：matched:true 让子串命中，结构化断言仍然能同时满足/拒绝
  schema.checkStepExpect({ matched: true, value: false }, "true", [{ path: "value", equals: true }]),
  /不等于 true/,
  "substring hit must not bypass structured expectation",
);
assert.equal(schema.checkStepExpect({ value: true }, "true", [{ path: "value", equals: true }]), null);
assert.match(schema.checkStepExpect({}, undefined, [{ path: "missing", exists: true }]), /字段不存在/);
assert.throws(() => schema.validateTemplate({
  id: "t", name: "T", description: "d", steps: "commands",
  body: [{ name: "ping", expectations: [{ path: "x" }] }],
}), /至少要声明/, "empty expectation entries must be rejected");
console.log("PASS core: template step expectations are structural, path-aware, and validated");

// ---------- stop 命令作用域语义（import 链重，用源码断言锁定关键行为） ----------
const commandsSource = fs.readFileSync("src/background/commands.ts", "utf8");
assert.match(commandsSource, /clientId === "browserpilot-internal"/, "popup/global stop must keep full cleanup");
assert.match(commandsSource, /ownerClientId === clientId &&/, "agent stop must filter spaces by caller clientId");
assert.match(commandsSource, /if \(state\.foregroundLease\?\.ownerClientId === clientId\) tpl\.cancelTemplateRuns\(\);/, "agent stop may only cancel template runs while holding the foreground lease itself");
assert.doesNotMatch(commandsSource.replace(/clientId === "browserpilot-internal"[\s\S]*?clearAllSpaces\(\);/, ""), /clearAllSpaces\(\)/, "agent-scoped stop must not call global clearAllSpaces");
console.log("PASS core: stop is scoped per agent and only global via user entrypoints");

// ---------- @results 页面表达式语法守卫（字符串拼出来的页面代码必须可被 V8 解析） ----------
{
  const tplLines = fs.readFileSync("src/background/templates.ts", "utf8").split("\n");
  const grab = (startMark, endMark) => {
    const s = tplLines.findIndex((l) => l.includes(startMark));
    const e = tplLines.findIndex((l, i) => i > s && l.includes(endMark));
    return tplLines.slice(s, e).join("\n");
  };
  const fnSource =
    grab("function numberOption", "/** 通用搜索结果抓取") + "\n" +
    grab("function searchResultsExpr", "/** 抓取 Google 搜索结果") + "\n" +
    grab("function googleResultsExpr", "// ---------------------------------------------------------------------------") +
    "\nexport { searchResultsExpr, googleResultsExpr };";
  const exprBuild = await build({
    stdin: { contents: fnSource, resolveDir: process.cwd(), loader: "ts" },
    format: "esm", platform: "browser", write: false,
  });
  const exprMod = await import("data:text/javascript;base64," + Buffer.from(exprBuild.outputFiles[0].text).toString("base64"));
  const searchExpr = exprMod.searchResultsExpr({ rootSelectors: ["#search"], excludeUrlPrefixes: ["/translate"] });
  const googleExpr = exprMod.googleResultsExpr();
  new Function(searchExpr);
  new Function(googleExpr);
  assert.match(searchExpr, /skip=\(u\)/, "searchResultsExpr must honor excludeUrlPrefixes");
  assert.match(googleExpr, /skip\(u\)/, "builtin google results must filter Google UI links");
  console.log("PASS core: @results page expressions are syntactically valid and filter Google UI links");
}
