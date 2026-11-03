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

// 真实 debugger-bridge 在模块加载时注册 chrome.debugger.onEvent；截图测试需要
// 手动触发一次 Page.screencastFrame，模拟扩展事件流。
let debuggerEventListeners = [];
function emitDebuggerEvent(tabId, method, params) {
  for (const listener of debuggerEventListeners) {
    listener({ tabId }, method, params);
  }
}

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
              ? "export const handoffSpaceForTab=async()=>{};export const assertTabInCommandSpace=async()=>{};export const ensureCommandSpace=async()=>({spaceId:'stub'});"
              : "export const interruptTab=async()=>{};export const attach=async()=>{};export const isAttached=()=>false;export const sendCommand=async()=>({});export const waitForDebuggerEvent=async()=>new Promise(()=>{});",
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
const leaseStateModule = await importTs("src/background/state.ts");
let leaseSeq = 0;
function resetLeaseState(extra = {}) {
  const now = Date.now();
  const space = (id, owner, windowId) => ({
    spaceId: id, name: id, windowId, ownerClientId: owner, ownership: "agent",
    layer: "L0", navVersion: 0, attached: false, eventQueueTail: 0,
  });
  storedSession["browserpilot.state.v1"] = {
    spaces: { "space-a": space("space-a", "agent:a", 101), "space-b": space("space-b", "agent:b", 102) },
    activeSpaceIds: { "agent:a": "space-a", "agent:b": "space-b" },
    startTime: now,
    ...extra,
  };
}
function leaseCmd(name, clientId, extra = {}) {
  return { type: "command", name, requestId: "lease-" + name + "-" + (++leaseSeq), _clientId: clientId, ...extra };
}
const acquireLease = (name, clientId, extra = {}) => foreground.acquireForegroundLease(leaseCmd(name, clientId, extra));

// 1) 纯后台命令不取任何前台租约：截图/点击/求值/等待/CDP 透传在不同窗口必须并行。
{
  resetLeaseState();
  const background = [
    "snapshot", "readText", "screenshot", "scroll_screenshot", "getElementInfo",
    "click", "dblclick", "hover", "drag", "wheel", "down", "up", "press", "type", "fill",
    "selectOption", "check", "uncheck", "setChecked",
    "js", "waitForURL", "waitForSelector", "waitForTimeout", "wait_dom_idle", "pageInfo",
    "tab_cdp_call", "download_image", "download_resource", "list_tabs",
  ];
  for (const name of background) {
    const a = await acquireLease(name, "agent:a", { space: "space-a", args: { tabId: 11 } });
    const b = await acquireLease(name, "agent:b", { space: "space-b", args: { tabId: 22 } });
    assert.equal(a, undefined, name + " must not take a foreground lease (agent A)");
    assert.equal(b, undefined, name + " must not take a foreground lease (agent B) — two agents must not serialise");
  }
  console.log("PASS core: background/observation commands take no lease, so different spaces run in parallel");
}

