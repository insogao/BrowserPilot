// 离线单测：P3 生产 API 客户端（chrome.browserCli.inputOwnership，扩展侧）。
//
// 覆盖：API 缺失/generic no-op / enhanced 同步 / 单调 version / 版本乱序重试 /
//       10s 心跳 / 30s 失联 degraded（AI 输入 fail closed）/ SW 重启恢复 /
//       ASSIST 命令 scope（一条命令 = 一次 grant + begin/end）/ 半实现 API /
//       内核 human_presence 事件桥 / 源码守卫。
//
// 运行：node scripts/test-input-ownership-api.mjs
// 也由 scripts/test-core.mjs 末尾 import（共用它的 chrome.storage.session mock）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

const STATE_KEY = "browserpilot.state.v1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sessionStore = {};
let clock = 1_000_000;
const tabsById = new Map([
  [11, { id: 11, windowId: 1, active: true }],
  [22, { id: 22, windowId: 2, active: true }],
  [33, { id: 33, windowId: 3, active: true }],
]);

function installChromeShim() {
  if (!globalThis.chrome) globalThis.chrome = {};
  const g = globalThis.chrome;
  g.storage = {
    session: {
      async get(key) {
        return { [key]: sessionStore[key] };
      },
      async set(values) {
        sessionStore = { ...sessionStore, ...values };
      },
    },
  };
  g.tabs = {
    async get(tabId) {
      const tab = tabsById.get(tabId);
      if (!tab) throw new Error("tab not found: " + tabId);
      return tab;
    },
    async query() {
      return [...tabsById.values()];
    },
  };
  g.windows = {
    async get(windowId) {
      return { id: windowId };
    },
    onRemoved: { addListener() {} },
  };
  g.alarms = undefined;
}

async function bundleInputOwnershipApi() {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/background/input-ownership-api.ts";',
        'export { InputOwnershipError, INPUT_COMMANDS, inputModeForSpace, onInputModeChanged } from "./src/background/input-ownership.ts";',
        'export { loadState, mutateState } from "./src/background/state.ts";',
        'export { markInternalCommand } from "./src/background/spaces.ts";',
        'export { drainEvents } from "./src/background/events.ts";',
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "chrome116",
    logLevel: "warning",
  });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
}

function space(id, overrides = {}) {
  return {
    spaceId: id,
    name: id,
    windowId: 1,
    tabId: 11,
    ownerClientId: "agent:a",
    ownership: "agent",
    layer: "L0",
    navVersion: 0,
    attached: false,
    eventQueueTail: 0,
    ...overrides,
  };
}

const enhancedCaps = {
  mode: "enhanced",
  protocolVersion: 1,
  managedMode: true,
  backgroundWindows: true,
  backgroundCapture: true,
  hardFocusIsolation: true,
  foregroundAssist: true,
  maxConcurrentWindows: 8,
};
const genericCaps = {
  mode: "generic",
  protocolVersion: 0,
  managedMode: false,
  backgroundWindows: false,
  backgroundCapture: false,
  hardFocusIsolation: false,
  foregroundAssist: false,
  maxConcurrentWindows: 1,
  degradeReason: "api-absent",
};

