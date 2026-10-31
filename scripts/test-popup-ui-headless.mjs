// Headless popup UI 最小验证（P3 用户入口）。
//
// 目的：不再只测“直接 chrome.runtime.sendMessage”。本测试把真实构建产物
// dist/popup/index.{html,js} 放进一个最小 headless 页面，在 index.js 之前注入
// mock `chrome`（mock service worker），在之后注入 selftest 脚本，然后：
//   1. 打开 popup，等待 #space-select 出现两个可选 space；
//   2. 只设置 select.value（不派发 change）后点击 #grant-input —— 复现 A1 失败路径，
//      断言发出的消息使用下拉框当前值，而不是初始化/自动选择的空间；
//   3. 断言 SW 返回 actions:1 后 UI 的 #input-mode / #input-grant / #input-toast
//      同步更新，并且 data-ok="true"、data-code=""、按钮 data-busy 已清除；
//   4. 用 change 事件选择另一个 space，点击 #human-presence，断言消息目标随选择变化。
//
// 隔离：独立临时 --user-data-dir；headless；不加载用户真实 profile；不显示窗口；
// 不读写用户扩展/注册表。测试结束按 PID 清理自己启动的 Chrome 进程树。
//
// 运行：node scripts/test-popup-ui-headless.mjs
//   （package.json 的 test:popup-ui 会先 npm run build）
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distPopup = path.join(root, "dist", "popup");