// 2) run_template 按 Task Space 加锁：不同 space 真并行，同一 space 互斥（含同 Agent 自冲突）。
{
  resetLeaseState();
  const runA = leaseCmd("run_template", "agent:a", { space: "space-a", args: { id: "t" } });
  const handleA = await foreground.acquireForegroundLease(runA);
  const runB = leaseCmd("run_template", "agent:b", { space: "space-b", args: { id: "t" } });
  const handleB = await foreground.acquireForegroundLease(runB);
  assert.ok(handleA && handleB, "run_template in two different spaces must acquire both leases (real parallelism)");
  assert.ok(runA._foregroundLeaseToken && runB._foregroundLeaseToken);
  assert.notEqual(runA._foregroundLeaseToken, runB._foregroundLeaseToken, "different spaces must use different lease tokens");
  assert.equal(runA._foregroundLeaseToken !== undefined && runB._foregroundLeaseToken !== undefined, true);

  await assert.rejects(
    () => foreground.acquireForegroundLease(leaseCmd("run_template", "agent:b", { space: "space-a", args: { id: "t" } })),
    (error) => error.code === "FOREGROUND_BUSY" && /space:space-a/.test(error.message),
    "another agent must be blocked by the same space key",
  );
  await assert.rejects(
    () => foreground.acquireForegroundLease(leaseCmd("run_template", "agent:a", { space: "space-a", args: { id: "t" } })),
    (error) => error.code === "FOREGROUND_BUSY" && /同一 Agent/.test(error.message),
    "same-client concurrent acquire on the same space must report self-ownership",
  );

  // 3) 模板子步骤继承 token 重入同一 key；不同 key（global）单独竞争。
  const nested = await foreground.acquireForegroundLease({
    type: "command", name: "open_tab", args: { url: "about:blank" }, space: "space-a",
    _clientId: "agent:a", requestId: "lease-nested", _foregroundLeaseToken: runA._foregroundLeaseToken,
  });
  assert.ok(nested, "template sub-step must re-enter its own space lease");
  await nested.release();
  const globalA = await acquireLease("ensure_visible", "agent:a", { space: "space-a" });
  assert.ok(globalA, "the same agent may hold its own space lease plus a global presentation lease");
  await assert.rejects(
    () => acquireLease("ensure_visible", "agent:b", { space: "space-b" }),
    (error) => error.code === "FOREGROUND_BUSY",
    "global window presentation stays process-wide serialised",
  );
  await globalA.release();

  // 4) 只有真正的前台呈现操作还在 global key 上串行。
  const openA = await acquireLease("open_space", "agent:a");
  await assert.rejects(() => acquireLease("open_space", "agent:b"), (error) => error.code === "FOREGROUND_BUSY");
  await openA.release();

  await handleA.release();
  await handleB.release();
  resetLeaseState();

  // 5) 后台 open_tab/switch_tab/close_tab 按 space key：不同 space 可同时开标签。
  const tabA = await acquireLease("open_tab", "agent:a", { space: "space-a", args: { url: "about:blank" } });
  const tabB = await acquireLease("open_tab", "agent:b", { space: "space-b", args: { url: "about:blank" } });
  assert.ok(tabA && tabB, "background open_tab in different spaces must not serialise");
  await tabA.release();
  await tabB.release();

  // 6) 释放只清除自己的 key：A 释放后 B 仍持有 space-b。
  const releaseA = await acquireLease("run_template", "agent:a", { space: "space-a", args: { id: "t" } });
  const releaseB = await acquireLease("run_template", "agent:b", { space: "space-b", args: { id: "t" } });
  await releaseA.release();
  await assert.rejects(
    () => foreground.acquireForegroundLease(leaseCmd("run_template", "agent:a", { space: "space-b", args: { id: "t" } })),
    (error) => error.code === "FOREGROUND_BUSY" && /space:space-b/.test(error.message),
    "releasing one key must not release another key",
  );
  await releaseB.release();
  const afterRelease = await foreground.acquireForegroundLease(leaseCmd("run_template", "agent:b", { space: "space-b", args: { id: "t" } }));
  assert.ok(afterRelease, "the released space key must be acquirable again");
  await afterRelease.release();
  console.log("PASS core: run_template is keyed per Task Space — parallel across spaces, exclusive within one");
}

