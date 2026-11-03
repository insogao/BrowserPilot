// 虚拟鼠标离线单测：轨迹纯函数 + SW 侧编排（含截图排除策略与清理钩子）+ 静态安全断言。
// 真实浏览器渲染/像素断言见 scripts/test-virtual-cursor-browser.mjs。
import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

console.log("---- 虚拟鼠标离线单测 ----");

// ---------- 1. 轨迹纯函数 ----------
const pathLib = await (async () => {
  const r = await build({
    stdin: { contents: 'export * from "./src/shared/cursor-path.ts"', resolveDir: process.cwd() },
    bundle: true, format: "esm", platform: "browser", write: false,
  });
  return import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
})();

{
  const path = pathLib.buildHumanPath({ x: 10, y: 20 }, { x: 410, y: 320 }, { random: () => 0.75 });
  assert.ok(path.points.length >= 5, "轨迹采样点太少");
  assert.deepEqual({ x: path.points[0].x, y: path.points[0].y }, { x: 10, y: 20 }, "轨迹起点不是当前位置");
  const last = path.points[path.points.length - 1];
  assert.deepEqual({ x: last.x, y: last.y }, { x: 410, y: 320 }, "轨迹终点不是目标中心（会点偏）");
  assert.equal(last.t, 1);
  for (let i = 1; i < path.points.length; i++) {
    assert.ok(path.points[i].t >= path.points[i - 1].t, "轨迹时间必须单调");
  }
  assert.ok(path.durationMs >= 160 && path.durationMs <= 700, "轨迹时长超出合理区间: " + path.durationMs);
  // 必须是曲线：中点偏离直线（否则就是瞬移/直线机械移动）
  const mid = path.points[Math.floor(path.points.length / 2)];
  const lineY = 20 + (320 - 20) * ((mid.x - 10) / (410 - 10));
  assert.ok(Math.abs(mid.y - lineY) > 0.5, "轨迹中段没有偏离直线，不构成拟人轨迹");
  // 归一化采样
  const s0 = pathLib.samplePath(path.points, 0);
  const s1 = pathLib.samplePath(path.points, 1);
  assert.deepEqual({ x: s0.x, y: s0.y }, { x: 10, y: 20 });
  assert.deepEqual({ x: s1.x, y: s1.y }, { x: 410, y: 320 });
  // 原地移动不抖动、不耗时
  const same = pathLib.buildHumanPath({ x: 5, y: 5 }, { x: 5, y: 5 });
  assert.deepEqual(same.points.map((p) => [p.x, p.y]), [[5, 5], [5, 5]]);
  assert.equal(same.durationMs, 0);
  console.log("PASS cursor: 轨迹从真实起点到元素中心、时间单调、曲线不瞬移");
}

// ---------- 2. SW 侧编排（用 stub 替换 chrome 边界） ----------
const transport = {
  log: [],
  contentFails: false,
  injectFails: false,
  evalFails: false,
  evalReturn: "hidden",
  resolveFails: false,
  resolve: { x: 800, y: 600 },
  captureCalls: 0,
  captureDeferred: false,
  captureWaiters: [],
};
function wireState(msg) {
  const hidden = msg.kind === "cursor_capture_hidden" ? msg.hidden === true : false;
  return {
    mounted: true,
    visible: msg.kind === "cursor_hide" ? false : !hidden,
    hiddenForCapture: hidden,
    style: "arrow",
    x: Number.isFinite(msg.x) ? msg.x : 450,
    y: Number.isFinite(msg.y) ? msg.y : 350,
    pointerEvents: "none",
    glyphPointerEvents: "none",
    hostDisplay: hidden ? "none" : "block",
    hostRect: { x: 0, y: 0, width: 900, height: 700 },
    glyphRect: { x: 0, y: 0, width: 24, height: 24 },
    elementAtPoint: "button#target",
    elementsAtPoint: ["button#target", "body", "html"],
    viewport: { width: 900, height: 700 },
  };
}
globalThis.__vcTest = {
  ensureInjected: async (tabId) => {
    transport.log.push({ op: "ensureInjected", tabId });
    if (transport.injectFails) throw new Error("cannot inject");
  },
  sendToTab: async (tabId, msg) => {
    transport.log.push({ op: msg.kind, tabId, msg });
    if (transport.contentFails) throw new Error("content down");
    return { ok: true, state: wireState(msg) };
  },
  evalPage: async (tabId, expr) => {
    transport.log.push({ op: "evalPage", tabId, expr });
    if (transport.evalFails) throw new Error("eval down");
    return transport.evalReturn;
  },
  resolveCoord: async (tabId, target, opts) => {
    transport.log.push({ op: "resolveCoord", tabId, target, opts });
    if (transport.resolveFails) throw new Error("page_updated");
    return transport.resolve;
  },
  captureScreenshot: async (tabId, format) => {
    transport.captureCalls += 1;
    transport.log.push({ op: "captureScreenshot", tabId, format });
    if (transport.captureDeferred) {
      await new Promise((resolve) => transport.captureWaiters.push(resolve));
    }
    return { base64: "AAAA", meta: { fromSurface: true, durationMs: 1, possiblyStale: false } };
  },
};

