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
let lastCreatedWindowFocused;
let createdWindowCount = 0;
const focusedWindowIds = [];
const mockWindows = new Map([
  [1, { id: 1, state: "normal", focused: false }],
  [2, { id: 2, state: "normal", focused: false }],
]);
Object.assign(globalThis.chrome, {
  windows: {
    async getLastFocused() { return { id: 1 }; },
    async create({ url, state, focused }) {
      createdWindowCount += 1;
      lastCreatedWindowState = state;
      lastCreatedWindowFocused = focused;
      const windowId = ++nextWindowId;
      mockWindows.set(windowId, { id: windowId, state: state ?? "normal", focused: focused === true });
      // Chrome 语义：新窗口首个标签在窗口内 active，与窗口是否 focused 无关。
      const tab = { id: ++nextTabId, windowId, index: 0, active: true, title: "new", url };
      mockTabs.set(tab.id, tab);
      return { id: windowId, tabs: [tab] };
    },
    async update(windowId, patch = {}) {
      if (patch.focused === true) focusedWindowIds.push(windowId);
      const win = mockWindows.get(windowId);
      if (win) Object.assign(win, patch);
      return win ?? { id: windowId, ...patch };
    },
    async get(windowId) {
      const win = mockWindows.get(windowId);
      if (!win) throw new Error("No window with id: " + windowId);
      return win;
    },
    async remove(windowId) {
      mockWindows.delete(windowId);
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
      if (!mockWindows.has(windowId)) throw new Error("No window with id: " + windowId);
      if (active) for (const tab of mockTabs.values()) if (tab.windowId === windowId) tab.active = false;
      const tab = { id: ++nextTabId, windowId, index: 1, active: active === true, title: "created", url };
      mockTabs.set(tab.id, tab);
      return tab;
    },
    async update(tabId, patch) {
      if (patch.active === true) {
        const target = mockTabs.get(tabId);
        if (target) for (const tab of mockTabs.values()) if (tab.windowId === target.windowId) tab.active = false;
      }
      const tab = { ...mockTabs.get(tabId), ...patch };
      mockTabs.set(tabId, tab);
      return tab;
    },
    async remove(tabId) {
      const removed = mockTabs.get(tabId);
      mockTabs.delete(tabId);
      if (removed?.active) {
        const neighbor = [...mockTabs.values()].find((tab) => tab.windowId === removed.windowId);
        if (neighbor) neighbor.active = true;
      }
    },
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
assert.equal(lastCreatedWindowState, "normal", "default task space must stay visible without being raised");
assert.equal(lastCreatedWindowFocused, false, "default task space must not steal focus");
const bVisible = await spaces.open_space({ type: "command", name: "open_space", requestId: "b2v", _clientId: "agent:b", args: { name: "B-visible", focus: true } });
assert.equal(lastCreatedWindowState, "maximized", "explicit focus:true must use the visible maximized viewport");
assert.equal(lastCreatedWindowFocused, true, "explicit focus:true must focus the window");
await spaces.complete_space({ type: "command", name: "complete_space", requestId: "b2v-close", _clientId: "agent:b", space: bVisible.spaceId });
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

// ---------- smoke:template 常驻窗口复用：跨轮同一 windowId，每轮只增删 tab ----------
const smokeLib = await import("./smoke-space-lib.mjs");
let smokeRequest = 0;
const smokeClient = "agent:smoke-template";
// 模拟 host/client 的错误码透传（native-bridge 会把 TaskSpaceError.code 放进 errorCode）。
const makeSmokeCall = (clientId) => (command, args = {}) =>
  spaces[command]({ type: "command", name: command, requestId: "smoke-" + (++smokeRequest), args, _clientId: clientId }).then(
    (data) => ({ ok: true, parsed: { ok: true, data } }),
    (error) => {
      const message = error?.message ?? String(error);
      return { ok: false, stderr: message, parsed: { ok: false, error: message, ...(error?.code ? { errorCode: error.code } : {}) } };
    },
  );
const smokeCall = makeSmokeCall(smokeClient);
const smokeTabs = async () => (await spaces.list_tabs({ type: "command", name: "list_tabs", requestId: "smoke-tabs", _clientId: smokeClient })).tabs;

const round1 = await smokeLib.ensureSmokeSpace(smokeCall);
assert.equal(round1.spaceMode, "created", "first smoke round must create the persistent window");
const windowsAfterCreate = createdWindowCount;
const smokeWindowId = (await smokeTabs())[0].windowId;
assert.ok(Number.isFinite(smokeWindowId), "smoke space must be bound to a real window");
assert.deepEqual(focusedWindowIds, [], "creating the background smoke window must not raise it");
const baseTabId = (await smokeTabs())[0].tabId;

const round2 = await smokeLib.ensureSmokeSpace(smokeCall);
assert.equal(round2.spaceMode, "reused", "second smoke round must reuse the persistent window");
assert.equal(round2.spaceId, round1.spaceId, "second smoke round must keep the same space");
assert.equal(createdWindowCount, windowsAfterCreate, "second smoke round must not create another window");

const openedTab = await spaces.open_tab({ type: "command", name: "open_tab", requestId: "smoke-open", _clientId: smokeClient, args: { url: "https://example.test" } });
assert.equal(openedTab.windowId, smokeWindowId, "open_tab must open inside the reused window");
assert.equal(createdWindowCount, windowsAfterCreate, "open_tab must never create a window");
assert.deepEqual(focusedWindowIds, [], "background open_tab must not focus the window");
await spaces.close_tab({ type: "command", name: "close_tab", requestId: "smoke-close", _clientId: smokeClient, args: { tabId: openedTab.tabId } });
assert.deepEqual((await smokeTabs()).map((tab) => tab.tabId), [baseTabId], "after a round only the persistent base tab may remain");
assert.equal(createdWindowCount, windowsAfterCreate, "tab churn must never create windows");
console.log("PASS core: consecutive smoke rounds reuse one window and only add/remove tabs");

// 用户关闭 smoke 窗口但扩展尚未处理 onRemoved（竞态）：状态仍挂着旧 windowId 时必须重建而不是复用死窗口。
// 重建的前提是 use_space 明确回报 SPACE_INACTIVE（扩展已用 windows.get 确认窗口消失并退休该 Space）。
await chrome.windows.remove(smokeWindowId);
const round3 = await smokeLib.ensureSmokeSpace(smokeCall);
assert.equal(round3.spaceMode, "created", "a closed smoke window must be rebuilt, not reused");
assert.equal(createdWindowCount, windowsAfterCreate + 1, "rebuild must create exactly one new window");
assert.notEqual(round3.spaceId, round1.spaceId, "rebuild must not resurrect the stale space");
const rebuiltWindowId = (await smokeTabs())[0].windowId;
assert.ok(Number.isFinite(rebuiltWindowId) && rebuiltWindowId !== smokeWindowId, "rebuild must bind a fresh window");
const retired = (await spaces.list_spaces({ type: "command", name: "list_spaces", requestId: "smoke-list", _clientId: smokeClient }))
  .find((space) => space.spaceId === round1.spaceId);
assert.equal(retired?.ownership, "inactive", "the stale space must be retired so later rounds never reuse it");
console.log("PASS core: a closed smoke window is retired and rebuilt exactly once");

// space.tabId 可能指向已关闭的模板标签：--visible 复用常驻窗口仍须置前（显式前台例外）。
const churnTab = await spaces.open_tab({ type: "command", name: "open_tab", requestId: "smoke-churn", _clientId: smokeClient, args: { url: "https://example.test/2" } });
await spaces.close_tab({ type: "command", name: "close_tab", requestId: "smoke-churn-close", _clientId: smokeClient, args: { tabId: churnTab.tabId } });
focusedWindowIds.length = 0;
const visibleRound = await smokeLib.ensureSmokeSpace(smokeCall, { visible: true });
assert.equal(visibleRound.spaceMode, "reused", "--visible must reuse the persistent window instead of creating one");
assert.equal(visibleRound.spaceId, round3.spaceId, "--visible must not swap spaces");
assert.deepEqual(focusedWindowIds, [rebuiltWindowId], "--visible must raise the reused window to the front");
console.log("PASS core: --visible raises the reused smoke window without recreating it");

// open_tab {newWindow:true} 是保留的显式例外：确实新建窗口，默认仍然不聚焦。
const nwBefore = createdWindowCount;
focusedWindowIds.length = 0;
const newWindowTab = await spaces.open_tab({ type: "command", name: "open_tab", requestId: "smoke-nw", _clientId: "agent:explicit-new-window", args: { newWindow: true, url: "about:blank" } });
assert.equal(createdWindowCount, nwBefore + 1, "explicit newWindow must create a new window");
assert.notEqual(newWindowTab.windowId, rebuiltWindowId, "explicit newWindow must not reuse the smoke window");
assert.deepEqual(focusedWindowIds, [], "explicit newWindow without focus:true must stay in the background");
console.log("PASS core: explicit open_tab newWindow remains a deliberate exception");

// fail-closed 负面用例：list_spaces/use_space/list_tabs/ensure_visible 的瞬态失败绝不能被解释为“没有窗口”而新建。
{
  const countBefore = createdWindowCount;
  const failCall = (failures) => {
    const base = makeSmokeCall(smokeClient);
    return (command, args, timeoutMs) => (failures[command] ? Promise.resolve(failures[command]) : base(command, args, timeoutMs));
  };
  const cases = [
    ["list_spaces 返回失败", { list_spaces: { ok: false, stderr: "host unreachable", parsed: { ok: false, error: "host unreachable" } } }, {}],
    ["list_spaces 数据异常", { list_spaces: { ok: true, parsed: { ok: true, data: {} } } }, {}],
    ["use_space 瞬态失败", { use_space: { ok: false, stderr: "boom", parsed: { ok: false, error: "boom" } } }, {}],
    ["list_tabs 瞬态失败", { list_tabs: { ok: false, stderr: "boom", parsed: { ok: false, error: "boom" } } }, {}],
    ["ensure_visible 置前失败", { ensure_visible: { ok: false, stderr: "cannot raise", parsed: { ok: false, error: "cannot raise" } } }, { visible: true }],
  ];
  for (const [label, failures, options] of cases) {
    await assert.rejects(
      () => smokeLib.ensureSmokeSpace(failCall(failures), options),
      /拒绝新建窗口|置前失败/,
      label,
    );
    assert.equal(createdWindowCount, countBefore, label + " must not create a window");
  }
  console.log("PASS core: smoke fail-closed on transient list_spaces/use_space/list_tabs/ensure_visible failures");
}

// 专用 Space 过滤：同 Agent 下其他用途窗口不被复用；没有专用 Space 时新建专用的，并持续复用它。
{
  const namedClient = "agent:smoke-dedicated";
  const namedCall = makeSmokeCall(namedClient);
  const other = await spaces.open_space({ type: "command", name: "open_space", requestId: "other-purpose", _clientId: namedClient, args: { name: "Other-purpose" } });
  const countBefore = createdWindowCount;
  const dedicated = await smokeLib.ensureSmokeSpace(namedCall);
  assert.equal(dedicated.spaceMode, "created", "missing dedicated smoke space must be created");
  assert.equal(createdWindowCount, countBefore + 1, "creating the dedicated space must create exactly one window");
  assert.notEqual(dedicated.spaceId, other.spaceId, "must not reuse a same-agent window created for other purposes");
  const dedicatedRecord = (await spaces.list_spaces({ type: "command", name: "list_spaces", requestId: "dedicated-list", _clientId: namedClient }))
    .find((space) => space.spaceId === dedicated.spaceId);
  assert.equal(dedicatedRecord?.name, "BrowserPilot Smoke", "dedicated space must carry the smoke name");
  const again = await smokeLib.ensureSmokeSpace(namedCall);
  assert.equal(again.spaceMode, "reused", "second round must reuse the dedicated smoke space");
  assert.equal(again.spaceId, dedicated.spaceId, "second round must keep the dedicated space");
  assert.equal(createdWindowCount, countBefore + 1, "second round must not create another window");
  console.log("PASS core: smoke selects only the dedicated BrowserPilot Smoke space");
}

// 多个专用 Space 候选时：第一个候选窗口已消失应改用仍存活的候选，而不是新建（避免并存第二个窗口）。
{
  const multiClient = "agent:smoke-multi-candidate";
  const multiCall = makeSmokeCall(multiClient);
  const first = await smokeLib.ensureSmokeSpace(multiCall);
  const second = await spaces.open_space({ type: "command", name: "open_space", requestId: "multi-second", _clientId: multiClient, args: { name: "BrowserPilot Smoke" } });
  const firstWindowId = (await spaces.list_spaces({ type: "command", name: "list_spaces", requestId: "multi-list", _clientId: multiClient }))
    .find((space) => space.spaceId === first.spaceId)?.windowId;
  await chrome.windows.remove(firstWindowId);
  const countBefore = createdWindowCount;
  const ensured = await smokeLib.ensureSmokeSpace(multiCall);
  assert.equal(ensured.spaceMode, "reused", "a retired candidate must not force a rebuild while another candidate lives");
  assert.equal(ensured.spaceId, second.spaceId, "must fall through to the live dedicated candidate");
  assert.equal(createdWindowCount, countBefore, "skipping a retired candidate must not create a window");
  console.log("PASS core: smoke skips a retired candidate and reuses a live dedicated space");
}

// 专用 Smoke Space 被用户接管（ownership=user）时不得另开窗口绕过接管（人工接管语义优先）。
{
  const heldClient = "agent:smoke-user-held";
  const heldCall = makeSmokeCall(heldClient);
  const created = await smokeLib.ensureSmokeSpace(heldCall);
  await spaces.handoff_space({ type: "command", name: "handoff_space", requestId: "held", _clientId: heldClient, space: created.spaceId });
  const countBefore = createdWindowCount;
  await assert.rejects(() => smokeLib.ensureSmokeSpace(heldCall), /用户接管/, "user-held dedicated space must block creation");
  assert.equal(createdWindowCount, countBefore, "user-held dedicated space must not trigger a new window");
  console.log("PASS core: a user-held dedicated smoke space blocks window creation");
}

// smoke 脚本的关闭保护用源码断言锁定：运行前清单失败即中断（blocked），收尾清单失败必须如实 failed。
const smokeSource = fs.readFileSync("scripts/smoke-template.mjs", "utf8");
assert.match(smokeSource, /if \(!before\.ok\) \{[\s\S]*?item\.status = "blocked";[\s\S]*?continue;\s*\}/, "smoke must abort the template when the pre-run tab listing failed");
assert.match(smokeSource, /cleanup_unverified/, "smoke must report unverifiable cleanup instead of passed");
assert.match(smokeSource, /if \(!closed\.ok\) failedCloses\.push\(tabId\)/, "smoke must report failed tab closes instead of silently leaking them");
assert.match(smokeSource, /import \{ ensureSmokeSpace \} from "\.\/smoke-space-lib\.mjs";/, "smoke must use the shared reusable-space lib");
console.log("PASS core: smoke aborts without an attributable tab baseline and reports unverifiable cleanup");

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
for (const id of ["template-list", "install-content", "install-github", "load-catalog", "catalog-template", "template-search", "check-updates", "tag-filter", "updates-panel", "updates-list", "install-selected", "close-updates"]) {
  assert.match(boardHtml, new RegExp('id="' + id + '"'), "template board missing #" + id);
}
assert.ok(fs.existsSync("dist/onboarding/index.js"), "template board bundle missing");
assert.ok(fs.existsSync("dist/templates.bundle.json"), "bundled template pack missing");
const bundle = JSON.parse(fs.readFileSync("dist/templates.bundle.json", "utf8"));
assert.ok(Array.isArray(bundle.templates) && bundle.templates.length >= 31, "bundled template pack should ship every registry template");
for (const tpl of bundle.templates) {
  assert.ok(Array.isArray(tpl.tags) && tpl.tags.length, "bundled template must carry at least one tag: " + tpl.id);
}
{
  const expressions = [];
  for (const tpl of bundle.templates) {
    if (tpl.steps !== "commands" || !Array.isArray(tpl.body)) continue;
    for (const step of tpl.body) {
      const expr = step.args?.expression;
      if (typeof expr === "string" && !expr.startsWith("@")) expressions.push([tpl.id, expr]);
    }
  }
  for (const [id, expr] of expressions) {
    try { new Function(expr); }
    catch (e) { throw new Error("bundled custom js expression does not parse (" + id + "): " + e.message); }
  }
  assert.ok(expressions.length >= 20, "expected custom js expressions in the bundled pack, found " + expressions.length);
  console.log("PASS core: every bundled custom js expression parses under V8 (" + expressions.length + " expressions)");
}
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
assert.match(templateSource, /if \(record && \(includeDisabled \|\| record\.enabled\)\) return record\.template;\s*const bundled = await loadBundledTemplates\(\);\s*return bundled\[id\]/, "installed templates should override same-id bundled templates");
assert.doesNotMatch(templateSource, /不能覆盖内置模板/, "runtime packages should be allowed to override bundled templates");
const spacesSource = fs.readFileSync("src/background/spaces.ts", "utf8");
assert.match(spacesSource, /return a\.focus === true \|\| a\.keepVisible === true \|\| a\.visible === true \|\| a\.background === false/, "visibility must require an explicit flag");
assert.match(spacesSource, /const win = await chrome\.windows\.create\(\{ url, focused: visible, state: requestedState \}\)/, "open_space must not focus by default");
assert.match(spacesSource, /const requestedState = args\.state === "normal" \? "normal" : visible \? "maximized" : "normal"/, "background spaces must open visible-normal without being raised");
assert.match(spacesSource, /const tab = await chrome\.tabs\.create\(\{ windowId: space\.windowId, url, active: true \}\);/, "open_tab must keep the agent tab active in its window for rendering and visibility");
assert.match(spacesSource, /background: !visible,/, "open_space must record whether it was created as a background space");
assert.match(spacesSource, /const patch = focus \? \(state \? \{ state, focused: true \} : \{ focused: true \}\) : \(state \? \{ state \} : null\);/, "ensure visible without focus must only restore minimized windows");
assert.match(templateSource, /const visibleRun = args\.background === false \|\| args\.focus === true \|\| args\.keepVisible === true \|\| args\.visible === true;/, "run_template must derive an explicit visible run intent");
assert.match(templateSource, /const shouldEnsureVisible = stepArgs\.ensureVisible === true \|\| \(visibleRun && stepArgs\.ensureVisible !== false\);/, "background runs must never touch window state");
assert.match(templateSource, /args: \{ tabId: visibleTab, focus: true \},/, "explicit visible runs must focus the target window");
console.log("PASS core: template runner keeps declaration-driven selectors and defaults every path to background");

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
const tagged = schema.validateTemplate({ id: "t", name: "T", description: "d", steps: "commands", body: [], tags: ["search", "finance"] });
assert.deepEqual(tagged.tags, ["search", "finance"], "valid tags must be preserved");
assert.throws(() => schema.validateTemplate({ id: "t", name: "T", description: "d", steps: "commands", body: [], tags: ["bogus"] }), /公共词汇表/, "unknown tags must be rejected");
assert.throws(() => schema.validateTemplate({ id: "t", name: "T", description: "d", steps: "commands", body: [], tags: ["search", "search"] }), /重复/, "duplicate tags must be rejected");
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
const pagedExpr = exprMod.searchResultsExpr({ rootSelectors: ["#b_results"], nextSelector: "a.sb_pagN", nextText: "下一页", maxPages: 3, limit: 25, pageDelayMs: 900 });
const googleExpr = exprMod.googleResultsExpr({ limit: 20 });
new Function(searchExpr);
new Function(pagedExpr);
new Function(googleExpr);
assert.match(searchExpr, /skip=\(u\)/, "searchResultsExpr must honor excludeUrlPrefixes");
assert.match(pagedExpr, /nextSel="a\.sb_pagN"/, "paged @results must carry the declared next-page selector");
assert.match(pagedExpr, /limit=25/, "paged @results must honor the requested limit");
assert.match(pagedExpr, /maxPages=3/, "paged @results must honor the page cap");
assert.match(pagedExpr, /pageDelay=900/, "paged @results must honor the polite page delay");
assert.match(googleExpr, /#pnnext/, "google fallback results must auto-paginate via #pnnext");
console.log("PASS core: @results page expressions are syntactically valid and filter Google UI links");
}