// 7) 过期清理、旧版全局租约迁移、Agent 级 stop 只清理自己的 key。
{
  resetLeaseState({
    foregroundLeases: {
      "space:space-a": { token: "expired", key: "space:space-a", scope: "space", ownerClientId: "agent:b", spaceId: "space-a", startedAt: 1, expiresAt: 2 },
    },
  });
  const revived = await acquireLease("run_template", "agent:a", { space: "space-a", args: { id: "t" } });
  assert.ok(revived, "an expired lease must be pruned instead of blocking the target forever");
  await revived.release();

  // 旧版单条租约（v1）仍会挡住 global，但不再挡住其它 space。
  resetLeaseState({
    foregroundLease: { token: "legacy", ownerClientId: "agent:b", spaceId: "space-b", startedAt: Date.now(), expiresAt: Date.now() + 60_000 },
  });
  await assert.rejects(() => acquireLease("ensure_visible", "agent:a", { space: "space-a" }), (error) => error.code === "FOREGROUND_BUSY");
  const legacyParallel = await acquireLease("run_template", "agent:a", { space: "space-a", args: { id: "t" } });
  assert.ok(legacyParallel, "a legacy global lease must not serialise space-scoped work");
  await legacyParallel.release();

  // Agent stop：只删自己（含 legacy）的租约，其他 Agent 的 space 锁保留。
  resetLeaseState();
  const own = await acquireLease("run_template", "agent:a", { space: "space-a", args: { id: "t" } });
  const other = await acquireLease("run_template", "agent:b", { space: "space-b", args: { id: "t" } });
  let removed;
  await leaseStateModule.mutateState((state) => {
    removed = foreground.deleteForegroundLeasesFor(state, "agent:a");
  });
  assert.deepEqual(removed.sort(), ["space:space-a"], "scoped stop must delete exactly the caller's keys");
  const reacquired = await acquireLease("run_template", "agent:a", { space: "space-a", args: { id: "t" } });
  assert.ok(reacquired, "the stopped agent's space must be free again");
  await assert.rejects(
    () => acquireLease("run_template", "agent:a", { space: "space-b", args: { id: "t" } }),
    (error) => error.code === "FOREGROUND_BUSY",
    "another agent's lease must survive a scoped stop",
  );
  await reacquired.release();
  await own.release();
  await other.release();
  console.log("PASS core: leases expire, legacy global leases migrate, and scoped stop only clears its own keys");
}

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
assert.match(commandsSource, /tpl\.cancelTemplateRuns\(clientId\)/, "agent stop may only cancel its own template runs (keyed concurrency)");
assert.match(commandsSource, /deleteForegroundLeasesFor\(s, clientId\)/, "agent stop must delete only the caller's keyed leases");
assert.doesNotMatch(commandsSource.replace(/clientId === "browserpilot-internal"[\s\S]*?clearAllSpaces\(\);/, ""), /clearAllSpaces\(\)/, "agent-scoped stop must not call global clearAllSpaces");
const templatesSourceForStop = fs.readFileSync("src/background/templates.ts", "utf8");
assert.match(templatesSourceForStop, /const clientRunGenerations = new Map<string, number>\(\)/, "template cancellation must be tracked per agent");
assert.match(templatesSourceForStop, /export function cancelTemplateRuns\(clientId\?: string\): void/, "cancelTemplateRuns must accept an agent scope");
assert.match(templatesSourceForStop, /isRunCancelled\(generation, clientKey\)/, "template steps must compare the caller's own generation");
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

