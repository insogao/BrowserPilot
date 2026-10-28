// 真实 headless Chromium 集成测试：AI 虚拟鼠标（插件级 overlay 光标）。
//
// 本测试跑的是**真实代码路径**：
//   - 用 esbuild 打包 src/background/virtual-cursor.ts，只把 chrome 扩展 API 边界
//     （content-bridge / cdp / tab-resolver）替换成「通过 CDP 转发到真实页面」的实现；
//   - 页面里注入真实打包产物 src/content/bridge.ts（带最小 chrome.runtime shim），
//     于是 cursor overlay 是真实 DOM/CSS/合成器渲染出来的；
//   - 真实点击用 CDP Input.dispatchMouseEvent 打到真实坐标。
//
// 断言：坐标正确、pointer-events:none、不影响布局、默认截图不含光标、includeCursor 含光标、
// 系统鼠标位置前后不变、导航/tab 切换后 overlay 与状态都被清理。
//
// 运行：node scripts/test-virtual-cursor-browser.mjs
//   Chromium 路径：环境变量 BP_CHROME_EXE，缺省 D:\work\wt\browser-cli-baseline\chrome.exe
// 隔离：独立临时 --user-data-dir；不使用 --no-sandbox；不触碰用户真实 profile/窗口。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { decodePng, pixelAt, regionDiff } from "./lib/png.mjs";
import { launchHeadlessChrome } from "./lib/cdp-client.mjs";

const CHROME_EXE = process.env.BP_CHROME_EXE || "D:\\work\\wt\\browser-cli-baseline\\chrome.exe";
const VIEWPORT = { width: 900, height: 700 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSystemCursorPos() {
  if (process.platform !== "win32") return null;
  const script = "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; \"$($p.X),$($p.Y)\"";
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  }).trim();
  const [x, y] = out.split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("GetCursorPos 解析失败: " + out);
  return { x, y };
}

const FIXTURE_INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>cursor fixture</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#f2f4f7;
    font:16px system-ui,-apple-system,"Segoe UI",sans-serif;}
  #target{position:absolute;left:300px;top:260px;width:200px;height:120px;background:#1a73e8;
    color:#fff;border:0;border-radius:8px;font-size:18px;cursor:pointer;}
  #log{position:absolute;left:16px;top:16px;font-size:12px;color:#111;}
</style></head>
<body>
  <button id="target" type="button">Target</button>
  <div id="log">idle</div>
  <script>
    window.__events = [];
    for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
      document.getElementById("target").addEventListener(t, (e) => {
        window.__events.push({ type: t, x: e.clientX, y: e.clientY, trusted: e.isTrusted });
        document.getElementById("log").textContent = t + " @" + e.clientX + "," + e.clientY;
      });
    }
  </script>