function makeApi(overrides = {}) {
  const calls = { set: [], heartbeat: [], get: [], grant: [], begin: [], end: [], attach: [] };
  const api = {
    async setOwnership(request) {
      calls.set.push(request);
      return overrides.setOwnership
        ? overrides.setOwnership(request, calls)
        : { accepted: true, mode: request.mode, version: request.version };
    },
    async heartbeat(request) {
      calls.heartbeat.push(request);
      return overrides.heartbeat
        ? overrides.heartbeat(request, calls)
        : { ok: true, version: request.version, stale: false };
    },
    async getOwnership(request) {
      calls.get.push(request);
      return overrides.getOwnership ? overrides.getOwnership(request, calls) : { mode: "ai", version: 1 };
    },
  };
  if (overrides.withScope !== false) {
    api.grantInput = async (request) => {
      calls.grant.push(request);
      return overrides.grantInput
        ? overrides.grantInput(request, calls)
        : { granted: true, actions: 1, expiresAt: clock + 10_000 };
    };
    api.beginInputCommand = async (request) => {
      calls.begin.push(request);
      return overrides.beginInputCommand
        ? overrides.beginInputCommand(request, calls)
        : { ok: true, scopeId: "scope-1", deadline: clock + 10_000 };
    };
    api.endInputCommand = async (request) => {
      calls.end.push(request);
      return overrides.endInputCommand ? overrides.endInputCommand(request, calls) : { ok: true, closed: true };
    };
  }
  if (overrides.withPresence !== false) {
    const listeners = [];
    api.onHumanPresence = {
      addListener(listener) {
        listeners.push(listener);
      },
      removeListener(listener) {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
    api.__presenceListeners = listeners;
  }
  return { api, calls };
}

export async function runInputOwnershipApiTests() {
  installChromeShim();
  const io = await bundleInputOwnershipApi();

  const cmd = (name, args = {}) => ({
    type: "command",
    name,
    args,
    requestId: "kapi-" + name + "-" + Math.random().toString(36).slice(2),
    _clientId: "agent:a",
  });
  const guard = (mode, extra = {}) => ({
    mode,
    spaceId: "space-a",
    tabId: 11,
    windowId: 1,
    ...extra,
  });
  const expectCode = async (promise, code, label) => {
    try {
      await promise;
    } catch (error) {
      assert.equal(error.code, code, (label ?? "") + ": 期望 " + code + "，实际 " + error.code + " (" + error.message + ")");
      return error;
    }
    assert.fail((label ?? "") + ": 期望抛出 " + code + "，实际成功");
  };
  const audit = (name) => io.drainEvents({ after_sequence: 0, limit: 100000, methods: [name] }).events;

  let apiBundle = null;
  let calls = null;

  async function reset(options = {}) {
    io.__resetKernelInputOwnershipForTests();
    clock = 1_000_000;
    io.__setKernelInputOwnershipClockForTests(() => clock);
    io.__setKernelInputHeartbeatIntervalForTests(10_000);
    io.__setKernelPresenceDebounceForTests(500);
    io.__setKernelApiTimeoutForTests(2000);
    // 默认关闭「状态变化自动同步」：测试显式调用 init/heartbeat，避免未等待的微任务干扰断言。
    io.__setKernelAutoSyncForTests(options.autoSync === true);
    sessionStore = {};
    apiBundle = options.api === null ? null : (options.api ?? makeApi().api);
    calls = options.calls ?? (options.api && options.api.__calls) ?? (apiBundle ? { set: [], heartbeat: [], get: [], grant: [], begin: [], end: [], attach: [] } : null);
    if (apiBundle) {
      globalThis.chrome.browserCli = { inputOwnership: apiBundle };
    } else {
      delete globalThis.chrome.browserCli;
    }
    const spaces = options.spaces ?? { "space-a": space("space-a") };
    const state = {
      spaces,
      activeSpaceIds: { "agent:a": "space-a" },
      startTime: 1,
      hostCapabilities: options.caps === null ? undefined : (options.caps ?? enhancedCaps),
    };
    if (options.ledger) state.kernelInputOwnership = options.ledger;
    sessionStore[STATE_KEY] = state;
    return { spaces };
  }

  try {
    // ------------------------------------------------------------------
    // 1. 探测：API 存在性是唯一信号；半实现不算支持
    // ------------------------------------------------------------------
    {
      await reset({ api: null });
      assert.equal(io.getInputOwnershipApi(), undefined, "普通 Chrome 上 API 必须不存在");
      globalThis.chrome.browserCli = { inputOwnership: { setOwnership: async () => ({}) } };
      assert.equal(io.getInputOwnershipApi(), undefined, "缺少 heartbeat/getOwnership 的半实现不得被视为支持");
      const { api } = makeApi();
      globalThis.chrome.browserCli = { inputOwnership: api };
      assert.equal(io.getInputOwnershipApi(), api, "完整 API 必须被探测到");
      console.log("PASS input-ownership-api: API presence is the only signal (partial APIs are unsupported)");
    }

    // ------------------------------------------------------------------
    // 2. generic host：即使 API 存在于全局，也零调用、零行为变化
    // ------------------------------------------------------------------
    {
      const made = makeApi();
      await reset({ caps: genericCaps, api: made.api });
      const madeCalls = made.calls;
      await io.initKernelInputOwnership({ force: true });
      assert.equal(madeCalls.set.length, 0, "generic host 不得调用 setOwnership");
      assert.equal(madeCalls.heartbeat.length, 0, "generic host 不得发送心跳");
      const status = io.kernelInputOwnershipStatusForWindow(1, "ai");
      assert.equal(status.state, "unsupported");
      assert.equal(status.reason, "generic-host");
      assert.equal(status.supported, false);
      let ran = 0;
      await io.withKernelInputScope(cmd("click"), guard("ai"), async () => {
        ran += 1;
        return "ok";
      });
      assert.equal(ran, 1, "generic host 的命令必须原样执行（只有命令层守卫）");
      assert.equal(madeCalls.set.length + madeCalls.heartbeat.length, 0);
      console.log("PASS input-ownership-api: generic host is a strict no-op (no calls, no timers)");
    }

    // ------------------------------------------------------------------
    // 3. enhanced host + API 缺失（Feature 关闭）：退化为命令层守卫
    // ------------------------------------------------------------------
    {
      await reset({ caps: enhancedCaps, api: null });
      await io.initKernelInputOwnership({ force: true });
      const status = io.kernelInputOwnershipStatusForWindow(1, "ai");
      assert.equal(status.state, "unsupported");
      assert.equal(status.reason, "api-absent");
      let ran = 0;
      await io.withKernelInputScope(cmd("click"), guard("assist"), async () => {
        ran += 1;
      });
      assert.equal(ran, 1, "内核 Feature 关闭时 ASSIST 也不得被客户端阻塞（命令层已守卫）");
      assert.equal(
        audit("input_ownership_api_unavailable").filter((event) => event.args.reason === "api-absent").length,
        1,
        "API 不可用只审计一次",
      );
      console.log("PASS input-ownership-api: enhanced host without the API falls back to the command-layer guard");
    }

    // ------------------------------------------------------------------
    // 4. enhanced 同步：三种派生模式 + 单调 version + 同模式走 heartbeat
    // ------------------------------------------------------------------
    {
      const spaces = {
        "space-a": space("space-a", { windowId: 1, tabId: 11 }),
        "space-b": space("space-b", { windowId: 2, tabId: 22, ownership: "user" }),
        "space-c": space("space-c", { windowId: 3, tabId: 33, assist: { since: 1, reason: "test" } }),
      };
      const made = makeApi();
      await reset({ spaces, api: made.api });
      const c = made.calls;
      await io.initKernelInputOwnership({ force: true });
      const byWindow = new Map(c.set.map((call) => [call.target.windowId, call]));
      assert.equal(byWindow.get(1).mode, "ai");
      assert.equal(byWindow.get(2).mode, "human");
      assert.equal(byWindow.get(3).mode, "assist");
      for (const call of c.set) assert.equal(call.version, 1, "首次同步 version 必须是 1");

      let ledger = (await io.loadState()).kernelInputOwnership.targets;
      assert.equal(ledger["win:1"].version, 1);
      assert.equal(ledger["win:1"].mode, "ai");

      // 模式不变：10s 心跳只发 heartbeat，不 bump version
      await io.heartbeatKernelInputOwnership("test-same");
      assert.equal(c.set.length, 3, "模式没变不得重复 setOwnership");
      assert.equal(c.heartbeat.length, 3, "每个目标都必须有心跳");
      assert.deepEqual(c.heartbeat.map((call) => call.version), [1, 1, 1]);

      // 模式变化：version +1
      await io.mutateState((state) => {
        state.spaces["space-a"].ownership = "user";
      });
      await io.heartbeatKernelInputOwnership("test-change");
      const aSets = c.set.filter((call) => call.target.windowId === 1);
      assert.equal(aSets.at(-1).mode, "human");
      assert.equal(aSets.at(-1).version, 2, "模式变化必须单调 +1");
      ledger = (await io.loadState()).kernelInputOwnership.targets;
      assert.equal(ledger["win:1"].version, 2);
      assert.equal(ledger["win:1"].mode, "human");
      console.log("PASS input-ownership-api: derived modes sync with monotonic versions; same mode only heartbeats");
    }

    // ------------------------------------------------------------------
    // 5. 版本乱序：采纳内核更高 version，只重试一次，绝不回退
    // ------------------------------------------------------------------
    {
      let callsSeen = 0;
      const made = makeApi({
        setOwnership(request) {
          callsSeen += 1;
          if (callsSeen === 1) {
            return { accepted: false, reason: "stale-version", version: 9, mode: "assist" };
          }
          return { accepted: true, version: 10, mode: "ai" };
        },
      });
      await reset({
        spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11 }) },
        api: made.api,
        ledger: { targets: { "win:1": { version: 5, mode: "assist", lastAckAt: clock } } },
      });
      await io.initKernelInputOwnership({ force: true });
      assert.deepEqual(made.calls.set.map((call) => call.version), [6, 10], "必须先尝试 6，采纳内核 9 后重试 10");
      const ledger = (await io.loadState()).kernelInputOwnership.targets;
      assert.equal(ledger["win:1"].version, 10, "必须持久采纳内核更高的 version");
      assert.equal(ledger["win:1"].mode, "ai");
      assert.equal(audit("input_ownership_version_conflict").length, 1, "版本冲突必须审计");
      console.log("PASS input-ownership-api: out-of-order versions are adopted and retried exactly once");
    }

    // ------------------------------------------------------------------
    // 6. 同步失败 → 30s 后 degraded；AI 输入 fail closed；恢复后自动放行
    // ------------------------------------------------------------------
    {
      const failCalls = { set: 0, heartbeat: 0 };
      const made = makeApi({
        setOwnership() {
          failCalls.set += 1;
          throw new Error("kernel down");
        },
        heartbeat() {
          failCalls.heartbeat += 1;
          throw new Error("kernel down");
        },
      });
      await reset({ spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11 }) }, api: made.api });
      await io.initKernelInputOwnership({ force: true });
      let status = io.kernelInputOwnershipStatusForWindow(1, "ai");
      assert.equal(status.degraded, false, "一次失败不得立刻降级");
      assert.match(status.lastError, /kernel down/);

      clock += 31_000;
      await io.heartbeatKernelInputOwnership("test-stale");
      status = io.kernelInputOwnershipStatusForWindow(1, "ai");
      assert.equal(status.degraded, true, "超过 30s 没有任何确认必须 degraded");
      assert.equal(status.effectiveMode, "assist", "degraded 必须按 ASSIST 语义呈现");
      assert.ok(audit("input_ownership_sync_lost").length >= 1, "失联必须审计");

      let ran = 0;
      await expectCode(
        io.withKernelInputScope(cmd("click"), guard("ai"), async () => {
          ran += 1;
        }),
        "INPUT_KERNEL_SYNC_LOST",
        "degraded 下的 AI 输入",
      );
      assert.equal(ran, 0, "degraded 时绝不能让 AI 输入静默继续");

      // 恢复：API 重新可用，下一次心跳/命令前同步清除 degraded
      made.api.setOwnership = async (request) => {
        made.calls.set.push(request);
        return { accepted: true, mode: request.mode, version: request.version };
      };
      made.api.heartbeat = async (request) => {
        made.calls.heartbeat.push(request);
        return { ok: true, version: request.version, stale: false };
      };
      await io.heartbeatKernelInputOwnership("recover");
      status = io.kernelInputOwnershipStatusForWindow(1, "ai");
      assert.equal(status.degraded, false, "同步恢复后必须解除 degraded");
      await io.withKernelInputScope(cmd("click"), guard("ai"), async () => {
        ran += 1;
      });
      assert.equal(ran, 1, "恢复后 AI 输入必须重新放行");
      console.log("PASS input-ownership-api: 30s sync loss degrades to ASSIST semantics and recovers explicitly");
    }

    // ------------------------------------------------------------------
    // 6b. 内核调用挂死：硬超时按失败处理，绝不阻塞 SW 初始化
    // ------------------------------------------------------------------
    {
      const made = makeApi({ setOwnership: () => new Promise(() => {}) });
      await reset({ spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11 }) }, api: made.api });
      io.__setKernelApiTimeoutForTests(20);
      const startedAt = Date.now();
      await io.initKernelInputOwnership({ force: true });
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 1000, "挂死的内核调用不得阻塞 SW 初始化，实际 " + elapsed + "ms");
      const status = io.kernelInputOwnershipStatusForWindow(1, "ai");
      assert.match(String(status.lastError), /timeout/, "超时必须被记录为同步失败");
      console.log("PASS input-ownership-api: a hung kernel call times out and never blocks SW startup");
    }

    // ------------------------------------------------------------------
    // 7. 10s 心跳定时器（按注入的 20ms 验证至少两次 tick）
    // ------------------------------------------------------------------
    {
      const made = makeApi();
      await reset({ spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11 }) }, api: made.api });
      io.__setKernelInputHeartbeatIntervalForTests(20);
      await io.initKernelInputOwnership({ force: true });
      const before = made.calls.heartbeat.length;
      await sleep(130);
      assert.ok(
        made.calls.heartbeat.length >= before + 2,
        "10s 心跳定时器必须周期触发（测试用 20ms），实际: " + (made.calls.heartbeat.length - before),
      );
      io.__resetKernelInputOwnershipForTests(); // 停止定时器
      console.log("PASS input-ownership-api: periodic heartbeat runs on the configured interval");
    }

    // ------------------------------------------------------------------
    // 8. SW 重启：重新探测 + 重新 setOwnership（同 version 幂等）+ heartbeat
    // ------------------------------------------------------------------
    {
      const made = makeApi();
      await reset({ spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11 }) }, api: made.api });
      await io.initKernelInputOwnership({ force: true });
      const firstSet = made.calls.set.length;
      assert.equal(firstSet, 1);
      assert.equal(made.calls.set[0].version, 1);

      io.__simulateServiceWorkerRestartForTests();
      await io.initKernelInputOwnership({ force: true });
      assert.equal(made.calls.set.length, firstSet + 1, "SW 重启后必须重新登记 setOwnership");
      assert.equal(made.calls.set.at(-1).version, 1, "模式/version 都没变时必须幂等重放，不能无故 +1");
      assert.equal(made.calls.set.at(-1).mode, "ai");
      const ledger = (await io.loadState()).kernelInputOwnership.targets;
      assert.equal(ledger["win:1"].version, 1, "重启不得重置或回退持久 version");

      await io.heartbeatKernelInputOwnership("after-restart");
      assert.ok(made.calls.heartbeat.length >= 1, "重启后必须继续心跳");
      console.log("PASS input-ownership-api: SW restart re-probes, replays setOwnership idempotently, resumes heartbeat");
    }

    // ------------------------------------------------------------------
    // 9. ASSIST 命令 scope：一条命令 = 1 次 grant + begin/end
    // ------------------------------------------------------------------
    {
      const made = makeApi();
      await reset({
        spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11, assist: { since: 1, reason: "test" } }) },
        api: made.api,
      });
      await io.initKernelInputOwnership({ force: true });
      made.calls.set.length = 0;
      made.calls.heartbeat.length = 0;
      let ran = 0;
      const result = await io.withKernelInputScope(
        cmd("dblclick", { selector: "#x" }),
        guard("assist"),
        async () => {
          ran += 1;
          return "done";
        },
        { attach: async (tabId) => made.calls.attach.push(tabId) },
      );
      assert.equal(result, "done");
      assert.equal(ran, 1);
      assert.deepEqual(made.calls.attach, [11], "ASSIST 必须先建立 debugger session");
      assert.equal(made.calls.grant.length, 1, "一条命令只能申请一次 grant");
      assert.deepEqual(made.calls.grant[0].target, { tabId: 11 });
      assert.equal(made.calls.grant[0].actions, 1);
      assert.equal(made.calls.grant[0].ttlMs, io.KERNEL_COMMAND_TTL_MS, "鼠标类命令默认 10s 绝对 TTL");
      assert.equal(io.commandTtlFor("type"), io.KERNEL_COMMAND_TEXT_TTL_MS, "type 需要更长的文本窗口");
      assert.equal(io.commandTtlFor("tab_cdp_call"), io.KERNEL_COMMAND_EVAL_TTL_MS, "CDP 透传需要更长的求值窗口");
      assert.equal(made.calls.begin.length, 1, "一条命令只能开一个 scope");
      assert.equal(made.calls.begin[0].kind, "dblclick");
      assert.equal(made.calls.end.length, 1);
      assert.equal(made.calls.end[0].outcome, "ok");
      assert.equal(made.calls.end[0].commandId, made.calls.begin[0].commandId);

      // handler 抛错：end 仍必须调用，outcome=failed
      made.calls.begin.length = 0;
      made.calls.end.length = 0;
      made.calls.grant.length = 0;
      await assert.rejects(
        () =>
          io.withKernelInputScope(cmd("click"), guard("assist"), async () => {
            throw new Error("action failed");
          }),
        /action failed/,
      );
      assert.equal(made.calls.end.length, 1);
      assert.equal(made.calls.end[0].outcome, "failed");
      console.log("PASS input-ownership-api: one ASSIST command maps to exactly one kernel grant and begin/end scope");
    }

    // ------------------------------------------------------------------
    // 10. ASSIST 下 begin/grant 失败 → fail closed；AI 不受影响；半实现 API 拒绝
    // ------------------------------------------------------------------
    {
      const made = makeApi({
        beginInputCommand() {
          return { ok: false, reason: "no-grant" };
        },
      });
      await reset({
        spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11, assist: { since: 1, reason: "test" } }) },
        api: made.api,
      });
      await io.initKernelInputOwnership({ force: true });
      let ran = 0;
      await expectCode(
        io.withKernelInputScope(cmd("click"), guard("assist"), async () => {
          ran += 1;
        }),
        "INPUT_KERNEL_SYNC_LOST",
        "begin 被拒绝",
      );
      assert.equal(ran, 0, "begin 失败时 handler 绝不能执行");

      // 半实现：核心三方法在，但没有 grant/begin/end
      const partial = makeApi({ withScope: false });
      await reset({
        spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11, assist: { since: 1, reason: "test" } }) },
        api: partial.api,
      });
      await io.initKernelInputOwnership({ force: true });
      await expectCode(
        io.withKernelInputScope(cmd("click"), guard("assist"), async () => {
          ran += 1;
        }),
        "INPUT_OWNERSHIP_API_INCOMPLETE",
        "半实现 API 的 ASSIST",
      );
      assert.equal(ran, 0);
      await io.withKernelInputScope(cmd("click"), guard("ai"), async () => {
        ran += 1;
      });
      assert.equal(ran, 1, "半实现 API 不影响 AI（不需要 grant/scope）");
      console.log("PASS input-ownership-api: ASSIST fails closed on begin/grant failure and on incomplete APIs");
    }

    // ------------------------------------------------------------------
    // 11. 内核 human_presence 事件桥：内部标记 → 500ms 去抖 → ASSIST
    // ------------------------------------------------------------------
    {
      const made = makeApi();
      await reset({ spaces: { "space-a": space("space-a", { windowId: 1, tabId: 11 }) }, api: made.api });
      await io.initKernelInputOwnership({ force: true });
      assert.equal(made.api.__presenceListeners.length, 1, "必须注册内核 human_presence 监听器");
      io.__setKernelPresenceDebounceForTests(40);
      made.api.__presenceListeners[0]({ tabId: 11, kind: "mouse", at: clock });
      await sleep(20);
      assert.equal(io.inputModeForSpace((await io.loadState()).spaces["space-a"]), "ai", "去抖窗口内不得提前进 ASSIST");
      await sleep(90);
      const after = (await io.loadState()).spaces["space-a"];
      assert.equal(io.inputModeForSpace(after), "assist", "内核人类在场事件必须进入 ASSIST");
      assert.equal(after.assist.reason, "kernel:mouse");
      assert.ok(audit("input_kernel_presence_received").length >= 1);

      made.api.__presenceListeners[0]({ tabId: 999, kind: "key" });
      await sleep(20);
      assert.ok(audit("input_kernel_presence_ignored").length >= 1, "未知 tab 的 presence 必须被忽略并审计");
      console.log("PASS input-ownership-api: kernel human_presence enters ASSIST through the internal bridge only");
    }

    // ------------------------------------------------------------------
    // 12. 源码守卫：不新建所有权 / 不绕过 cdp 层 / 接线存在
    // ------------------------------------------------------------------
    {
      const apiSource = fs.readFileSync("src/background/input-ownership-api.ts", "utf8");
      assert.doesNotMatch(apiSource, /ownership\s*[:=]\s*["'](?:agent|user|inactive|assist)["']/,
        "input-ownership-api 不得写 ownership");
      assert.doesNotMatch(apiSource, /from "\.\/(?:cdp|mask|actions|screenshot-policy|virtual-cursor)"/,
        "input-ownership-api 不得依赖 CDP/遮罩/动作实现");
      assert.match(apiSource, /markInternalCommand\(/, "内核 presence 桥必须用进程内标记构造命令");
      assert.match(apiSource, /KERNEL_HEARTBEAT_INTERVAL_MS = 10_000/, "心跳周期必须是 10s");
      assert.match(apiSource, /KERNEL_STALE_MS = 30_000/, "失联阈值必须是 30s");

      const stateSource = fs.readFileSync("src/background/state.ts", "utf8");
      assert.match(stateSource, /ownership\?: "agent" \| "user" \| "inactive";/,
        "ownership 取值集合不得扩展");
      assert.match(stateSource, /kernelInputOwnership\?: KernelInputOwnershipState;/,
        "内核同步账本必须是可选字段（普通 Chrome 零数据面变化）");

      const commandsSource = fs.readFileSync("src/background/commands.ts", "utf8");
      assert.match(commandsSource, /withKernelInputScope\(cmd, guard, \(\) => KNOWN\[name\]\(cmd\)/,
        "dispatch 必须用内核 scope 包裹真正的 handler");
      assert.match(commandsSource, /kernelInputOwnershipStatusForWindow\(status\.windowId, status\.mode\)/,
        "input_status 必须透出内核同步视图");

      const indexSource = fs.readFileSync("src/background/index.ts", "utf8");
      assert.match(indexSource, /initKernelInputOwnership\(\)/, "SW 启动必须初始化内核输入权桥");
      assert.match(indexSource, /heartbeatKernelInputOwnership\("alarm"\)/, "30s alarm 必须兜底心跳");

      const inputOwnershipSource = fs.readFileSync("src/background/input-ownership.ts", "utf8");
      assert.match(inputOwnershipSource, /onInputModeChanged/, "assist enter/exit 必须通知内核同步");
      for (const file of ["cdp.ts", "screenshot-policy.ts", "virtual-cursor.ts", "mask.ts", "actions.ts"]) {
        assert.doesNotMatch(
          fs.readFileSync("src/background/" + file, "utf8"),
          /input-ownership-api/,
          file + " 不得被本轮改动（边界要求）",
        );
      }
      console.log("PASS input-ownership-api: source guards keep one ownership source and the kernel bridge isolated");
    }
  } finally {
    io.__setKernelInputOwnershipClockForTests(undefined);
    io.__resetKernelInputOwnershipForTests();
    delete globalThis.chrome.browserCli;
  }
}

// 独立运行时执行；被 test-core import 时同样执行（顶层 await）。
await runInputOwnershipApiTests();