const vc = await (async () => {
  const r = await build({
    stdin: { contents: 'export * from "./src/background/virtual-cursor.ts"', resolveDir: process.cwd() },
    bundle: true, format: "esm", platform: "browser", write: false,
    plugins: [{
      name: "vc-stubs",
      setup(b) {
        b.onResolve({ filter: /(^|\/)content-bridge$/ }, () => ({ path: "content-bridge", namespace: "vc" }));
        b.onResolve({ filter: /(^|\/)cdp$/ }, () => ({ path: "cdp", namespace: "vc" }));
        b.onResolve({ filter: /(^|\/)tab-resolver$/ }, () => ({ path: "tab-resolver", namespace: "vc" }));
        b.onLoad({ filter: /.*/, namespace: "vc" }, (args) => {
          const hook = "const H = () => globalThis.__vcTest;";
          if (args.path === "content-bridge") {
            return { contents: hook + "export const ensureInjected = async (t) => H().ensureInjected(t);\nexport const sendToTab = async (t, m, f) => H().sendToTab(t, m, f);" };
          }
          if (args.path === "cdp") {
            return {
              contents:
                hook +
                "export const evalPage = async (t, e) => H().evalPage(t, e);\n" +
                "export const resolveCoord = async (t, g, o) => H().resolveCoord(t, g, o);\n" +
                "export const captureScreenshot = async (t, f, o) => H().captureScreenshot(t, f, o);",
            };
          }
          return { contents: "export const resolveTargetTab = async () => 1;" };
        });
      },
    }],
  });
  return import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
})();

const reset = () => {
  transport.log.length = 0;
  transport.contentFails = false;
  transport.injectFails = false;
  transport.evalFails = false;
  transport.evalReturn = "hidden";
  transport.resolveFails = false;
  transport.captureCalls = 0;
  transport.captureDeferred = false;
  for (const release of transport.captureWaiters) release();
  transport.captureWaiters = [];
  vc.__resetCursorStateForTests();
};
const ops = () => transport.log.map((e) => e.op);

// 2.1 动作包装：先移动光标（真实坐标）再执行真实动作，并带轨迹时长
{
  reset();
  const order = [];
  transport.log.push({ op: "MARK" });
  const result = await vc.withCursorAction(1, { selector: "#target" }, async () => {
    transport.log.push({ op: "run" });
    return "clicked";
  }, { pulse: true });
  await new Promise((r) => setTimeout(r, 0));
  const seq = ops().filter((o) => o !== "MARK");
  assert.equal(result, "clicked");
  assert.deepEqual(
    seq.slice(0, 4),
    ["resolveCoord", "cursor_show", "cursor_move", "run"],
    "光标必须先移动到目标再执行真实动作，实际: " + JSON.stringify(seq)
  );
  const move = transport.log.find((e) => e.op === "cursor_move").msg;
  assert.equal(move.x, 800);
  assert.equal(move.y, 600);
  assert.ok(move.durationMs > 0, "cursor_move 缺少轨迹时长");
  assert.ok(seq.includes("cursor_pulse"), "点击后没有涟漪反馈");
  console.log("PASS cursor: withCursorAction 先移动光标再执行真实动作（含涟漪）");
}

