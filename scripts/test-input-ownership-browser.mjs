// 真实 headless Chromium 集成测试：输入权仲裁（P3，扩展侧）。
//
// 与 test-virtual-cursor-browser.mjs 同一模式：跑**真实代码路径**。
//   - 用 esbuild 打包真实的 commands.ts / spaces.ts / state.ts / input-ownership.ts / actions.ts / cdp.ts；
//   - 只把 chrome 扩展 API 边界（chrome.storage/tabs/windows/debugger + content-bridge/templates/
//     native-bridge/download-resource/groq）替换成 Node shim；
//   - chrome.debugger.sendCommand 直接转发到真实 CDP 会话，所以 click 的
//     Runtime.evaluate / Input.dispatchMouseEvent 是真实注入到真实页面；
//   - 断言每次点击尝试后的页面点击计数与 DOM 文本（不只看错误码）。
//
// 运行：node scripts/test-input-ownership-browser.mjs
//   Chromium 路径：环境变量 BP_CHROME_EXE，缺省 D:\work\wt\browser-cli-baseline\chrome.exe
// 隔离：独立临时 --user-data-dir；不使用 --no-sandbox；不触碰用户真实 profile/窗口。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "esbuild";
import { launchHeadlessChrome } from "./lib/cdp-client.mjs";

const CHROME_EXE = process.env.BP_CHROME_EXE || "D:\\work\\wt\\browser-cli-baseline\\chrome.exe";
const VIEWPORT = { width: 900, height: 700 };
const STATE_KEY = "browserpilot.state.v1";
const CLIENT = "agent:tester";
const INTERNAL = "browserpilot-internal";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>input ownership fixture</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:#f5f6f8;
    font:16px system-ui,"Segoe UI",sans-serif;}
  #target{position:absolute;left:320px;top:240px;width:220px;height:120px;background:#1a73e8;
    color:#fff;border:0;border-radius:10px;font-size:20px;cursor:pointer;}
  #count{position:absolute;left:24px;top:20px;font-size:22px;color:#111;}
  #log{position:absolute;left:24px;top:60px;font-size:12px;color:#333;white-space:pre;}
</style></head>
<body>
  <div id="count">0</div>
  <div id="log">idle</div>
  <button id="target" type="button">Target</button>
  <script>
    window.__clicks = 0;
    window.__events = [];
    window.__jsRuns = 0;
    const button = document.getElementById("target");
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      button.addEventListener(type, (event) => {
        window.__events.push({ type, trusted: event.isTrusted });
        if (type === "click") {
          window.__clicks += 1;
          document.getElementById("count").textContent = String(window.__clicks);
        }
      });
    }
  </script>