</body></html>`;

const FIXTURE_NEXT = `<!doctype html>
<html><head><meta charset="utf-8"><title>cursor fixture next</title>
<style>html,body{margin:0;height:100%;background:#ffffff;font:16px system-ui}</style>
</head><body><h1 id="page2">page 2</h1></body></html>`;

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(FIXTURE_INDEX);
      return;
    }
    if (url === "/next.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(FIXTURE_NEXT);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, origin: "http://127.0.0.1:" + port });
    });
  });
}

/** 页面侧 chrome.runtime 最小 shim + 让 Node 能在页面里同步/异步地调用内容脚本 listener。 */
const PAGE_SHIM = `(() => {
  window.__bpListeners = [];
  window.__bpCalls = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener(fn) { window.__bpListeners.push(fn); } },
      sendMessage() { return Promise.resolve(); },
    },
  };
  window.__bpCall = (msg) => new Promise((resolve) => {
    window.__bpCalls.push(msg && msg.kind);
    let done = false;
    const send = (r) => { if (!done) { done = true; resolve(r); } };
    for (const fn of window.__bpListeners) {
      try { fn(msg, {}, send); } catch (e) { send({ ok: false, error: String(e) }); }
    }
    setTimeout(() => { if (!done) resolve({ ok: false, error: "content listener timeout" }); }, 8000);
  });
})();`;

async function bundle(entry, plugins) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "chrome116",
    logLevel: "warning",
    ...(plugins ? { plugins } : {}),
  });
  return result.outputFiles[0].text;
}

async function bundleContentScript() {
  const result = await build({
    entryPoints: ["src/content/bridge.ts"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome116",
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}

/** 只替换 chrome 扩展 API 边界；其余逻辑（含 CDP 坐标解析、截图策略）都是真实实现。 */
function browserBridgePlugin() {
  return {
    name: "browser-bridge",
    setup(b) {
      b.onResolve({ filter: /(^|\/)content-bridge$/ }, () => ({ path: "content-bridge", namespace: "bp" }));
      b.onResolve({ filter: /(^|\/)cdp$/ }, () => ({ path: "cdp", namespace: "bp" }));
      b.onResolve({ filter: /(^|\/)tab-resolver$/ }, () => ({ path: "tab-resolver", namespace: "bp" }));
      b.onLoad({ filter: /.*/, namespace: "bp" }, (args) => {
        if (args.path === "content-bridge") {
          return {
            contents:
              "export const ensureInjected = async (tabId) => { globalThis.__bpInjected = (globalThis.__bpInjected || 0) + 1; };\n" +
              "export const sendToTab = async (tabId, msg, frameId) => globalThis.__bpSendToTab(tabId, msg, frameId);\n",
          };
        }
        if (args.path === "cdp") {
          return {
            contents:
              "export const evalPage = async (tabId, expr) => globalThis.__bpEvalPage(tabId, expr);\n" +
              "export const resolveCoord = async (tabId, target, opts) => globalThis.__bpResolveCoord(tabId, target, opts);\n" +
              "export const captureScreenshot = async (tabId, format, opts) => globalThis.__bpCaptureScreenshot(tabId, format, opts);\n",
          };
        }
        return { contents: "export const resolveTargetTab = async () => 1;\n" };
      });
    },
  };
}

async function main() {
  if (!fs.existsSync(CHROME_EXE)) {
    throw new Error("找不到 Chromium：" + CHROME_EXE + "（可用 BP_CHROME_EXE 覆盖）");
  }
  const { server, origin } = await startFixtureServer();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bp-vcursor-test-"));
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
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const contentBundle = await bundleContentScript();
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SHIM + "\n;\n" + contentBundle });

    const evalInPage = async (expression, { awaitPromise = true } = {}) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) {
        throw new Error("页面求值异常: " + JSON.stringify(r.exceptionDetails).slice(0, 1200));
      }
      return r.result ? r.result.value : undefined;
    };

    const navigate = async (url) => {
      const loaded = conn.waitFor("Page.loadEventFired", sessionId, 20000);
      await send("Page.navigate", { url });
      await loaded;
      await sleep(150);
    };

    await navigate(origin + "/");
    // 等 content script 注册 listener（bundle 在 document_start 注入）。
    for (let i = 0; i < 100; i++) {
      const n = await evalInPage("window.__bpListeners ? window.__bpListeners.length : 0");
      if (n > 0) break;
      await sleep(50);
    }
    assert.ok((await evalInPage("window.__bpListeners.length")) > 0, "content script 未注册 listener");

    // ---------- 接上真实 background 模块 ----------
    const captured = [];
    globalThis.__bpSendToTab = async (tabId, msg) => {
      captured.push({ tabId, msg });
      return evalInPage("window.__bpCall(" + JSON.stringify(msg) + ")");
    };
    globalThis.__bpEvalPage = async (_tabId, expr) => evalInPage(expr);
    globalThis.__bpResolveCoord = async (_tabId, target, opts) => {
      let coord = null;
      if (target && typeof target === "object") {
        coord = { x: Number(target.x), y: Number(target.y) };
      } else if (typeof target === "string") {
        const sel = target.startsWith("@") ? '[data-bp-id="bp-' + target.slice(1) + '"]' : target;
        coord = await evalInPage(
          "(()=>{const el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return null;" +
            (opts && opts.scroll === false ? "" : 'el.scrollIntoView({block:"center",inline:"center"});') +
            "const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()"
        );
      }
      globalThis.__bpLastCoord = coord;
      return coord;
    };
    globalThis.__bpCaptureScreenshot = async (_tabId, format) => {
      const r = await send("Page.captureScreenshot", { format: format || "png", fromSurface: true });
      return { base64: r.data, meta: { fromSurface: true, durationMs: 0, possiblyStale: false } };
    };

    // 真实 chrome.tabs 事件的 shim（用于验证导航/tab 切换清理）。
    const tabListeners = { onUpdated: [], onActivated: [], onRemoved: [] };
    globalThis.chrome = {
      tabs: {
        onUpdated: { addListener: (fn) => tabListeners.onUpdated.push(fn) },
        onActivated: { addListener: (fn) => tabListeners.onActivated.push(fn) },
        onRemoved: { addListener: (fn) => tabListeners.onRemoved.push(fn) },
        query: async ({ windowId }) => [{ id: 1, windowId }],
      },
    };

    const vcText = await bundle("src/background/virtual-cursor.ts", [browserBridgePlugin()]);
    const vc = await import("data:text/javascript;base64," + Buffer.from(vcText).toString("base64"));
    vc.registerVirtualCursorHandlers();
    assert.equal(tabListeners.onUpdated.length, 1, "未注册 tabs.onUpdated 清理钩子");

    const sysBefore = getSystemCursorPos();
    report.push("系统鼠标位置（操作前）: " + JSON.stringify(sysBefore));

    // ---------- 1. 真实元素 rect -> 光标移动 -> CDP 点击 ----------
    const before = await evalInPage(`(()=>{
      const r = document.getElementById("target").getBoundingClientRect();
      const de = document.documentElement;
      return {
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        layout: {
          bodyW: document.body.getBoundingClientRect().width,
          bodyH: document.body.getBoundingClientRect().height,
          scrollW: de.scrollWidth,
          scrollH: de.scrollHeight,
        },
      };
    })()`);
    report.push("目标元素 rect(center): " + JSON.stringify(before.center) + " viewport=" + JSON.stringify(before.viewport));

    const clicked = await vc.withCursorAction(
      1,
      { selector: "#target" },
      async () => {
        const c = globalThis.__bpLastCoord;
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y, button: "none", buttons: 0 });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", buttons: 1, clickCount: 1 });
        await sleep(20);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", buttons: 0, clickCount: 1 });
        return c;
      },
      { pulse: true }
    );
    await sleep(120);

    const state1 = await vc.getCursorState(1);
    report.push("cursor state(cached+verified): " + JSON.stringify({
      ok: state1.ok, visible: state1.visible, x: state1.x, y: state1.y, style: state1.style,
    }));

    assert.equal(state1.ok, true, "cursor 状态查询失败: " + (state1.error || ""));
    assert.equal(state1.visible, true, "虚拟光标未显示");
    assert.equal(clicked.x, before.center.x, "CDP 点击坐标与元素中心不一致");
    assert.equal(clicked.y, before.center.y, "CDP 点击坐标与元素中心不一致");
    assert.equal(state1.x, before.center.x, "光标 x 未落在元素中心（差 " + (state1.x - before.center.x) + "px）");
    assert.equal(state1.y, before.center.y, "光标 y 未落在元素中心（差 " + (state1.y - before.center.y) + "px）");

    // 轨迹由真实 rect 算出，且是「沿路径移动」而不是瞬移
    const moveMsgs = captured.filter((c) => c.msg.kind === "cursor_move");
    assert.ok(moveMsgs.length >= 1, "没有发出 cursor_move");
    assert.equal(moveMsgs[moveMsgs.length - 1].msg.x, before.center.x, "cursor_move 目标 x 不是元素中心");
    assert.equal(moveMsgs[moveMsgs.length - 1].msg.y, before.center.y, "cursor_move 目标 y 不是元素中心");
    assert.ok(moveMsgs[moveMsgs.length - 1].msg.durationMs > 0, "cursor_move 没有轨迹时长（瞬移）");

    const overlay = await evalInPage(`(()=>{
      const probe = window.__bpCall({ kind: "cursor_status" });
      return probe;
    })()`);
    assert.equal(overlay.ok, true);
    assert.equal(overlay.state.pointerEvents, "none", "host pointer-events 不是 none");
    assert.equal(overlay.state.glyphPointerEvents, "none", "glyph pointer-events 不是 none");
    assert.equal(overlay.state.elementsAtPoint.some((s) => s.includes("bp-virtual-cursor-host")), false,
      "光标 overlay 参与了命中测试（会拦截点击/选择）");
    assert.equal(overlay.state.elementAtPoint.startsWith("button#target"), true,
      "落点最上层元素不是目标按钮，实际 " + overlay.state.elementAtPoint);
    assert.equal(overlay.state.hostRect.width, VIEWPORT.width, "overlay host 未铺满视口");
    assert.equal(overlay.state.hostRect.height, VIEWPORT.height, "overlay host 未铺满视口");
    report.push("overlay: pointerEvents=" + overlay.state.pointerEvents +
      " glyph=" + overlay.state.glyphPointerEvents +
      " elementAtPoint=" + overlay.state.elementAtPoint +
      " elementsAtPoint=" + JSON.stringify(overlay.state.elementsAtPoint));

    const after = await evalInPage(`(()=>{
      const r = document.getElementById("target").getBoundingClientRect();
      const de = document.documentElement;
      return {
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        layout: {
          bodyW: document.body.getBoundingClientRect().width,
          bodyH: document.body.getBoundingClientRect().height,
          scrollW: de.scrollWidth,
          scrollH: de.scrollHeight,
        },
        events: window.__events,
      };
    })()`);
    assert.deepEqual(after.rect, before.rect, "overlay 改变了目标元素的 rect（影响了布局）");
    assert.deepEqual(after.layout, before.layout, "overlay 改变了页面布局尺寸");
    assert.ok(after.events.some((e) => e.type === "click" && Math.abs(e.x - before.center.x) <= 1 && Math.abs(e.y - before.center.y) <= 1),
      "真实点击没有命中目标：overlay 可能拦截了点击或坐标错误");
    report.push("页面收到的点击事件: " + JSON.stringify(after.events));
    report.push("注意：CDP 注入事件在页面里 isTrusted=" + String(after.events[0]?.trusted) +
      "（所以内核必须用 kFromDebugger 而不是 isTrusted 区分自动化输入）");

    const sysAfterAction = getSystemCursorPos();
    report.push("系统鼠标位置（全部 CDP 操作后）: " + JSON.stringify(sysAfterAction));
    assert.deepEqual(sysAfterAction, sysBefore, "系统鼠标位置发生了变化（虚拟光标绝不能移动系统鼠标）");

    // ---------- 2. 截图：默认排除 / includeCursor 包含 ----------
    const shotInclude = await vc.captureScreenshotWithCursorPolicy(1, "png", { includeCursor: true });
    const afterIncludeState = await vc.getCursorState(1);
    const shotDefault = await vc.captureScreenshotWithCursorPolicy(1, "png");
    const afterDefaultState = await vc.getCursorState(1);

    assert.equal(shotInclude.cursorIncluded, true, "includeCursor=true 时没有把光标算进截图");
    assert.equal(shotDefault.cursorIncluded, false, "默认截图报告包含光标");
    assert.equal(afterIncludeState.visible, true, "includeCursor 截图后光标状态被破坏");
    assert.equal(afterDefaultState.visible, true, "默认截图后没有恢复光标");
    assert.equal(afterDefaultState.hiddenForCapture, false, "默认截图后 hiddenForCapture 残留");

    const removed = await vc.removeCursor(1);
    assert.equal(removed.removed, true, "removeCursor 失败");
    const shotBaseline = await vc.captureScreenshotWithCursorPolicy(1, "png");
    const mountAfterRemove = await evalInPage("!!document.getElementById('bp-virtual-cursor-host')");
    assert.equal(mountAfterRemove, false, "removeCursor 后 overlay 仍留在页面里");

    const imgInclude = decodePng(Buffer.from(shotInclude.base64, "base64"));
    const imgDefault = decodePng(Buffer.from(shotDefault.base64, "base64"));
    const imgBaseline = decodePng(Buffer.from(shotBaseline.base64, "base64"));
    assert.equal(imgBaseline.width, VIEWPORT.width, "截图宽度与视口不一致");
    assert.equal(imgBaseline.height, VIEWPORT.height, "截图高度与视口不一致");

    const region = { x: before.center.x - 13, y: before.center.y - 13, width: 26, height: 26 };
    const diffDefault = regionDiff(imgDefault, imgBaseline, region);
    const diffInclude = regionDiff(imgInclude, imgBaseline, region);
    const centerInclude = pixelAt(imgInclude, before.center.x + 2, before.center.y + 2);
    const centerBaseline = pixelAt(imgBaseline, before.center.x + 2, before.center.y + 2);
    report.push("截图像素断言 region=" + JSON.stringify(region) +
      " diff(default vs baseline)=" + diffDefault +
      " diff(includeCursor vs baseline)=" + diffInclude +
      " pixel@center+2 include=" + JSON.stringify(centerInclude) +
      " baseline=" + JSON.stringify(centerBaseline));

    assert.equal(diffDefault, 0, "默认截图在光标位置包含 overlay 像素（diff=" + diffDefault + "）");
    assert.ok(diffInclude >= 20, "includeCursor=true 的截图没有光标像素（diff=" + diffInclude + "）");
    assert.notDeepEqual(centerInclude, centerBaseline, "光标热点处的像素没有变化");

    // ---------- 3. tab 切换清理 ----------
    await vc.moveCursor(1, { x: 500, y: 400 }, { durationMs: 60 });
    const beforeSwitch = await vc.getCursorState(1);
    assert.equal(beforeSwitch.visible, true);
    const capturedBefore = captured.length;
    for (const fn of tabListeners.onActivated) fn({ tabId: 999, windowId: 1 });
    await sleep(200);
    const switchMsgs = captured.slice(capturedBefore).filter((c) => c.msg.kind === "cursor_hide");
    assert.ok(switchMsgs.length >= 1, "tab 切走时没有发出 cursor_hide");
    const afterSwitch = await vc.getCursorState(1);
    assert.equal(afterSwitch.visible, false, "tab 切走后光标仍然可见");
    assert.equal(afterSwitch.enabled, false, "tab 切走后光标未关闭");
    report.push("tab 切换: 已发送 cursor_hide 并关闭光标（" + JSON.stringify(switchMsgs.map((c) => c.msg.kind)) + "）");

    // ---------- 4. 导航清理 ----------
    await vc.moveCursor(1, { x: 420, y: 320 }, { durationMs: 60 });
    assert.equal((await vc.getCursorState(1)).visible, true);
    const loadNext = conn.waitFor("Page.loadEventFired", sessionId, 20000);
    for (const fn of tabListeners.onUpdated) fn(1, { status: "loading" });
    await send("Page.navigate", { url: origin + "/next.html" });
    await loadNext;
    await sleep(200);
    const hostOnNewPage = await evalInPage("!!document.getElementById('bp-virtual-cursor-host')");
    assert.equal(hostOnNewPage, false, "导航后 overlay 残留在新页面");
    const afterNav = await vc.getCursorState(1);
    assert.equal(afterNav.visible, false, "导航后 SW 侧光标状态仍可见");
    assert.equal(afterNav.enabled, false, "导航后 SW 侧光标状态未清理");
    assert.equal(afterNav.mounted, false, "导航后仍认为 overlay 已挂载");
    report.push("导航后: overlay 不残留, SW 状态已清理 (" + JSON.stringify({
      visible: afterNav.visible, enabled: afterNav.enabled, mounted: afterNav.mounted,
    }) + ")");

    // 新页面仍可正常显示（不是一次性开关）
    const onNewPage = await vc.moveCursor(1, { x: 200, y: 150 }, { durationMs: 40 });
    assert.equal(onNewPage.ok, true, "导航后无法再次显示光标: " + (onNewPage.error || ""));
    assert.equal(onNewPage.visible, true);

    const sysAfterAll = getSystemCursorPos();
    report.push("系统鼠标位置（全部操作结束）: " + JSON.stringify(sysAfterAll));
    assert.deepEqual(sysAfterAll, sysBefore, "整个测试期间系统鼠标位置发生了变化");

    console.log("---- 虚拟鼠标集成测试原始结果 ----");
    for (const line of report) console.log("  " + line);
    console.log("PASS cursor: 真实 headless 浏览器上的虚拟光标（坐标/pointer-events/截图/系统鼠标/导航清理）");
  } finally {
    try { if (chrome) await chrome.kill(); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
    // Windows 上 Chromium 退出后文件句柄可能延迟释放：失败可接受（临时目录）。
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  }
}

main().catch((e) => {
  console.error("FAIL cursor-browser:", e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