// 2.2 单次动作可显式关闭光标
{
  reset();
  let ran = false;
  await vc.withCursorAction(1, { selector: "#target", cursor: false }, async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(ops().some((o) => o.startsWith("cursor_")), false, "cursor:false 时仍然发了光标消息");
  console.log("PASS cursor: cursor:false 完全旁路光标层");
}

// 2.3 光标层失败绝不阻断真实输入（fail-open）
{
  reset();
  transport.contentFails = true;
  transport.injectFails = true;
  let ran = false;
  await vc.withCursorAction(1, { selector: "#target" }, async () => { ran = true; });
  assert.equal(ran, true, "光标不可用时真实动作被阻断（必须是 fail-open）");
  const st = await vc.getCursorState(1, { verify: false });
  assert.equal(st.enabled, false);
  assert.equal(st.unavailable, true, "不可注入页面未被标记 unavailable");
  // 之后同一 tab 不再尝试（避免每条动作都白跑 IPC）
  transport.log.length = 0;
  await vc.withCursorAction(1, { selector: "#target" }, async () => {});
  assert.equal(transport.log.length, 0, "unavailable tab 仍在尝试光标消息");
  console.log("PASS cursor: 光标层失败 fail-open，且不可注入页面不会反复重试");
}

// 2.4 显式关闭后不再自动弹出（必须显式 show 才恢复）
{
  reset();
  await vc.showCursor(1);
  await vc.hideCursor(1); // 默认 disable=true：这是「用户意图关闭」
  transport.log.length = 0;
  let ran = false;
  await vc.withCursorAction(1, { selector: "#target" }, async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(transport.log.filter((e) => e.op.startsWith("cursor_")).length, 0,
    "显式关闭后动作仍然自动弹出了光标");

  await vc.showCursor(1);
  transport.log.length = 0;
  await vc.withCursorAction(1, { selector: "#target" }, async () => {});
  assert.ok(transport.log.some((e) => e.op === "cursor_move"), "显式 show 之后没有恢复自动光标");
  // mask / tab 切换只做「临时收起」，不应永久关闭
  vc.onMaskStateChange(1);
  await new Promise((r) => setTimeout(r, 0));
  transport.log.length = 0;
  await vc.withCursorAction(1, { selector: "#target" }, async () => {});
  assert.ok(transport.log.some((e) => e.op === "cursor_move"), "mask 的临时收起误当成了永久关闭");
  console.log("PASS cursor: 显式 hide 会关闭自动光标，mask/tab 切换只临时收起");
}

// 2.5 默认截图：先隐藏光标 -> 截图 -> 恢复
{
  reset();
  await vc.showCursor(1);
  transport.log.length = 0;
  const shot = await vc.captureScreenshotWithCursorPolicy(1, "png");
  const seq = ops();
  assert.deepEqual(seq, ["cursor_capture_hidden", "captureScreenshot", "cursor_capture_hidden"],
    "默认截图没有按 隐藏->截图->恢复 的顺序执行: " + JSON.stringify(seq));
  const [hide, , restore] = transport.log;
  assert.equal(hide.msg.hidden, true);
  assert.equal(restore.msg.hidden, false);
  assert.equal(shot.cursorIncluded, false, "默认截图报告包含光标");
  assert.equal(shot.base64, "AAAA");
  assert.equal((await vc.getCursorState(1, { verify: false })).hiddenForCapture, false, "截图后没有恢复");
  console.log("PASS cursor: 默认截图隐藏光标、截完恢复，且报告 cursorIncluded=false");
}

// 2.4b 同一 tab 两个截图重叠：只隐藏一次，最后一个结束才恢复
{
  reset();
  await vc.showCursor(1);
  transport.log.length = 0;
  transport.captureDeferred = true;
  const p1 = vc.captureScreenshotWithCursorPolicy(1, "png");
  const p2 = vc.captureScreenshotWithCursorPolicy(1, "png");
  await new Promise((r) => setTimeout(r, 0));
  const hides = transport.log.filter((e) => e.op === "cursor_capture_hidden" && e.msg.hidden === true);
  assert.equal(hides.length, 1, "重叠截图重复发送了隐藏消息: " + hides.length);
  assert.equal(transport.captureWaiters.length, 2, "两个截图没有同时进入等待");
  transport.captureWaiters.shift()();
  await p1;
  const restoresAfterFirst = transport.log.filter(
    (e) => e.op === "cursor_capture_hidden" && e.msg.hidden === false,
  );
  assert.equal(restoresAfterFirst.length, 0, "第一个截图结束后过早恢复了光标，第二个截图会拍到它");
  transport.captureWaiters.shift()();
  await p2;
  const restoresAfterSecond = transport.log.filter(
    (e) => e.op === "cursor_capture_hidden" && e.msg.hidden === false,
  );
  assert.equal(restoresAfterSecond.length, 1, "最后一个截图结束后没有恢复光标");
  console.log("PASS cursor: 重叠截图只隐藏一次，最后一个结束才恢复");
}

// 2.5 includeCursor=true：不隐藏、报告 cursorIncluded=true
{
  reset();
  await vc.showCursor(1);
  transport.log.length = 0;
  const shot = await vc.captureScreenshotWithCursorPolicy(1, "png", { includeCursor: true });
  assert.deepEqual(ops(), ["captureScreenshot"], "includeCursor 路径不应隐藏光标");
  assert.equal(shot.cursorIncluded, true, "includeCursor=true 时没有报告光标");
  console.log("PASS cursor: includeCursor=true 才把光标放进截图");
}

// 2.6 隐藏失败必须 fail closed（绝不返回可能带光标的截图）
{
  reset();
  await vc.showCursor(1);
  transport.contentFails = true;
  transport.evalFails = true;
  await assert.rejects(
    () => vc.captureScreenshotWithCursorPolicy(1, "png"),
    (e) => e.name === "CursorCaptureError" && /拒绝返回/.test(e.message),
  );
  assert.equal(transport.captureCalls, 0, "隐藏失败后仍然截了图（可能带光标）");
  console.log("PASS cursor: 无法隐藏光标时截图 fail closed");
}

// 2.7 content 不可用时用 DOM 兜底隐藏，并正确恢复
{
  reset();
  await vc.showCursor(1);
  transport.contentFails = true;
  transport.evalReturn = "hidden";
  const shot = await vc.captureScreenshotWithCursorPolicy(1, "png");
  assert.equal(shot.cursorIncluded, false);
  const evals = transport.log.filter((e) => e.op === "evalPage");
  assert.equal(evals.length, 2, "DOM 兜底应包含隐藏与恢复两次求值，实际 " + evals.length);
  assert.match(evals[0].expr, /display.*none/);
  assert.match(evals[1].expr, /bp-prev-display/);
  console.log("PASS cursor: content 不可用时用 DOM 兜底隐藏并在截图后恢复");
}

// 2.8 导航清理 / tab 切换清理 / mask 清理
{
  reset();
  const listeners = { onUpdated: [], onActivated: [], onRemoved: [] };
  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.tabs = {
    onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
    onActivated: { addListener: (fn) => listeners.onActivated.push(fn) },
    onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
    query: async ({ windowId }) => [{ id: 1, windowId }, { id: 2, windowId }],
  };
  vc.registerVirtualCursorHandlers();
  assert.equal(listeners.onUpdated.length, 1);
  assert.equal(listeners.onActivated.length, 1);
  assert.equal(listeners.onRemoved.length, 1);

  await vc.showCursor(1);
  await vc.showCursor(2);
  transport.log.length = 0;
  listeners.onActivated[0]({ tabId: 2, windowId: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(transport.log.some((e) => e.op === "cursor_hide" && e.tabId === 1),
    "tab 切走时没有隐藏旧 tab 的光标");

  await vc.showCursor(3);
  listeners.onUpdated[0](3, { status: "loading" });
  assert.equal((await vc.getCursorState(3, { verify: false })).enabled, false, "导航后 SW 光标状态未清理");

  await vc.showCursor(4);
  vc.onMaskStateChange(4);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await vc.getCursorState(4, { verify: false })).enabled, false, "mask 开启后光标未收起");

  listeners.onRemoved[0](2);
  assert.equal(vc.getCursorStates().some((s) => s.tabId === 2), false, "tab 关闭后状态残留");

  const cleared = await vc.clearAllCursors();
  assert.ok(cleared.length >= 1, "clearAllCursors 没有清理任何 tab");
  assert.equal(vc.getCursorStates().length, 0);
  console.log("PASS cursor: 导航/tab 切换/tab 关闭/mask 启停都会清理光标状态");
}

// 2.9 cursor 命令（集成方在 commands.ts 注册后即可用）
{
  reset();
  const view = await vc.handleCursorCommand({ type: "command", name: "cursor", requestId: "c1", args: { action: "show", style: "dot" } });
  assert.equal(view.ok, true);
  assert.equal(view.enabled, true);
  const moved = await vc.handleCursorCommand({ type: "command", name: "cursor", requestId: "c2", args: { action: "move", x: 12, y: 34 } });
  assert.equal(moved.x, 12);
  assert.equal(moved.y, 34);
  const gone = await vc.handleCursorCommand({ type: "command", name: "cursor", requestId: "c3", args: { action: "remove" } });
  assert.equal(gone.removed, true);
  assert.equal(vc.getCursorStates().length, 0);
  console.log("PASS cursor: cursor 命令支持 show/move/remove/state");
}

// ---------- 3. 静态安全断言 ----------
{
  const files = [
    "src/background/virtual-cursor.ts",
    "src/content/cursor.ts",
    "src/shared/cursor-path.ts",
    "src/shared/cursor-contract.ts",
  ];
  const banned = /robotjs|nut-js|@nut-tree|ffi-napi|node-ffi|SendInput|mouse_event|SetCursorPos|keybd_event/i;
  // 只扫代码，不扫注释（注释里会明确写「禁止使用 xxx」）。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, "utf8"));
    assert.equal(banned.test(src), false, f + " 出现了系统级输入/鼠标 API（禁止）");
  }
  const bg = stripComments(fs.readFileSync("src/background/virtual-cursor.ts", "utf8"));
  assert.equal(/Input\.dispatch(Mouse|Key)Event/.test(bg), false,
    "virtual-cursor 不应自己发输入（真实输入必须复用 actions.ts 的 CDP 通道）");
  const actions = fs.readFileSync("src/background/actions.ts", "utf8");
  assert.match(actions, /Input\.dispatchMouseEvent/, "真实点击仍必须走 CDP Input.dispatchMouseEvent");
  assert.match(actions, /Input\.dispatchKeyEvent|Input\.insertText/, "真实键盘输入仍必须走 CDP");
  // 光标必须在真实按下之前移动（否则视觉与真实点击不同步）
  const clickBody = actions.slice(actions.indexOf("export async function click("), actions.indexOf("export async function dblclick("));
  assert.match(clickBody, /await cursorTo\(tabId, coord, a\)/, "click 没有先移动虚拟光标");
  assert.ok(
    clickBody.indexOf("await cursorTo(tabId, coord, a)") < clickBody.indexOf('mouseEvent(tabId, "mousePressed"'),
    "虚拟光标必须在真实 mousePressed 之前移动",
  );
  assert.match(actions, /a\.cursor === false/, "actions 必须支持单次动作关闭光标");
  const vcSrc = fs.readFileSync("src/background/virtual-cursor.ts", "utf8");
  assert.match(vcSrc, /export async function moveCursorForAction[\s\S]*?catch \{/, "moveCursorForAction 必须 fail-open（吞掉错误）");

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const name of Object.keys(deps)) {
    assert.equal(/robotjs|nut|ffi/i.test(name), false, "package.json 引入了系统级输入依赖: " + name);
  }

  const bridgeSrc = fs.readFileSync("src/content/bridge.ts", "utf8");
  assert.match(bridgeSrc, /CURSOR_MSG\.move/, "content bridge 没有接 cursor_move");
  assert.match(bridgeSrc, /CURSOR_MSG\.captureHidden/, "content bridge 没有接 cursor_capture_hidden");
  assert.match(bridgeSrc, /异步响应/, "cursor_move/capture_hidden 必须异步回包");

  const clickableSrc = fs.readFileSync("src/content/clickable.ts", "utf8");
  assert.match(clickableSrc, /bp-virtual-cursor-host/, "L0 可点击树没有排除虚拟光标 host");
  console.log("PASS cursor: 无系统级输入依赖；光标层不自己发输入；L0/内容桥已接线");
}

console.log("PASS cursor: 离线单测全部通过");
