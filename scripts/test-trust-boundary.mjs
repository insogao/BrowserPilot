// 信任边界测试：真实 native host + 真实扩展命令层。
//
// 目标（P3 审计结论的回归锁定）：
//   1. 外部 TCP 客户端不能通过 agentId / _clientId / _channel / _foregroundLeaseToken /
//      args.internal 任何字段把自己变成 `browserpilot-internal`；
//   2. 即使 host 完全失守（模拟回归：直接把 `_clientId: "browserpilot-internal"` 送进扩展），
//      扩展的命令层也必须拒绝 grant_input / human_presence；
//   3. 用户入口（popup/内核桥）仍然可用：身份是 SW 进程内的 WeakSet 标记，不是消息字段。
//
// 运行：node scripts/test-trust-boundary.mjs
// 不启动浏览器、不触碰用户 Chrome/profile；host 进程按 PID 结束自己启动的实例。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { build } from "esbuild";

const PORT = Number(process.env.BP_TRUST_TEST_PORT || 48361);
const STATE_KEY = "browserpilot.state.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1) 真实 host：读 native messaging 帧，发 TCP 伪造请求
// ---------------------------------------------------------------------------
function startHost() {
  const child = spawn(process.execPath, ["native-host/host.js"], {
    cwd: process.cwd(),
    env: { ...process.env, BROWSERPILOT_HOST_BASE_PORT: String(PORT) },
  });
  const frames = [];
  let buf = Buffer.alloc(0);
  let ready;
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      let msg;
      try { msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")); } catch { msg = undefined; }
      buf = buf.subarray(4 + len);
      if (!msg) continue;
      if (msg.type === "event" && msg.name === "ready") ready = msg.args;
      if (msg.type === "command") frames.push(msg);
    }
  });
  child.stderr.on("data", () => {}); // host 的审计日志不参与断言，避免污染输出
  return { child, frames, ready: () => ready };
}

const waitFor = async (fn, timeout = 8000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error("timeout waiting for host state");
};

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

/** 一个 TCP 连接上逐条发送，返回 host 转发给扩展的帧（按发送顺序）。 */
async function probeHost(host) {
  const socket = await connect(host.ready().port);
  const replies = [];
  let buf = "";
  socket.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { replies.push(JSON.parse(line)); } catch { /* ignore */ } }
    }
  });

  const cases = [
    ["reserved-id + all spoofed fields", {
      type: "command", name: "grant_input", requestId: "probe-1",
      agentId: "browserpilot-internal", _clientId: "browserpilot-internal",
      _channel: "internal", _foregroundLeaseToken: "spoof",
      args: { spaceId: "space-x", actions: 1, internal: true },
    }],
    ["colon in agentId", { type: "command", name: "grant_input", requestId: "probe-2", agentId: "a:b", args: {} }],
    ["agent: prefix supplied", { type: "command", name: "grant_input", requestId: "probe-3", agentId: "agent:browserpilot-internal", args: {} }],
    ["only _clientId", { type: "command", name: "grant_input", requestId: "probe-4", _clientId: "browserpilot-internal", args: {} }],
    ["reserved id case-insensitive", { type: "command", name: "grant_input", requestId: "probe-5", agentId: "Internal", args: {} }],
    ["normal agent", { type: "command", name: "grant_input", requestId: "probe-6", agentId: "browserpilot-cli", args: {} }],
    ["trimmed agent", { type: "command", name: "grant_input", requestId: "probe-7", agentId: "  ok-id  ", args: {} }],
    ["bad command name", { type: "command", name: "grant input", requestId: "probe-8", agentId: "browserpilot-cli", args: {} }],
  ];

  const forwarded = [];
  for (const [label, message] of cases) {
    const before = host.frames.length;
    socket.write(JSON.stringify({ ...message, authToken: host.ready().authToken }) + "\n");
    if (message.name === "grant input") {
      await waitFor(() => replies.some((r) => r.requestId === message.requestId));
      forwarded.push({ label, message, frame: undefined, reply: replies.find((r) => r.requestId === message.requestId) });
      continue;
    }
    await waitFor(() => host.frames.length > before);
    forwarded.push({ label, message, frame: host.frames[host.frames.length - 1] });
  }
  socket.end();
  return forwarded;
}