// ---------- 宿主能力探测：三种结果 + 禁止用 UA/产品名旁路（Phase 7） ----------
{
  // 探测模块直接读 chrome.browserCli；用可替换的 stub 覆盖各分支。
  const capsMod = await importTs("src/background/capabilities.ts");

  const withApi = async (impl) => {
    globalThis.chrome = {
      ...globalThis.chrome,
      browserCli: impl === undefined ? undefined : { getCapabilities: impl },
    };
    // 接口存在时无需等待；只有 api-absent 分支会走满重试窗口，用 0 避免测试变慢。
    return capsMod.detectHostCapabilities({ apiAppearTimeoutMs: 0 });
  };

  // 1. 接口不存在（普通 Chrome 的正常形态）→ generic
  delete globalThis.chrome.browserCli;
  const absent = await capsMod.detectHostCapabilities({ apiAppearTimeoutMs: 0 });
  assert.equal(absent.mode, "generic", "absent API must degrade to generic");
  assert.equal(absent.degradeReason, "api-absent", "absent API must record why");
  assert.equal(absent.protocolVersion, 0, "generic mode has no host protocol");
  assert.equal(absent.maxConcurrentWindows, 1, "generic mode allows exactly one window");
  for (const flag of ["managedMode", "backgroundWindows", "backgroundCapture", "hardFocusIsolation", "foregroundAssist"]) {
    assert.equal(absent[flag], false, `generic mode must report ${flag}=false`);
  }

  // 1b. 注入竞态：API 延迟出现时必须等到它，而不是误判成普通 Chrome。
  //     （实测内核在 SW 创建后约 0.5s 才注入 browserCli。）
  {
    const saved = globalThis.chrome;
    globalThis.chrome = { ...saved };
    delete globalThis.chrome.browserCli;
    const appeared = setTimeout(() => {
      globalThis.chrome.browserCli = {
        getCapabilities: async () => ({
          protocolVersion: 1, managedMode: true, backgroundWindows: true,
          backgroundCapture: true, hardFocusIsolation: true, foregroundAssist: true,
          maxConcurrentWindows: 8,
        }),
      };
    }, 150);
    const late = await capsMod.detectHostCapabilities({ apiAppearTimeoutMs: 3000 });
    clearTimeout(appeared);
    assert.equal(late.mode, "enhanced", "API appearing after startup must not be misread as generic");
    globalThis.chrome = saved;
  }

  // 2. 调用抛异常 → generic + 记录错误，绝不向上抛
  const failed = await withApi(async () => { throw new Error("boom"); });
  assert.equal(failed.mode, "generic", "throwing API must degrade, not propagate");
  assert.match(failed.degradeReason, /call-failed: boom/, "call failure must be recorded");

  // 3. 协议版本不认识 → generic（猜测能力正是该接口要防的事）
  const wrongProtocol = await withApi(async () => ({
    protocolVersion: 2, managedMode: true, backgroundWindows: true,
    maxConcurrentWindows: 8,
  }));
  assert.equal(wrongProtocol.mode, "generic", "unknown protocol must degrade");
  assert.match(wrongProtocol.degradeReason, /unsupported-protocol: 2/);
  const badProtocolType = await withApi(async () => ({ protocolVersion: "1", managedMode: true }));
  assert.equal(badProtocolType.mode, "generic", "non-numeric protocol must degrade");

  // 4. 协议正确但 managedMode=false → generic（内核没有策略保护时不得相信其它标志）
  const unmanaged = await withApi(async () => ({
    protocolVersion: 1, managedMode: false,
    backgroundWindows: true, backgroundCapture: true,
    hardFocusIsolation: true, foregroundAssist: true,
    maxConcurrentWindows: 8,
  }));
  assert.equal(unmanaged.mode, "generic", "managedMode=false must degrade even if flags claim otherwise");
  assert.equal(unmanaged.degradeReason, "managed-mode-disabled");
  assert.equal(unmanaged.backgroundWindows, false, "unmanaged mode must not trust host flags");

  // 5. 全绿 → enhanced，字段透传
  const enhanced = await withApi(async () => ({
    product: "Browser CLI", browserVersion: "156.0.8067.0",
    protocolVersion: 1, managedMode: true,
    backgroundWindows: true, backgroundCapture: true,
    hardFocusIsolation: true, foregroundAssist: true,
    maxConcurrentWindows: 8,
  }));
  assert.equal(enhanced.mode, "enhanced");
  assert.equal(enhanced.product, "Browser CLI");
  assert.equal(enhanced.maxConcurrentWindows, 8);
  assert.equal(capsMod.concurrencyLimit(enhanced), 8, "enhanced limit must come from the host");
  assert.equal(capsMod.concurrencyLimit(absent), 1, "generic limit is exactly one");

  // 6. 上限缺失/非法 → 退回 1，不得等于 0 或 NaN
  const badMax = await withApi(async () => ({
    protocolVersion: 1, managedMode: true, backgroundWindows: true,
    backgroundCapture: true, hardFocusIsolation: true, foregroundAssist: true,
    maxConcurrentWindows: 0,
  }));
  assert.equal(badMax.maxConcurrentWindows, 1, "non-positive host limit must fall back to 1");
  assert.equal(capsMod.concurrencyLimit(badMax), 1);

  // 7. 源码守卫：禁止用 UA / 产品名推断增强能力（要求 5）
  const capsSource = fs.readFileSync("src/background/capabilities.ts", "utf8");
  assert.doesNotMatch(capsSource, /userAgent|navigator\.platform|vendor/,
    "capability detection must not read User-Agent or platform");
  // product 只作为日志字段透传，源码里不得出现基于它的分支
  assert.doesNotMatch(capsSource, /product\s*===\s*["']/,
    "product name must never gate a capability decision");

  delete globalThis.chrome.browserCli;
  console.log("PASS core: host capability probe degrades safely and never trusts UA or product name");
}

// ---------- 截图策略：超时 / 降级 / 新鲜度（P0 后台截图链路） ----------
{
  const policy = await importTs("src/background/screenshot-policy.ts");
  const T = 60;

  // 1. 正常路径：合成器给帧，必须标记为新鲜。
  const fresh = await policy.captureWithFallback(async (params) => {
    assert.equal(params.fromSurface, true, "第一条路径必须尝试 fromSurface=true");
    return { data: "FRESH-PNG" };
  }, "png", T);
  assert.equal(fresh.base64, "FRESH-PNG");
  assert.equal(fresh.meta.possiblyStale, false, "合成器帧必须标记为新鲜");
  assert.equal(fresh.meta.fromSurface, true);

  // 2. 遮挡场景：fromSurface=true 永不返回 -> 必须超时并降级，且明确标注可能过期。
  let seen = [];
  const degraded = await policy.captureWithFallback(async (params) => {
    seen.push(params.fromSurface);
    if (params.fromSurface === true) return new Promise(() => {}); // 永不 resolve
    return { data: "CACHED-PNG" };
  }, "png", T);
  assert.equal(degraded.base64, "CACHED-PNG");
  assert.equal(degraded.meta.fromSurface, false, "超时后必须降级到浏览器进程快照");
  assert.equal(degraded.meta.possiblyStale, true, "降级得到的图必须标记 possiblyStale");
  assert.match(String(degraded.meta.reason), /60ms|没有返回/, "必须记录降级原因");
  assert.deepEqual(seen, [true, false], "两条路径都必须被尝试");

  // 3. 两条路径都失败 -> 抛错（带首次失败原因），不得返回空图。
  await assert.rejects(
    () => policy.captureWithFallback(async (params) => {
      if (params.fromSurface === true) return new Promise(() => {});
      throw new Error("snapshot unavailable");
    }, "png", T),
    /snapshot unavailable|两种路径/,
    "both paths failing must throw, never return an empty image",
  );

  // 4. 返回空数据同样视为失败（不能把空串当作成功画面）。
  await assert.rejects(
    () => policy.captureWithFallback(async () => ({ data: "" }), "png", T),
    /空数据|两种路径/,
  );

  // 5. 遮挡冷却：合成器超时后，冷却期内直接走快照，不重复挂起/累积 presentation 回调。
  let clock = 1_000;
  const cool = new policy.SurfaceCooldown({ baseMs: 5_000, maxMs: 20_000, maxConsecutiveTimeouts: 4 }, () => clock);
  assert.equal(cool.shouldSkip(), false);
  cool.recordTimeout();
  assert.equal(cool.shouldSkip(), true);
  assert.equal(cool.consecutiveTimeouts, 1);
  assert.equal(cool.remainingMs, 5_000);
  clock += 4_999;
  assert.equal(cool.shouldSkip(), true);
  clock += 1;
  assert.equal(cool.shouldSkip(), false, "冷却到期后必须重新尝试合成器路径");
  cool.recordTimeout();
  assert.equal(cool.remainingMs, 10_000, "连续超时必须按 2 倍退避");
  cool.recordSuccess();
  assert.equal(cool.shouldSkip(), false, "合成器成功后必须清除冷却");
  assert.equal(cool.consecutiveTimeouts, 0);

  // 5b. 硬闸：连续超时达到上限后彻底停止尝试，直到显式 reset。
  let hardClock = 1_000;
  const hard = new policy.SurfaceCooldown({ baseMs: 1_000, maxMs: 8_000, maxConsecutiveTimeouts: 3 }, () => hardClock);
  hard.recordTimeout();
  hard.recordTimeout();
  hard.recordTimeout();
  assert.equal(hard.shouldSkip(), true);
  assert.equal(hard.isHardStopped, true);
  hardClock += 1_000_000;
  assert.equal(hard.shouldSkip(), true, "硬闸不能被时间自动解除");
  hard.reset();
  assert.equal(hard.shouldSkip(), false, "reset 后必须恢复合成器尝试");

  // 6. 冷却期内的降级路径：不调用 fromSurface=true，但仍然明确标记 stale。
  const skippedCalls = [];
  const skipped = await policy.captureWithFallback(async (params) => {
    skippedCalls.push(params.fromSurface);
    return { data: "SNAPSHOT-PNG" };
  }, "png", T, {}, { skipFromSurface: true, skipReason: "fromSurface-cooldown-after-timeout" });
  assert.deepEqual(skippedCalls, [false], "冷却期必须跳过合成器路径");
  assert.equal(skipped.meta.possiblyStale, true);
  assert.equal(skipped.meta.reason, "fromSurface-cooldown-after-timeout");

  // 7. 源码守卫：截图路径不得再调用 ensureTabVisible（会把窗口拉到前台）。
  const cdpSource = fs.readFileSync("src/background/cdp.ts", "utf8");
  const activeLines = cdpSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
  assert.ok(
    !activeLines.some((line) => line.includes("ensureTabVisible(")),
    "captureScreenshot must never call ensureTabVisible",
  );
  assert.ok(
    cdpSource.includes("SurfaceCooldown") && cdpSource.includes("skipSurface"),
    "cdp.ts must throttle repeated fromSurface attempts on a tab that timed out",
  );
  assert.ok(
    cdpSource.includes("withTabCaptureLock"),
    "cdp.ts must serialise captures per tab so concurrent callers cannot stack fromSurface requests",
  );
  assert.ok(
    cdpSource.includes("resetSurfaceCooldown"),
    "cdp.ts must expose an explicit reset for the hard-stop cooldown",
  );
  console.log("PASS core: screenshots time out, degrade with an explicit stale flag, and never touch window focus");
}

// ---------- 截图超时清理：pending 表清空 / 迟到帧丢弃 / 错误两段原因 ----------
{
  const policy = await importTs("src/background/screenshot-policy.ts");
  // withTimeout 的迟到消费器：超时后 resolve 不得造成 unhandled rejection 或二次 settle。
  let releaseLate;
  const late = new Promise((resolve) => { releaseLate = resolve; });
  const events = [];
  await assert.rejects(
    () => policy.withTimeout(late, 20, "late-test", {
      phase: "fromSurface",
      hooks: {
        onAttemptSettle: (phase, outcome) => events.push([phase, outcome]),
        onTimeout: () => events.push(["timeout"]),
        onLateSettle: (phase, outcome) => events.push(["late", phase, outcome]),
      },
    }),
    /20ms 内没有返回/,
  );
  releaseLate("LATE");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, [["timeout"], ["fromSurface", "abandoned"], ["late", "fromSurface", "ok"]], "late settle must be consumed and reported exactly once");

  // 两条路径都抛错：错误必须保留两段原因（不得只留最后一次失败）。
  const bothFailed = await policy.captureWithFallback(async (params) => {
    throw new Error(params.fromSurface ? "surface-fail" : "snapshot-fail");
  }, "png", 30).then(() => undefined, (e) => e);
  assert.equal(bothFailed?.code, "SCREENSHOT_FAILED");
  assert.match(String(bothFailed?.firstReason), /surface-fail/);
  assert.match(String(bothFailed?.secondReason), /snapshot-fail/);
  assert.match(String(bothFailed?.message), /surface-fail[\s\S]*snapshot-fail/);
  console.log("PASS core: screenshot timeout cleans up and both-path errors keep every reason");
}