function findChrome() {
  const candidates = [
    process.env.BP_CHROME,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    "D:\\c\\src\\out\\WinDev\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file));
}

function setupPage(tempDir) {
  const pageDir = path.join(tempDir, "popup");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.copyFileSync(path.join(distPopup, "index.js"), path.join(pageDir, "index.js"));

  const html = fs.readFileSync(path.join(distPopup, "index.html"), "utf8");
  assert.match(html, /<script src="index\.js"><\/script>/, "popup/index.html 缺少 index.js 引用");
  assert.match(html, /<\/body>/, "popup/index.html 缺少 </body>");
  const instrumented = html
    .replace(
      '<script src="index.js"></script>',
      '<script src="mock-chrome.js"></script>\n    <script src="index.js"></script>',
    )
    .replace("</body>", '    <script src="selftest.js"></script>\n  </body>');
  fs.writeFileSync(path.join(pageDir, "index.html"), instrumented, "utf8");
  fs.writeFileSync(path.join(pageDir, "mock-chrome.js"), MOCK_CHROME, "utf8");
  fs.writeFileSync(path.join(pageDir, "selftest.js"), SELFTEST_JS, "utf8");
  return { pageDir, url: pathToFileURL(path.join(pageDir, "index.html")).href };
}

const MOCK_CHROME = `
// Mock service worker：只验证 popup UI 接线，不实现真实命令层/内核。
(() => {
  const messages = [];
  let getStatusCount = 0;
  globalThis.__bpPopupTestMessages = messages;
  const statusFor = (msg) => {
    const selected = typeof msg.spaceId === "string" && msg.spaceId ? msg.spaceId : "space-auto";
    if (msg.kind === "get_status") getStatusCount += 1;
    const baseSpaces = [
      { spaceId: "space-auto", name: "Auto", windowId: 1, tabId: 21, ownership: "agent", mode: "ai", updatedAt: 2 },
      { spaceId: "space-test", name: "Test", windowId: 2, tabId: 11, ownership: "agent", mode: "assist", updatedAt: 1 },
    ];
    // 第二次 get_status 起反转 option 顺序：强制 popup 重建 <select>，验证
    // 自动化只设置 value（无 change）时不会被 1s 轮询清掉（A1 回归）。
    const spaces = getStatusCount > 1 ? baseSpaces.slice().reverse() : baseSpaces;
    return {
      attached: false,
      hostReady: false,
      connected: true,
      clientCount: 0,
      mode: "agent",
      tabId: 21,
      spaces,
      target: { spaceId: "space-auto", tabId: 21 },
      input: {
        spaceId: selected,
        windowId: selected === "space-test" ? 2 : 1,
        tabId: selected === "space-test" ? 11 : 21,
        mode: "assist",
        ownership: "agent",
        assistSince: Date.now() - 1000,
        assistExpiresAt: Date.now() + 60000,
        grantActionsRemaining: 1,
        kernel: { state: "unsupported", supported: false, degraded: false, reason: "generic-host" },
      },
    };
  };
  globalThis.chrome = {
    runtime: {
      async sendMessage(msg) {
        messages.push({ msg: msg && typeof msg === "object" ? JSON.parse(JSON.stringify(msg)) : msg, senderUrl: location.href, at: Date.now() });
        if (!msg || typeof msg !== "object") return { attached: false };
        switch (msg.kind) {
          case "get_status":
          case "input_status":
            return statusFor(msg);
          case "grant_input":
            return {
              spaceId: msg.spaceId,
              mode: "assist",
              tabId: 11,
              grant: { token: "mocktok…", actions: 1, expiresAt: Date.now() + 60000 },
            };
          case "human_presence":
            return {
              spaceId: msg.spaceId, tabId: 11, mode: "assist", ownership: "agent",
              changed: true, scheduled: false, source: "popup:user", debounceMs: 500,
            };
          case "ensure_visible":
            return { presented: true, tabId: 11, windowId: 2, state: "normal", focused: false, managedMode: false };
          default:
            return { attached: false };
        }
      },
      getURL(relative) { return new URL(relative, location.href).href; },
      async openOptionsPage() {},
    },
    storage: {
      local: {
        async get() { return {}; },
        async set() {},
      },
    },
  };
})();
`;

const SELFTEST_JS = `
(() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const byId = (id) => document.getElementById(id);
  const waitFor = async (fn, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = fn();
      if (value) return value;
      await sleep(25);
    }
    return undefined;
  };
  (async () => {
    const result = { pass: false, checks: {} };
    try {
      const select = byId("space-select");
      result.checks.options = !!(await waitFor(() => select.querySelector('option[value="space-test"]')));
      // 自动选择来自 mock SW 的 target=space-auto。
      result.checks.autoSelected = select.value === "space-auto";

      // A1 回归路径：只改 select.value，不派发 change；再等一次 1s 轮询
      // （mock 从第二次 get_status 起反转 option 顺序，强制重建 select）。
      select.value = "space-test";
      await sleep(1200);
      result.checks.valueSurvivedPoll = select.value === "space-test";
      const grantButton = byId("grant-input");
      result.checks.enabled = grantButton.disabled === false;
      grantButton.click();
      result.checks.busySet = grantButton.dataset.busy === "true";

      await waitFor(() => byId("input-toast").dataset.ok === "true");
      const toast = byId("input-toast");
      result.checks.toastOk = toast.dataset.ok === "true";
      result.checks.toastCodeEmpty = toast.dataset.code === "";
      result.checks.toastAction = toast.dataset.action;
      result.checks.toastSeq = toast.dataset.seq;
      result.checks.busyCleared = !grantButton.dataset.busy;
      result.checks.mode = byId("input-mode").textContent;
      result.checks.grant = byId("input-grant").textContent;

      const messages = globalThis.__bpPopupTestMessages || [];
      const grants = messages.filter((m) => m.msg && m.msg.kind === "grant_input");
      result.checks.grantMessage = grants[grants.length - 1] || null;
      result.checks.grantSpace = result.checks.grantMessage && result.checks.grantMessage.msg.spaceId;
      result.checks.senderIsPopup = messages.length > 0 && messages.every(
        (m) => typeof m.senderUrl === "string" && m.senderUrl.indexOf("/popup/index.html") >= 0,
      );

      // 正常路径：change 事件 + human_presence，确认目标随下拉框变化。
      select.value = "space-auto";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(50);
      byId("human-presence").click();
      await waitFor(
        () => byId("input-toast").dataset.action === "human_presence" && byId("input-toast").dataset.ok === "true",
      );
      const toast2 = byId("input-toast");
      result.checks.presenceOk = toast2.dataset.ok === "true";
      const presences = (globalThis.__bpPopupTestMessages || []).filter(
        (m) => m.msg && m.msg.kind === "human_presence",
      );
      result.checks.presenceMessage = presences[presences.length - 1] || null;
      result.checks.presenceSpace = result.checks.presenceMessage && result.checks.presenceMessage.msg.spaceId;

      result.pass = [
        result.checks.options,
        result.checks.autoSelected,
        result.checks.valueSurvivedPoll,
        result.checks.enabled,
        result.checks.busySet,
        result.checks.toastOk,
        result.checks.toastCodeEmpty,
        result.checks.toastAction === "grant_input",
        result.checks.busyCleared,
        /ASSIST/.test(result.checks.mode || ""),
        /1 次/.test(result.checks.grant || ""),
        result.checks.grantSpace === "space-test",
        result.checks.senderIsPopup,
        result.checks.presenceOk,
        result.checks.presenceSpace === "space-auto",
      ].every(Boolean);
    } catch (error) {
      result.error = String((error && error.stack) || error);
    }
    const pre = document.createElement("pre");
    pre.id = "selftest-json";
    pre.textContent = JSON.stringify(result);
    document.body.appendChild(pre);
    document.title = result.pass ? "SELFTEST_PASS" : "SELFTEST_FAIL";
  })();
})();
`;

function runChrome(chrome, url, profileDir, timeoutMs = 45000) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--user-data-dir=" + profileDir,
    "--virtual-time-budget=15000",
    "--run-all-compositor-stages-before-draw",
    "--dump-dom",
    url,
  ];
  return new Promise((resolve) => {
    const child = spawn(chrome, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) {
        // 只清理自己启动的进程树，不按镜像名结束任何进程。
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        try { child.kill(); } catch { /* ignore */ }
      }
      resolve({ code: child.exitCode, stdout, stderr, reason });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      stderr += String(error);
      finish("spawn-error");
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, reason: "exit" });
      }
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(distPopup, "index.js"))) {
    throw new Error("dist/popup/index.js 不存在：先运行 npm run build（test:popup-ui 会自动构建）");
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error("SKIP popup-ui-headless: 未找到 Chrome（可用 BP_CHROME 指定）");
    process.exitCode = 0;
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-popup-ui-"));
  try {
    const { url } = setupPage(tempDir);
    const profileDir = path.join(tempDir, "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    const run = await runChrome(chrome, url, profileDir);
    const match = run.stdout.match(/<pre id="selftest-json">([\s\S]*?)<\/pre>/);
    if (!match) {
      console.error("popup-ui-headless: 未找到 selftest 结果（reason=" + run.reason + ", code=" + run.code + "）");
      console.error("stdout tail:\n" + run.stdout.slice(-3000));
      console.error("stderr tail:\n" + run.stderr.slice(-3000));
      process.exitCode = 1;
      return;
    }
    const decoded = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const result = JSON.parse(decoded);
    console.log("popup-ui-headless raw:", JSON.stringify(result, null, 2));
    assert.equal(result.checks.options, true, "space-select 应出现 space-test");
    assert.equal(result.checks.autoSelected, true, "初始应自动选中 SW target=space-auto");
    assert.equal(result.checks.valueSurvivedPoll, true, "1s 轮询重建 option 后 select.value 必须保留");
    assert.equal(result.checks.enabled, true, "点击前 grant 按钮必须可用");
    assert.equal(result.checks.busySet, true, "点击后按钮必须立即进入 data-busy");
    assert.equal(result.checks.toastOk, true, "#input-toast data-ok 应为 true");
    assert.equal(result.checks.toastCodeEmpty, true, "成功时 #input-toast data-code 必须为空字符串");
    assert.equal(result.checks.toastAction, "grant_input");
    assert.equal(result.checks.busyCleared, true, "完成后必须清除 data-busy");
    assert.match(result.checks.mode || "", /ASSIST/);
    assert.match(result.checks.grant || "", /1 次/);
    assert.equal(result.checks.grantSpace, "space-test", "只设置 select.value 时也必须使用该 space");
    assert.equal(result.checks.senderIsPopup, true, "消息必须来自 popup 页面");
    assert.equal(result.checks.presenceOk, true);
    assert.equal(result.checks.presenceSpace, "space-auto", "change 后 human_presence 必须使用新选择");
    assert.equal(result.pass, true, "selftest 自检失败：" + JSON.stringify(result));
    console.log("PASS popup-ui-headless: select.value + #grant-input sends the selected space, SW actions:1, UI signal stable");
    console.log("PASS popup-ui-headless: change event + #human-presence follows the new selection");
  } finally {
    // Chrome 可能短暂占用文件；重试清理，失败不覆盖测试结论。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}

main().catch((error) => {
  console.error("popup-ui-headless failed:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