// ---------------------------------------------------------------------------
// 2) 真实扩展命令层（input-ownership / state / spaces），只 shim chrome API 边界
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
  if (!g.tabs) {
    const tabs = new Map();
    g.tabs = {
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("tab not found: " + tabId);
        return tab;
      },
      __set(tab) { tabs.set(tab.id, tab); },
    };
  }
}

async function bundleCommandLayer() {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/background/input-ownership.ts";',
        'export { loadState } from "./src/background/state.ts";',
        'export { commandClientId, markInternalCommand, INTERNAL_CLIENT_ID, UNTRUSTED_CLIENT_ID } from "./src/background/spaces.ts";',
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

function spaceState(ownerClientId) {
  return {
    [STATE_KEY]: {
      spaces: {
        "space-x": {
          spaceId: "space-x",
          name: "Trust",
          windowId: 1,
          tabId: 1,
          ownerClientId,
          ownership: "agent",
          assist: { since: Date.now() },
          layer: "L0",
          navVersion: 0,
          attached: false,
          eventQueueTail: 0,
        },
      },
      activeSpaceIds: { [ownerClientId]: "space-x" },
      startTime: Date.now(),
    },
  };
}

async function main() {
  ensureChromeShim();
  globalThis.chrome.tabs.__set({ id: 1, windowId: 1, active: true, url: "about:blank" });
  const io = await bundleCommandLayer();
  const setState = async (state) => globalThis.chrome.storage.session.set(state);
  const setSpaceOwner = (owner) => setState(spaceState(owner));

  const host = startHost();
  const report = [];
  try {
    await waitFor(() => host.ready());
    const probes = await probeHost(host);
    report.push("host 转发帧（原始，authToken 已剥离）:");
    for (const probe of probes) {
      if (probe.frame) {
        const shown = { ...probe.frame, requestId: "<host-internal>" };
        report.push("  [" + probe.label + "] " + JSON.stringify(shown));
      } else {
        report.push("  [" + probe.label + "] host 本地拒绝: " + JSON.stringify(probe.reply));
      }
    }

    // --- host 侧断言 -----------------------------------------------------
    const byLabel = Object.fromEntries(probes.map((p) => [p.label, p]));
    assert.equal(byLabel["reserved-id + all spoofed fields"].frame._clientId, "agent:socket-1",
      "保留 ID 必须被服务端重新分配为 socket-N");
    assert.equal(byLabel["reserved-id + all spoofed fields"].frame._channel, undefined, "_channel 不得被转发");
    assert.equal(byLabel["reserved-id + all spoofed fields"].frame._foregroundLeaseToken, undefined, "_foregroundLeaseToken 不得被转发");
    assert.equal(byLabel["reserved-id + all spoofed fields"].frame.args.internal, undefined, "args.internal 不得被转发");
    assert.equal(byLabel["reserved-id + all spoofed fields"].frame.args.actions, 1, "合法 args 必须保留");
    for (const label of ["colon in agentId", "agent: prefix supplied", "only _clientId", "reserved id case-insensitive"]) {
      assert.equal(byLabel[label].frame._clientId, "agent:socket-1", label + " 必须被重新分配为 socket-N");
    }
    assert.equal(byLabel["normal agent"].frame._clientId, "agent:browserpilot-cli");
    assert.equal(byLabel["trimmed agent"].frame._clientId, "agent:ok-id");
    assert.equal(byLabel["bad command name"].reply.error, "bad_command_name", "非法命令名必须被 host 拒绝");
    for (const probe of probes) {
      if (probe.frame) assert.notEqual(probe.frame._clientId, "browserpilot-internal", "host 绝不能转发保留 ID 原文");
    }
    console.log("PASS trust-boundary: real host assigns `agent:<id>` server-side and strips every spoofed field");

    // --- 扩展命令层：把 host 真实转发的帧原样喂进去 -----------------------
    const forged = byLabel["reserved-id + all spoofed fields"].frame;
    await setSpaceOwner(forged._clientId); // 最坏情况：攻击者连 space 所有权都拿到了
    const expectFailure = async (promise, codes, label) => {
      try {
        await promise;
      } catch (error) {
        assert.ok(codes.includes(error.code), label + ": 期望 " + codes.join("/") + "，实际 " + error.code + " (" + error.message + ")");
        report.push("  [deny] " + label + " -> " + error.code + " (" + error.message + ")");
        return error;
      }
      assert.fail(label + ": 期望被拒绝，实际成功");
    };
    const forbidden = ["INPUT_GRANT_FORBIDDEN", "INPUT_IDENTITY_UNTRUSTED", "SPACE_NOT_OWNED"];
    const presenceForbidden = ["INPUT_PRESENCE_FORBIDDEN", "INPUT_IDENTITY_UNTRUSTED", "SPACE_NOT_OWNED"];

    await expectFailure(io.grantInputCommand({ ...forged }), forbidden,
      "host 转发帧（owner=agent:socket-1，agentId=browserpilot-internal）grant_input");
    await expectFailure(io.humanPresenceCommand({ ...forged, name: "human_presence", args: { spaceId: "space-x", source: "spoof" } }), presenceForbidden,
      "host 转发帧 human_presence");
    await expectFailure(io.grantInputCommand({ ...byLabel["normal agent"].frame, args: { spaceId: "space-x", actions: 1 } }), ["SPACE_NOT_OWNED"],
      "其他 Agent 对 space-x grant_input");

    // 模拟 host 完全失守：直接把保留 ID 当 _clientId 送进扩展。
    await setSpaceOwner("agent:socket-1");
    await expectFailure(
      io.grantInputCommand({ type: "command", name: "grant_input", args: { spaceId: "space-x", actions: 1 }, requestId: "regress-1", _clientId: "browserpilot-internal" }),
      ["INPUT_IDENTITY_UNTRUSTED"], "host 回归：_clientId=browserpilot-internal grant_input",
    );
    await expectFailure(
      io.humanPresenceCommand({ type: "command", name: "human_presence", args: { space: "space-x", source: "spoof" }, requestId: "regress-2", _clientId: "browserpilot-internal" }),
      ["INPUT_IDENTITY_UNTRUSTED"], "host 回归：_clientId=browserpilot-internal human_presence",
    );
    await expectFailure(
      io.grantInputCommand({ type: "command", name: "grant_input", args: { spaceId: "space-x", actions: 1 }, requestId: "regress-3", _channel: "internal" }),
      ["INPUT_IDENTITY_UNTRUSTED"], "纯 _channel=internal 字段",
    );
    await expectFailure(
      io.grantInputCommand({ type: "command", name: "grant_input", args: { spaceId: "space-x", actions: 1, internal: true }, requestId: "regress-4", _clientId: "agent:socket-1" }),
      ["INPUT_GRANT_FORBIDDEN"], "owner Agent + args.internal=true grant_input",
    );
    assert.equal((await io.loadState()).spaces["space-x"].assist.grant, undefined, "伪造请求不得留下 grant");

    // 用户入口（进程内标记）仍然可用。
    const internalGrant = await io.grantInputCommand(
      io.markInternalCommand({ type: "command", name: "grant_input", args: { spaceId: "space-x", actions: 2, ttlMs: 5000 }, requestId: "user-1" }),
    );
    assert.equal(internalGrant.mode, "assist");
    assert.equal(internalGrant.grant.actions, 2);
    report.push("  [allow] 用户入口 grant_input -> " + JSON.stringify({ mode: internalGrant.mode, actions: internalGrant.grant.actions }));
    const internalPresence = await io.humanPresenceCommand(
      io.markInternalCommand({ type: "command", name: "human_presence", args: { space: "space-x", source: "kernel:mouse", immediate: true }, requestId: "user-2" }),
    );
    assert.equal(internalPresence.changed, true);
    report.push("  [allow] 用户入口 human_presence -> " + JSON.stringify({ mode: internalPresence.mode, changed: internalPresence.changed }));

    // 身份解析的直接证据。
    assert.equal(io.commandClientId(forged), forged._clientId);
    assert.equal(io.commandClientId({ type: "command", name: "ping", requestId: "x" }), io.UNTRUSTED_CLIENT_ID);
    assert.equal(
      io.commandClientId(io.markInternalCommand({ type: "command", name: "ping", requestId: "y" })),
      io.INTERNAL_CLIENT_ID,
    );

    console.log("---- 信任边界原始结果 ----");
    for (const line of report) console.log("  " + line);
    console.log("PASS trust-boundary: 外部客户端无法伪造 browserpilot-internal；grant_input/human_presence 全部被拒；用户入口仍可用");
  } finally {
    host.child.kill();
  }
}

main().catch((e) => {
  console.error("FAIL trust-boundary:", e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