// ---------- cdp.ts 截图请求表：挂在 fromSurface 的请求超时后必须从 pending 移除 ----------
{
  debuggerEventListeners = [];
  globalThis.chrome.debugger = {
    onEvent: { addListener(fn) { debuggerEventListeners.push(fn); } },
    onDetach: { addListener() {} },
    async attach() {},
    async detach() {},
    async sendCommand() { return {}; },
  };
  const cdp = await importTs("src/background/cdp.ts");
  let resolveHung;
  let captured = 0;
  globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Page.startScreencast") {
      setTimeout(() => emitDebuggerEvent(target.tabId, "Page.screencastFrame", { data: "SCREENCAST-FRAME", sessionId: 1 }), 0);
      return {};
    }
    if (method !== "Page.captureScreenshot") return { result: { value: true } };
    captured += 1;
    if (params.fromSurface === true) {
      return new Promise((resolve) => { resolveHung = () => resolve({ data: "LATE-FRAME" }); });
    }
    return { data: "FALLBACK-FRAME" };
  };

  const shot = await cdp.captureScreenshot(11, "png", { timeoutMs: 30 });
  assert.equal(shot.base64, "SCREENCAST-FRAME", "fromSurface 超时后必须走单帧投屏兜底");
  assert.equal(shot.meta.path, "screencast");
  assert.equal(shot.meta.fromSurface, true, "投屏帧仍来自合成器");
  assert.equal(shot.meta.possiblyStale, false, "投屏兜底返回的必须是新鲜帧");
  assert.match(String(shot.meta.reason), /30ms/, "降级原因必须保留超时时长");
  assert.equal(cdp.pendingScreenshotAttempts(11), 0, "超时后不得留下 pending 截图请求");

  // 迟到的帧只允许被丢弃：不能成为下一次截图的结果。
  resolveHung();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cdp.screenshotCleanupStats().abandoned >= 1, "abandoned attempt must be counted");
  assert.ok(cdp.screenshotCleanupStats().lateSettles >= 1, "late frame must be observed and discarded");
  globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Page.startScreencast") {
      setTimeout(() => emitDebuggerEvent(target.tabId, "Page.screencastFrame", { data: "SCREENCAST-FRAME", sessionId: 1 }), 0);
      return {};
    }
    return method === "Page.captureScreenshot"
      ? { data: params.fromSurface ? "FRESH-2" : "OLD-2" }
      : { result: { value: true } };
  };
  const second = await cdp.captureScreenshot(11, "png", { timeoutMs: 500 });
  assert.equal(second.base64, "SCREENCAST-FRAME", "cooldown 必须直接走单帧投屏");
  assert.equal(second.meta.possiblyStale, false);
  assert.equal(second.meta.reason, "fromSurface-cooldown-after-timeout");
  cdp.__resetSurfaceCooldownsForTests();
  const third = await cdp.captureScreenshot(11, "png", { timeoutMs: 500 });
  assert.equal(third.base64, "FRESH-2", "a late frame must never leak into the next capture");
  assert.equal(third.meta.possiblyStale, false);
  assert.equal(cdp.pendingScreenshotAttempts(11), 0);
  assert.ok(captured >= 1);
  console.log("PASS core: timed-out CDP screenshots fall back to a fresh screencast frame and late frames are discarded");
}

