// 离线单测：输入权仲裁（P3，扩展侧）。
//
// 覆盖：模式派生 / HUMAN 拒绝 / ASSIST 无 grant 拒绝 / grant 消耗·用尽·过期 /
//       ownership 变更清空 / AI 放行 / 审计事件 / human_presence 去抖 /
//       「没有第二套 ownership 状态机」的源码守卫。
//
// 运行：node scripts/test-input-ownership.mjs
// 也由 scripts/test-core.mjs 末尾 import（共用它的 chrome.storage.session mock）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

const STATE_KEY = "browserpilot.state.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 最小 chrome shim（独立运行时安装；test-core 里复用它的 storage mock）
// ---------------------------------------------------------------------------
function ensureChromeShim() {
  if (!globalThis.chrome) globalThis.chrome = {};
  const g = globalThis.chrome;
  if (!g.storage?.session) {
    let stored = {};
    g.storage = {
      session: {
        async get(key) { return { [key]: stored[key] }; },
        async set(values) { stored = { ...stored, ...values }; },
      },
    };
  }
}

async function bundleInputOwnership() {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/background/input-ownership.ts";',
        'export { drainEvents } from "./src/background/events.ts";',
        'export { loadState, patchSpace } from "./src/background/state.ts";',
        'export { claim_space } from "./src/background/spaces.ts";',
        'export { ensureCommandSpace } from "./src/background/spaces.ts";',
        'export { commandClientId, markInternalCommand, INTERNAL_CLIENT_ID, UNTRUSTED_CLIENT_ID } from "./src/background/spaces.ts";',
        'export * from "./src/background/popup-entry.ts";',
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

function makeState(spaceOverrides = {}) {
  return {
    spaces: {
      "space-a": {
        spaceId: "space-a",
        name: "A",
        windowId: 1,
        tabId: 11,
        ownerClientId: "agent:a",
        ownership: "agent",
        layer: "L0",
        navVersion: 0,
        attached: false,
        eventQueueTail: 0,
        ...(spaceOverrides["space-a"] ?? {}),
      },
      ...Object.fromEntries(
        Object.entries(spaceOverrides).filter(([id]) => id !== "space-a").map(([id, value]) => [id, {
          spaceId: id,
          name: id,
          layer: "L0",
          navVersion: 0,
          attached: false,
          eventQueueTail: 0,
          ...value,
        }]),
      ),
    },
    activeSpaceIds: { "agent:a": "space-a" },
    startTime: Date.now(),
  };
}

export async function runInputOwnershipTests() {
  ensureChromeShim();
  const prevTabs = globalThis.chrome.tabs;
  const tabsById = new Map();
  globalThis.chrome.tabs = {
    ...(prevTabs ?? {}),
    async get(tabId) {
      const tab = tabsById.get(tabId);
      if (!tab) throw new Error("tab not found: " + tabId);
      return tab;
    },
  };

  const io = await bundleInputOwnership();
  const prevWindows = globalThis.chrome.windows;
  globalThis.chrome.windows = {
    ...(prevWindows ?? {}),
    async get(windowId) {
      return { id: windowId, state: "normal", focused: false };
    },
    async getLastFocused() {
      return { id: 1, state: "normal", focused: false };
    },
  };
  let seq = 0;
  const cmd = (name, args = {}, extra = {}) => ({
    type: "command", name, args, requestId: "io-" + (++seq), _clientId: "agent:a", ...extra,
  });
  /** 用户入口：与 popup/内核桥一致——在进程内构造命令并打上不可伪造的内部标记。 */
  const internal = (name, args = {}) =>
    io.markInternalCommand({ type: "command", name, args, requestId: "internal-" + (++seq) });
  const setState = async (state) => {
    await globalThis.chrome.storage.session.set({ [STATE_KEY]: state });
  };
  const readSpace = async (id = "space-a") => (await io.loadState()).spaces[id];
  const audit = (name) => io.drainEvents({ after_sequence: 0, limit: 10000, methods: [name] }).events;
  const expectCode = async (promise, code, label) => {
    try {
      await promise;
    } catch (error) {
      assert.equal(error.code, code, (label ?? "") + ": 期望 " + code + "，实际 " + error.code + " (" + error.message + ")");
      return error;
    }
    assert.fail((label ?? "") + ": 期望抛出 " + code + "，实际成功放行");
  };
  /** 信任边界用：只要失败码在允许集合里就算“被拒绝”，并打印实际码作为证据。 */
  const expectFailure = async (promise, codes, label) => {
    try {
      await promise;
    } catch (error) {
      assert.ok(codes.includes(error.code), (label ?? "") + ": 期望失败码 " + codes.join("/") + "，实际 " + error.code + " (" + error.message + ")");
      console.log("  [deny] " + label + " -> " + error.code + " (" + error.message + ")");
      return error;
    }
    assert.fail((label ?? "") + ": 期望被拒绝，实际成功");
  };

  try {
    // ------------------------------------------------------------------
    // 1. 模式派生：只有 ownership(+assist) 一个真源
    // ------------------------------------------------------------------
    assert.equal(io.inputModeForSpace({ ownership: "user" }), "human");
    assert.equal(io.inputModeForSpace({ ownership: "agent" }), "ai");
    assert.equal(io.inputModeForSpace({ ownership: "agent", assist: { since: 1 } }), "assist");
    assert.equal(io.inputModeForSpace({ ownership: "inactive" }), "human", "退休空间必须 fail closed");
    assert.equal(io.inputModeForSpace(undefined), "human", "未知空间必须 fail closed");
    console.log("PASS input-ownership: mode derivation is a pure view over ownership(+assist)");

    // ------------------------------------------------------------------
    // 2. AI 放行 / HUMAN 拒绝 / ASSIST 无 grant 拒绝
    // ------------------------------------------------------------------
    await setState(makeState());
    const ai = await io.guardInputCommand(cmd("click", { selector: "#x", cursor: false }));
    assert.equal(ai.mode, "ai");
    assert.equal(ai.spaceId, "space-a");

    await setState(makeState({ "space-a": { ownership: "user" } }));
    const humanError = await expectCode(
      io.guardInputCommand(cmd("click", { selector: "#x", cursor: false })),
      "INPUT_HUMAN_OWNED",
      "HUMAN click",
    );
    assert.equal(humanError.detail.reason, "ownership-user");
    assert.equal(humanError.detail.clientId, "agent:a");
    assert.equal(humanError.detail.command, "click");
    const humanAudit = audit("input_command_rejected").filter((e) => e.args.code === "INPUT_HUMAN_OWNED");
    assert.ok(humanAudit.length >= 1, "HUMAN 拒绝必须写入审计事件");
    assert.equal(humanAudit.at(-1).args.spaceId, "space-a");
    assert.equal(typeof humanAudit.at(-1).args.at, "number");

    await setState(makeState({ "space-a": { assist: { since: Date.now(), reason: "test" } } }));
    const assistError = await expectCode(
      io.guardInputCommand(cmd("type", { text: "x" })),
      "INPUT_ASSIST_REQUIRES_GRANT",
      "ASSIST 无 grant",
    );
    assert.equal(assistError.detail.reason, "no-grant");
    const assistAudit = audit("input_command_rejected").filter((e) => e.args.code === "INPUT_ASSIST_REQUIRES_GRANT");
    assert.ok(assistAudit.length >= 1, "ASSIST 拒绝必须写入审计事件");
    console.log("PASS input-ownership: AI allows, HUMAN rejects INPUT_HUMAN_OWNED, ASSIST rejects without grant");

    // ------------------------------------------------------------------
    // 3. grant 消耗 / 用尽 / 过期
    // ------------------------------------------------------------------
    await setState(makeState({
      "space-a": {
        assist: {
          since: Date.now(),
          grant: { token: "tok-single", actions: 1, expiresAt: Date.now() + 60_000 },
        },
      },
    }));
    const allowed = await io.guardInputCommand(cmd("click", { selector: "#x", cursor: false }));
    assert.equal(allowed.mode, "assist");
    assert.equal(allowed.grantRemaining, 0, "actions=1 的命令应把剩余次数消耗到 0");
    assert.equal((await readSpace()).assist.grant, undefined, "用尽后 grant 必须立即清空");
    assert.equal((await readSpace()).assist.since > 0, true, "grant 用尽不得顺带清掉 ASSIST 租约");
    await expectCode(
      io.guardInputCommand(cmd("click", { selector: "#x", cursor: false })),
      "INPUT_ASSIST_REQUIRES_GRANT",
      "grant 用尽后的第二次点击",
    );
    const consumedAudit = audit("input_grant_consumed");
    assert.ok(consumedAudit.length >= 1, "grant 消耗必须写入审计事件");
    assert.equal(consumedAudit.at(-1).args.remaining, 0);
    assert.equal(consumedAudit.at(-1).args.token, "tok-single", "10 字符以内的 token 原样摘要");

    await setState(makeState({
      "space-a": {
        assist: {
          since: Date.now(),
          grant: { token: "tok-expired", actions: 5, expiresAt: Date.now() - 1 },
        },
      },
    }));
    const expired = await expectCode(
      io.guardInputCommand(cmd("fill", { selector: "#x", value: "v" })),
      "INPUT_ASSIST_REQUIRES_GRANT",
      "过期 grant",
    );
    assert.equal(expired.detail.reason, "expired");
    assert.equal((await readSpace()).assist.grant, undefined, "过期 grant 必须被清空");

    await setState(makeState({
      "space-a": {
        assist: {
          since: Date.now(),
          grant: { token: "tok-zero", actions: 0, expiresAt: Date.now() + 60_000 },
        },
      },
    }));
    const exhausted = await expectCode(
      io.guardInputCommand(cmd("press", { key: "Enter" })),
      "INPUT_ASSIST_REQUIRES_GRANT",
      "0 次 grant",
    );
    assert.equal(exhausted.detail.reason, "exhausted");
    console.log("PASS input-ownership: grant is consumed once per command, cleared on exhaustion/expiry");

    // ------------------------------------------------------------------
    // 4. grant_input 参数校验 / 授权 / 摘要
    // ------------------------------------------------------------------
    await setState(makeState({ "space-a": { ownership: "user" } }));
    await expectCode(
      io.grantInputCommand(internal("grant_input", { spaceId: "space-a", actions: 1 })),
      "INPUT_HUMAN_OWNED",
      "HUMAN 下 grant_input",
    );

    await setState(makeState());
    await expectCode(
      io.grantInputCommand(internal("grant_input", { spaceId: "space-a", actions: 1 })),
      "INPUT_GRANT_NOT_IN_ASSIST",
      "AI 下 grant_input",
    );

    await setState(makeState({ "space-a": { assist: { since: Date.now() } } }));
    await expectCode(
      io.grantInputCommand(cmd("grant_input", { spaceId: "space-a", actions: 1 })),
      "INPUT_GRANT_FORBIDDEN",
      "owner Agent 不得自行发放 grant（否则 ASSIST 自证）",
    );
    for (const actions of [0, -1, 1.5, "3", NaN]) {
      await expectCode(
        io.grantInputCommand(internal("grant_input", { spaceId: "space-a", actions })),
        "INPUT_GRANT_INVALID",
        "非法 actions=" + String(actions),
      );
    }
    for (const ttlMs of [0, -5, 1.5, 700_000]) {
      await expectCode(
        io.grantInputCommand(internal("grant_input", { spaceId: "space-a", actions: 1, ttlMs })),
        "INPUT_GRANT_INVALID",
        "非法 ttlMs=" + String(ttlMs),
      );
    }
    await expectCode(
      io.grantInputCommand(cmd("grant_input", { space: "space-a", actions: 1 }, { _clientId: "agent:b" })),
      "SPACE_NOT_OWNED",
      "非 owner 发放 grant",
    );

    const issued = await io.grantInputCommand(
      internal("grant_input", { spaceId: "space-a", actions: 2, ttlMs: 5000 }),
    );
    assert.equal(issued.mode, "assist");
    assert.equal(issued.grant.actions, 2);
    assert.ok(issued.grant.expiresAt > Date.now());
    assert.match(issued.grant.token, /…$/, "对外 token 必须是截断摘要");
    const storedGrant = (await readSpace()).assist.grant;
    assert.equal(storedGrant.actions, 2);
    assert.equal(storedGrant.token.length, 36, "状态里保存完整 UUID token");
    assert.notEqual(storedGrant.token, issued.grant.token, "不得把完整 token 返回给调用方");
    assert.ok(audit("input_grant_issued").length >= 1, "发放 grant 必须写入审计事件");

    const status = await io.inputStatusCommand(cmd("input_status"));
    assert.equal(status.mode, "assist");
    assert.equal(status.ownership, "agent");
    assert.equal(status.grantActionsRemaining, 2);
    assert.equal(status.assistExpiresAt, storedGrant.expiresAt);
    assert.equal(status.grant.actions, 2);

    const internalGrant = await io.grantInputCommand(
      internal("grant_input", { space: "space-a", actions: 3, ttlMs: 5000 }),
    );
    assert.equal(internalGrant.grant.actions, 3, "用户入口（internal）必须能发放 grant");

    const consumedOnce = await io.guardInputCommand(cmd("click", { selector: "#x", cursor: false }));
    assert.equal(consumedOnce.grantRemaining, 2);
    const statusAfter = await io.inputStatusCommand(cmd("input_status"));
    assert.equal(statusAfter.grantActionsRemaining, 2);
    console.log("PASS input-ownership: grant_input validates counts/TTL, is user-entry-only, and returns a truncated token");

    // ------------------------------------------------------------------
    // 5. ownership 变更清空 assist/grant（claim_space 是既有迁移，不是新状态机）
    // ------------------------------------------------------------------
    await setState(makeState({
      "space-a": {
        assist: {
          since: Date.now(),
          grant: { token: "tok-before-claim", actions: 9, expiresAt: Date.now() + 60_000 },
        },
      },
    }));
    const claimed = await io.claim_space(cmd("claim_space"));
    assert.equal(claimed.ownership, "agent");
    assert.equal(claimed.assist, undefined, "claim_space 必须清空 assist + grant");
    assert.equal(io.inputModeForSpace(await readSpace()), "ai");

    await setState(makeState({ "space-a": { assist: { since: Date.now() } } }));
    await io.patchSpace("space-a", { ownership: "user" });
    assert.equal((await readSpace()).assist, undefined, "handoff（ownership=user）必须清空 assist");

    await setState(makeState({ "space-a": { assist: { since: Date.now() } } }));
    await io.patchSpace("space-a", { ownership: "inactive" });
    assert.equal((await readSpace()).assist, undefined, "退休空间不得残留 assist");

    // 待触发的 human_presence 去抖也必须作废：claim_space 之后不得再被拉回 ASSIST。
    await setState(makeState());
    io.noteHumanPresence("space-a", { debounceMs: 40, source: "test" });
    await io.patchSpace("space-a", { ownership: "agent" });
    await sleep(90);
    assert.equal((await readSpace()).assist, undefined, "ownership 写入后，迟到的 presence 定时器必须被取消");
    console.log("PASS input-ownership: ownership transitions clear the assist lease and cancel pending presence");

    // ------------------------------------------------------------------
    // 6. enterAssist / exitAssist
    // ------------------------------------------------------------------
    await setState(makeState({ "space-a": { ownership: "user" } }));
    assert.equal(await io.enterAssist("space-a", { reason: "test" }), false, "HUMAN 空间不得被进入 ASSIST");
    assert.equal((await readSpace()).assist, undefined);

    await setState(makeState());
    assert.equal(await io.enterAssist("space-a", { reason: "kernel:mouse", source: "kernel" }), true);
    const assistSpace = await readSpace();
    assert.equal(assistSpace.assist.reason, "kernel:mouse");
    assert.equal(io.inputModeForSpace(assistSpace), "assist");
    assert.ok(audit("input_assist_entered").some((e) => e.args.reason === "kernel:mouse"));

    await io.grantInputCommand(
      internal("grant_input", { spaceId: "space-a", actions: 5, ttlMs: 5000 }),
    );
    assert.ok((await readSpace()).assist.grant, "grant 应存在");
    await io.enterAssist("space-a", { reason: "more-human-input" });
    assert.equal((await readSpace()).assist.grant, undefined, "新的人类在场必须清掉未用完的 grant（人类优先）");

    assert.equal(await io.exitAssist("space-a", "test-exit"), true);
    assert.equal((await readSpace()).assist, undefined);
    assert.equal(io.inputModeForSpace(await readSpace()), "ai");
    assert.ok(audit("input_assist_exited").some((e) => e.args.reason === "test-exit"));
    console.log("PASS input-ownership: enter/exit assist only writes the assist lease, never ownership");

    // ------------------------------------------------------------------
    // 7. human_presence 命令（去抖 / 授权 / 幂等）
    // ------------------------------------------------------------------
    await setState(makeState());
    await expectCode(
      io.humanPresenceCommand(cmd("human_presence", { source: "test" })),
      "INPUT_PRESENCE_FORBIDDEN",
      "普通 Agent 不得直接触发 human_presence",
    );
    await expectCode(
      io.humanPresenceCommand(cmd("human_presence", { space: "space-a", source: "test", internal: true }, { _clientId: "agent:b" })),
      "SPACE_NOT_OWNED",
      "非 owner 即使 internal:true 也不能替别人进 ASSIST",
    );
    await expectCode(
      io.humanPresenceCommand(cmd("human_presence", { space: "space-a", source: "test", internal: true })),
      "INPUT_PRESENCE_FORBIDDEN",
      "owner Agent 加 internal:true 也不能伪造 human_presence",
    );

    const scheduled = await io.humanPresenceCommand(
      internal("human_presence", { space: "space-a", source: "kernel:mouse", debounceMs: 40 }),
    );
    assert.equal(scheduled.mode, "ai");
    assert.equal(scheduled.scheduled, true);
    assert.equal(scheduled.debounceMs, 40);
    await sleep(20);
    assert.equal(io.inputModeForSpace(await readSpace()), "ai", "去抖窗口内不得提前切 ASSIST");
    await sleep(80);
    await sleep(15);
    assert.equal(io.inputModeForSpace(await readSpace()), "assist", "去抖结束后必须进入 ASSIST");

    // 连续事件只保留最后一次（trailing debounce）
    await setState(makeState());
    const before = audit("input_assist_entered").length;
    io.noteHumanPresence("space-a", { debounceMs: 50, source: "burst-1" });
    await sleep(20);
    io.noteHumanPresence("space-a", { debounceMs: 50, source: "burst-2" });
    await sleep(20);
    assert.equal(io.inputModeForSpace(await readSpace()), "ai", "burst 期间仍应是 AI");
    await sleep(80);
    await sleep(15);
    assert.equal(io.inputModeForSpace(await readSpace()), "assist");
    assert.equal(audit("input_assist_entered").length, before + 1, "同一 burst 只允许一次 ASSIST 进入事件");

    const immediate = await io.humanPresenceCommand(
      internal("human_presence", { space: "space-a", source: "kernel:key", immediate: true }),
    );
    assert.equal(immediate.mode, "assist");
    assert.equal(immediate.changed, true);

    await setState(makeState({ "space-a": { ownership: "user" } }));
    const alreadyHuman = await io.humanPresenceCommand(
      internal("human_presence", { space: "space-a", source: "kernel:mouse" }),
    );
    assert.equal(alreadyHuman.mode, "human");
    assert.equal(alreadyHuman.changed, false, "HUMAN 空间不得被 human_presence 改写");
    assert.equal(alreadyHuman.reason, "already-human");

    await setState(makeState({ "space-a": { ownership: "inactive" } }));
    await expectCode(
      io.humanPresenceCommand(internal("human_presence", { space: "space-a" })),
      "SPACE_INACTIVE",
      "inactive 空间",
    );
    console.log("PASS input-ownership: human_presence is gated, debounced, and never rewrites ownership");

    // ------------------------------------------------------------------
    // 8. 守卫按 tabId 所属窗口解析 space（不只看调用方 active space）
    // ------------------------------------------------------------------
    const multi = makeState({
      "space-a": {},
      "space-b": { name: "B", windowId: 2, tabId: 22, ownerClientId: "agent:a", ownership: "user" },
      "space-c": { name: "C", windowId: 3, tabId: 33, ownerClientId: "agent:a", ownership: "inactive" },
      "space-d": {
        name: "D", windowId: 4, tabId: 44, ownerClientId: "agent:b", ownership: "agent",
        assist: { since: Date.now(), grant: { token: "foreign-grant", actions: 2, expiresAt: Date.now() + 60_000 } },
      },
    });
    await setState(multi);
    tabsById.set(11, { id: 11, windowId: 1, active: true });
    tabsById.set(22, { id: 22, windowId: 2, active: true });
    tabsById.set(33, { id: 33, windowId: 3, active: true });
    tabsById.set(44, { id: 44, windowId: 4, active: true });

    await expectCode(
      io.guardInputCommand(cmd("click", { tabId: 22, selector: "#x", cursor: false })),
      "INPUT_HUMAN_OWNED",
      "tab 位于调用方自己的 HUMAN 空间（即使 active space 是 AI）",
    );
    const inactiveGuard = await io.guardInputCommand(cmd("click", { tabId: 33, selector: "#x", cursor: false }));
    assert.equal(inactiveGuard, undefined, "inactive 空间不在此处守卫，交回既有路径报 SPACE_INACTIVE");
    await expectCode(
      io.guardInputCommand(cmd("click", { tabId: 44, selector: "#x", cursor: false })),
      "SPACE_NOT_OWNED",
      "外部 Agent 不得操作别人的空间（先做归属校验）",
    );
    assert.equal(
      (await readSpace("space-d")).assist.grant.actions,
      2,
      "外部 Agent 的拒绝不得消耗 owner 的 grant（防 DoS）",
    );
    await expectCode(
      io.grantInputCommand(
        internal("grant_input", { tabId: 22, actions: 1 }),
      ),
      "INPUT_HUMAN_OWNED",
      "显式 tabId 的 grant_input 命中自己的 HUMAN 空间",
    );

    await setState(makeState({ "space-a": { assist: { since: Date.now() } } }));
    await expectCode(
      io.grantInputCommand(
        internal("grant_input", { tabId: 999, spaceId: "space-a", actions: 1 }),
      ),
      "TAB_OUTSIDE_SPACE",
      "tabId 不属于该 space",
    );

    await setState(makeState());
    await expectCode(
      io.inputStatusCommand(cmd("input_status", { space: "space-missing" })),
      "SPACE_NOT_FOUND",
      "未知 space",
    );
    console.log("PASS input-ownership: tab-based space resolution prevents cross-space bypass");

    // ------------------------------------------------------------------
    // 9. INPUT_COMMANDS 语义：js / tab_cdp_call 纳入（可注入输入的旁路）
    // ------------------------------------------------------------------
    for (const name of ["click", "type", "fill", "js", "tab_cdp_call", "press", "wheel"]) {
      assert.equal(io.INPUT_COMMANDS.has(name), true, name + " 必须纳入输入权守卫");
    }
    for (const name of ["screenshot", "cursor", "download_image", "download_resource", "input_status", "grant_input"]) {
      assert.equal(io.INPUT_COMMANDS.has(name), false, name + " 不应纳入输入权守卫");
    }
    console.log("PASS input-ownership: every input-injecting command (including js/tab_cdp_call) is guarded");

    // ------------------------------------------------------------------
    // 10. 源码守卫：不存在第二套 ownership 状态机
    // ------------------------------------------------------------------
    const stateSource = fs.readFileSync("src/background/state.ts", "utf8");
    assert.match(stateSource, /ownership\?: "agent" \| "user" \| "inactive";/,
      "ownership 取值集合不得扩展（ASSIST 必须是派生视图）");
    assert.doesNotMatch(stateSource, /ownership\s*[:=]\s*["']assist["']/,
      "不得把 assist 写进 ownership");
    assert.match(stateSource, /assist\?: AssistLease;/, "assist 必须是 SpaceState 上的从属可选字段");
    assert.match(stateSource, /if \(result\.ownership !== "agent"\) \{\s*delete result\.assist;/,
      "patchSpace 必须在单一收口处清空非 agent 状态的 assist");

    const ownershipSource = fs.readFileSync("src/background/input-ownership.ts", "utf8");
    assert.doesNotMatch(ownershipSource, /ownership\s*[:=]\s*["'](?:agent|user|inactive|assist)["']/,
      "input-ownership 不得写 ownership（迁移只能走 claim/handoff/complete/close）");
    assert.match(ownershipSource, /export function inputModeForSpace\(/, "模式派生必须有唯一入口");
    assert.match(ownershipSource, /export async function guardInputCommand\(/, "统一守卫必须存在");

    const commandsSource = fs.readFileSync("src/background/commands.ts", "utf8");
    assert.match(
      commandsSource,
      /if \(INPUT_COMMANDS\.has\(name\)\) \{[\s\S]*?await guardInputCommand\(cmd\);[\s\S]*?withKernelInputScope\(/,
      "dispatch 必须在 handler 之前调用统一守卫，并用内核命令 scope 包裹实际执行",
    );
    assert.match(commandsSource, /if \(ACTION_NAMES\.has\(name\) && hasTakeover\(\)\)/, "既有 takeover 检查必须保留");

    for (const file of fs.readdirSync("src/background")) {
      if (!file.endsWith(".ts")) continue;
      const source = fs.readFileSync("src/background/" + file, "utf8");
      assert.doesNotMatch(source, /ownership\s*[:=]\s*["']assist["']/,
        file + " 不得引入 ownership:\"assist\" 第二套状态");
    }

    const popupSource = fs.readFileSync("src/shared/types.ts", "utf8");
    for (const name of ["grant_input", "input_status", "human_presence"]) {
      assert.match(popupSource, new RegExp('"' + name + '"'), "CommandName 缺少 " + name);
    }
    console.log("PASS input-ownership: single ownership state machine (source guards), no new ownership values");

    // ------------------------------------------------------------------
    // 11. 信任边界：用户入口身份不可由消息字段伪造
    // ------------------------------------------------------------------
    // 身份唯一入口只有两种：host 分配的 `agent:<id>`，或 SW 进程内 WeakSet 标记。
    assert.equal(io.commandClientId({ type: "command", name: "ping", requestId: "x", _clientId: "agent:real" }), "agent:real");
    assert.equal(io.commandClientId({ type: "command", name: "ping", requestId: "x", _clientId: "  agent:real  " }), "agent:real");
    assert.equal(io.commandClientId({ type: "command", name: "ping", requestId: "x", _clientId: "browserpilot-internal" }), io.UNTRUSTED_CLIENT_ID,
      "保留 ID 直接出现在 _clientId 里不得被当成用户身份");
    assert.equal(io.commandClientId({ type: "command", name: "ping", requestId: "x", _clientId: "agent:" }), io.UNTRUSTED_CLIENT_ID);
    assert.equal(io.commandClientId({ type: "command", name: "ping", requestId: "x", _clientId: "socket-1" }), io.UNTRUSTED_CLIENT_ID);
    assert.equal(io.commandClientId({ type: "command", name: "ping", requestId: "x" }), io.UNTRUSTED_CLIENT_ID,
      "缺 _clientId 且未打内部标记 → 不可信（绝不回退到 browserpilot-internal）");
    assert.equal(io.commandClientId({ type: "command", name: "ping", requestId: "x", _channel: "internal" }), io.UNTRUSTED_CLIENT_ID,
      "`_channel` 之类的消息字段不得产生用户身份");
    assert.equal(io.commandClientId(io.markInternalCommand({ type: "command", name: "ping", requestId: "x" })), io.INTERNAL_CLIENT_ID,
      "只有进程内标记才是用户入口");

    await setState(makeState({ "space-a": { assist: { since: Date.now() } } }));
    const spoofGrantCases = [
      ["_clientId=browserpilot-internal", { _clientId: "browserpilot-internal" }],
      ["_clientId=agent:browserpilot-internal（非 owner）", { _clientId: "agent:browserpilot-internal" }],
      ["_channel=internal（无 _clientId）", { _channel: "internal" }],
      ["args.internal=true（owner Agent）", { _clientId: "agent:a", args: { spaceId: "space-a", actions: 1, internal: true } }],
    ];
    for (const [label, extra] of spoofGrantCases) {
      await expectFailure(
        io.grantInputCommand({
          type: "command", name: "grant_input", args: { spaceId: "space-a", actions: 1 },
          requestId: "spoof-g-" + (++seq), ...extra,
        }),
        ["INPUT_IDENTITY_UNTRUSTED", "INPUT_GRANT_FORBIDDEN", "SPACE_NOT_OWNED"],
        "grant_input 伪造 " + label,
      );
    }
    assert.equal((await readSpace()).assist.grant, undefined, "伪造 grant 请求不得留下任何 grant");

    await setState(makeState());
    const spoofPresenceCases = [
      ["_clientId=browserpilot-internal", { _clientId: "browserpilot-internal" }],
      ["_channel=internal（无 _clientId）", { _channel: "internal" }],
      ["args.internal=true（owner Agent）", { _clientId: "agent:a", args: { space: "space-a", source: "spoof", internal: true } }],
    ];
    for (const [label, extra] of spoofPresenceCases) {
      await expectFailure(
        io.humanPresenceCommand({
          type: "command", name: "human_presence", args: { space: "space-a", source: "spoof" },
          requestId: "spoof-p-" + (++seq), ...extra,
        }),
        ["INPUT_IDENTITY_UNTRUSTED", "INPUT_PRESENCE_FORBIDDEN", "SPACE_NOT_OWNED"],
        "human_presence 伪造 " + label,
      );
    }
    assert.equal(io.inputModeForSpace(await readSpace()), "ai", "伪造 presence 不得把空间拉进 ASSIST");

    // 用户入口仍然可用：同一组操作换成进程内标记即可成功。
    await setState(makeState({ "space-a": { assist: { since: Date.now() } } }));
    const legitGrant = await io.grantInputCommand(internal("grant_input", { spaceId: "space-a", actions: 1, ttlMs: 5000 }));
    assert.equal(legitGrant.mode, "assist");
    assert.equal(legitGrant.grant.actions, 1);
    await setState(makeState());
    const legitPresence = await io.humanPresenceCommand(
      internal("human_presence", { space: "space-a", source: "kernel:mouse", immediate: true }),
    );
    assert.equal(legitPresence.changed, true, "用户入口（进程内标记）必须仍能进入 ASSIST");
    console.log("PASS input-ownership: user identity is a process-local marker; wire fields cannot forge it");

    // 源码守卫：任何“缺字段即用户”的回退都不允许回来。
    const spacesSource = fs.readFileSync("src/background/spaces.ts", "utf8");
    assert.doesNotMatch(spacesSource, /\|\|\s*["']browserpilot-internal["']/,
      "commandClientId 不得回退到用户身份");
    assert.match(spacesSource, /const internalCommands = new WeakSet<object>\(\)/,
      "内部身份必须是进程内 WeakSet 标记");
    const indexSource = fs.readFileSync("src/background/index.ts", "utf8");
    assert.equal((indexSource.match(/dispatch\(markInternalCommand\(/g) ?? []).length, 2,
      "popup/options 的两个 dispatch 必须打内部标记");
    const hostSource = fs.readFileSync("native-host/host.js", "utf8");
    assert.match(hostSource, /RESERVED_AGENT_IDS/, "host 必须拒绝保留 agentId");
    assert.doesNotMatch(hostSource, /\.\.\.forward/, "host 不得把客户端对象原样展开转发（字段白名单）");
    console.log("PASS input-ownership: source guards keep identity fail-closed (no field-based fallback)");

    // ------------------------------------------------------------------
    // 12. popup 用户入口（P3）：固定动作 + 进程内标记 + 消息字段不可注入
    // ------------------------------------------------------------------
    // 12.1 构造器是唯一入口：三个动作的 args 由 SW 固定，popup 只能选 space。
    const popupGrantCmd = io.buildPopupInputCommand("grant_input", { spaceId: "space-a", tabId: 11 });
    assert.equal(popupGrantCmd.name, "grant_input");
    assert.deepEqual(popupGrantCmd.args, { spaceId: "space-a", tabId: 11, actions: 1 },
      "grant_input 必须固定 actions=1，popup 不能放大授权");
    assert.equal(io.commandClientId(popupGrantCmd), io.INTERNAL_CLIENT_ID,
      "popup 输入命令必须是进程内标记的用户入口");

    const popupPresenceCmd = io.buildPopupInputCommand("human_presence", { spaceId: "space-a", tabId: 11 });
    assert.equal(popupPresenceCmd.name, "human_presence");
    assert.deepEqual(popupPresenceCmd.args, { spaceId: "space-a", tabId: 11, source: "popup:user", immediate: true },
      "human_presence 必须固定 source=popup:user + immediate=true");
    assert.equal(io.commandClientId(popupPresenceCmd), io.INTERNAL_CLIENT_ID);

    const popupShowCmd = io.buildPopupInputCommand("ensure_visible", { spaceId: "space-a", tabId: 11 });
    assert.equal(popupShowCmd.name, "ensure_visible");
    assert.deepEqual(popupShowCmd.args, { spaceId: "space-a", tabId: 11, focus: false },
      "显示窗口必须固定 focus=false（不抢用户焦点）");
    assert.equal(io.commandClientId(popupShowCmd), io.INTERNAL_CLIENT_ID);

    // 消息/调用方塞进来的多余字段一律被丢弃（构造器只读取 spaceId/tabId）。
    const injected = io.buildPopupInputCommand("grant_input", {
      spaceId: "space-a", tabId: 11, actions: 99, ttlMs: 999999,
      source: "spoof", immediate: false, internal: true, _clientId: "browserpilot-internal",
    });
    assert.equal(injected.args.actions, 1, "actions 不得被调用方覆盖");
    assert.equal(injected.args.ttlMs, undefined, "ttlMs 不进入 popup 授权（走命令层默认 60s）");
    assert.equal(injected.args.source, undefined);
    assert.equal(injected.args.internal, undefined);
    assert.equal(injected.args._clientId, undefined);

    // 一旦离开 SW 进程（JSON 反序列化），内部标记必须消失。
    const roundtrip = JSON.parse(JSON.stringify(popupGrantCmd));
    assert.equal(io.commandClientId(roundtrip), io.UNTRUSTED_CLIENT_ID,
      "JSON roundtrip 必须丢失内部标记（外部 host 不能复用 popup 身份）");

    // 12.2 用 popup 实际会构造的命令走一遍命令层：授权/ASSIST/状态都可复现。
    await setState(makeState({ "space-a": { assist: { since: Date.now() } } }));
    const popupGrantResult = await io.grantInputCommand(
      io.buildPopupInputCommand("grant_input", { spaceId: "space-a", tabId: 11 }),
    );
    assert.equal(popupGrantResult.mode, "assist");
    assert.equal(popupGrantResult.grant.actions, 1);
    const popupStatusCmd = io.buildPopupStatusCommand({ spaceId: "space-a", tabId: 11 });
    assert.equal(io.commandClientId(popupStatusCmd), io.INTERNAL_CLIENT_ID);
    const popupStatus = await io.inputStatusCommand(popupStatusCmd);
    assert.equal(popupStatus.mode, "assist");
    assert.equal(popupStatus.grantActionsRemaining, 1);

    await setState(makeState());
    const popupPresenceResult = await io.humanPresenceCommand(
      io.buildPopupInputCommand("human_presence", { spaceId: "space-a", tabId: 11 }),
    );
    assert.equal(popupPresenceResult.mode, "assist");
    assert.equal(popupPresenceResult.changed, true);
    assert.equal(popupPresenceResult.source, "popup:user");
    assert.equal(io.inputModeForSpace(await readSpace()), "assist");

    // 用户入口可以操作 Agent 拥有的空间（包括 HUMAN 空间）；Agent 之间的隔离不变。
    await setState(makeState({ "space-a": { ownership: "user" } }));
    const internalUse = io.markInternalCommand({
      type: "command", name: "use_space", args: { spaceId: "space-a" }, requestId: "internal-use",
    });
    assert.equal((await io.ensureCommandSpace(internalUse)).spaceId, "space-a",
      "用户入口必须能对 Agent 拥有的 HUMAN 空间执行 ensure_visible 等操作");
    await expectCode(
      io.ensureCommandSpace(cmd("use_space", { spaceId: "space-a" }, { _clientId: "agent:b" })),
      "SPACE_NOT_OWNED",
      "其他 Agent 仍不得操作用户入口选择的 space",
    );
    console.log("PASS input-ownership: popup entry builds fixed, internally marked commands (grant/presence/show)");

    // 12.3 源码守卫：popup 不读身份字段；SW 三个 case 都走构造器；外部通道无入口。
    const popupTsSource = fs.readFileSync("src/popup/index.ts", "utf8");
    // 只检查可执行代码：注释里出现“_clientId”是在解释“不使用它”。
    const popupTsCode = popupTsSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(popupTsCode, /_clientId|browserpilot-internal|__bpInternal/,
      "popup 不得读取/发送可伪造的身份字段");
    assert.doesNotMatch(popupTsCode, /URLSearchParams|location\.(search|hash)/,
      "popup 不得从 URL 参数读取身份或目标");
    assert.doesNotMatch(popupTsCode, /chrome\.runtime\.onMessage/,
      "popup 只能通过 handlePopup 入口，不能自己监听命令");
    assert.match(popupTsCode, /chrome\.runtime\.sendMessage/);
    for (const kind of ["grant_input", "human_presence", "ensure_visible"]) {
      assert.match(popupTsCode, new RegExp('kind: "' + kind + '"'), "popup 缺少动作 " + kind);
    }
    const popupHtml = fs.readFileSync("src/popup/index.html", "utf8");
    for (const id of [
      "space-select", "human-presence", "grant-input", "show-window", "input-refresh",
      "input-mode", "input-ownership", "input-grant", "input-kernel", "input-target", "input-toast",
    ]) {
      assert.match(popupHtml, new RegExp('id="' + id + '"'), "popup 缺少自动化选择器 #" + id);
    }

    const popupEntrySource = fs.readFileSync("src/background/popup-entry.ts", "utf8");
    assert.match(popupEntrySource, /markInternalCommand\(\{/, "popup 命令构造器必须打进程内标记");
    assert.match(popupEntrySource, /actions: 1/);
    assert.match(popupEntrySource, /source: "popup:user"/);
    assert.match(popupEntrySource, /immediate: true/);
    assert.match(popupEntrySource, /focus: false/);
    assert.doesNotMatch(popupEntrySource, /msg\./, "构造器不得透传 popup 消息字段");

    const popupIndexSource = fs.readFileSync("src/background/index.ts", "utf8");
    assert.doesNotMatch(popupIndexSource, /export\s+(?:async\s+)?function\s+handlePopup/,
      "handlePopup 不得导出（外部模块/通道不能直接调用）");
    assert.match(popupIndexSource, /__bpErrorCode/, "popup 错误必须带稳定错误码");
    const inputCasesStart = popupIndexSource.indexOf('case "grant_input":');
    const inputCasesEnd = popupIndexSource.indexOf('case "stop":', inputCasesStart);
    assert.ok(inputCasesStart >= 0 && inputCasesEnd > inputCasesStart, "handlePopup 缺少三个输入权 case");
    const inputCases = popupIndexSource.slice(inputCasesStart, inputCasesEnd);
    for (const kind of ["human_presence", "ensure_visible"]) {
      assert.match(inputCases, new RegExp('case "' + kind + '":'), "handlePopup 缺少 case " + kind);
    }
    assert.match(inputCases, /isPopupSender\(sender\)/,
      "三个用户动作必须校验 sender 是 popup 页面");
    assert.match(inputCases, /dispatch\(buildPopupInputCommand\(msg\.kind, resolved\.target\)\)/,
      "三个用户动作必须 dispatch 进程内构造的 Command");
    assert.doesNotMatch(inputCases, /msg\.args|msg\.name|_clientId/,
      "三个用户动作不得透传消息里的命令/身份字段");

    const nativeBridgeSource = fs.readFileSync("src/background/native-bridge.ts", "utf8");
    assert.doesNotMatch(nativeBridgeSource, /markInternalCommand|buildPopupInputCommand|handlePopup/,
      "外部 host 通道（native-bridge）不得拥有任何用户入口标记能力");
    console.log("PASS input-ownership: popup source guards (no forgeable fields, fixed actions, popup-only sender)");
  } finally {
    if (prevTabs === undefined) delete globalThis.chrome.tabs;
    else globalThis.chrome.tabs = prevTabs;
    if (prevWindows === undefined) delete globalThis.chrome.windows;
    else globalThis.chrome.windows = prevWindows;
  }
}

// 独立运行时执行；被 test-core import 时同样执行（顶层 await）。
await runInputOwnershipTests();