</body></html>`;

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(FIXTURE);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: "http://127.0.0.1:" + port });
    });
  });
}

/** 只替换真正的 chrome 扩展 API 边界；业务模块（commands/spaces/state/input-ownership/actions/cdp）全是真的。 */
function browserBridgePlugin() {
  return {
    name: "input-ownership-browser-bridge",
    setup(b) {
      b.onResolve({ filter: /(^|\/)content-bridge$/ }, () => ({ path: "content-bridge", namespace: "bp" }));
      b.onResolve({ filter: /(^|\/)native-bridge$/ }, () => ({ path: "native-bridge", namespace: "bp" }));
      b.onResolve({ filter: /(^|\/)templates$/ }, () => ({ path: "templates", namespace: "bp" }));
      b.onResolve({ filter: /(^|\/)download-resource$/ }, () => ({ path: "download-resource", namespace: "bp" }));
      b.onResolve({ filter: /(^|\/)groq$/ }, () => ({ path: "groq", namespace: "bp" }));
      b.onLoad({ filter: /.*/, namespace: "bp" }, (args) => {
        if (args.path === "content-bridge") {
          return {
            contents: [
              "export const ensureInjected = async () => {};",
              "export const sendToTab = async () => ({ ok: true });",
              "export const getL0Snapshot = async () => ({ title: '', url: '', content: '', refs: {} });",
              "export const readTextFromTab = async () => '';",
            ].join("\n"),
          };
        }
        if (args.path === "native-bridge") {
          return { contents: "export const pushEvent = () => {};" };
        }
        if (args.path === "templates") {
          const names = [
            "cancelTemplateRuns", "setCommandRunner", "importTemplate", "installTemplate", "listTemplates",
            "exportTemplate", "runTemplate", "uninstallTemplate", "setTemplateEnabled", "checkTemplateUpdate",
            "checkRegistryUpdates", "listTemplateCatalog", "syncRegistry", "searchTemplates",
            "getTemplateDetail", "compareTemplates", "updateTemplate", "rollbackTemplate",
          ];
          return {
            contents: names.map((name) => "export const " + name + " = async () => ({ stub: '" + name + "' });").join("\n"),
          };
        }
        if (args.path === "download-resource") {
          return { contents: "export const downloadResource = async () => ({ stub: true });" };
        }
        return { contents: "export const transcribeMedia = async () => ({ stub: true });" };
      });
    },
  };
}

async function bundleHarness() {
  const result = await build({
    stdin: {
      contents: [
        'export { dispatch } from "./src/background/commands.ts";',
        'export { drainEvents } from "./src/background/events.ts";',
        'export { loadState } from "./src/background/state.ts";',
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
    plugins: [browserBridgePlugin()],
  });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
}

async function main() {
  if (!fs.existsSync(CHROME_EXE)) {
    throw new Error("找不到 Chromium：" + CHROME_EXE + "（可用 BP_CHROME_EXE 覆盖）");
  }
  const { server, origin } = await startFixtureServer();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bp-input-ownership-"));
  const userDataDir = path.join(tmpRoot, "profile");
  let chrome;
  const report = [];

  try {
    chrome = await launchHeadlessChrome({ chromeExe: CHROME_EXE, userDataDir, viewport: VIEWPORT });
    const conn = chrome.connection;
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params = {}, timeoutMs) => conn.send(method, params, sessionId, timeoutMs);

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
    });

    const evalInPage = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error("页面求值异常: " + JSON.stringify(r.exceptionDetails).slice(0, 800));
      return r.result ? r.result.value : undefined;
    };
    const navigate = async (url) => {
      const loaded = conn.waitFor("Page.loadEventFired", sessionId, 20000);
      await send("Page.navigate", { url });
      await loaded;
      await sleep(150);
    };

    // ---------------- chrome 扩展 API shim（边界，全部可审计） ----------------
    let stored = {
      [STATE_KEY]: {
        spaces: {
          "space-test": {
            spaceId: "space-test",
            name: "InputOwnership",
            windowId: 1,
            tabId: 1,
            ownerClientId: CLIENT,
            ownership: "agent",
            layer: "L0",
            navVersion: 0,
            attached: false,
            eventQueueTail: 0,
          },
        },
        activeSpaceIds: { [CLIENT]: "space-test" },
        startTime: Date.now(),
      },
    };
    const tab = { id: 1, windowId: 1, index: 0, active: true, title: "fixture", url: origin + "/" };
    const win = { id: 1, state: "normal", focused: false, type: "normal" };
    const tabListeners = { onUpdated: [], onActivated: [], onRemoved: [] };
    globalThis.chrome = {
      storage: {
        session: {
          async get(key) { return { [key]: stored[key] }; },
          async set(values) { stored = { ...stored, ...values }; },
        },
      },
      debugger: {
        onEvent: { addListener() {} },
        onDetach: { addListener() {} },
        async attach() {},
        async detach() {},
        async sendCommand(_target, method, params) { return send(method, params ?? {}); },
      },
      tabs: {
        onUpdated: { addListener: (fn) => tabListeners.onUpdated.push(fn) },
        onActivated: { addListener: (fn) => tabListeners.onActivated.push(fn) },
        onRemoved: { addListener: (fn) => tabListeners.onRemoved.push(fn) },
        async get(id) {
          if (id !== tab.id) throw new Error("No tab with id: " + id);
          return tab;
        },
        async query(query = {}) {
          if (query.windowId !== undefined && query.windowId !== tab.windowId) return [];
          if (query.active === true && tab.active !== true) return [];
          return [tab];
        },
        async update(id, patch = {}) {
          if (id !== tab.id) throw new Error("No tab with id: " + id);
          Object.assign(tab, patch);
          return tab;
        },
        async create() { throw new Error("测试不创建标签"); },
        async remove() { throw new Error("测试不关闭标签"); },
      },
      windows: {
        onRemoved: { addListener() {} },
        async get(id) {
          if (id !== win.id) throw new Error("No window with id: " + id);
          return win;
        },
        async getLastFocused() { return win; },
        async create() { throw new Error("测试不创建窗口"); },
        async update(id, patch = {}) {
          if (id !== win.id) throw new Error("No window with id: " + id);
          Object.assign(win, patch);
          return win;
        },
        async remove() {},
      },
      runtime: {
        id: "test-extension",
        onMessage: { addListener() {} },
        getManifest: () => ({ version: "0.0.0-test" }),
      },
      downloads: {},
    };

    await navigate(origin + "/");
    const initial = await evalInPage("({clicks: window.__clicks, text: document.getElementById('count').textContent})");
    assert.deepEqual(initial, { clicks: 0, text: "0" });
    report.push("页面初始状态: " + JSON.stringify(initial));

    const harness = await bundleHarness();
    let seq = 0;
    const call = (name, args = {}, clientId = CLIENT) =>
      harness.dispatch({ type: "command", name, args, requestId: "io-" + (++seq), _clientId: clientId });
    const expectCode = async (promise, code, label) => {
      try {
        await promise;
      } catch (error) {
        assert.equal(error.code, code, label + ": 期望 " + code + "，实际 " + error.code + " (" + error.message + ")");
        return error;
      }
      assert.fail(label + ": 期望 " + code + "，实际成功放行");
    };
    const pageState = async (label) => {
      const state = await evalInPage(
        "({clicks: window.__clicks, text: document.getElementById('count').textContent, jsRuns: window.__jsRuns, events: window.__events.slice(-3)})",
      );
      report.push(label + " -> " + JSON.stringify(state));
      return state;
    };
    const status = async (label) => {
      const s = await call("input_status");
      report.push(label + " input_status -> " + JSON.stringify({
        mode: s.mode, ownership: s.ownership, grantActionsRemaining: s.grantActionsRemaining,
        assistExpiresAt: s.assistExpiresAt,
      }));
      return s;
    };

    // ---------------- 1) AI 空间：click 成功（真实注入） ----------------
    const s1 = await status("step1");
    assert.equal(s1.mode, "ai");
    const click1 = await call("click", { selector: "#target", cursor: false });
    assert.equal(click1.clicked, true);
    const p1 = await pageState("step1 AI click");
    assert.equal(p1.clicks, 1, "AI 模式下真实点击没有落到页面");
    assert.equal(p1.text, "1", "DOM 计数没有更新（点击未生效）");
    assert.ok(p1.events.some((e) => e.type === "click" && e.trusted === true), "页面未收到受信 click");
    console.log("PASS input-ownership-browser: AI mode delivers real clicks");

    // ---------------- 2) handoff_space → HUMAN：click 被拒，页面未被点击 ----------------
    const handed = await call("handoff_space");
    assert.equal(handed.ownership, "user");
    assert.equal((await status("step2")).mode, "human");
    await expectCode(call("click", { selector: "#target", cursor: false }), "INPUT_HUMAN_OWNED", "HUMAN click");
    const p2 = await pageState("step2 HUMAN click rejected");
    assert.equal(p2.clicks, 1, "HUMAN 模式下页面仍被点击了（守卫未生效）");
    assert.equal(p2.text, "1", "HUMAN 模式下 DOM 计数被 AI 改动");
    // js 同样被拒绝：否则 el.click() 可以绕过输入权
    await expectCode(call("js", { expression: "window.__jsRuns += 1; 1" }), "INPUT_HUMAN_OWNED", "HUMAN js");
    const p2b = await pageState("step2 HUMAN js rejected");
    assert.equal(p2b.jsRuns, 0, "HUMAN 模式下 js 仍在页面执行");
    // HUMAN 下不能靠 grant 绕过
    await expectCode(call("grant_input", { actions: 1 }), "INPUT_HUMAN_OWNED", "HUMAN grant_input");
    console.log("PASS input-ownership-browser: HUMAN rejects clicks/js/grant without touching the page");

    // ---------------- 3) claim_space → AI；human_presence → ASSIST ----------------
    const claimed = await call("claim_space");
    assert.equal(claimed.ownership, "agent");
    assert.equal((await status("step3 claimed")).mode, "ai");
    await expectCode(
      call("human_presence", { source: "test" }),
      "INPUT_PRESENCE_FORBIDDEN",
      "普通 Agent 直接 human_presence",
    );
    const presence = await call("human_presence", { tabId: 1, source: "kernel:mouse" }, INTERNAL);
    assert.equal(presence.scheduled, true);
    assert.equal(presence.debounceMs, 500);
    await sleep(750);
    const s3 = await status("step3 after debounce");
    assert.equal(s3.mode, "assist", "human_presence 去抖后没有进入 ASSIST");
    assert.ok(typeof s3.assistSince === "number");
    await expectCode(call("click", { selector: "#target", cursor: false }), "INPUT_ASSIST_REQUIRES_GRANT", "ASSIST 无 grant");
    const p3 = await pageState("step3 ASSIST click without grant");
    assert.equal(p3.clicks, 1, "ASSIST 无 grant 时页面仍被点击");
    console.log("PASS input-ownership-browser: human_presence debounces into ASSIST and blocks AI input");

    // ---------------- 4) grant_input actions:1 → 第一次成功、第二次被拒 ----------------
    const granted = await call("grant_input", { actions: 1, ttlMs: 5000 });
    assert.equal(granted.mode, "assist");
    assert.equal(granted.grant.actions, 1);
    assert.match(granted.grant.token, /…$/, "grant token 必须截断返回");
    report.push("grant_input -> " + JSON.stringify({ actions: granted.grant.actions, expiresAt: granted.grant.expiresAt, token: granted.grant.token }));
    const click2 = await call("click", { selector: "#target", cursor: false });
    assert.equal(click2.clicked, true);
    const p4 = await pageState("step4 first click with grant");
    assert.equal(p4.clicks, 2, "grant 放行的点击没有落到页面");
    assert.equal(p4.text, "2");
    await expectCode(call("click", { selector: "#target", cursor: false }), "INPUT_ASSIST_REQUIRES_GRANT", "grant 用尽");
    const p4b = await pageState("step4 second click without grant");
    assert.equal(p4b.clicks, 2, "grant 用尽后页面仍被点击");
    console.log("PASS input-ownership-browser: one grant action delivers exactly one real click");

    // ---------------- 5) grant 过期后被拒 ----------------
    const shortGrant = await call("grant_input", { actions: 2, ttlMs: 120 });
    assert.equal(shortGrant.grant.actions, 2);
    await sleep(400);
    const expiredError = await expectCode(
      call("click", { selector: "#target", cursor: false }),
      "INPUT_ASSIST_REQUIRES_GRANT",
      "过期 grant",
    );
    assert.equal(expiredError.detail.reason, "expired");
    const p5 = await pageState("step5 expired grant click");
    assert.equal(p5.clicks, 2, "过期 grant 仍放行了点击");
    const s5 = await status("step5 expired");
    assert.equal(s5.mode, "assist", "过期 grant 不应把空间踢出 ASSIST");
    assert.equal(s5.grantActionsRemaining, null, "过期 grant 不得再报告剩余次数");
    console.log("PASS input-ownership-browser: an expired grant is rejected and never honored");

    // ---------------- 6) claim_space 回 AI → click 恢复 ----------------
    await call("claim_space");
    const s6 = await status("step6 claimed");
    assert.equal(s6.mode, "ai");
    const click3 = await call("click", { selector: "#target", cursor: false });
    assert.equal(click3.clicked, true);
    const p6 = await pageState("step6 AI click after claim");
    assert.equal(p6.clicks, 3, "claim_space 之后 AI 点击没有恢复");
    assert.equal(p6.text, "3");

    // ---------------- 7) 状态层不变量 + 审计事件 ----------------
    const finalState = stored[STATE_KEY].spaces["space-test"];
    assert.equal(finalState.ownership, "agent");
    assert.equal(finalState.assist, undefined, "claim_space 后不得残留 assist");
    for (const space of Object.values(stored[STATE_KEY].spaces)) {
      assert.notEqual(space.ownership, "assist", "不得出现 ownership:\"assist\" 的第二套状态");
    }
    const auditRejected = harness.drainEvents({ after_sequence: 0, limit: 1000, methods: ["input_command_rejected"] }).events;
    const auditConsumed = harness.drainEvents({ after_sequence: 0, limit: 1000, methods: ["input_grant_consumed"] }).events;
    const auditIssued = harness.drainEvents({ after_sequence: 0, limit: 1000, methods: ["input_grant_issued"] }).events;
    assert.ok(auditRejected.some((e) => e.args.code === "INPUT_HUMAN_OWNED" && e.args.command === "click"));
    assert.ok(auditRejected.some((e) => e.args.code === "INPUT_HUMAN_OWNED" && e.args.command === "js"));
    assert.ok(auditRejected.some((e) => e.args.code === "INPUT_ASSIST_REQUIRES_GRANT" && e.args.reason === "expired"));
    assert.ok(auditConsumed.some((e) => e.args.remaining === 0), "grant 用尽应记录剩余 0");
    assert.ok(auditConsumed.every((e) => e.args.spaceId === "space-test" && typeof e.args.command === "string"),
      "每条 grant 消耗事件都必须带 spaceId/command");
    assert.ok(auditIssued.length >= 2, "每次成功发放 grant 都必须有审计事件");
    report.push("审计事件: input_command_rejected=" + auditRejected.length
      + " input_grant_consumed=" + auditConsumed.length
      + " input_grant_issued=" + auditIssued.length);
    report.push("最终 SpaceState: " + JSON.stringify({
      ownership: finalState.ownership, assist: finalState.assist ?? null, tabId: finalState.tabId,
    }));

    console.log("---- 输入权集成测试原始结果 ----");
    for (const line of report) console.log("  " + line);
    console.log("PASS input-ownership-browser: HUMAN/ASSIST/AI 全链路在真实 headless 浏览器上成立（点击计数/DOM 变化/错误码/审计）");
  } finally {
    try { if (chrome) await chrome.kill(); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  }
}

main().catch((e) => {
  console.error("FAIL input-ownership-browser:", e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