// ---------- 同一 tab 截图串行 / 不同 tab 互不阻塞 / 冷却阻止重复 fromSurface ----------
{
  const cdp = await importTs("src/background/cdp.ts");
  cdp.__resetSurfaceCooldownsForTests();
  const surfaceCalls = new Map([[21, 0], [22, 0]]);
  globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Page.startScreencast") {
      setTimeout(() => emitDebuggerEvent(target.tabId, "Page.screencastFrame", { data: "SCREENCAST-21", sessionId: 1 }), 0);
      return {};
    }
    if (method === "Runtime.evaluate") return { result: { value: true } };
    if (method !== "Page.captureScreenshot") return {};
    const tabId = target.tabId;
    if (params.fromSurface === true) {
      surfaceCalls.set(tabId, (surfaceCalls.get(tabId) ?? 0) + 1);
      if (tabId === 21) return new Promise(() => {}); // hangs forever
      return { data: "FRESH-" + tabId };
    }
    return { data: "SNAPSHOT-" + tabId };
  };

  let firstSettled = false;
  const first = cdp.captureScreenshot(21, "png", { timeoutMs: 500 });
  void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  const second = cdp.captureScreenshot(21, "png", { timeoutMs: 500 });

  const other = await cdp.captureScreenshot(22, "png", { timeoutMs: 500 });
  assert.equal(other.base64, "FRESH-22");
  assert.equal(other.meta.possiblyStale, false);
  assert.equal(firstSettled, false, "a hanging tab must not block screenshots on other tabs");

  const firstShot = await first;
  assert.equal(firstShot.base64, "SCREENCAST-21");
  assert.equal(firstShot.meta.path, "screencast");
  assert.equal(firstShot.meta.possiblyStale, false);
  const secondShot = await second;
  assert.equal(secondShot.base64, "SCREENCAST-21");
  assert.equal(secondShot.meta.possiblyStale, false);
  assert.equal(secondShot.meta.reason, "fromSurface-cooldown-after-timeout");
  assert.equal(surfaceCalls.get(21), 1, "same-tab concurrent captures issued more than one fromSurface request");
  console.log("PASS core: same-tab captures serialise, other tabs stay independent, cooldown blocks repeat fromSurface");
}

// ---------- registry:check：CRLF 检出不得被误判为生成文件过期 ----------
{
  const registry = await import("./registry-check.mjs");
  assert.equal(registry.normalizeNewlines("a\r\nb\rc\nd"), "a\nb\nc\nd", "CRLF and lone CR must normalize to LF");
  assert.equal(registry.sameGeneratedContent("a\r\nb\r\n", "a\nb\n"), true, "CRLF checkout must match LF generator output");
  assert.equal(registry.sameGeneratedContent("a\r\nb\n", "a\nB\n"), false, "real content differences must still fail");
  const catalogText = fs.readFileSync("registry/catalog.json", "utf8");
  const crlfCatalog = catalogText.replace(/\r?\n/g, "\r\n");
  assert.equal(registry.sameGeneratedContent(crlfCatalog, catalogText), true, "a CRLF checkout of registry/catalog.json must pass registry:check");
  const mismatch = registry.describeMismatch("a\nb\n", "a\nc\n");
  assert.equal(mismatch?.line, 2, "mismatch reports the first differing line");
  console.log("PASS core: registry check normalizes CRLF/LF instead of rewriting every generated file");
}

// ---------- 虚拟光标接线守卫：截图命令必须走 cursor-aware 策略 ----------
{
  const commandsSource = fs.readFileSync("src/background/commands.ts", "utf8");
  assert.ok(
    commandsSource.includes("captureScreenshotWithCursorPolicy("),
    "screenshot must use the cursor-aware capture policy",
  );
  assert.ok(
    commandsSource.includes("withCursorHiddenForCapture("),
    "scroll_screenshot must hide the cursor for the whole capture",
  );
  assert.ok(commandsSource.includes("handleCursorCommand"), "commands.ts must expose the cursor command");
  assert.ok(
    !/\bcaptureScreenshot\(/.test(commandsSource),
    "commands.ts must not bypass the cursor policy with a raw captureScreenshot call",
  );
  const indexSource = fs.readFileSync("src/background/index.ts", "utf8");
  assert.ok(
    indexSource.includes("registerVirtualCursorHandlers()"),
    "index.ts must register cursor lifecycle handlers",
  );
  console.log("PASS core: virtual cursor is wired into screenshot, scroll capture, stop, and SW startup");
}

// ---------- AI 虚拟鼠标（虚拟光标 overlay / 截图排除 / 清理）----------
await import("./test-virtual-cursor.mjs");

// ---------- 输入权仲裁（P3，扩展侧）：HUMAN / ASSIST / AI 派生视图 + grant ----------
// 与独立的 test:input-ownership 共用同一份用例，避免两处漂移。
await import("./test-input-ownership.mjs");

// ---------- 输入权生产 API（P3）：chrome.browserCli.inputOwnership 客户端 ----------
// 覆盖 API 探测/generic no-op/单调 version/10s 心跳/30s 失联/SW 重启/命令 scope。
await import("./test-input-ownership-api.mjs");
