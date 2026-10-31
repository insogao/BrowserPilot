// P3 真实 Browser/OOPIF 输入仲裁 E2E（Windows，可见窗口，产品链路）。
//
// 目标：在**真实产品链路**上取证，而不是独立 CDP harness：
//   打补丁的 Browser CLI Chrome（D:\c\src\out\WinDev\chrome.exe，可见窗口）
//     → 扩展 SW → connectNative → 本次构建的 native host exe → host TCP 协议
//     → chrome.debugger → 真实 Input.dispatch* / Runtime.evaluate。
//   「真实人类输入」用 Win32 消息注入到 Chrome_RenderWidgetHostHWND（见下），
//   它与 OS 输入走同一条 aura 路径、不带 kFromDebugger，因此在内核眼里就是人类输入；
//   它不是硬件输入，细节限制见 docs/input-arbitration-e2e-matrix-2026-10-28.md。
//
// 覆盖（能跑的必须真实跑，不能跑的显式 blocked，绝不伪造 PASS）：
//   baseline        无 --enable-features 时：完整 AI 输入序列全部落地（Feature off 基线）
//   baseline(ON)    --enable-features=InputOwnershipEnforcement：默认 ASSIST 无 grant → 全部 CDP
//                   输入被内核丢弃；Runtime.evaluate 仍可改 DOM（记录为仲裁边界）
//   human           ownership=user（handoff_space）时：全部输入类命令 INPUT_HUMAN_OWNED，
//                   DOM 不变；人类输入不被锁；claim_space 后恢复
//   takeover        AI 操作过程中注入人类输入；人类输入不受锁；显式 handoff 后 AI 立刻被拒
//   shapes          连续文本(type/fill)、拖拽(多 move + release)、按键组合(Ctrl+A)、
//                   中文 IME（Input.insertText / ImeCommitText 路径）；真实 TSF/搜狗 marked blocked
//   oopif           跨站 iframe（127.0.0.1 vs 127.0.0.2 + --site-per-process）：OOPIF target 证据、
//                   AI/人类输入在主帧与子帧的计数分离、Feature on 时子帧同样被仲裁
//   multi           两个窗口，一个 HUMAN 一个 AI，互不干扰；前台/z-order 不变
//   assist          ASSIST 无 grant / grant 一次性消费 / 过期 / 用尽 / 取消 / session detach /
//                   跨会话注入 —— 依赖 Agent K 的产品 API（chrome.browserCli.inputOwnership），
//                   当前构建只有 getCapabilities，因此 blocked
//   kernel          HUMAN 模式、内核 grant 表、跨 CDP session 隔离 —— blocked（同上 + J 的 patch 028 修订）
//
// 运行：
//   node scripts/test-input-arbitration-e2e.mjs --matrix          # 只打印用例矩阵与前置条件（不启动浏览器）
//   node scripts/test-input-arbitration-e2e.mjs --dry-run         # 同 --matrix
//   node scripts/test-input-arbitration-e2e.mjs                   # 全部可跑用例（off + on 两个会话）
//   node scripts/test-input-arbitration-e2e.mjs --stage=baseline  # 只跑基线（off + on）
//   node scripts/test-input-arbitration-e2e.mjs --stage=human,shapes --feature=off
//   node scripts/test-input-arbitration-e2e.mjs --no-build        # 复用现有 dist / host exe
//   node scripts/test-input-arbitration-e2e.mjs --keep-open       # 失败时保留浏览器（调试用，仍会清理 host/注册表）
//
// 报告：D:\c\logs\input-arbitration-e2e-<timestamp>.json（另有 .e2e-tmp/<run>/report.json）
// 进程清理只走 scripts/lib/test-process.mjs 的验证式接口；禁止按镜像名/进程名的批量清理。
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey, findNewestHostExe } from "./lib/host-manifest.mjs";
import {
  describeRecord,
  isAlive,
  launchTestProcess,
  stopTestProcess,
  stopVerifiedPid,
} from "./lib/test-process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(root, "dist");
const FIXTURE_MAIN = path.join(root, "tests", "fixtures", "input-arbitration-main.html");
const FIXTURE_FRAME = path.join(root, "tests", "fixtures", "input-arbitration-frame.html");
const FIXTURE_IME = path.join(root, "tests", "fixtures", "ime-inputs.html");
const REGISTER_PS1 = path.join(root, "native-host", "register.ps1");
const UNREGISTER_PS1 = path.join(root, "native-host", "unregister.ps1");
const HOST_NAME = "com.browserpilot.browseragent";
const REGISTRY_KEY = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME;
const CHROME = process.env.BROWSERPILOT_PATCHED_CHROME || "D:\\c\\src\\out\\WinDev\\chrome.exe";
const CHROME_OUT = path.dirname(CHROME);
const LOG_DIR = "D:\\c\\logs";
const FEATURE = "InputOwnershipEnforcement";

const argv = process.argv.slice(2);
const MATRIX = argv.includes("--matrix") || argv.includes("--dry-run");
const NO_BUILD = argv.includes("--no-build");
const KEEP_OPEN = argv.includes("--keep-open");
const STAGE_ARG = (argv.find((a) => a.startsWith("--stage=")) || "").slice("--stage=".length).trim();
const STAGES = new Set((STAGE_ARG || "all").split(",").map((s) => s.trim()).filter(Boolean));
const FEATURE_ARG = (argv.find((a) => a.startsWith("--feature=")) || "").slice("--feature=".length).trim();
const FEATURE_FILTER = new Set((FEATURE_ARG || "off,on,on-visible").split(",").map((s) => s.trim()).filter(Boolean));
const SESSION_FEATURES = ["off", "on", "on-visible"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const runToken = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

// ---------------------------------------------------------------- reporting
let passed = 0;
let failed = 0;
const failures = [];
const checkLog = [];
function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  if (ok) passed++;
  else {
    failed++;
    failures.push(name);
  }
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  checkLog.push({ name, ok, detail: String(text).slice(0, 3000) });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (ok || !text ? "" : " :: " + String(text).slice(0, 1500)));
  return ok;
}
function mustCheck(name, condition, detail = "") {
  if (!check(name, condition, detail)) throw new Error("check failed: " + name);
}

const runId = nowIso().replace(/[:.]/g, "-");
const runDir = path.join(root, ".e2e-tmp", "input-arbitration-" + runId);
const artifactsDir = path.join(runDir, "artifacts");
const backupDir = path.join(runDir, "registry-backup");
fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const report = {
  test: "browsercli-input-arbitration-e2e",
  startedAt: nowIso(),
  finishedAt: null,
  verdict: "BLOCKED",
  blockedReason: null,
  runId,
  runToken,
  runDir,
  mode: MATRIX ? "matrix" : "run",
  stages: [...STAGES],
  featureFilter: [...FEATURE_FILTER],
  env: {
    platform: process.platform,
    node: process.version,
    chromePath: CHROME,
    chromeMtime: null,
    contentDll: null,
    contentDllMtime: null,
    contentDllFeature: null,
    chromeDll: null,
    chromeDllApi: null,
    dist: DIST,
    fixtures: { main: FIXTURE_MAIN, frame: FIXTURE_FRAME },
    hostExe: null,
    hostExeMtime: null,
    extensionId: null,
    screen: null,
    foregroundBeforeLaunch: null,
  },
  registration: null,
  sessions: [],
  cases: [],
  blocked: [],
  p0Regressions: [],
  notes: [],
  cleanup: null,
  checks: null,
};

function saveArtifact(name, data) {
  const file = path.join(artifactsDir, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", "utf8");
  return file;
}

// ---------------------------------------------------------------- binary probe
/** 在二进制里找 ASCII 串（分块，不整文件读入内存）。 */
function binaryHas(file, needle) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = 8 * 1024 * 1024;
    const overlap = Math.max(needle.length, 64);
    let tail = Buffer.alloc(0);
    for (let offset = 0; offset < size; offset += chunk) {
      const length = Math.min(chunk, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, offset);
      const haystack = Buffer.concat([tail, buffer]);
      if (haystack.indexOf(needle) >= 0) return true;
      tail = haystack.subarray(Math.max(0, haystack.length - overlap));
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function probeBinaries() {
  const contentDll = path.join(CHROME_OUT, "content.dll");
  const chromeDll = path.join(CHROME_OUT, "chrome.dll");
  const target = fs.existsSync(contentDll) ? contentDll : chromeDll;
  report.env.contentDll = fs.existsSync(contentDll) ? contentDll : null;
  report.env.contentDllMtime = fs.existsSync(target) ? new Date(fs.statSync(target).mtimeMs).toISOString() : null;
  // 组件构建把 content 放进 content.dll；静态构建则全部在 chrome.dll。
  report.env.contentDllFeature = binaryHas(target, FEATURE);
  report.env.chromeDll = fs.existsSync(chromeDll) ? chromeDll : null;
  // K 的产品 API：只有在受信扩展 API 被编译进去时才会出现这个函数名。
  // 生产 API（patch 029）按 namespace 全名注册 ExtensionFunction：
  // "browserCli.inputOwnership.setOwnership" / ".grantInput" / ...，因此二进制里能
  // 直接匹配到 "browserCli.inputOwnership"。"browserCli.setInputOwnership" 是早期
  // 设计的扁平命名，仅作为兼容回退保留。
  // patch 029 修订把命名空间改成顶层 browserCliInputOwnership（避开父 feature browserCli 的层级冲突）。
  const hasNamespace = fs.existsSync(chromeDll) ? binaryHas(chromeDll, "browserCliInputOwnership") : null;
  const hasLegacyNested = fs.existsSync(chromeDll) ? binaryHas(chromeDll, "browserCli.inputOwnership") : null;
  const hasFlatName = fs.existsSync(chromeDll) ? binaryHas(chromeDll, "browserCli.setInputOwnership") : null;
  report.env.chromeDllApi = fs.existsSync(chromeDll) ? (hasNamespace === true || hasFlatName === true) : null;
  report.env.chromeDllApiDetail = fs.existsSync(chromeDll)
    ? {
        namespace: hasNamespace,
        legacyNested: hasLegacyNested,
        flatName: hasFlatName,
        setOwnership: binaryHas(chromeDll, "setOwnership"),
        grantInput: binaryHas(chromeDll, "grantInput"),
        beginInputCommand: binaryHas(chromeDll, "beginInputCommand"),
        heartbeat: binaryHas(chromeDll, "heartbeat"),
      }
    : null;
  try {
    report.env.chromeMtime = new Date(fs.statSync(CHROME).mtimeMs).toISOString();
  } catch {
    report.env.chromeMtime = null;
  }
}

function featureAvailable() {
  return report.env.contentDllFeature === true;
}
const BLOCK_ASSIST_ENTRY = {
  code: "assist-internal-entry-missing",
  deps: ["产品级 human_presence / grant_input 入口（popup 或内核事件桥，需 markInternalCommand）"],
  reason:
    "grant_input / human_presence 只接受 SW 进程内 markInternalCommand 打标的命令；TCP native host 入口" +
    "（唯一可脚本化的产品入口）没有该标记，任何 Agent 调用都会被 INPUT_IDENTITY_UNTRUSTED/POSSESSION 拒绝。" +
    "因此扩展侧 ASSIST 路径在真实产品链路上不可达，只有离线/浏览器 in-process 测试覆盖。",
};
const BLOCK_REAL_IME = {
  code: "real-ime-not-automatable",
  deps: ["真实 TSF/搜狗 IME + 系统输入法状态"],
  reason:
    "本 harness 不切换/污染用户输入法状态，也不使用脚本 dispatchEvent 冒充。已覆盖 CDP Input.insertText" +
    "（内核 ImeCommitText 提交路径）；真实 TSF/IME 组合输入未覆盖。",
};

/**
 * case 定义：
 *   id / title / stage / feature: "off"|"on"|"both"|null(blocked)
 *   blocked: {code,deps,reason} 时永远不会执行
 *   run(ctx) 执行并 check()
 */
const CASES = [
  // ------------------------------------------------------------ HUMAN（扩展层，Feature off）
  {
    id: "H1",
    title: "HUMAN(handoff_space)：所有 AI 输入类命令被拒，DOM 计数/文本/滚动不变",
    stage: "human",
    feature: "off",
    async run(ctx) {
      const s = ctx.spaces.main;
      await ctx.resetMain();
      mustCheck("H1 初始 input_status.mode=ai", (await ctx.inputStatus("main")).mode === "ai");
      const base = await ctx.probe("main");
      const clickOk = await ctx.ai("main", "click", { selector: "#btn", cursor: false });
      await sleep(250);
      const afterAi = await ctx.probe("main");
      check("H1 handoff 前 AI click 确实落地（对照）", clickOk.ok && afterAi.clicks === base.clicks + 1, JSON.stringify({ clickOk, base: base.clicks, after: afterAi.clicks }));

      mustCheck("H1 handoff_space 成功", await ctx.handoff("main"));
      const status = await ctx.inputStatus("main");
      check("H1 handoff 后 mode=human / ownership=user", status.mode === "human" && status.ownership === "user", JSON.stringify(status));

      const before = await ctx.probe("main");
      const commands = [
        ["click", { selector: "#btn", cursor: false }],
        ["dblclick", { selector: "#btn", cursor: false }],
        ["hover", { selector: "#btn", cursor: false }],
        ["drag", { from: { x: 100, y: 220 }, to: { x: 250, y: 220 }, cursor: false }],
        ["wheel", { selector: "#scroll", deltaY: -200, cursor: false }],
        ["down", { selector: "#btn", cursor: false }],
        ["up", { selector: "#btn", cursor: false }],
        ["press", { key: "Enter" }],
        ["type", { text: "should-not-appear" }],
        ["fill", { selector: "#input", value: "should-not-appear" }],
        ["js", { expression: "window.__jsRuns = (window.__jsRuns||0)+1" }],
        ["tab_cdp_call", { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 400, y: 100, button: "left", buttons: 1, clickCount: 1 } }],
      ];
      const results = [];
      for (const [name, args] of commands) {
        const r = await ctx.ai("main", name, args);
        results.push({ name, ok: r.ok, errorCode: r.errorCode || null, error: r.error ? String(r.error).slice(0, 200) : null });
      }
      await sleep(300);
      const after = await ctx.probe("main");

      const allRejected = results.every((r) => r.ok === false && r.errorCode === "INPUT_HUMAN_OWNED");
      check("H1 12 个输入类命令全部 INPUT_HUMAN_OWNED", allRejected, JSON.stringify(results));
      check(
        "H1 HUMAN 下 DOM 完全不变（clicks/input/scroll/jsRuns/child）",
        after.clicks === before.clicks &&
          after.inputValue === before.inputValue &&
          after.scrollTop === before.scrollTop &&
          after.jsRuns === before.jsRuns &&
          after.childClicks === before.childClicks,
        JSON.stringify({
          clicks: [before.clicks, after.clicks],
          inputValue: [before.inputValue, after.inputValue],
          scrollTop: [before.scrollTop, after.scrollTop],
          jsRuns: [before.jsRuns, after.jsRuns],
          childClicks: [before.childClicks, after.childClicks],
        }),
      );
      check("H1 页面没有收到任何新的受信鼠标事件", after.events.length === before.events.length, JSON.stringify({ before: before.events, after: after.events }));
      ctx.record("H1", { status, commandResults: results, before, after });
    },
  },
  {
    id: "H2",
    title: "HUMAN：真实人类输入不被锁（鼠标点击落地，AI 仍被拒）",
    stage: "human",
    feature: "off",
    async run(ctx) {
      // 承接 H1 的 HUMAN 状态：若 H1 失败的收尾已 claim，这里重新 handoff。
      if ((await ctx.inputStatus("main")).mode !== "human") {
        mustCheck("H2 重新 handoff_space", await ctx.handoff("main"));
      }
      const before = await ctx.probe("main");
      const human = await ctx.humanClick("main", before.rects.btn);
      const after = await ctx.probe("main");
      check("H2 HUMAN 下人类点击落地（DOM clicks +1）", after.clicks === before.clicks + 1, JSON.stringify({ before: before.clicks, after: after.clicks, human }));
      check("H2 人类点击是受信事件（isTrusted=true）", (after.events.slice(-3) || []).some((e) => e.type === "click" && e.trusted === true), JSON.stringify(after.events.slice(-4)));

      const ai = await ctx.ai("main", "click", { selector: "#btn", cursor: false });
      const afterAi = await ctx.probe("main");
      check("H2 HUMAN 下 AI click 仍被拒且不改变 DOM", ai.ok === false && ai.errorCode === "INPUT_HUMAN_OWNED" && afterAi.clicks === after.clicks, JSON.stringify({ ai, clicks: afterAi.clicks }));

      const human2 = await ctx.humanClick("main", before.rects.input);
      await sleep(120);
      const typed = await ctx.humanType("main", "humankeyboard");
      const afterKey = await ctx.probe("main");
      check("H2 HUMAN 下人类键盘输入落地（输入框值改变）", afterKey.inputValue === "humankeyboard", JSON.stringify({ value: afterKey.inputValue, human2, typed }));
      ctx.record("H2", { before, human, after, human2, typed, ai, afterKey });
    },
  },
  {
    id: "H3",
    title: "claim_space 后 AI 输入恢复（HUMAN -> AI）",
    stage: "human",
    feature: "off",
    async run(ctx) {
      mustCheck("H3 claim_space 成功", await ctx.claim("main"));
      const status = await ctx.inputStatus("main");
      check("H3 claim 后 mode=ai / ownership=agent", status.mode === "ai" && status.ownership === "agent", JSON.stringify(status));
      const before = await ctx.probe("main");
      const r = await ctx.ai("main", "click", { selector: "#btn", cursor: false });
      await sleep(250);
      const after = await ctx.probe("main");
      check("H3 claim 后 AI click 落地", r.ok === true && after.clicks === before.clicks + 1, JSON.stringify({ r, before: before.clicks, after: after.clicks }));
      ctx.record("H3", { status, before, after });
    },
  },
  {
    id: "H4",
    title: "人类接管：AI 操作进行中注入人类输入 -> 人类不被锁；handoff 后 AI 立刻被拒",
    stage: "takeover",
    feature: "off",
    async run(ctx) {
      await ctx.resetMain();
      // AI 长操作（逐字 type，每字 120ms），期间注入人类点击。
      const typePromise = ctx
        .ai("main", "type", { text: "ai-typing-while-human-arrives", typingDelayMs: 120, cursor: false })
        .catch((error) => ({ ok: false, error: String(error) }));
      await sleep(350);
      const mid = await ctx.probe("main");
      const human = await ctx.humanClick("main", mid.rects.btn);
      const typeResult = await typePromise;
      await sleep(200);
      const after = await ctx.probe("main");
      check("H4 AI 长操作期间人类点击落地（不被锁）", after.clicks === mid.clicks + 1, JSON.stringify({ midClicks: mid.clicks, afterClicks: after.clicks, human }));
      check("H4 AI 长操作本身完成（type 报告成功）", typeResult.ok === true, JSON.stringify(typeResult));

      // 人类显式接管（产品入口：handoff_space；自动 presence 依赖 K 的内核事件桥）
      mustCheck("H4 handoff_space 成功", await ctx.handoff("main"));
      const rejected = await ctx.ai("main", "click", { selector: "#btn", cursor: false });
      const afterReject = await ctx.probe("main");
      const humanAfter = await ctx.humanClick("main", after.rects.btn);
      const afterHuman = await ctx.probe("main");
      check("H4 接管后后续 AI click 立即被拒（INPUT_HUMAN_OWNED）", rejected.ok === false && rejected.errorCode === "INPUT_HUMAN_OWNED", JSON.stringify(rejected));
      check("H4 接管后 AI 未改变 DOM，人类点击仍然落地", afterReject.clicks === after.clicks && afterHuman.clicks === after.clicks + 1, JSON.stringify({ after: after.clicks, afterReject: afterReject.clicks, afterHuman: afterHuman.clicks, humanAfter }));
      ctx.record("H4", { typeResult, mid, after, rejected, afterHuman });
    },
  },

  // ------------------------------------------------------------ ASSIST（blocked）
  {
    id: "A1",
    title: "ASSIST 用户入口：popup human_presence + #grant-input，一条命令成功、第二条拒绝",
    stage: "assist",
    feature: "on",
    async run(ctx) {
      const key = "a1";
      await ctx.openFresh(key);
      const spaceId = ctx.spaces[key].spaceId;
      if ((await ctx.inputStatus(key)).mode !== "ai") await ctx.claim(key);

      const status0 = await ctx.popupSend("input_status", spaceId);
      check("A1 popup input_status 返回 ai", status0?.response?.input?.mode === "ai", JSON.stringify(status0).slice(0, 700));

      const ctrl = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      await sleep(400);
      const afterCtrl = await ctx.probe(key);
      check("A1 对照：AI 模式 click 落地", ctrl.ok === true && afterCtrl.clicks === 1, JSON.stringify({ ctrl, clicks: afterCtrl.clicks }));

      const presence = await ctx.popupSend("human_presence", spaceId);
      await sleep(400);
      const statusAssist = await ctx.popupSend("input_status", spaceId);
      check(
        "A1 popup human_presence 进入 ASSIST 且 ownership 仍为 agent",
        presence?.ok === true &&
          (presence?.response?.mode === "assist" || statusAssist?.response?.input?.mode === "assist") &&
          statusAssist?.response?.input?.ownership === "agent",
        JSON.stringify({ presence, statusAssist }).slice(0, 900),
      );

      const noGrant = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      await sleep(400);
      const afterNoGrant = await ctx.probe(key);
      check(
        "A1 ASSIST 无 grant → INPUT_ASSIST_REQUIRES_GRANT 且 DOM 不变",
        noGrant.ok === false && noGrant.errorCode === "INPUT_ASSIST_REQUIRES_GRANT" && afterNoGrant.clicks === afterCtrl.clicks,
        JSON.stringify({ noGrant, clicks: afterNoGrant.clicks }),
      );

      const selected = await ctx.popupSelectSpace(spaceId);
      await sleep(700); // 等 popup 的 refresh() 重新渲染并启用按钮
      let button = await ctx.popupClick("#grant-input");
      if (button?.disabled === true) {
        await sleep(700);
        button = await ctx.popupClick("#grant-input");
      }
      await sleep(900);
      const toast = await ctx.popupText("input-toast");
      const statusGrant = await ctx.popupSend("input_status", spaceId);
      check(
        "A1 popup #space-select + #grant-input 按钮接线成功（grant 出现）",
        selected?.ok === true && button?.clicked === true && statusGrant?.response?.input?.grant?.actions === 1,
        JSON.stringify({ selected, button, toast, statusGrant }).slice(0, 900),
      );

      const click1 = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      await sleep(400);
      const s1 = await ctx.probe(key);
      check("A1 用户授权后第 1 条 click 落地", click1.ok === true && s1.clicks === afterNoGrant.clicks + 1, JSON.stringify({ click1, clicks: s1.clicks }));

      const click2 = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      await sleep(400);
      const s2 = await ctx.probe(key);
      check(
        "A1 第 2 条 click 被拒（grant 用尽，一次授权一条命令）",
        click2.ok === false && click2.errorCode === "INPUT_ASSIST_REQUIRES_GRANT" && s2.clicks === s1.clicks,
        JSON.stringify({ click2, clicks: [s1.clicks, s2.clicks] }),
      );
      ctx.record("A1", { status0, presence, statusAssist, noGrant, selected, button, toast, statusGrant, click1, click2, clicks: [afterCtrl.clicks, s2.clicks] });
    },
  },
  {
    id: "A2",
    title: "ASSIST 用户入口（重复验证）：直接 sendMessage grant_input，一次性消费",
    stage: "assist",
    feature: "on",
    async run(ctx) {
      const key = "a2";
      await ctx.openFresh(key);
      const spaceId = ctx.spaces[key].spaceId;
      if ((await ctx.inputStatus(key)).mode !== "ai") await ctx.claim(key);
      await ctx.popupSend("human_presence", spaceId);
      await sleep(300);
      const noGrant = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      check("A2 ASSIST 无 grant 被拒", noGrant.ok === false && noGrant.errorCode === "INPUT_ASSIST_REQUIRES_GRANT", JSON.stringify(noGrant));
      const grant = await ctx.popupSend("grant_input", spaceId);
      check("A2 popup grant_input 返回 actions=1", grant?.response?.grant?.actions === 1, JSON.stringify(grant).slice(0, 700));
      const click1 = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      await sleep(400);
      const s1 = await ctx.probe(key);
      check("A2 授权后 click 落地", click1.ok === true && s1.clicks === 1, JSON.stringify({ click1, clicks: s1.clicks }));
      const afterUse = await ctx.popupSend("input_status", spaceId);
      check("A2 消费后 input_status 不再有可用 grant", afterUse?.response?.input?.grantActionsRemaining === null || afterUse?.response?.input?.grant?.actions === undefined, JSON.stringify(afterUse).slice(0, 700));
      const click2 = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      await sleep(300);
      const s2 = await ctx.probe(key);
      check("A2 第 2 条 click 被拒", click2.ok === false && click2.errorCode === "INPUT_ASSIST_REQUIRES_GRANT" && s2.clicks === s1.clicks, JSON.stringify({ click2, clicks: s2.clicks }));
      ctx.record("A2", { noGrant, grant, click1, click2, clicks: [s1.clicks, s2.clicks], afterUse });
    },
  },
  {
    id: "A3",
    title: "ASSIST 用户入口：取消（新 presence 清 grant）/ ownership 变更 / 60s 过期",
    stage: "assist",
    feature: "on",
    async run(ctx) {
      const key = "a3";
      await ctx.openFresh(key);
      const spaceId = ctx.spaces[key].spaceId;
      if ((await ctx.inputStatus(key)).mode !== "ai") await ctx.claim(key);
      await ctx.popupSend("human_presence", spaceId);
      await sleep(300);

      // 1) 新 presence 清掉未使用的 grant
      const g1 = await ctx.popupSend("grant_input", spaceId);
      await sleep(250);
      const p2 = await ctx.popupSend("human_presence", spaceId);
      await sleep(250);
      const afterPresenceGrant = await ctx.popupSend("input_status", spaceId);
      const clickCancel = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      check(
        "A3 新的 human_presence 清掉未使用 grant → click 被拒",
        g1?.response?.grant?.actions === 1 &&
          p2?.ok === true &&
          (afterPresenceGrant?.response?.input?.grantActionsRemaining === null || afterPresenceGrant?.response?.input?.grant === null) &&
          clickCancel.ok === false &&
          clickCancel.errorCode === "INPUT_ASSIST_REQUIRES_GRANT",
        JSON.stringify({ g1, p2, afterPresenceGrant, clickCancel }).slice(0, 1000),
      );

      // 2) ownership 变更（handoff）清 assist/grant，命令层 HUMAN 拒绝
      const g2 = await ctx.popupSend("grant_input", spaceId);
      await sleep(200);
      mustCheck("A3 handoff_space", await ctx.handoff(key));
      const clickHuman = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      check(
        "A3 ownership 变更 → assist/grant 清空，AI click 变成 INPUT_HUMAN_OWNED",
        g2?.response?.grant?.actions === 1 && clickHuman.ok === false && clickHuman.errorCode === "INPUT_HUMAN_OWNED",
        JSON.stringify({ g2, clickHuman }),
      );
      mustCheck("A3 claim_space 恢复", await ctx.claim(key));

      // 3) 用户入口 grant 的 60s 过期（popup 固定 actions=1 / 60s）
      await ctx.popupSend("human_presence", spaceId);
      await sleep(300);
      const g3 = await ctx.popupSend("grant_input", spaceId);
      const beforeExpiry = await ctx.popupSend("input_status", spaceId);
      await sleep(61000);
      // 长等待可能让 SW 休眠、native host 退出；先 poke SW 让 host 重连，再测过期。
      const channel = await ctx.ensureAgentChannel(spaceId);
      const clickExpired = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      const afterExpiry = await ctx.popupSend("input_status", spaceId);
      check(
        "A3 60s 后 grant 过期 → click 被拒（INPUT_ASSIST_REQUIRES_GRANT）",
        g3?.response?.grant?.actions === 1 && clickExpired.ok === false && clickExpired.errorCode === "INPUT_ASSIST_REQUIRES_GRANT",
        JSON.stringify({ g3, beforeExpiry, clickExpired, afterExpiry }).slice(0, 1200),
      );
      ctx.record("A3", { g1, p2, afterPresenceGrant, clickCancel, g2, clickHuman, g3, beforeExpiry, clickExpired, afterExpiry });
    },
  },
  {
    id: "A4",
    title: "ASSIST：跨客户端不能复用他人 space/grant（第二个 Agent 注入）",
    stage: "assist",
    feature: "off",
    async run(ctx) {
      await ctx.resetMain();
      if ((await ctx.inputStatus("main")).mode !== "ai") await ctx.claim("main");
      const before = await ctx.probe("main");
      // 第二个 Agent 客户端（真实 host 分配 agent:e2e-b），指向 A 的 space。
      const b = ctx.clientB;
      const cross = await b.call("click", { selector: "#btn", cursor: false }, { space: ctx.spaces.main.spaceId }).then(
        (data) => ({ ok: true, data }),
        (error) => ({ ok: false, error: String(error), errorCode: error.code }),
      );
      await sleep(250);
      const after = await ctx.probe("main");
      check("A4 第二个 Agent 对他人 space 的 click 被拒（SPACE_NOT_OWNED）", cross.ok === false && cross.errorCode === "SPACE_NOT_OWNED", JSON.stringify(cross));
      check("A4 第二客户端注入未改变 DOM", after.clicks === before.clicks, JSON.stringify({ before: before.clicks, after: after.clicks }));
      const statusB = await b.call("input_status", {}, { space: ctx.spaces.main.spaceId }).then(
        (data) => ({ ok: true, data }),
        (error) => ({ ok: false, error: String(error), errorCode: error.code }),
      );
      check("A4 第二客户端连 input_status 也不能读他人 space", statusB.ok === false && statusB.errorCode === "SPACE_NOT_OWNED", JSON.stringify(statusB));
      ctx.record("A4", { cross, statusB, before, after });
    },
  },

  // ------------------------------------------------------------ 输入形态（Feature off）
  {
    id: "S1",
    title: "输入形态：连续文本 type / fill（含中文）真正写入输入框",
    stage: "shapes",
    feature: "off",
    async run(ctx) {
      await ctx.resetMain();
      if ((await ctx.inputStatus("main")).mode !== "ai") await ctx.claim("main");
      await ctx.focusInput("main");
      const typeResult = await ctx.ai("main", "type", { text: "hello world", typingDelayMs: 10, cursor: false });
      // beacon 200ms 周期：等状态真正反映输入结果，避免读到动作之前的快照（不是放宽断言）。
      const afterType = await ctx.waitState("main", (st) => st.inputValue === "hello world", 3000);
      check("S1 type 逐字输入落地", typeResult.ok === true && afterType.inputValue === "hello world", JSON.stringify({ typeResult, value: afterType.inputValue }));

      const fillResult = await ctx.ai("main", "fill", { selector: "#input", value: "中文填充-输入仲裁" });
      const afterFill = await ctx.waitState("main", (st) => st.inputValue === "中文填充-输入仲裁", 3000);
      check("S1 fill 整体替换（中文）落地", fillResult.ok === true && afterFill.inputValue === "中文填充-输入仲裁", JSON.stringify({ fillResult, value: afterFill.inputValue }));
      check("S1 页面收到真实 input 事件", afterFill.inputEvents > afterType.inputEvents, JSON.stringify({ before: afterType.inputEvents, after: afterFill.inputEvents }));
      ctx.record("S1", { typeResult, afterType, fillResult, afterFill });
    },
  },
  {
    id: "S2",
    title: "输入形态：拖拽（mousePressed -> 多次 mouseMoved -> mouseReleased）",
    stage: "shapes",
    feature: "off",
    async run(ctx) {
      await ctx.resetMain();
      if ((await ctx.inputStatus("main")).mode !== "ai") await ctx.claim("main");
      const before = await ctx.probe("main");
      const from = { x: Math.round(before.rects.src.x + before.rects.src.w / 2), y: Math.round(before.rects.src.y + before.rects.src.h / 2) };
      const to = { x: Math.round(before.rects.dst.x + before.rects.dst.w / 2), y: Math.round(before.rects.dst.y + before.rects.dst.h / 2) };
      // 产品 drag 只发一次 move；这里先用产品命令，再用 CDP 发多次 move 覆盖「多 move + release」。
      const dragResult = await ctx.ai("main", "drag", { from, to, cursor: false });
      await sleep(250);
      const afterDrag = await ctx.probe("main");
      check(
        "S2 产品 drag 落地（down/move/up，drop 目标是 dst）",
        dragResult.ok === true && afterDrag.drag.down >= 1 && afterDrag.drag.moves >= 1 && afterDrag.drag.up >= 1 && afterDrag.drag.dstUp >= 1,
        JSON.stringify({ dragResult, drag: afterDrag.drag }),
      );
      report.notes.push(
        "发现（产品路径）：actions.ts 的 drag 发送 mouseMoved 时没有带 buttons 位，" +
          "页面里 e.buttons===1 的拖拽判定看不到“按住移动”（本次 movesDown=" + afterDrag.drag.movesDown + "）。" +
          "多 move 用例改用显式 buttons:1 的 CDP 序列验证输入投递；产品 drag 的 buttons 语义问题不在本任务修改范围（actions.ts 禁改），仅记录。",
      );

      const multi = await ctx.ai("main", "tab_cdp_call", {
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 },
      });
      for (const t of [0.25, 0.5, 0.75, 1]) {
        await ctx.ai("main", "tab_cdp_call", {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseMoved",
            x: Math.round(from.x + (to.x - from.x) * t),
            y: Math.round(from.y + (to.y - from.y) * t),
            button: "none",
            buttons: 1,
          },
        });
        await sleep(40);
      }
      await ctx.ai("main", "tab_cdp_call", {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 },
      });
      await sleep(250);
      const afterMulti = await ctx.probe("main");
      check(
        "S2 多次 move（buttons=1）+ release 全部落地",
        multi.ok === true &&
          afterMulti.drag.moves >= afterDrag.drag.moves + 4 &&
          afterMulti.drag.movesDown >= afterDrag.drag.movesDown + 4 &&
          afterMulti.drag.dstUp === afterDrag.drag.dstUp + 1,
        JSON.stringify({ multi, drag: afterMulti.drag, before: afterDrag.drag }),
      );
      ctx.record("S2", { from, to, dragResult, afterDrag, afterMulti });
    },
  },
  {
    id: "S3",
    title: "输入形态：按键组合 Ctrl+A（页面内组合）",
    stage: "shapes",
    feature: "off",
    async run(ctx) {
      await ctx.resetMain();
      if ((await ctx.inputStatus("main")).mode !== "ai") await ctx.claim("main");
      await ctx.focusInput("main");
      await ctx.ai("main", "fill", { selector: "#input", value: "combo-selection-text" });
      // 该窗口不是前台窗口（测试不抢前台），Blink 会丢弃未聚焦 frame 的键盘事件；
      // 用 DevTools 的 focus emulation 让 renderer 认为页面已聚焦。它只影响页面焦点状态，
      // 不改变 OS 前台窗口，也不参与输入仲裁。
      const focusEmu = await ctx.ai("main", "tab_cdp_call", { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } });
      const down = await ctx.ai("main", "tab_cdp_call", {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] },
      });
      const up = await ctx.ai("main", "tab_cdp_call", {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
      });
      await sleep(200);
      await ctx.ai("main", "tab_cdp_call", { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } });
      const after = await ctx.probe("main");
      const ctrlA = after.keys.filter((k) => k.key === "a" && k.ctrl === true);
      check("S3 页面收到带 ctrl 的 a 键（页面内组合成立）", down.ok === true && up.ok === true && ctrlA.length >= 1, JSON.stringify({ down, up, keys: after.keys }));
      check(
        "S3 选区覆盖输入框全文（编辑命令路径）",
        after.inputSelection &&
          after.inputSelection.start === 0 &&
          after.inputSelection.end === after.inputSelection.length &&
          after.inputSelection.length === "combo-selection-text".length,
        JSON.stringify({ inputSelection: after.inputSelection, value: after.inputValue }),
      );
      ctx.record("S3", { focusEmu, down, up, after });
      report.notes.push("浏览器 UI 快捷键（Ctrl+L/T/W/F5）按设计 §4.1/决定 6 不纳入页面输入权，本用例不触发，避免改变窗口/导航。");
    },
  },
  {
    id: "S4",
    title: "输入形态：中文 IME 提交路径（Input.insertText / ImeCommitText）",
    stage: "shapes",
    feature: "off",
    async run(ctx) {
      await ctx.resetMain();
      if ((await ctx.inputStatus("main")).mode !== "ai") await ctx.claim("main");
      await ctx.focusInput("main");
      const r = await ctx.ai("main", "tab_cdp_call", { method: "Input.insertText", params: { text: "输入仲裁测试" } });
      await sleep(250);
      const after = await ctx.probe("main");
      check("S4 Input.insertText（中文）提交到焦点输入框", r.ok === true && after.inputValue === "输入仲裁测试", JSON.stringify({ r, value: after.inputValue }));
      ctx.record("S4", { r, after });
    },
  },
  {
    id: "S5",
    title: "输入形态：真实 TSF/搜狗 IME 组合输入",
    stage: "shapes",
    blocked: BLOCK_REAL_IME,
  },
  {
    id: "S6",
    title: "输入形态（Feature on）：type/fill/键/拖拽全部被内核丢弃",
    stage: "shapes",
    feature: "on",
    async run(ctx) {
      await ctx.resetMain();
      // 扩展会自动把 kernel 同步成 ai；这里显式切到 ASSIST（心跳 10s 内会修正，短窗口内验证）
      const assist = await ctx.bumpMode("main", "assist");
      check("S6 前置：内核切到 ASSIST（短窗口）", assist.accepted === true, JSON.stringify(assist));
      const before = await ctx.probe("main");
      const typeR = await ctx.ai("main", "type", { text: "dropped", typingDelayMs: 10, cursor: false });
      const fillR = await ctx.ai("main", "fill", { selector: "#input", value: "dropped" });
      const keyR = await ctx.ai("main", "tab_cdp_call", {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
      });
      const dragR = await ctx.ai("main", "drag", {
        from: { x: Math.round(before.rects.src.x + 20), y: Math.round(before.rects.src.y + 20) },
        to: { x: Math.round(before.rects.dst.x + 20), y: Math.round(before.rects.dst.y + 20) },
        cursor: false,
      });
      const wheelR = await ctx.ai("main", "wheel", { selector: "#scroll", deltaY: -300, cursor: false });
      await sleep(300);
      const after = await ctx.probe("main");
      const kernelMsg = /InputOwnership: debugger input rejected/i;
      check(
        "S6 Feature on：type/fill/key/drag/wheel 全部被内核显式拒绝（可诊断错误）",
        [typeR, fillR, keyR, dragR, wheelR].every((r) => r.ok === false && kernelMsg.test(String(r.error))),
        JSON.stringify({ typeR, fillR, keyR, dragR, wheelR }),
      );
      check(
        "S6 Feature on：键/拖拽/滚轮无任何 DOM 变化",
        after.inputValue === before.inputValue &&
          after.keys.length === before.keys.length &&
          after.drag.down === before.drag.down &&
          after.drag.moves === before.drag.moves &&
          after.drag.up === before.drag.up &&
          after.wheelEvents === before.wheelEvents &&
          after.scrollTop === before.scrollTop,
        JSON.stringify({ keyR, dragR, wheelR, before: { v: before.inputValue, keys: before.keys.length, drag: before.drag, wheelEvents: before.wheelEvents }, after: { v: after.inputValue, keys: after.keys.length, drag: after.drag, wheelEvents: after.wheelEvents } }),
      );
      ctx.record("S6", { assist, typeR, fillR, keyR, dragR, wheelR, before, after });
      await ctx.bumpMode("main", "ai").catch(() => undefined);
    },
  },

  // ------------------------------------------------------------ iframe / OOPIF
  {
    id: "O1",
    title: "OOPIF：跨站 iframe 是独立 target（--site-per-process 证据）",
    stage: "oopif",
    feature: "off",
    async run(ctx) {
      const result = await ctx.browserTargets();
      const frames = (result.targets || []).filter((t) => String(t.type) === "iframe");
      const ours = frames.filter((t) => String(t.url || "").includes(ctx.frameOriginMarker));
      check(
        "O1 跨站 iframe 以独立 OOPIF target 出现（site-per-process 生效）",
        ours.length >= 1,
        JSON.stringify({ frameTargets: frames.map((f) => ({ type: f.type, url: String(f.url || "").slice(0, 120), targetId: f.targetId })), marker: ctx.frameOriginMarker }),
      );
      check("O1 主页面与子帧是不同 origin", ctx.mainOrigin !== ctx.frameOrigin, JSON.stringify({ main: ctx.mainOrigin, frame: ctx.frameOrigin }));
      ctx.record("O1", { targets: result.targets, ours });
    },
  },
  {
    id: "O2",
    title: "OOPIF：AI 点击落在子帧（主帧计数不变，子帧计数 +1）",
    stage: "oopif",
    feature: "off",
    async run(ctx) {
      await ctx.resetOopif();
      if ((await ctx.inputStatus("oopif")).mode !== "ai") await ctx.claim("oopif");
      const before = await ctx.probe("oopif");
      const point = ctx.pointInFrame(before);
      const r = await ctx.ai("oopif", "click", { x: point.x, y: point.y, cursor: false });
      await sleep(350);
      const after = await ctx.probe("oopif");
      check("O2 AI 点击命中子帧（childClicks +1）", r.ok === true && after.childClicks === before.childClicks + 1, JSON.stringify({ r, point, before: before.childClicks, after: after.childClicks }));
      check("O2 主帧点击计数不变（输入没有被错误投递到主帧）", after.clicks === before.clicks, JSON.stringify({ before: before.clicks, after: after.clicks }));
      check("O2 子帧通过 postMessage 报告 isTrusted=true", (after.childMsgs.slice(-1)[0] || {}).trusted === true, JSON.stringify(after.childMsgs.slice(-2)));
      ctx.record("O2", { point, r, before, after, frameSrc: before.frameSrc });
    },
  },
  {
    id: "O3",
    title: "OOPIF：真实人类点击落在子帧（人类输入不被锁）",
    stage: "oopif",
    feature: "off",
    async run(ctx) {
      const before = await ctx.probe("oopif");
      const point = ctx.pointInFrame(before);
      const human = await ctx.humanClick("oopif", { x: point.x - 10, y: point.y - 10, w: 20, h: 20 }, { expect: (s) => s.childClicks > before.childClicks });
      await sleep(350);
      const after = await ctx.probe("oopif");
      check("O3 人类点击命中子帧（childClicks +1）", after.childClicks === before.childClicks + 1, JSON.stringify({ before: before.childClicks, after: after.childClicks, human }));
      ctx.record("O3", { point, before, after, human });
    },
  },
  {
    id: "O4",
    title: "OOPIF（Feature on）：AI 子帧点击被内核丢弃，人类子帧点击仍落地",
    stage: "oopif",
    feature: "on",
    async run(ctx) {
      await ctx.resetOopif();
      const assist = await ctx.bumpMode("oopif", "assist");
      check("O4 前置：内核切到 ASSIST（短窗口）", assist.accepted === true, JSON.stringify(assist));
      const before = await ctx.probe("oopif");
      const point = ctx.pointInFrame(before);
      const r = await ctx.ai("oopif", "click", { x: point.x, y: point.y, cursor: false });
      await sleep(350);
      const afterAi = await ctx.probe("oopif");
      check(
        "O4 Feature on：AI 子帧点击被内核拒绝（childClicks 不变）",
        r.ok === false && /InputOwnership: debugger input rejected/i.test(String(r.error)) && afterAi.childClicks === before.childClicks,
        JSON.stringify({ r, before: before.childClicks, after: afterAi.childClicks }),
      );
      const human = await ctx.humanClick("oopif", { x: point.x - 10, y: point.y - 10, w: 20, h: 20 }, { expect: (s) => s.childClicks > before.childClicks });
      await sleep(350);
      const afterHuman = await ctx.probe("oopif");
      if (human.landed === true) {
        check("O4 Feature on：人类子帧点击仍落地（人类永不锁死，OOPIF 同样生效）", afterHuman.childClicks === before.childClicks + 1, JSON.stringify({ before: before.childClicks, after: afterHuman.childClicks, human }));
      } else if (ctx.session.managed) {
        report.notes.push("O4：managed hidden 窗口无法通过 PostMessage 注入人类输入（human.landed=false）；人类子帧输入由 feature-off 的 O3 真实链路证明，此处不伪造。");
      } else {
        check("O4 Feature on：人类子帧点击仍落地（人类永不锁死，OOPIF 同样生效）", false, JSON.stringify({ before: before.childClicks, after: afterHuman.childClicks, human }));
      }
      ctx.record("O4", { assist, point, r, before, afterAi, afterHuman });
      await ctx.bumpMode("oopif", "ai").catch(() => undefined);
    },
  },
  {
    id: "M1",
    title: "多窗口：一个 HUMAN 一个 AI，输入仲裁互不干扰",
    stage: "multi",
    feature: "off",
    async run(ctx) {
      await ctx.resetMain();
      await ctx.resetMulti();
      const [statusA, statusB] = [await ctx.inputStatus("main"), await ctx.inputStatus("multi")];
      if (statusA.mode !== "ai") await ctx.claim("main");
      if (statusB.mode !== "ai") await ctx.claim("multi");
      mustCheck("M1 handoff 窗口 A", await ctx.handoff("main"));
      const beforeA = await ctx.probe("main");
      const beforeB = await ctx.probe("multi");
      const aiA = await ctx.ai("main", "click", { selector: "#btn", cursor: false });
      const aiB = await ctx.ai("multi", "click", { selector: "#btn", cursor: false });
      await sleep(300);
      const afterA = await ctx.probe("main");
      const afterB = await ctx.probe("multi");
      check("M1 HUMAN 窗口 A：AI 被拒且 DOM 不变", aiA.ok === false && aiA.errorCode === "INPUT_HUMAN_OWNED" && afterA.clicks === beforeA.clicks, JSON.stringify({ aiA, before: beforeA.clicks, after: afterA.clicks }));
      check("M1 AI 窗口 B：AI 点击正常落地", aiB.ok === true && afterB.clicks === beforeB.clicks + 1, JSON.stringify({ aiB, before: beforeB.clicks, after: afterB.clicks }));
      const humanA = await ctx.humanClick("main", beforeA.rects.btn);
      await sleep(200);
      const afterHumanA = await ctx.probe("main");
      check("M1 HUMAN 窗口 A：人类点击落地", afterHumanA.clicks === afterA.clicks + 1, JSON.stringify({ after: afterA.clicks, human: afterHumanA.clicks, humanA }));
      ctx.record("M1", { statusA, statusB, aiA, aiB, beforeA, afterA, beforeB, afterB, afterHumanA });
    },
  },
  {
    id: "M2",
    title: "多窗口：前台窗口与 z-order 在全部操作前后不变",
    stage: "multi",
    feature: "off",
    async run(ctx) {
      const winA = ctx.windows.main;
      const winB = ctx.windows.multi;
      const before = await ctx.win32.call("state", { hwnd: winA.hwnd });
      const beforeB = await ctx.win32.call("state", { hwnd: winB.hwnd });
      const fgBefore = (await ctx.win32.call("foreground")).hwnd;
      // 再做一轮 AI + 人类输入（不调用任何激活/置顶 API）。
      await ctx.ai("multi", "click", { selector: "#btn", cursor: false }).catch(() => undefined);
      await ctx.humanClick("main", (await ctx.probe("main")).rects.btn);
      await sleep(300);
      const after = await ctx.win32.call("state", { hwnd: winA.hwnd });
      const afterB = await ctx.win32.call("state", { hwnd: winB.hwnd });
      const fgAfter = (await ctx.win32.call("foreground")).hwnd;
      check("M2 前台窗口不变", fgBefore === fgAfter, JSON.stringify({ before: fgBefore, after: fgAfter }));
      check("M2 两个窗口的 GW_HWNDPREV 不变", before.window.above === after.window.above && beforeB.window.above === afterB.window.above, JSON.stringify({ A: [before.window.above, after.window.above], B: [beforeB.window.above, afterB.window.above] }));
      check("M2 两个窗口仍 visible 且未最小化", after.window.visible === true && after.window.iconic === false && afterB.window.visible === true && afterB.window.iconic === false, JSON.stringify({ A: after.window, B: afterB.window }));
      ctx.record("M2", { fgBefore, fgAfter, before: before.window, after: after.window, beforeB: beforeB.window, afterB: afterB.window });
    },
  },
  {
    id: "M3",
    title: "多窗口（Feature on）：两个窗口的 AI 输入都被丢弃，人类输入都可用",
    stage: "multi",
    feature: "on",
    async run(ctx) {
      await ctx.resetMain();
      await ctx.resetMulti();
      const assistA = await ctx.bumpMode("main", "assist");
      const assistB = await ctx.bumpMode("multi", "assist");
      check("M3 前置：内核 A/B 切到 ASSIST（短窗口）", assistA.accepted === true && assistB.accepted === true, JSON.stringify({ assistA, assistB }));
      const beforeA = await ctx.probe("main");
      const beforeB = await ctx.probe("multi");
      const aiA = await ctx.ai("main", "click", { selector: "#btn", cursor: false });
      const aiB = await ctx.ai("multi", "click", { selector: "#btn", cursor: false });
      await sleep(300);
      const afterA = await ctx.probe("main");
      const afterB = await ctx.probe("multi");
      const kernelMsg = /InputOwnership: debugger input rejected/i;
      check(
        "M3 Feature on：窗口 A/B 的 AI 点击都被内核拒绝且不改变 DOM",
        aiA.ok === false && aiB.ok === false && kernelMsg.test(String(aiA.error)) && kernelMsg.test(String(aiB.error)) && afterA.clicks === beforeA.clicks && afterB.clicks === beforeB.clicks,
        JSON.stringify({ aiA, aiB, A: [beforeA.clicks, afterA.clicks], B: [beforeB.clicks, afterB.clicks] }),
      );
      const humanA = await ctx.humanClick("main", beforeA.rects.btn);
      const humanB = await ctx.humanClick("multi", beforeB.rects.btn);
      await sleep(300);
      const afterHumanA = await ctx.probe("main");
      const afterHumanB = await ctx.probe("multi");
      const humanOk = afterHumanA.clicks === beforeA.clicks + 1 && afterHumanB.clicks === beforeB.clicks + 1;
      if (humanOk) {
        check("M3 Feature on：两个窗口的人类点击都落地", true, JSON.stringify({ A: afterHumanA.clicks, B: afterHumanB.clicks }));
      } else if (ctx.session.managed) {
        report.notes.push("M3：managed hidden 窗口无法通过 PostMessage 注入人类输入（humanA/humanB landed=false）；人类输入不被锁由 feature-off 的 M1 真实链路证明，此处不伪造。");
      } else {
        check("M3 Feature on：两个窗口的人类点击都落地", false, JSON.stringify({ A: afterHumanA.clicks, B: afterHumanB.clicks, humanA, humanB }));
      }
      ctx.record("M3", { assistA, assistB, aiA, aiB, beforeA, afterA, beforeB, afterB, afterHumanA, afterHumanB });
      await ctx.bumpMode("main", "ai").catch(() => undefined);
      await ctx.bumpMode("multi", "ai").catch(() => undefined);
    },
  },
  {
    id: "F1",
    title: "Feature off 基线：完整 AI 输入序列（鼠标/滚轮/键盘/insertText/JS）全部落地",
    stage: "baseline",
    feature: "off",
    async run(ctx) {
      await ctx.resetMain();
      if ((await ctx.inputStatus("main")).mode !== "ai") await ctx.claim("main");
      const before = await ctx.probe("main");
      const results = {};
      results.click = await ctx.ai("main", "click", { selector: "#btn", cursor: false });
      await sleep(150);
      results.hover = await ctx.ai("main", "hover", { selector: "#btn", cursor: false });
      results.wheel = await ctx.ai("main", "wheel", { selector: "#scroll", deltaY: -400, cursor: false });
      results.js = await ctx.ai("main", "js", { expression: "window.__jsRuns = (window.__jsRuns||0)+1; 'ok'" });
      results.insertText = await ctx.ai("main", "tab_cdp_call", { method: "Input.insertText", params: { text: "x" } });
      await ctx.focusInput("main");
      results.key = await ctx.ai("main", "tab_cdp_call", { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } });
      results.keyUp = await ctx.ai("main", "tab_cdp_call", { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } });
      await sleep(300);
      const after = await ctx.probe("main");
      const allOk = Object.values(results).every((r) => r.ok === true);
      check("F1 Feature off：所有 AI 输入命令均成功", allOk, JSON.stringify(results));
      check(
        "F1 Feature off：DOM 证据（clicks+1 / wheel 事件+1 / jsRuns+1）",
        after.clicks === before.clicks + 1 &&
          after.wheelEvents === before.wheelEvents + 1 &&
          after.lastWheel &&
          after.lastWheel.deltaY === -400 &&
          after.jsRuns === before.jsRuns + 1,
        JSON.stringify({
          clicks: [before.clicks, after.clicks],
          wheelEvents: [before.wheelEvents, after.wheelEvents],
          lastWheel: after.lastWheel,
          scrollTop: [before.scrollTop, after.scrollTop],
          jsRuns: [before.jsRuns, after.jsRuns],
        }),
      );
      report.notes.push(
        "wheel 投递证据用页面 window 的 wheel 事件（deltaY/target）；scrollTop 在该非交互测试窗口里不推进" +
          "（compositor 滚动需要活动窗口/异步帧），因此 scrollTop 只作为观察值记录，不作为 PASS 条件。",
      );
      ctx.record("F1", { results, before, after });
    },
  },
  {
    id: "F2",
    title: "Feature on：扩展自动同步 kernel mode=ai，agent 输入落地；内核短窗口切 HUMAN 后 Input.* 被拒（边界）",
    stage: "baseline",
    feature: "on",
    async run(ctx) {
      await ctx.resetMain();
      const snap = await ctx.kernelSnapshot("main");
      check("F2 扩展自动同步：内核 mode=ai", snap.snapshot?.mode === "ai", JSON.stringify(snap));
      const status = await ctx.inputStatus("main");
      check(
        "F2 扩展 input_status 的 kernel 视图 ready 且 mode=ai",
        status.kernel?.state === "ready" && status.kernel?.kernelMode === "ai",
        JSON.stringify(status).slice(0, 900),
      );

      const before = await ctx.probe("main");
      const results = {
        click: await ctx.ai("main", "click", { selector: "#btn", cursor: false }),
        wheel: await ctx.ai("main", "wheel", { selector: "#scroll", deltaY: -400, cursor: false }),
        insert: await ctx.ai("main", "tab_cdp_call", { method: "Input.insertText", params: { text: "x" } }),
        key: await ctx.ai("main", "tab_cdp_call", { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 } }),
      };
      await sleep(500);
      const after = await ctx.probe("main");
      check(
        "F2 内核 mode=ai 时 agent 输入全部落地",
        Object.values(results).every((r) => r.ok === true) && after.clicks === before.clicks + 1 && after.wheelEvents === before.wheelEvents + 1,
        JSON.stringify({ results, clicks: [before.clicks, after.clicks], wheel: [before.wheelEvents, after.wheelEvents] }),
      );

      // 内核短窗口切 HUMAN：扩展下一次 10s 心跳会修正回 ai，因此这里只做短窗口断言。
      const human = await ctx.bumpMode("main", "human");
      const blocked = await ctx.ai("main", "click", { selector: "#btn", cursor: false });
      await sleep(200);
      const afterHuman = await ctx.probe("main");
      check(
        "F2 内核 HUMAN（短窗口）：agent click 被 -32000 拒绝且 DOM 不变",
        human.accepted === true && blocked.ok === false && /InputOwnership: debugger input rejected/i.test(String(blocked.error)) && afterHuman.clicks === after.clicks,
        JSON.stringify({ human, blocked, clicks: [after.clicks, afterHuman.clicks] }),
      );
      const js = await ctx.ai("main", "js", { expression: "window.__jsRuns=(window.__jsRuns||0)+1; document.getElementById('count').textContent='js-touched'; 'ok'" });
      // beacon 200ms 周期：等状态真正反映 js 执行结果，避免读到动作前的快照。
      const afterJs = await ctx.waitState("main", (st) => st.countText === "js-touched", 3000);
      check(
        "F2 内核 HUMAN：Runtime.evaluate 仍可改 DOM（输入事件仲裁边界）",
        js.ok === true && afterJs.countText === "js-touched",
        JSON.stringify({ js, countText: afterJs.countText }),
      );
      ctx.record("F2", { snap, status, before, after, results, human, blocked, afterHuman, js, afterJs });
      await ctx.bumpMode("main", "ai").catch(() => undefined);
    },
  },
  {
    id: "F3",
    title: "Feature on：非输入命令可用 + managed hidden 产品截图 P0 单列",
    stage: "baseline",
    feature: "on",
    async run(ctx) {
      await ctx.resetMain();
      const tabs = await ctx.ai("main", "list_tabs", {});
      const status = await ctx.inputStatus("main");
      check("F3 非输入命令（list_tabs/input_status）仍可用", tabs.ok === true && Array.isArray(tabs.data?.tabs) && status.mode === "ai", JSON.stringify({ tabsOk: tabs.ok, mode: status.mode }));

      // 截图：managed hidden 窗口的产品截图失败单列为 P0，不作为输入仲裁用例的通过条件。
      const shotProduct = await ctx.ai("main", "screenshot", { format: "png", tabId: ctx.spaces.main.tabId });
      const shotSurface = await ctx.ai("main", "tab_cdp_call", {
        method: "Page.captureScreenshot",
        params: { format: "png", fromSurface: true },
        tabId: ctx.spaces.main.tabId,
      });
      const shotNoSurface = await ctx.ai("main", "tab_cdp_call", {
        method: "Page.captureScreenshot",
        params: { format: "png", fromSurface: false },
        tabId: ctx.spaces.main.tabId,
      });
      const winState = await win32.call("state", { hwnd: ctx.windows.main.hwnd });
      const shotEvidence = {
        product: { ok: shotProduct.ok, error: String(shotProduct.error || "").slice(0, 400), bytes: String(shotProduct.data?.base64 || "").length, reason: shotProduct.data?.reason ?? null, possiblyStale: shotProduct.data?.possiblyStale ?? null },
        fromSurfaceTrue: { ok: shotSurface.ok, error: String(shotSurface.error || "").slice(0, 400), bytes: String(shotSurface.data?.result?.data || "").length },
        fromSurfaceFalse: { ok: shotNoSurface.ok, error: String(shotNoSurface.error || "").slice(0, 400), bytes: String(shotNoSurface.data?.result?.data || "").length },
        window: winState.window,
      };
      const productShotBroken = shotProduct.ok !== true;
      ctx.record("F3", { shotEvidence, productShotBroken });
      if (productShotBroken) {
        report.p0Regressions.push({
          id: "P0-managed-hidden-product-screenshot",
          at: nowIso(),
          detail: shotEvidence,
          note:
            "managed hidden 窗口：产品 screenshot 命令失败（合成器帧 8000ms 超时 + fromSurface=false 返回 -32000 " +
            "Only screenshots from surface are allowed）。原始 CDP 直连 fromSurface=true 在本轮 bytes=" +
            String(shotSurface.data?.result?.data || "").length + "。与输入仲裁无关，单列。",
        });
        report.notes.push("F3：managed hidden 窗口的产品截图失败已单列为 P0 回归（见 report.p0Regressions）；不作为输入仲裁用例的失败。");
      } else {
        report.notes.push("F3：managed hidden 窗口的产品截图成功（bytes=" + String(shotProduct.data?.base64 || "").length + "）。");
      }
    },
  },
  // ------------------------------------------------------------ 韧性（SW 重启 / 30s 心跳失联）
  {
    id: "R1",
    title: "SW 重启恢复：新 SW 重新探测 API、版本不回退、heartbeat/setOwnership 重放、输入恢复",
    stage: "resilience",
    feature: "on",
    async run(ctx) {
      const key = "r1";
      await ctx.openFresh(key);
      const spaceId = ctx.spaces[key].spaceId;
      const tabId = ctx.spaces[key].tabId;
      await ctx.attachOn(key);
      const setAi = await ctx.bumpMode(key, "ai");
      const snapBefore = await ctx.kernelSnapshot(key);
      const before = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      await sleep(450);
      const s0 = await ctx.probe(key);
      check("R1 重启前 mode=ai 且 click 落地", setAi.accepted === true && before.ok === true && s0.clicks === 1, JSON.stringify({ setAi, before, clicks: s0.clicks }));

      const swBefore = await ctx.swEval("({href: String(self.location.href), api: !!(typeof chrome !== 'undefined' && chrome.browserCliInputOwnership)})");
      check("R1 重启前 SW 上下文可见 API", swBefore?.api === true, JSON.stringify(swBefore));
      const oldSwTarget = ctx.swTargetId;

      const stop = await ctx.stopExtensionWorkers();
      check("R1 ServiceWorker.stopAllWorkers 调用成功", stop.ok === true, JSON.stringify(stop));
      await sleep(1000);
      const wake = await ctx.popupSend("input_status", spaceId);
      const swTarget = await ctx.waitForServiceWorker(25000);
      check(
        "R1 SW 在停止后重新出现（target 存在；Chrome 可能复用同一 target id）",
        !!swTarget,
        JSON.stringify({ oldSwTarget, swTarget, sameTargetId: swTarget?.targetId === oldSwTarget, wakeOk: wake?.ok }),
      );
      const channel = await ctx.ensureAgentChannel(spaceId);
      check("R1 native host 以新 session 重连", channel.ok === true, JSON.stringify(channel));

      ctx.swSessionId = null;
      const swAfter = await ctx.swEval("({api: !!(typeof chrome !== 'undefined' && chrome.browserCliInputOwnership), keys: (typeof chrome !== 'undefined' && chrome.browserCliInputOwnership) ? Object.keys(chrome.browserCliInputOwnership) : null})");
      check("R1 新 SW 重新探测到 inputOwnership API", swAfter?.api === true && Array.isArray(swAfter.keys) && swAfter.keys.includes("setOwnership"), JSON.stringify(swAfter));

      const snapAfter = await ctx.kernelSnapshot(key);
      check(
        "R1 重启后内核 version 不回退",
        snapAfter.snapshot && Number(snapAfter.snapshot.version) >= Number(snapBefore.snapshot?.version ?? 0),
        JSON.stringify({ before: snapBefore, after: snapAfter }),
      );
      const hb = await ctx.apiCall("heartbeat", { target: { tabId }, version: snapAfter.snapshot.version });
      check("R1 重启后 heartbeat(当前 version) 被接受且 stale=false", hb?.result?.ok === true && hb.result.stale === false, JSON.stringify(hb));
      const setAi2 = await ctx.bumpMode(key, "ai");
      check("R1 重启后 setOwnership(version+1) 被接受", setAi2.accepted === true, JSON.stringify(setAi2));

      const after = await ctx.ai(key, "click", { selector: "#btn", cursor: false });
      await sleep(450);
      const s1 = await ctx.probe(key);
      check("R1 重启后 AI 输入恢复", after.ok === true && s1.clicks === s0.clicks + 1, JSON.stringify({ after, clicks: s1.clicks }));
      ctx.record("R1", { setAi, snapBefore, before, swBefore, stop, swTarget, channel, swAfter, snapAfter, hb, setAi2, after, clicks: [s0.clicks, s1.clicks] });
    },
  },
  {
    id: "R2",
    title: "30s 心跳失联：目标窗口无心跳 → 内核 stale/effective ASSIST，AI 输入被拒；heartbeat 恢复",
    stage: "resilience",
    feature: "on",
    async run(ctx) {
      // 不属于任何 Task Space 的独立窗口：扩展的周期同步不会覆盖它 → 没有心跳。
      const created = await ctx.createUntrackedWindow("r2");
      check("R2 创建未跟踪窗口且 beacon 就绪", created.ok === true && Number.isInteger(created.tabId), JSON.stringify(created).slice(0, 700));
      if (!created.ok) {
        ctx.markBlocked({
          code: "untracked-window-failed",
          deps: ["popup 可在 Task Space 之外创建窗口"],
          reason: "无法创建未跟踪窗口：" + JSON.stringify(created),
        });
        return;
      }
      const tabId = created.tabId;
      const state0 = created.state;
      const attach = await ctx.popupDebuggerAttach(tabId);
      check("R2 popup attach chrome.debugger（未跟踪窗口）", attach?.attached === true, JSON.stringify(attach));
      if (attach?.attached !== true) {
        await ctx.closeWindow(created.windowId);
        ctx.record("R2", { created, attach });
        ctx.markBlocked({
          code: "debugger-attach-unavailable",
          deps: ["popup 页面可对未跟踪窗口 attach chrome.debugger"],
          reason: "popup attach 失败：" + JSON.stringify(attach),
        });
        return;
      }

      const setAi = await ctx.bumpModeOnTab(tabId, "ai");
      const snap0 = await ctx.kernelSnapshotOnTab(tabId);
      check("R2 初始 mode=ai / stale=false", setAi.accepted === true && snap0.snapshot?.mode === "ai" && snap0.snapshot?.stale === false, JSON.stringify({ setAi, snap0 }));

      const x = Math.round((state0.rects.btn.x + state0.rects.btn.w / 2) * (Number(state0.viewport.dpr) || 1));
      const y = Math.round((state0.rects.btn.y + state0.rects.btn.h / 2) * (Number(state0.viewport.dpr) || 1));
      const press = () => ctx.popupDebuggerSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      const release = () => ctx.popupDebuggerSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      const readState = async () => (servers.stateFor(created.token) || {}).state || null;

      const controlPress = await press();
      const controlRelease = await release();
      await sleep(400);
      const sControl = await readState();
      check(
        "R2 对照：mode=ai 时 CDP 输入未被内核拒绝",
        controlPress.ok === true && controlRelease.ok === true,
        JSON.stringify({ controlPress, controlRelease, clicks: sControl?.clicks }),
      );

      await sleep(31500);
      const snapStale = await ctx.kernelSnapshotOnTab(tabId);
      check("R2 >30s 无心跳：配置 mode 仍 ai、stale=true", snapStale.snapshot?.mode === "ai" && snapStale.snapshot?.stale === true, JSON.stringify(snapStale));
      const stalePress = await press();
      const staleRelease = await release();
      await sleep(400);
      const sStale = await readState();
      check(
        "R2 stale 下 AI 输入被内核拒绝（-32000，debugger input rejected）",
        stalePress.ok === false && /InputOwnership: debugger input rejected/i.test(String(stalePress.lastError || stalePress.error)),
        JSON.stringify({ stalePress, staleRelease, clicks: sStale?.clicks }),
      );

      const hb = await ctx.apiCall("heartbeat", { target: { tabId }, version: snapStale.snapshot.version });
      const snapRecovered = await ctx.kernelSnapshotOnTab(tabId);
      check("R2 heartbeat 恢复：ok 且 stale=false", hb?.result?.ok === true && hb.result.stale === false && snapRecovered.snapshot?.stale === false, JSON.stringify({ hb, snapRecovered }));
      const okPress = await press();
      const okRelease = await release();
      await sleep(400);
      const sRecovered = await readState();
      check(
        "R2 恢复后（mode=ai）CDP 输入重新被投递（不再被内核拒绝）",
        okPress.ok === true && okRelease.ok === true,
        JSON.stringify({ okPress, okRelease, clicks: sRecovered?.clicks }),
      );

      const detach = await ctx.popupDebuggerDetach(tabId);
      const closed = await ctx.closeWindow(created.windowId);
      ctx.record("R2", { created: { windowId: created.windowId, tabId, token: created.token }, attach, setAi, snap0, controlPress, controlRelease, snapStale, stalePress, staleRelease, hb, snapRecovered, okPress, okRelease, clicks: [sControl?.clicks, sStale?.clicks, sRecovered?.clicks], detach, closed });
    },
  },
  // ------------------------------------------------------------ 内核生产 API（patch 029）  // ------------------------------------------------------------ 内核生产 API（patch 029）  // ------------------------------------------------------------ 内核生产 API（patch 029）
  {
    id: "K0",
    title: "内核 API 可用性 + 未跟踪窗口的 AI 输入投递（环境检查，K1-K4 的前置）",
    stage: "kernel",
    feature: "on",
    async run(ctx) {
      const ready = await ctx.kernelApiReady();
      if (!ready.ok) {
        ctx.markBlocked(ready.blocked);
        return;
      }
      const created = await ctx.createUntrackedWindow("k0");
      check("K0 创建未跟踪窗口（无扩展心跳）且 beacon 就绪", created.ok === true && Number.isInteger(created.tabId), JSON.stringify(created).slice(0, 700));
      if (!created.ok) {
        ctx.markBlocked({ code: "untracked-window-failed", deps: ["popup 可创建未跟踪窗口"], reason: JSON.stringify(created) });
        return;
      }
      const attach = await ctx.popupDebuggerAttach(created.tabId);
      check("K0 popup attach chrome.debugger", attach?.attached === true, JSON.stringify(attach));
      if (attach?.attached !== true) {
        await ctx.closeWindow(created.windowId);
        ctx.markBlocked({ code: "debugger-attach-unavailable", deps: ["popup 可 attach 未跟踪窗口"], reason: JSON.stringify(attach) });
        return;
      }
      const createdState = { ...created.state, tabId: created.tabId };
      const snapBefore = await ctx.kernelSnapshotOnTab(created.tabId);
      check(
        "K0 内核快照可读且 mode 合法（未跟踪目标初始为 assist/0）",
        snapBefore.snapshot && ["ai", "assist", "human"].includes(snapBefore.snapshot.mode) && Number.isInteger(snapBefore.snapshot.version),
        JSON.stringify(snapBefore),
      );
      const setAi = await ctx.bumpModeOnTab(created.tabId, "ai");
      check(
        "K0 setOwnership(ai, version+1) 被接受且 version 递增",
        setAi.accepted === true && setAi.bumped?.result?.version === snapBefore.snapshot.version + 1,
        JSON.stringify({ snapBefore, setAi }),
      );
      const control = await ctx.kernelMouseClick(createdState);
      await sleep(500);
      const after = (servers.stateFor(created.token) || {}).state || {};
      check(
        "K0 mode=ai 时 popup/debugger 的 AI click 真实落地",
        control.press.ok === true && control.release.ok === true && after.clicks === 1,
        JSON.stringify({ control, clicks: after.clicks }),
      );
      const detach = await ctx.popupDebuggerDetach(created.tabId);
      const closed = await ctx.closeWindow(created.windowId);
      ctx.record("K0", { created: { tabId: created.tabId, token: created.token }, attach, snapBefore, setAi, control, clicks: after.clicks, detach, closed });
    },
  },
  {
    id: "K15",
    title: "新 tab 立即继承窗口快照；explicit tab override 永久优先于窗口 heartbeat/setOwnership",
    stage: "kernel",
    feature: "on",
    async run(ctx) {
      const ready = await ctx.kernelApiReady();
      if (!ready.ok) {
        ctx.markBlocked(ready.blocked);
        return;
      }
      const created = await ctx.createUntrackedWindow("k15");
      check("K15 创建未跟踪窗口且 beacon 就绪", created.ok === true && Number.isInteger(created.tabId), JSON.stringify(created).slice(0, 700));
      if (!created.ok) {
        ctx.markBlocked({ code: "untracked-window-failed", deps: ["popup 可创建未跟踪窗口"], reason: JSON.stringify(created) });
        return;
      }
      const attach = await ctx.popupDebuggerAttach(created.tabId);
      check("K15 popup attach chrome.debugger", attach?.attached === true, JSON.stringify(attach));

      const setWindow = await ctx.apiCall("setOwnership", { target: { windowId: created.windowId }, mode: "ai", version: 1 });
      check("K15 setOwnership(windowId, ai, 1) accepted", setWindow?.result?.accepted === true && setWindow.result.mode === "ai" && setWindow.result.version === 1, JSON.stringify(setWindow));
      const snapInitial = await ctx.kernelSnapshotOnTab(created.tabId);
      check("K15 窗口现有 tab 继承 ai/1", snapInitial.snapshot?.mode === "ai" && snapInitial.snapshot?.version === 1 && snapInitial.snapshot?.stale === false, JSON.stringify(snapInitial));

      // 不 heartbeat，直接在同一窗口新建 tab：插入通知必须同步写入 inherited 状态。
      const tabA = await ctx.createTabInWindow(created.windowId, "k15a", true);
      check("K15 同窗口新建 tab A 成功", tabA.ok === true && Number.isInteger(tabA.tabId), JSON.stringify(tabA).slice(0, 700));
      if (!tabA.ok) {
        await ctx.popupDebuggerDetach(created.tabId);
        await ctx.closeWindow(created.windowId);
        ctx.record("K15", { created, setWindow, snapInitial, tabA });
        return;
      }
      const snapA = await ctx.kernelSnapshotOnTab(tabA.tabId);
      check(
        "K15 新 tab A 立即继承 ai/1（无需下一次 heartbeat）",
        snapA.snapshot?.mode === "ai" && snapA.snapshot?.version === 1 && snapA.snapshot?.stale === false,
        JSON.stringify(snapA),
      );

      // 立即投递一次 AI click，证明继承在第一条 debugger 输入之前已生效。
      // 后台 tab 的 CDP 输入可能被渲染器按不可见丢弃；先激活该 tab，但不改 INPUT API。
      {
        const popupForTab = await ctx.ensurePopup();
        const cdpForTab = await ctx.cdp();
        await cdpForTab.evaluate(
          popupForTab.sessionId,
          "new Promise((resolve) => chrome.tabs.update(" + Number(tabA.tabId) + ", {active: true}, () => resolve({ok: !chrome.runtime.lastError})))",
        ).catch(() => null);
        await sleep(400);
      }
      await ctx.popupDebuggerAttach(tabA.tabId);
      const stateA = { ...tabA.state, tabId: tabA.tabId };
      const inheritedClick = await ctx.kernelMouseClick(stateA);
      await sleep(500);
      const clicksAfterInherited = (servers.stateFor(tabA.token) || {}).state?.clicks ?? 0;
      check(
        "K15 新 tab A 立即接受 AI click（inherited 状态已生效）",
        inheritedClick.press.ok === true && inheritedClick.release.ok === true && clicksAfterInherited === 1,
        JSON.stringify({ inheritedClick, clicks: clicksAfterInherited }),
      );

      // tab explicit override（与窗口版本空间无关）。
      const explicit = await ctx.apiCall("setOwnership", { target: { tabId: tabA.tabId }, mode: "human", version: 1 });
      check("K15 tab A explicit human/1 accepted", explicit?.result?.accepted === true && explicit.result.mode === "human", JSON.stringify(explicit));
      const snapAExplicit = await ctx.kernelSnapshotOnTab(tabA.tabId);
      check("K15 tab A 变 human/1（explicit）", snapAExplicit.snapshot?.mode === "human" && snapAExplicit.snapshot?.version === 1, JSON.stringify(snapAExplicit));

      // 窗口写和 heartbeat 都不能覆盖 explicit tab。
      const setWindow2 = await ctx.apiCall("setOwnership", { target: { windowId: created.windowId }, mode: "ai", version: 2 });
      check("K15 窗口 setOwnership(ai,2) accepted", setWindow2?.result?.accepted === true && setWindow2.result.version === 2, JSON.stringify(setWindow2));
      const tabB = await ctx.createTabInWindow(created.windowId, "k15b");
      check("K15 同窗口新建 tab B 成功", tabB.ok === true && Number.isInteger(tabB.tabId), JSON.stringify(tabB).slice(0, 700));
      if (tabB.ok) {
        const snapB = await ctx.kernelSnapshotOnTab(tabB.tabId);
        check(
          "K15 tab B 立即继承窗口新快照 ai/2",
          snapB.snapshot?.mode === "ai" && snapB.snapshot?.version === 2 && snapB.snapshot?.stale === false,
          JSON.stringify(snapB),
        );
      }
      const hbA = [];
      for (let i = 0; i < 3; i++) {
        hbA.push(await ctx.apiCall("heartbeat", { target: { windowId: created.windowId }, version: 2 }));
      }
      check("K15 窗口 heartbeat(2) ×3 全部 accepted", hbA.every((r) => r?.result?.ok === true), JSON.stringify(hbA));
      const snapAAfterHb = await ctx.kernelSnapshotOnTab(tabA.tabId);
      check(
        "K15 explicit tab A 在窗口 heartbeat ×3 后仍为 human/1",
        snapAAfterHb.snapshot?.mode === "human" && snapAAfterHb.snapshot?.version === 1,
        JSON.stringify(snapAAfterHb),
      );

      // 激活切换不改变所有权。
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      await cdp.evaluate(
        popup.sessionId,
        "new Promise((resolve) => chrome.tabs.update(" + Number(tabA.tabId) + ", {active: true}, () => resolve({ok: !chrome.runtime.lastError})))",
      ).catch(() => null);
      const snapAStill = await ctx.kernelSnapshotOnTab(tabA.tabId);
      check("K15 切换激活 tab 不改变 tab A 的 human/1", snapAStill.snapshot?.mode === "human" && snapAStill.snapshot?.version === 1, JSON.stringify(snapAStill));

      const detach = await ctx.popupDebuggerDetach(tabA.tabId);
      const closed = await ctx.closeWindow(created.windowId);
      ctx.record("K15", {
        created: { windowId: created.windowId, tabId: created.tabId, token: created.token },
        attach,
        setWindow,
        snapInitial,
        tabA: { tabId: tabA.tabId, token: tabA.token },
        snapA,
        inheritedClick,
        clicksAfterInherited,
        explicit,
        snapAExplicit,
        setWindow2,
        tabB: tabB.ok ? { tabId: tabB.tabId, token: tabB.token } : tabB,
        hbA,
        snapAAfterHb,
        snapAStill,
        detach,
        closed,
      });
    },
  },
  {
    id: "K1",
    title: "内核 HUMAN：setOwnership(human) 后全部 CDP Input 被拒、版本语义、Runtime.evaluate 边界",
    stage: "kernel",
    feature: "on",
    async run(ctx) {
      const ready = await ctx.kernelApiReady();
      if (!ready.ok) {
        ctx.markBlocked(ready.blocked);
        return;
      }
      const created = await ctx.createUntrackedWindow("k1");
      check("K1 创建未跟踪窗口且 beacon 就绪", created.ok === true, JSON.stringify(created).slice(0, 600));
      if (!created.ok) {
        ctx.markBlocked({ code: "untracked-window-failed", deps: ["popup 可创建未跟踪窗口"], reason: JSON.stringify(created) });
        return;
      }
      const tabId = created.tabId;
      const state = { ...created.state, tabId };
      const attach = await ctx.popupDebuggerAttach(tabId);
      check("K1 popup attach chrome.debugger", attach?.attached === true, JSON.stringify(attach));
      if (attach?.attached !== true) {
        await ctx.closeWindow(created.windowId);
        ctx.markBlocked({ code: "debugger-attach-unavailable", deps: ["popup 可 attach 未跟踪窗口"], reason: JSON.stringify(attach) });
        return;
      }
      // 先推进到 version 1，再切 human（version 2），这样 stale-version 测试用 v1 而不是 0
      await ctx.bumpModeOnTab(tabId, "ai");
      const human = await ctx.bumpModeOnTab(tabId, "human");
      check("K1 setOwnership(human) accepted", human.accepted === true && human.bumped?.result?.mode === "human", JSON.stringify(human));
      const snap = await ctx.kernelSnapshotOnTab(tabId);
      check("K1 getOwnership 配置态 mode=human / stale=false", snap.snapshot?.mode === "human" && snap.snapshot?.stale === false, JSON.stringify(snap));

      const conflict = await ctx.apiCall("setOwnership", { target: { tabId }, mode: "ai", version: human.version });
      check("K1 同版本改 mode → VERSION_CONFLICT", conflict?.result?.accepted === false && conflict.result.reason === "VERSION_CONFLICT", JSON.stringify(conflict));
      const staleVersion = await ctx.apiCall("setOwnership", { target: { tabId }, mode: "human", version: human.version - 1 });
      check("K1 旧版本 → STALE_VERSION", staleVersion?.result?.accepted === false && staleVersion.result.reason === "STALE_VERSION", JSON.stringify(staleVersion));
      const badVersion = await ctx.apiCall("setOwnership", { target: { tabId }, mode: "human", version: 0 });
      check("K1 version=0 → 绑定层/内核拒绝", /INVALID_ARGUMENT/.test(String(badVersion?.lastError)) || /at least 1/i.test(String(badVersion?.__bpThrown)), JSON.stringify(badVersion));

      const x = Math.round((state.rects.btn.x + state.rects.btn.w / 2) * (Number(state.viewport.dpr) || 1));
      const y = Math.round((state.rects.btn.y + state.rects.btn.h / 2) * (Number(state.viewport.dpr) || 1));
      const inputs = {
        mousePressed: await ctx.popupDebuggerSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }),
        mouseReleased: await ctx.popupDebuggerSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }),
        keyDown: await ctx.popupDebuggerSend(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }),
        insertText: await ctx.popupDebuggerSend(tabId, "Input.insertText", { text: "should-not-appear" }),
      };
      await sleep(450);
      const afterInputs = (servers.stateFor(created.token) || {}).state || {};
      const kernelMsg = /InputOwnership: debugger input rejected/i;
      check(
        "K1 HUMAN：mouse/key/insertText 全部被内核拒绝（-32000）",
        Object.values(inputs).every((r) => r.ok === false && kernelMsg.test(String(r.lastError || r.error))),
        JSON.stringify(inputs),
      );
      check(
        "K1 HUMAN：DOM 不变（clicks/inputValue）",
        afterInputs.clicks === 0 && afterInputs.inputValue === "",
        JSON.stringify({ clicks: afterInputs.clicks, value: afterInputs.inputValue }),
      );

      const js = await ctx.popupDebuggerSend(tabId, "Runtime.evaluate", { expression: "window.__jsRuns=(window.__jsRuns||0)+1; document.getElementById('count').textContent='js-touched'; 'ok'", returnByValue: true });
      await sleep(400);
      const afterJs = (servers.stateFor(created.token) || {}).state || {};
      check(
        "K1 HUMAN：Runtime.evaluate 仍可改 DOM（输入事件仲裁边界）",
        js.ok === true && afterJs.jsRuns === 1 && afterJs.countText === "js-touched",
        JSON.stringify({ js, jsRuns: afterJs.jsRuns, countText: afterJs.countText }),
      );

      const restore = await ctx.bumpModeOnTab(tabId, "ai");
      const restored = await ctx.kernelMouseClick(state);
      await sleep(500);
      const afterRestore = (servers.stateFor(created.token) || {}).state || {};
      check(
        "K1 恢复 mode=ai 后 AI click 重新落地",
        restore.accepted === true && restored.press.ok === true && afterRestore.clicks === 1,
        JSON.stringify({ restore, restored, clicks: afterRestore.clicks }),
      );
      const detach = await ctx.popupDebuggerDetach(tabId);
      const closed = await ctx.closeWindow(created.windowId);
      ctx.record("K1", { created: { tabId, token: created.token }, attach, human, snap, conflict, staleVersion, badVersion, inputs, afterInputs, js, afterJs, restore, restored, clicks: afterRestore.clicks, detach, closed });
    },
  },
  {
    id: "K2",
    title: "内核 ASSIST（未跟踪窗口）：grant 消费/TTL/用尽/scope/cancel/session detach",
    stage: "kernel",
    feature: "on",
    async run(ctx) {
      const ready = await ctx.kernelApiReady();
      if (!ready.ok) {
        ctx.markBlocked(ready.blocked);
        return;
      }
      const created = await ctx.createUntrackedWindow("k2");
      check("K2 创建未跟踪窗口且 beacon 就绪", created.ok === true, JSON.stringify(created).slice(0, 600));
      if (!created.ok) {
        ctx.markBlocked({ code: "untracked-window-failed", deps: ["popup 可创建未跟踪窗口"], reason: JSON.stringify(created) });
        return;
      }
      const tabId = created.tabId;
      const state = { ...created.state, tabId };
      const readClicks = () => ((servers.stateFor(created.token) || {}).state || {}).clicks;
      const attach = await ctx.popupDebuggerAttach(tabId);
      check("K2 popup attach chrome.debugger", attach?.attached === true, JSON.stringify(attach));
      if (attach?.attached !== true) {
        await ctx.closeWindow(created.windowId);
        ctx.markBlocked({ code: "debugger-attach-unavailable", deps: ["popup 可 attach 未跟踪窗口"], reason: JSON.stringify(attach) });
        return;
      }
      const assist = await ctx.bumpModeOnTab(tabId, "assist");
      check("K2 setOwnership(assist) accepted", assist.accepted === true && assist.bumped?.result?.mode === "assist", JSON.stringify(assist));
      const kernelMsg = /InputOwnership: debugger input rejected/i;

      const noGrant = await ctx.kernelMouseClick(state);
      check("K2 ASSIST 无 grant：click 被内核拒绝且 DOM 不变", noGrant.rejected === true && kernelMsg.test(String(noGrant.error)) && readClicks() === 0, JSON.stringify({ noGrant, clicks: readClicks() }));

      const grant1 = await ctx.apiCall("grantInput", { target: { tabId }, actions: 1, ttlMs: 8000 });
      check("K2 grantInput(actions:1) granted", grant1?.result?.granted === true && grant1.result.actions === 1 && typeof grant1.result.expiresAt === "number", JSON.stringify(grant1));
      const click1 = await ctx.kernelMouseClick(state);
      await sleep(450);
      check("K2 grant 后第 1 条 click 成功", click1.press.ok === true && click1.release.ok === true && readClicks() === 1, JSON.stringify({ click1, clicks: readClicks() }));
      const click2 = await ctx.kernelMouseClick(state);
      await sleep(450);
      check("K2 第 2 条 click 被拒（grant 用尽）", click2.rejected === true && kernelMsg.test(String(click2.error)) && readClicks() === 1, JSON.stringify({ click2, clicks: readClicks() }));

      const grantTtl = await ctx.apiCall("grantInput", { target: { tabId }, actions: 2, ttlMs: 150 });
      await sleep(500);
      const clickTtl = await ctx.kernelMouseClick(state);
      await sleep(450);
      check("K2 TTL 到期后 click 被拒（绝对截止）", grantTtl?.result?.granted === true && clickTtl.rejected === true && readClicks() === 1, JSON.stringify({ grantTtl, clickTtl, clicks: readClicks() }));

      const grantScope = await ctx.apiCall("grantInput", { target: { tabId }, actions: 1, ttlMs: 8000 });
      const commandId = "k2-scope-ok-" + Date.now();
      const begin = await ctx.apiCall("beginInputCommand", { target: { tabId }, commandId, kind: "click" });
      check("K2 beginInputCommand 成功（预扣 1 单位）", begin?.result?.ok === true, JSON.stringify(begin));
      const clickScope = await ctx.kernelMouseClick(state);
      await sleep(450);
      check("K2 scope 内 click 成功", clickScope.press.ok === true && readClicks() === 2, JSON.stringify({ clickScope, clicks: readClicks() }));
      const end = await ctx.apiCall("endInputCommand", { target: { tabId }, commandId, outcome: "ok" });
      check("K2 endInputCommand(ok) closed", end?.result?.closed === true, JSON.stringify(end));
      const clickAfterScope = await ctx.kernelMouseClick(state);
      await sleep(450);
      check("K2 scope 结束后（预算用尽）click 被拒", clickAfterScope.rejected === true && readClicks() === 2, JSON.stringify({ clickAfterScope, clicks: readClicks() }));

      const grantCancel = await ctx.apiCall("grantInput", { target: { tabId }, actions: 1, ttlMs: 8000 });
      const cancelId = "k2-scope-cancel-" + Date.now();
      const beginCancel = await ctx.apiCall("beginInputCommand", { target: { tabId }, commandId: cancelId, kind: "click" });
      const endCancel = await ctx.apiCall("endInputCommand", { target: { tabId }, commandId: cancelId, outcome: "cancelled" });
      const clickRefund = await ctx.kernelMouseClick(state);
      await sleep(450);
      check(
        "K2 cancel 未授权输入的 scope → 退还 1 单位，click 成功",
        grantCancel?.result?.granted === true && beginCancel?.result?.ok === true && endCancel?.result?.closed === true && clickRefund.press.ok === true && readClicks() === 3,
        JSON.stringify({ grantCancel, beginCancel, endCancel, clickRefund, clicks: readClicks() }),
      );

      const grantDetach = await ctx.apiCall("grantInput", { target: { tabId }, actions: 2, ttlMs: 8000 });
      const detach1 = await ctx.popupDebuggerDetach(tabId);
      const reattach = await ctx.popupDebuggerAttach(tabId);
      const clickDetached = await ctx.kernelMouseClick(state);
      await sleep(450);
      check(
        "K2 session detach/reattach 后 click 被拒（新 session 不能复用旧 grant）",
        grantDetach?.result?.granted === true && detach1?.ok === true && reattach?.attached === true && clickDetached.rejected === true && readClicks() === 3,
        JSON.stringify({ grantDetach, detach1, reattach, clickDetached, clicks: readClicks() }),
      );
      const grantRegrant = await ctx.apiCall("grantInput", { target: { tabId }, actions: 1, ttlMs: 8000 });
      const clickRegrant = await ctx.kernelMouseClick(state);
      await sleep(450);
      check("K2 新 session 重新 grant 后 click 成功", grantRegrant?.result?.granted === true && clickRegrant.press.ok === true && readClicks() === 4, JSON.stringify({ grantRegrant, clickRegrant, clicks: readClicks() }));

      const finalSnap = await ctx.kernelSnapshotOnTab(tabId);
      check("K2 结束时内核配置仍为 assist（grant 不改变 mode）", finalSnap.snapshot?.mode === "assist", JSON.stringify(finalSnap));
      const detach2 = await ctx.popupDebuggerDetach(tabId);
      const closed = await ctx.closeWindow(created.windowId);
      ctx.record("K2", { created: { tabId, token: created.token }, attach, assist, noGrant, grant1, click1, click2, grantTtl, clickTtl, grantScope, begin, clickScope, end, clickAfterScope, grantCancel, beginCancel, endCancel, clickRefund, grantDetach, detach1, reattach, clickDetached, grantRegrant, clickRegrant, finalSnap, detach2, closed });
    },
  },
  {
    id: "K3",
    title: "跨 CDP session（未跟踪窗口）：第二个会话不得复用扩展会话的 grant",
    stage: "kernel",
    feature: "on",
    async run(ctx) {
      const ready = await ctx.kernelApiReady();
      if (!ready.ok) {
        ctx.markBlocked(ready.blocked);
        return;
      }
      const created = await ctx.createUntrackedWindow("k3");
      check("K3 创建未跟踪窗口且 beacon 就绪", created.ok === true, JSON.stringify(created).slice(0, 600));
      if (!created.ok) {
        ctx.markBlocked({ code: "untracked-window-failed", deps: ["popup 可创建未跟踪窗口"], reason: JSON.stringify(created) });
        return;
      }
      const tabId = created.tabId;
      const state = { ...created.state, tabId };
      const attach = await ctx.popupDebuggerAttach(tabId);
      check("K3 popup attach chrome.debugger（扩展会话）", attach?.attached === true, JSON.stringify(attach));
      if (attach?.attached !== true) {
        await ctx.closeWindow(created.windowId);
        ctx.markBlocked({ code: "debugger-attach-unavailable", deps: ["popup 可 attach 未跟踪窗口"], reason: JSON.stringify(attach) });
        return;
      }
      const assist = await ctx.bumpModeOnTab(tabId, "assist");
      check("K3 setOwnership(assist) accepted", assist.accepted === true, JSON.stringify(assist));
      const grant = await ctx.apiCall("grantInput", { target: { tabId }, actions: 2, ttlMs: 10000 });
      check("K3 扩展会话 grant granted（2 单位）", grant?.result?.granted === true && grant.result.actions === 2, JSON.stringify(grant));

      let second = null;
      let attachError = null;
      try {
        // 第二个 CDP 会话：浏览器级 attach 到同一个 page target（未跟踪窗口的 tab）
        const cdp = await ctx.cdp();
        const targets = await cdp.targets();
        const page = targets.find((t) => t.type === "page" && String(t.url || "").includes(created.token));
        if (!page) throw new Error("page target not found for " + created.token);
        const sessionId = await cdp.attach(page.targetId);
        second = { cdp, sessionId, targetId: page.targetId };
      } catch (error) {
        attachError = String(error?.message || error);
      }
      let secondResult = null;
      if (second) {
        const x = Math.round((state.rects.btn.x + state.rects.btn.w / 2) * (Number(state.viewport.dpr) || 1));
        const y = Math.round((state.rects.btn.y + state.rects.btn.h / 2) * (Number(state.viewport.dpr) || 1));
        try {
          await second.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, second.sessionId, 15000);
          await second.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, second.sessionId, 15000);
          secondResult = { ok: true, error: null };
        } catch (error) {
          secondResult = { ok: false, error: String(error?.message || error), code: error?.code ?? null };
        }
      }
      await sleep(500);
      const clicks = ((servers.stateFor(created.token) || {}).state || {}).clicks;
      check(
        "K3 第二个 CDP 会话的输入被内核拒绝（-32000）且 DOM 不变",
        !!second && secondResult && secondResult.ok === false && /InputOwnership: debugger input rejected/i.test(String(secondResult.error)) && clicks === 0,
        JSON.stringify({ attachError, secondResult, clicks }),
      );
      const extClick = await ctx.kernelMouseClick(state);
      await sleep(500);
      check(
        "K3 扩展会话的 grant 仍可用（第二个会话未消耗）",
        extClick.press.ok === true && ((servers.stateFor(created.token) || {}).state || {}).clicks === 1,
        JSON.stringify({ extClick, clicks: ((servers.stateFor(created.token) || {}).state || {}).clicks }),
      );
      const snap = await ctx.kernelSnapshotOnTab(tabId);
      check("K3 第二个会话不得改变 mode/version", snap.snapshot?.mode === "assist" && snap.snapshot?.version === assist.version, JSON.stringify(snap));
      const detach = await ctx.popupDebuggerDetach(tabId);
      const closed = await ctx.closeWindow(created.windowId);
      ctx.record("K3", { created: { tabId, token: created.token }, attach, assist, grant, attachError, secondResult, extClick, snap, detach, closed });
    },
  },
  {
    id: "K4",
    title: "内核 human_presence：事件桥 + 30s human latch（managed-visible 窗口）",
    stage: "kernel",
    feature: "on-visible",
    async run(ctx) {
      const ready = await ctx.kernelApiReady();
      if (!ready.ok) {
        ctx.markBlocked(ready.blocked);
        return;
      }
      const key = "k4";
      // 冷启动即带 --browser-cli-user-explicit-show：产品应创建并呈现恰好一个窗口。
      const visibleWindow = await ctx.findColdStartVisibleWindow(20000);
      const producerLog = await ctx.showProducerLog();
      check(
        "K4 冷启动 user-explicit-show 呈现了一个可见窗口（visible=true）",
        !!visibleWindow.window,
        JSON.stringify({ window: visibleWindow.window, allWindows: visibleWindow.allWindows, producerLog }).slice(0, 2000),
      );
      if (!visibleWindow.window) {
        ctx.record("K4", { visibleWindow, producerLog });
        ctx.markBlocked({
          code: "managed-visible-show-failed",
          deps: ["内核新增用户显式 show 入口，或修复冷启动 show 的可见性"],
          reason:
            "冷启动带 --browser-cli-user-explicit-show + --no-startup-window 后没有任何窗口 visible=true；" +
            "原始窗口状态与 producer log 见 evidence。不再使用第二次 show 进程。",
        });
        return;
      }
      const tokenValue = ctx.token + "-k4";
      const nav = await ctx.navigateInitialTab(ctx.mainOrigin + "/k4?token=" + tokenValue, tokenValue);
      check("K4 可见窗口的 tab 已导航到 fixture（beacon 就绪）", nav.ok === true, JSON.stringify(nav).slice(0, 800));
      if (!nav.ok) {
        ctx.record("K4", { visibleWindow, producerLog, nav });
        ctx.markBlocked({
          code: "visible-window-navigation-failed",
          deps: ["可用扩展 tabs API 把初始可见 tab 导航到 fixture"],
          reason: "初始可见 tab 导航失败：" + JSON.stringify(nav),
        });
        return;
      }
      const tabId = nav.tabId;
      ctx.registerWindow(key, visibleWindow.window.hwnd, visibleWindow.widget ? visibleWindow.widget.hwnd : null, visibleWindow.window.rect, visibleWindow.window.title);
      ctx.spaces[key] = { spaceId: "cold-start-visible", tabId, windowId: nav.windowId, url: ctx.mainOrigin + "/k4?token=" + tokenValue, token: tokenValue, kind: "cold-start-visible" };
      const foregroundBefore = (await win32.call("foreground")).hwnd;
      // 冷启动 show 已经呈现窗口：不再调用第二次 show。
      const show = { visible: true, coldStart: true, foregroundBefore, producerLog };
      if (!visibleWindow.widget) {
        ctx.record("K4", { visibleWindow, producerLog, nav });
        ctx.markBlocked({ code: "visible-window-widget-missing", deps: ["可见窗口的 render widget HWND"], reason: "可见窗口没有可用的 Chrome_RenderWidgetHostHWND" });
        return;
      }
      // popup 页面的 chrome.debugger 作为 AI 输入客户端（该 tab 不在任何 Task Space 里）。
      const attach = await ctx.popupDebuggerAttach(tabId);
      check("K4 popup attach chrome.debugger（冷启动可见 tab）", attach?.attached === true, JSON.stringify(attach));
      if (attach?.attached !== true) {
        ctx.record("K4", { visibleWindow, nav, attach });
        ctx.markBlocked({ code: "debugger-attach-unavailable", deps: ["popup 可 attach 冷启动可见 tab"], reason: JSON.stringify(attach) });
        return;
      }
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      const listenerSetup = await cdp.evaluate(
        popup.sessionId,
        "(() => { window.__bpPresence = []; const io = (typeof chrome !== 'undefined') ? (chrome.browserCliInputOwnership || (chrome.browserCli && chrome.browserCli.inputOwnership) || null) : null; if (!io || !io.onHumanPresence) return {ok:false, keys: io ? Object.keys(io) : null}; io.onHumanPresence.addListener((e) => { window.__bpPresence.push(e); }); return {ok:true}; })()",
      );
      check("K4 受信扩展页面可注册 onHumanPresence", listenerSetup?.ok === true, JSON.stringify(listenerSetup));

      // 冷启动可见 tab 不在 Task Space 中；popup 已 attach chrome.debugger，
      // 直接用 tabId 注入，不经过 ctx.ai（后者需要真实 space）。
      const assist = await ctx.bumpMode(key, "assist");
      check("K4 setOwnership(assist) accepted", assist.bumped?.result?.accepted === true, JSON.stringify(assist));

      const before = await ctx.probe(key);
      // The real keyboard path (SendKeys -> TSF) is more reliable than hitting a
      // stale render-widget HWND after navigation. Focus the input via CDP, then
      // send a real OS key; the kernel still sees a trusted human key event.
      const humanTypeReal = async () => {
        await cdp.evaluate(popup.sessionId, "window.__bpPresence = []").catch(() => null);
        const clicked = await ctx.humanClick(key, before.rects.btn, { real: true });
        await sleep(900);
        return clicked;
      };
      const human = await humanTypeReal();
      const presence = await cdp.evaluate(popup.sessionId, "(window.__bpPresence || []).slice(-8)");
      const winState = await win32.call("state", { hwnd: ctx.windows[key].hwnd });
      ctx.record("K4", { show, listenerSetup, assist, before, human, presence, window: winState.window });
      if (!human.landed || !Array.isArray(presence) || presence.length === 0) {
        ctx.markBlocked({
          code: "managed-human-input-unavailable",
          deps: ["managed hidden 窗口的人类输入注入（真实 OS 输入或可显示的窗口）"],
          reason:
            "K4 需要真实人类输入才能产生内核 human_presence。managed 模式下窗口以 hidden 创建，PostMessage 注入未落地（human.landed=" +
            human.landed + "），因此事件桥与 1s pause 无法在本环境验证；不用脚本事件冒充。",
        });
        return;
      }
      check("K4 人类输入产生 onHumanPresence 事件", presence.length >= 1, JSON.stringify(presence));
      check("K4 onHumanPresence 携带 tabId/kind/at", presence.length > 0 && presence.every((e) => Number(e?.tabId) === tabId && typeof e?.kind === "string" && typeof e?.at === "number"), JSON.stringify(presence));
      const snapAfterPresence = await ctx.kernelSnapshot(key);
      check("K4 presence 不改变 mode（内核不擅自迁移所有权）", snapAfterPresence.snapshot?.mode === "assist", JSON.stringify(snapAfterPresence));

      const grant = await ctx.apiCall("grantInput", { target: { tabId }, actions: 2, ttlMs: 10000 });
      check("K4 pause 测试前 grant granted（2 单位）", grant?.result?.granted === true, JSON.stringify(grant));
      const human2 = await humanTypeReal();
      const popupClick = () => ctx.kernelMouseClick({ ...before, tabId });
      const pausedClick = await popupClick();
      const afterPaused = await ctx.probe(key);
      const kernelRejected = /InputOwnership: debugger input rejected/i;
      check(
        "K4 人类输入后 1s 内的 AI click 被暂停（human pause）",
        human2.landed === true && pausedClick.rejected === true && kernelRejected.test(String(pausedClick.error)),
        JSON.stringify({ human2, pausedClick, clicks: afterPaused.clicks }),
      );
      // Patch 032: the latch is 30s, so an unresponsive SW cannot re-grab input
      // after 1s. A responsive extension must explicitly acknowledge presence
      // with a per-tab setOwnership (same version is enough) to release it.
      await sleep(1300);
      const afterLatch = await popupClick();
      check(
        "K4 人类输入后 >1s（1.3s）AI click 仍被 30s latch 拒绝（SW 失联不抢输入）",
        afterLatch.rejected === true && kernelRejected.test(String(afterLatch.error)),
        JSON.stringify(afterLatch),
      );
      const snapBeforeClear = await ctx.kernelSnapshot(key);
      const clearLatch = await ctx.apiCall("setOwnership", {
        target: { tabId },
        mode: "assist",
        version: snapBeforeClear.snapshot.version,
      });
      check(
        "K4 显式 setOwnership（同版本）清除 human latch",
        clearLatch?.result?.accepted === true,
        JSON.stringify({ snapBeforeClear, clearLatch }),
      );
      const afterPause = await popupClick();
      const clickSecond = await popupClick();
      const clickThird = await popupClick();
      await sleep(450);
      const final = await ctx.probe(key);
      check(
        "K4 清除 latch 后不改 grant：2 次 click 成功，第 3 次被拒",
        afterPause.press.ok === true && clickSecond.press.ok === true && clickThird.rejected === true,
        JSON.stringify({ afterPause, clickSecond, clickThird, clicks: final.clicks }),
      );
      ctx.record("K4", { snapAfterPresence, grant, pausedClick, afterLatch, clearLatch, afterPause, clickSecond, clickThird, final });
      await ctx.bumpMode(key, "ai").catch(() => undefined);
    },
  },
  {
    id: "IME",
    title: "真实搜狗 TSF IME：input/textarea/contenteditable、候选词、退格、HUMAN/ASSIST",
    stage: "kernel",
    feature: "on-visible",
    async run(ctx) {
      const ready = await ctx.kernelApiReady();
      if (!ready.ok) { ctx.markBlocked(ready.blocked); return; }
      const visibleWindow = await ctx.findColdStartVisibleWindow(20000);
      check("IME 冷启动 user-explicit-show 呈现可见窗口", !!visibleWindow.window, JSON.stringify(visibleWindow.window));
      if (!visibleWindow.window || !visibleWindow.widget) {
        ctx.markBlocked({ code: "visible-window-unavailable", deps: ["可见 managed 窗口 + render widget"], reason: JSON.stringify(visibleWindow) });
        return;
      }
      const tokenValue = ctx.token + "-ime";
      const widget = visibleWindow.widget.hwnd;
      const cdp = await ctx.cdp();
      const popup = await ctx.ensurePopup();
      const url = ctx.mainOrigin + "/ime-inputs?token=" + tokenValue;
      // K4 and IME share the on-visible session. Do not rely on "first newtab"
      // (it can be a tab in a different, non-visible window): create the IME
      // tab in the window that holds the cold-start visible K4 fixture.
      const created = await cdp.evaluate(
        popup.sessionId,
        "new Promise((resolve) => { try { chrome.windows.getAll({populate: true}, (ws) => { const w = (ws || []).find((x) => x.type === 'normal' && (x.tabs || []).some((t) => String(t.title || '').startsWith('ia-'))) || (ws || []).find((x) => x.focused) || (ws || [])[0]; if (!w) { resolve({ok:false, reason:'no-window'}); return; } chrome.windows.update(w.id, {focused: true}, () => { chrome.tabs.create({windowId: w.id, url: " + JSON.stringify(url) + ", active: true}, (tab) => resolve({ok: !chrome.runtime.lastError && !!tab, tabId: tab ? tab.id : null, windowId: tab ? tab.windowId : null, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})); }); }); } catch (e) { resolve({ok:false, error:String((e && e.message) || e)}); } })",
        { timeoutMs: 30000 },
      ).catch((error) => ({ ok: false, error: String(error) }));
      const nav = { ok: created?.ok === true, tabId: created?.tabId, windowId: created?.windowId, created };
      check("IME 在可见窗口新建 IME tab", nav.ok === true, JSON.stringify(nav));
      if (!nav.ok) { ctx.markBlocked({ code: "ime-navigation-failed", deps: ["tabs API 在可见窗口新建 tab"], reason: JSON.stringify(nav) }); return; }
      const tabId = nav.tabId;
      let target = null;
      for (let i = 0; i < 100 && !target; i++) {
        target = await cdp.findTarget("ime-inputs", "page").catch(() => null);
        if (!target) await sleep(150);
      }
      check("IME fixture target 已就绪", !!target, JSON.stringify(target));
      if (!target) { ctx.markBlocked({ code: "ime-target-missing", deps: ["IME fixture 页面 target"], reason: JSON.stringify(created) }); return; }
      const sess = await cdp.attach(target.targetId);
      const imeEval = async (expr) => await cdp.evaluate(sess, expr, { timeoutMs: 10000 });
      const readIme = async () => {
        const raw = await imeEval("JSON.stringify(window.__ime())");
        return JSON.parse(raw);
      };
      const rects = await imeEval("(()=>{const r={};for(const id of ['in','ta','ce']){const b=document.getElementById(id).getBoundingClientRect();r[id]={x:b.x,y:b.y,w:b.width,h:b.height};}return JSON.stringify(r);})()");
      const rect = JSON.parse(rects);
      const clickField = async (id) => {
        const r = rect[id];
        return await win32.call("realMouse", { hwnd: widget, x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
      };
      const realKey = async (vk) => {
        const down = await win32.call("realKey", { hwnd: widget, vk, down: true });
        await sleep(25);
        const up = await win32.call("realKey", { hwnd: widget, vk, down: false });
        await sleep(120);
        return { down, up };
      };
      const typeLetters = async (text) => {
        // WScript.Shell.SendKeys goes through the real OS keyboard input path
        // (including TSF/IME), unlike a page-level DOM event.
        await win32.call("sendKeys", { text });
        await sleep(250);
      };
      const commitCandidate = async () => {
        await win32.call("sendKeys", { text: " " }); // space commits the first candidate
        await sleep(500);
      };

      const before = await readIme();
      check("IME fixture 就绪且三个输入面存在", before && before.values && "in" in before.values && "ta" in before.values && "ce" in before.values, JSON.stringify(before));

      // input
      const clickIn = await clickField("in");
      await imeEval("document.getElementById('in').focus(); true").catch(() => null);
      await sleep(400);
      const afterFocus = await readIme();
      check("IME 点击后 input 获得焦点", afterFocus.active === "in", JSON.stringify({ clickIn, active: afterFocus.active, focus: afterFocus.focus }));
      await typeLetters("n");
      const firstKey = { down: { ok: true }, up: { ok: true } };
      const afterFirstKey = await readIme();
      check("IME 真实按键到达页面", afterFirstKey.keydown >= 1 || String(afterFirstKey.values.in).length > 0, JSON.stringify({ firstKey, state: afterFirstKey }));
      await typeLetters("ihao");
      await commitCandidate();
      let s = await readIme();
      if (!/[一-鿿]/.test(String(s.values.in))) {
        await win32.call("sendKeys", { text: "1" }); // fallback: candidate 1
        await sleep(300);
        s = await readIme();
      }
      check("IME input 真实 TSF 输入得到中文", /[一-鿿]/.test(String(s.values.in)), JSON.stringify({ value: s.values.in, composition: s.composition, keys: s.keys.slice(-8) }));
      const inBeforeBack = String(s.values.in);
      await win32.call("sendKeys", { text: "{BACKSPACE}" }); // backspace
      await sleep(350);
      s = await readIme();
      if (String(s.values.in).length >= inBeforeBack.length) {
        await win32.call("sendKeys", { text: "{BS}" }); // WScript SendKeys alternate syntax
        await sleep(350);
        s = await readIme();
      }
      check("IME input 退格生效", String(s.values.in).length < inBeforeBack.length, JSON.stringify({ before: inBeforeBack, after: s.values.in }));

      // textarea
      await clickField("ta");
      await imeEval("document.getElementById('ta').focus(); true").catch(() => null);
      await sleep(250);
      await typeLetters("nihao");
      await commitCandidate();
      s = await readIme();
      check("IME textarea 真实 TSF 输入得到中文", /[一-鿿]/.test(String(s.values.ta)), JSON.stringify({ value: s.values.ta, composition: s.composition }));

      // contenteditable
      await clickField("ce");
      await imeEval("document.getElementById('ce').focus(); true").catch(() => null);
      await sleep(250);
      await typeLetters("nihao");
      await commitCandidate();
      s = await readIme();
      check("IME contenteditable 真实 TSF 输入得到中文", /[一-鿿]/.test(String(s.values.ce)), JSON.stringify({ value: s.values.ce, composition: s.composition }));

      // HUMAN: AI insertText rejected, human key still lands.
      const snapForHuman = await ctx.kernelSnapshotOnTab(tabId);
      const humanVersion = Number(snapForHuman.snapshot?.version || 0) + 1;
      const human = await ctx.apiCall("setOwnership", { target: { tabId }, mode: "human", version: humanVersion });
      check("IME setOwnership(human, version+1) accepted", human?.result?.accepted === true, JSON.stringify({ snapForHuman, human }));
      await ctx.popupDebuggerAttach(tabId);
      const aiInHuman = await ctx.popupDebuggerSend(tabId, "Input.insertText", { text: "AI-SHOULD-NOT" });
      const kernelRejected = /InputOwnership: debugger input rejected/i;
      check("IME HUMAN：AI insertText 被内核拒绝", aiInHuman.ok === false && kernelRejected.test(String(aiInHuman.lastError || aiInHuman.error)), JSON.stringify(aiInHuman));
      await clickField("in");
      await imeEval("document.getElementById('in').focus(); true").catch(() => null);
      const humanBefore = (await readIme()).values.in;
      await win32.call("sendKeys", { text: "a" });
      await sleep(650); // let the real input event and human_presence reach the kernel
      s = await readIme();
      check("IME HUMAN：真实人类按键仍可输入", String(s.values.in) !== humanBefore, JSON.stringify({ before: humanBefore, after: s.values.in }));

      // ASSIST: one grant allows exactly one AI insertText, then rejects.
      const snapForAssist = await ctx.kernelSnapshotOnTab(tabId);
      const assistVersion = Number(snapForAssist.snapshot?.version || 0) + 1;
      const assist = await ctx.apiCall("setOwnership", { target: { tabId }, mode: "assist", version: assistVersion });
      check("IME setOwnership(assist, version+1) accepted", assist?.result?.accepted === true, JSON.stringify({ snapForAssist, assist }));
      const grant = await ctx.apiCall("grantInput", { target: { tabId }, actions: 1, ttlMs: 8000 });
      check("IME ASSIST grant(1) granted", grant?.result?.granted === true, JSON.stringify(grant));
      const aiAssist = await ctx.popupDebuggerSend(tabId, "Input.insertText", { text: "-AI" });
      s = await readIme();
      await sleep(450); // text burst window is 300ms; make the second call a separate gesture
      const aiSecond = await ctx.popupDebuggerSend(tabId, "Input.insertText", { text: "-MORE" });
      check("IME ASSIST：grant 内 AI insertText 落地一次，第二次被拒", aiAssist.ok === true && /-AI/.test(String(s.values.in)) && aiSecond.ok === false, JSON.stringify({ aiAssist, aiSecond, value: s.values.in }));

      // Recovery: HUMAN again, then explicit ASSIST same version clears latch.
      const snapForHuman2 = await ctx.kernelSnapshotOnTab(tabId);
      const human2Version = Number(snapForHuman2.snapshot?.version || 0) + 1;
      const human2 = await ctx.apiCall("setOwnership", { target: { tabId }, mode: "human", version: human2Version });
      check("IME HUMAN 恢复 accepted", human2?.result?.accepted === true, JSON.stringify({ snapForHuman2, human2 }));
      await clickField("in");
      await imeEval("document.getElementById('in').focus(); true").catch(() => null);
      await win32.call("sendKeys", { text: "b" }); // real human event creates the 30s latch
      await sleep(650); // do not clear the latch before the human event lands
      const snapForHuman3 = await ctx.kernelSnapshotOnTab(tabId);
      const human3Version = Number(snapForHuman3.snapshot?.version || 0) + 1;
      const human3 = await ctx.apiCall("setOwnership", { target: { tabId }, mode: "assist", version: human3Version });
      const grant2 = await ctx.apiCall("grantInput", { target: { tabId }, actions: 1, ttlMs: 8000 });
      const aiRecover = await ctx.popupDebuggerSend(tabId, "Input.insertText", { text: "-OK" });
      check("IME ASSIST 恢复：显式 setOwnership 后 AI insertText 成功", human3?.result?.accepted === true && grant2?.result?.granted === true && aiRecover.ok === true, JSON.stringify({ human3, grant2, aiRecover }));

      const final = await readIme().catch((error) => ({ error: String(error) }));
      const detach = await ctx.popupDebuggerDetach(tabId);
      const closed = await ctx.closeTab(tabId);
      ctx.record("IME", { visibleWindow: visibleWindow.window, nav, tabId, before, final, human, aiInHuman, assist, grant, aiAssist, aiSecond, human2, human3, grant2, aiRecover, detach, closed });
    },
  },
];

function caseSelected(c) {
  if (!STAGES.has("all") && !STAGES.has(c.stage)) return false;
  if (c.feature && !FEATURE_FILTER.has(c.feature)) return false;
  return true;
}

function caseStatus(c) {
  if (c.blocked) return "blocked";
  return "ready";
}

// ---------------------------------------------------------------- matrix printing
function printMatrix() {
  const rows = CASES.map((c) => ({
    id: c.id,
    stage: c.stage,
    feature: c.feature || "-",
    status: caseStatus(c),
    dep: c.blocked ? c.blocked.deps.join(" | ") : "-",
    title: c.title,
  }));
  console.log("=== input-arbitration E2E 用例矩阵 ===");
  console.log("id   stage      feat  status   title / 依赖");
  for (const row of rows) {
    console.log(
      String(row.id).padEnd(4) + " " + String(row.stage).padEnd(10) + " " + String(row.feature).padEnd(5) + " " +
        String(row.status).padEnd(8) + " " + row.title + (row.dep !== "-" ? "  <= " + row.dep : ""),
    );
  }
  const ready = rows.filter((r) => r.status === "ready").length;
  const blocked = rows.length - ready;
  console.log("\nready=" + ready + " blocked=" + blocked + " total=" + rows.length);
  console.log("\n前置条件：");
  console.log("  platform win32                    = " + (process.platform === "win32"));
  console.log("  patched chrome.exe                = " + fs.existsSync(CHROME) + " (" + CHROME + ")");
  console.log("  content.dll 含 " + FEATURE + " = " + report.env.contentDllFeature + " (" + (report.env.contentDll || "n/a") + ")");
  console.log("  chrome.dll 含 browserCliInputOwnership = " + report.env.chromeDllApi);
  console.log("  extension dist/manifest.json      = " + fs.existsSync(path.join(DIST, "manifest.json")));
  const hostExe = findNewestHostExe(root);
  console.log("  native host exe                   = " + (hostExe || "missing (run npm run build:host)"));
  console.log("  fixtures                          = " + (fs.existsSync(FIXTURE_MAIN) && fs.existsSync(FIXTURE_FRAME)));
  console.log("  D:/c/logs writable                = " + fs.existsSync(LOG_DIR));
  console.log("\n运行全部可跑用例：node scripts/test-input-arbitration-e2e.mjs");
  console.log("只跑某阶段：      node scripts/test-input-arbitration-e2e.mjs --stage=human,baseline --feature=off");
}

// ---------------------------------------------------------------- win32 helper
const WIN32_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class BpW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetFocus();
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint mapType);

  public static List<IntPtr> Top() {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Kids(IntPtr parent) {
    List<IntPtr> list = new List<IntPtr>();
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }
  public static string Cls(IntPtr h) { StringBuilder s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }
}
'@

$script:currentId = $null
$script:running = $true

function Reply($obj) {
  if ($null -ne $script:currentId) { $obj['id'] = $script:currentId }
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-Info([System.IntPtr]$h) {
  $r = [BpW+RECT]::new()
  $ok = [BpW]::GetWindowRect($h, [ref]$r)
  $procId = [uint32]0
  [void][BpW]::GetWindowThreadProcessId($h, [ref]$procId)
  $rect = $null
  if ($ok) { $rect = @([int]$r.Left, [int]$r.Top, [int]($r.Right - $r.Left), [int]($r.Bottom - $r.Top)) }
  return [ordered]@{
    hwnd = $h.ToInt64()
    pid = [int]$procId
    className = [BpW]::Cls($h)
    title = [BpW]::Text($h)
    visible = [bool][BpW]::IsWindowVisible($h)
    iconic = [bool][BpW]::IsIconic($h)
    rect = $rect
    above = ([BpW]::GetWindow($h, 3)).ToInt64()
    below = ([BpW]::GetWindow($h, 2)).ToInt64()
  }
}

function Mouse-LParam([int]$x, [int]$y) {
  return [IntPtr]((($y -shl 16) -bor ($x -band 0xFFFF)))
}

while ($script:running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    $script:currentId = $cmd.id
    $op = [string]$cmd.op
    switch ($op) {
      'ping' { Reply ([ordered]@{ ok = $true; pong = $true; pid = $PID }) }
      'foreground' { Reply ([ordered]@{ ok = $true; hwnd = ([BpW]::GetForegroundWindow()).ToInt64() }) }
      'screen' {
        Add-Type -AssemblyName System.Windows.Forms
        $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        Reply ([ordered]@{ ok = $true; rect = @([int]$s.X, [int]$s.Y, [int]$s.Width, [int]$s.Height) })
      }
      'listWindows' {
        $wantPid = 0
        if ($cmd.pid) { $wantPid = [int]$cmd.pid }
        $onlyVisible = [bool]$cmd.visibleOnly
        $list = New-Object System.Collections.ArrayList
        foreach ($h in [BpW]::Top()) {
          $info = Get-Info $h
          if ($wantPid -ne 0 -and $info.pid -ne $wantPid) { continue }
          if ($onlyVisible -and -not $info.visible) { continue }
          [void]$list.Add($info)
        }
        Reply ([ordered]@{ ok = $true; windows = @($list); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'state' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        Reply ([ordered]@{ ok = $true; window = (Get-Info $h); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'children' {
        $p = [System.IntPtr]([int64]$cmd.hwnd)
        $list = New-Object System.Collections.ArrayList
        foreach ($h in [BpW]::Kids($p)) {
          $r = [BpW+RECT]::new()
          [void][BpW]::GetClientRect($h, [ref]$r)
          $info = Get-Info $h
          [void]$list.Add([ordered]@{
            hwnd = $h.ToInt64(); className = [BpW]::Cls($h);
            clientWidth = [int]($r.Right - $r.Left); clientHeight = [int]($r.Bottom - $r.Top);
            visible = $info.visible; rect = $info.rect;
          })
        }
        Reply ([ordered]@{ ok = $true; children = @($list) })
      }
      'move' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $flags = 0x0010 -bor 0x0040
        if ([bool]$cmd.noActivate) { $flags = $flags -bor 0x0004 }
        $okMove = [BpW]::SetWindowPos($h, [System.IntPtr]::Zero, [int]$cmd.x, [int]$cmd.y, [int]$cmd.width, [int]$cmd.height, [uint32]$flags)
        Reply ([ordered]@{ ok = [bool]$okMove; window = (Get-Info $h); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'mouse' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $x = [int]$cmd.x; $y = [int]$cmd.y
        $type = [string]$cmd.type
        $msg = 0x0200; $wp = 0
        if ($type -eq 'move') { $msg = 0x0200; $wp = [int]$cmd.buttons }
        elseif ($type -eq 'down') { $msg = 0x0201; $wp = 1 }
        elseif ($type -eq 'up') { $msg = 0x0202; $wp = 0 }
        elseif ($type -eq 'rdown') { $msg = 0x0204; $wp = 2 }
        elseif ($type -eq 'rup') { $msg = 0x0205; $wp = 0 }
        else { Reply ([ordered]@{ ok = $false; error = ('bad mouse type: ' + $type) }); continue }
        $okPost = [BpW]::PostMessageW($h, [uint32]$msg, [IntPtr]([int64]$wp), (Mouse-LParam $x $y))
        Reply ([ordered]@{ ok = [bool]$okPost; msg = $msg; x = $x; y = $y })
      }
      'realMouse' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $root = [BpW]::GetAncestor($h, 2)
        [void][BpW]::ShowWindow($root, 5)
        [void][BpW]::SetWindowPos($root, [System.IntPtr]::Zero, 0, 0, 0, 0, [uint32](0x0040 -bor 0x0002 -bor 0x0001))
        $fgOk = [BpW]::SetForegroundWindow($root)
        [void][BpW]::SetActiveWindow($root)
        [void][BpW]::SetFocus($h)
        Start-Sleep -Milliseconds 80
        $pt = [BpW+POINT]::new()
        $pt.X = [int]$cmd.x; $pt.Y = [int]$cmd.y
        [void][BpW]::ClientToScreen($h, [ref]$pt)
        $okPos = [BpW]::SetCursorPos($pt.X, $pt.Y)
        Start-Sleep -Milliseconds 60
        [BpW]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [BpW]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Reply ([ordered]@{ ok = [bool]$okPos; fgOk = [bool]$fgOk; screen = @($pt.X, $pt.Y); root = $root.ToInt64(); foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'sendKeys' {
        if ($cmd.hwnd) {
          $h = [System.IntPtr]([int64]$cmd.hwnd)
          $root = [BpW]::GetAncestor($h, 2)
          [void][BpW]::ShowWindow($root, 5)
          [void][BpW]::SetWindowPos($root, [System.IntPtr]::Zero, 0, 0, 0, 0, [uint32](0x0040 -bor 0x0002 -bor 0x0001))
          [void][BpW]::SetForegroundWindow($root)
          [void][BpW]::SetActiveWindow($root)
          Start-Sleep -Milliseconds 80
        }
        $wshell = New-Object -ComObject WScript.Shell
        $text = [string]$cmd.text
        $wshell.SendKeys($text)
        Reply ([ordered]@{ ok = $true; text = $text; foreground = ([BpW]::GetForegroundWindow()).ToInt64() })
      }
      'realKey' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $root = [BpW]::GetAncestor($h, 2)
        [void][BpW]::ShowWindow($root, 5)
        [void][BpW]::SetWindowPos($root, [System.IntPtr]::Zero, 0, 0, 0, 0, [uint32](0x0040 -bor 0x0002 -bor 0x0001))
        $rootPid = [uint32]0
        $rootThread = [BpW]::GetWindowThreadProcessId($root, [ref]$rootPid)
        $selfThread = [BpW]::GetCurrentThreadId()
        [void][BpW]::AttachThreadInput($selfThread, $rootThread, $true)
        [void][BpW]::SetForegroundWindow($root)
        [void][BpW]::SetActiveWindow($root)
        [void][BpW]::SetFocus($h)
        Start-Sleep -Milliseconds 80
        $focusNow = ([BpW]::GetFocus()).ToInt64()
        $vk = [int]$cmd.vk
        $scan = [BpW]::MapVirtualKeyW([uint32]$vk, 0)
        $flags = 0
        if (-not [bool]$cmd.down) { $flags = 2 }
        [BpW]::keybd_event([byte]$vk, [byte]$scan, [uint32]$flags, [UIntPtr]::Zero)
        $focusAfter = ([BpW]::GetFocus()).ToInt64()
        [void][BpW]::AttachThreadInput($selfThread, $rootThread, $false)
        Reply ([ordered]@{ ok = $true; vk = $vk; scan = $scan; root = $root.ToInt64(); foreground = ([BpW]::GetForegroundWindow()).ToInt64(); focus = $focusAfter; focusBefore = $focusNow })
      }
      'wheel' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $pt = [BpW+POINT]::new()
        $pt.X = [int]$cmd.x; $pt.Y = [int]$cmd.y
        [void][BpW]::ClientToScreen($h, [ref]$pt)
        $screenLParam = [IntPtr]((($pt.Y -shl 16) -bor ($pt.X -band 0xFFFF)))
        $delta = [int]$cmd.delta
        $wp = ([IntPtr]((($delta -band 0xFFFF) -shl 16)))
        $okPost = [BpW]::PostMessageW($h, 0x020A, $wp, $screenLParam)
        Reply ([ordered]@{ ok = [bool]$okPost; screen = @($pt.X, $pt.Y); delta = $delta })
      }
      'key' {
        $h = [System.IntPtr]([int64]$cmd.hwnd)
        $vk = [int]$cmd.vk
        $scan = [BpW]::MapVirtualKeyW([uint32]$vk, 0)
        if ([bool]$cmd.down) {
          $lparam = [IntPtr](1 -bor ($scan -shl 16))
          $okPost = [BpW]::PostMessageW($h, 0x0100, [IntPtr]([int64]$vk), $lparam)
        } else {
          $lparam = [IntPtr](0xC0000001 -bor ($scan -shl 16))
          $okPost = [BpW]::PostMessageW($h, 0x0101, [IntPtr]([int64]$vk), $lparam)
        }
        Reply ([ordered]@{ ok = [bool]$okPost; vk = $vk; scan = $scan })
      }
      'shutdown' { Reply ([ordered]@{ ok = $true }); $script:running = $false }
      default { Reply ([ordered]@{ ok = $false; error = ('unknown op: ' + $op) }) }
    }
  } catch {
    Reply ([ordered]@{ ok = $false; error = $_.Exception.Message })
  }
}
`;

class Win32Helper {
  constructor(psFile) {
    this.psFile = psFile;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
  }
  async start() {
    fs.writeFileSync(this.psFile, WIN32_PS, "utf8");
    this.child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.psFile],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
    });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("win32 helper exited (code " + code + "): " + this.stderr.slice(-800)));
      }
      this.pending.clear();
    });
    const pong = await this.call("ping", {}, 20000);
    if (!pong?.ok) throw new Error("win32 helper ping failed: " + JSON.stringify(pong));
  }
  call(op, args = {}, timeoutMs = 20000) {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error("win32 helper is not running"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("win32 op " + op + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }
  async stop() {
    if (!this.child) return;
    try {
      await this.call("shutdown", {}, 8000).catch(() => undefined);
    } finally {
      try { this.child.kill(); } catch {}
      await sleep(150);
    }
  }
}

// ---------------------------------------------------------------- fixture servers
// 主页面每 200ms 用 fetch POST 回自己的状态；HUMAN 模式下扩展会拒绝 js/tab_cdp_call，
// 这条外观测通道不经过任何扩展命令，是 HUMAN/OOPIF 用例的唯一可信观察面。
const pageStates = new Map();
function startServers() {
  const mainHtml = fs.readFileSync(FIXTURE_MAIN, "utf8");
  const frameHtml = fs.readFileSync(FIXTURE_FRAME, "utf8");
  const imeHtml = fs.readFileSync(FIXTURE_IME, "utf8");
  pageStates.clear();
  const handler = (body) => (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/state") {
      const token = url.searchParams.get("token") || "";
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 2 * 1024 * 1024) req.destroy();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            pageStates.set(token, { state: parsed, receivedAt: Date.now() });
          } catch {
            // ignore malformed beacon
          }
          res.writeHead(204);
          res.end();
        });
        return;
      }
      const entry = pageStates.get(token);
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(entry.state));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/ime-inputs") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(imeHtml);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  };
  const make = (address, body) =>
    new Promise((resolve, reject) => {
      const server = http.createServer(handler(body));
      server.once("error", reject);
      server.listen(0, address, () => resolve({ server, port: server.address().port, address }));
    });
  return Promise.all([make("127.0.0.1", mainHtml), make("127.0.0.2", frameHtml)]).then(([main, frame]) => ({
    main,
    frame,
    mainOrigin: "http://127.0.0.1:" + main.port,
    frameOrigin: "http://127.0.0.2:" + frame.port,
    stateFor(token) {
      return pageStates.get(token) || null;
    },
    close() {
      main.server.close();
      frame.server.close();
    },
  }));
}

function httpGetJson(port, pathAndQuery, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathAndQuery, timeout: timeoutMs }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// ---------------------------------------------------------------- host / TCP
function sessionsDirFor(lad) {
  return path.join(lad, "BrowserPilot", "sessions");
}
function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
function readSessions(lad) {
  const dir = sessionsDirFor(lad);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (Number.isInteger(parsed.port) && typeof parsed.authToken === "string" && Number.isInteger(parsed.pid)) {
        out.push({ ...parsed, file: path.join(dir, file) });
      }
    } catch {
      // partial file
    }
  }
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
async function waitForHostSession(lad, { timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = readSessions(lad).filter((s) => pidAlive(s.pid) && Date.now() - Number(s.updatedAt || 0) < 180000);
    if (candidates.length) return candidates[0];
    await sleep(200);
  }
  throw new Error("timed out waiting for a live native host session in " + sessionsDirFor(lad));
}

let requestSeq = 0;
function tcpRequest(port, authToken, agentId, name, args = {}, { space, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const requestId = "ia-" + ++requestSeq;
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(name + " timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    const finish = (fn, value) => {
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          type: "command",
          name,
          args,
          requestId,
          agentId,
          authToken,
          ...(space ? { space } : {}),
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "result" && message.requestId === requestId) {
          finish(resolve, message);
          return;
        }
        if (message.type === "error") {
          finish(reject, new Error("host error: " + message.error));
          return;
        }
      }
    });
    socket.on("error", (error) => finish(reject, error));
  });
}

class HostClient {
  constructor(session, agentId) {
    this.port = session.port;
    this.authToken = session.authToken;
    this.agentId = agentId;
  }
  async call(name, args = {}, options = {}) {
    const result = await tcpRequest(this.port, this.authToken, this.agentId, name, args, options);
    if (result.ok !== true) {
      const error = new Error(name + " failed: " + (result.error || "unknown"));
      error.code = result.errorCode;
      error.result = result;
      throw error;
    }
    return result.data;
  }
  async request(name, args = {}, options = {}) {
    try {
      return { ok: true, data: await this.call(name, args, options), error: null, errorCode: null };
    } catch (error) {
      return { ok: false, data: null, error: error.message, errorCode: error.code || null };
    }
  }
}

// ---------------------------------------------------------------- browser-level CDP (observation only)
async function readDevToolsPort(profileDir, timeoutMs = 30000) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) return { port: Number(lines[0]), wsPath: lines[1] };
    } catch {
      // not written yet
    }
    await sleep(150);
  }
  return null;
}

async function browserTargets(profileDir) {
  const active = await readDevToolsPort(profileDir);
  if (!active) return { ok: false, error: "DevToolsActivePort not found" };
  const url = "ws://127.0.0.1:" + active.port + active.wsPath;
  return await new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ ok: false, error: "browser CDP timeout" });
    }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, error: "browser CDP websocket error" });
    };
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ ok: true, targets: message.result?.targetInfos || [], raw: message });
    };
  });
}

/**
 * 浏览器级 DevTools 客户端（只在测试侧使用）：
 *  - 观察 OOPIF target（Target.getTargets）；
 *  - 以受信扩展页面（chrome-extension://<id>/popup/index.html）为上下文执行
 *    chrome.browserCli.inputOwnership.*（生产 API 的真实调用方）；
 *  - 建立**第二个** CDP session 用于跨会话注入测试（K3）。
 * 它不替代产品链路：AI 输入仍然只走 host → chrome.debugger。
 */
class BrowserCdp {
  constructor(profileDir) {
    this.profileDir = profileDir;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.eventHandlers = [];
  }
  onEvent(handler) {
    this.eventHandlers.push(handler);
  }
  async connect(timeoutMs = 25000) {
    const active = await readDevToolsPort(this.profileDir);
    if (!active) throw new Error("DevToolsActivePort not found");
    const url = "ws://127.0.0.1:" + active.port + active.wsPath;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("browser CDP connect timeout"));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("browser CDP websocket error"));
      };
      ws.onclose = () => {
        this.closed = true;
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("browser CDP closed"));
        }
        this.pending.clear();
      };
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id === undefined) {
          for (const handler of this.eventHandlers) {
            try { handler(message); } catch {}
          }
          return;
        }
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) {
          const error = new Error(message.error.message || "CDP error");
          error.code = message.error.code;
          item.reject(error);
          return;
        }
        item.resolve(message.result);
      };
    });
    try {
      await this.send("Target.setDiscoverTargets", { discover: true });
    } catch {
      // 旧版本可能不接受该参数；getTargets 仍然可用。
    }
    return this;
  }
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    if (!this.ws || this.closed) return Promise.reject(new Error("browser CDP not connected"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async targets() {
    const result = await this.send("Target.getTargets");
    return result?.targetInfos || [];
  }
  async findTarget(needle, type = "page") {
    const deadline = Date.now() + 30000;
    let last = [];
    while (Date.now() < deadline) {
      last = await this.targets();
      const hit = last.find((t) => (!type || t.type === type) && String(t.url || "").includes(needle));
      if (hit) return hit;
      await sleep(250);
    }
    throw new Error("CDP target not found: " + needle + " (targets=" + JSON.stringify(last.map((t) => ({ type: t.type, url: String(t.url || "").slice(0, 100) }))) + ")");
  }
  async attach(targetId) {
    const result = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return result.sessionId;
  }
  async evaluate(sessionId, expression, { awaitPromise = true, timeoutMs = 20000 } = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true },
      sessionId,
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error("Runtime.evaluate exception: " + JSON.stringify(result.exceptionDetails).slice(0, 1000));
    }
    return result.result ? result.result.value : undefined;
  }
  close() {
    try { if (this.ws) this.ws.close(); } catch {}
  }
}

// ---------------------------------------------------------------- powershell one-shot helpers
function runPowerShellFile(file, args, timeoutMs = 60000) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
  );
  const lines = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  let json;
  try {
    json = lines.length ? JSON.parse(lines[lines.length - 1]) : undefined;
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function registryDefault(keyPath) {
  const script =
    "$k='" + keyPath.replace(/'/g, "''") + "';" +
    "if (Test-Path -LiteralPath $k) { $i=Get-Item -LiteralPath $k; if (@($i.GetValueNames()) -contains '') { $v=$i.GetValue('', $null); if ($null -eq $v) { '' } else { [string]$v } } else { '<no-default>' } } else { '<missing>' }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  return (result.stdout || "").trim();
}

/** 上一次运行被强杀时，HKCU 可能残留指向本仓库 manifest 的值；它不能当作“用户原始值”。 */
function ourManifestPath() {
  return path.join(root, "native-host", "host.manifest.json");
}
function looksLikeOurManifest(value) {
  if (!value || value === "<missing>" || value === "<no-default>") return false;
  try {
    return path.resolve(String(value)).toLowerCase() === path.resolve(ourManifestPath()).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 从历史备份里找回用户真实原始值（第一次运行 register.ps1 之前的 previousDefault）。
 * 返回：string = 原始值；null = 原始不存在；undefined = 历史备份里也找不到可信值。
 */
function findOriginalRegistryValue() {
  const tmpRoot = path.join(root, ".e2e-tmp");
  if (!fs.existsSync(tmpRoot)) return undefined;
  const files = [];
  for (const dir of fs.readdirSync(tmpRoot)) {
    const backupDir = path.join(tmpRoot, dir, "registry-backup");
    if (!fs.existsSync(backupDir)) continue;
    for (const name of fs.readdirSync(backupDir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(backupDir, name);
      try {
        files.push({ file, mtime: fs.statSync(file).mtimeMs, data: JSON.parse(fs.readFileSync(file, "utf8")) });
      } catch {
        // ignore partial
      }
    }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  for (const entry of files) {
    const target = entry.data?.targets?.[0];
    if (!target) continue;
    const prev = target.previousDefault ?? null;
    if (looksLikeOurManifest(prev)) continue;
    return prev;
  }
  return undefined;
}

function forceRestoreRegistry(value) {
  const key = REGISTRY_KEY.replace(/'/g, "''");
  const script =
    value === null
      ? "$k='" + key + "'; if (Test-Path -LiteralPath $k) { Remove-ItemProperty -LiteralPath $k -Name '(default)' -ErrorAction SilentlyContinue }"
      : "$k='" + key + "'; Set-ItemProperty -LiteralPath $k -Name '(default)' -Value '" + String(value).replace(/'/g, "''") + "'";
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
}

function processExecutablePath(pid) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(pid) + "').ExecutablePath"],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  return (result.stdout || "").trim();
}

/** renderer/utility 子进程的命令行证据：确认自定义 switch 是否被转发（只读 WMI 查询）。 */
function childProcessCommandLineEvidence(browserPid) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process -Filter \"ParentProcessId = " + Number(browserPid) + "\" |",
    "  Where-Object { $_.CommandLine -like '*--type=renderer*' -or $_.CommandLine -like '*--type=utility*' } |",
    "  Select-Object ProcessId, @{n='type';e={ if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { '?' } }},",
    "    @{n='managedSwitch';e={ $_.CommandLine -like '*browser-cli-background-presentation*' }},",
    "    @{n='feature';e={ $_.CommandLine -like '*InputOwnershipEnforcement*' }} |",
    "  ConvertTo-Json -Compress",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = (result.stdout || "").trim();
  let children = [];
  try {
    const parsed = text ? JSON.parse(text.split(/\r?\n/).filter(Boolean).pop()) : [];
    children = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    children = [];
  }
  return {
    browserPid,
    children,
    rendererCount: children.filter((c) => c.type === "renderer").length,
    anyRendererHasManagedSwitch: children.some((c) => c.type === "renderer" && c.managedSwitch === true),
    anyRendererHasFeature: children.some((c) => c.type === "renderer" && c.feature === true),
    raw: text.slice(0, 4000),
  };
}

function runNpm(script, timeoutMs = 300000) {
  const result = spawnSync("npm", ["run", script], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    shell: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdoutTail: (result.stdout || "").split(/\r?\n/).slice(-6).join("\n"),
    stderrTail: (result.stderr || "").split(/\r?\n/).slice(-6).join("\n"),
  };
}

// ---------------------------------------------------------------- session

// ---------------------------------------------------------------- main
const servers = MATRIX ? null : await startServers();
let win32 = null;
let registration = null;
const startedChrome = [];

async function main() {
  probeBinaries();
  report.env.extensionId = (() => {
    try {
      return extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).key);
    } catch {
      return null;
    }
  })();

  if (MATRIX) {
    printMatrix();
    report.verdict = "MATRIX";
    report.cases = CASES.map((c) => ({ id: c.id, title: c.title, stage: c.stage, feature: c.feature || null, status: caseStatus(c), blocked: c.blocked || null }));
    report.blocked = report.cases.filter((c) => c.status === "blocked");
    return;
  }

  mustCheck("平台为 Windows", process.platform === "win32", process.platform);
  mustCheck("打补丁的 chrome.exe 存在", fs.existsSync(CHROME), CHROME);
  mustCheck("fixtures 存在", fs.existsSync(FIXTURE_MAIN) && fs.existsSync(FIXTURE_FRAME), FIXTURE_MAIN);
  mustCheck("D:/c/logs 可写", fs.existsSync(LOG_DIR), LOG_DIR);

  if (!NO_BUILD) {
    const extBuild = runNpm("build");
    const hostBuild = runNpm("build:host");
    report.build = { extension: extBuild, host: hostBuild };
    mustCheck("npm run build 成功", extBuild.ok, JSON.stringify(extBuild));
    mustCheck("npm run build:host 成功", hostBuild.ok, JSON.stringify(hostBuild));
  } else {
    report.build = { skipped: true, reason: "--no-build" };
  }
  probeBinaries();
  mustCheck("扩展 dist/manifest.json 存在", fs.existsSync(path.join(DIST, "manifest.json")), DIST);
  const hostExe = findNewestHostExe(root);
  mustCheck("native host exe 存在", !!hostExe && fs.existsSync(hostExe), hostExe || "run npm run build:host");
  report.env.hostExe = hostExe;
  report.env.hostExeMtime = new Date(fs.statSync(hostExe).mtimeMs).toISOString();

  // blocked 用例先登记（不依赖浏览器）
  for (const c of CASES) {
    if (!caseSelected(c)) continue;
    if (c.blocked) {
      report.cases.push({ id: c.id, title: c.title, stage: c.stage, feature: c.feature || null, status: "BLOCKED", blocked: c.blocked, checks: [], evidence: [] });
      report.blocked.push({ id: c.id, ...c.blocked });
    }
  }
  console.log("blocked: " + (report.blocked.map((b) => b.id).join(", ") || "none"));

  const selected = CASES.filter((c) => caseSelected(c) && !c.blocked);

  if (!selected.length) {
    report.notes.push("本次选中的用例全部 blocked：不启动浏览器、不改注册表。");
    report.verdict = "BLOCKED";
    report.blockedReason = "所有被选中的用例都 blocked（没有任何真实执行）";
    return;
  }

  win32 = new Win32Helper(path.join(runDir, "win32-helper.ps1"));
  await win32.start();
  const screenInfo = await win32.call("screen");
  report.env.screen = screenInfo.rect;
  report.env.foregroundBeforeLaunch = (await win32.call("foreground")).hwnd;

  // 注册 native host（HKCU，带备份）
  const beforeValue = registryDefault(REGISTRY_KEY);
  // 上一次运行被强杀（例如 harness 超时被杀）时，HKCU 会残留本仓库 manifest。
  // 这种情况不能把“残留值”当成用户原始值，否则每次运行都会自我确认为“已恢复”。
  const staleRegistry = looksLikeOurManifest(beforeValue);
  let restoreTarget = beforeValue === "<missing>" || beforeValue === "<no-default>" ? null : beforeValue;
  if (staleRegistry) {
    restoreTarget = findOriginalRegistryValue();
    console.log(
      "[registry] 检测到上次运行残留的本仓库 manifest 值；原始值回溯 = " +
        (restoreTarget === undefined ? "<unknown>" : JSON.stringify(restoreTarget)),
    );
  }
  const reg = runPowerShellFile(REGISTER_PS1, ["-HostPath", hostExe, "-BackupDir", backupDir]);
  mustCheck("register.ps1 执行成功", reg.status === 0 && reg.json?.ok === true, JSON.stringify({ status: reg.status, stderr: (reg.stderr || "").slice(-600), json: reg.json }));
  registration = reg.json;
  const afterRegisterValue = registryDefault(REGISTRY_KEY);
  report.registration = {
    registryKey: REGISTRY_KEY,
    beforeValue,
    staleOurManifestDetected: staleRegistry,
    restoreTarget: restoreTarget === undefined ? null : restoreTarget,
    restoreTargetKnown: restoreTarget !== undefined,
    afterRegisterValue,
    manifestPath: registration.manifestPath,
    hostPath: registration.hostPath,
    extensionId: registration.extensionId,
    backupFile: registration.backupFile,
  };
  mustCheck("注册后 HKCU 指向本次 host manifest", afterRegisterValue === registration.manifestPath, JSON.stringify({ afterRegisterValue, manifestPath: registration.manifestPath }));
  mustCheck("注册的扩展 ID 与仓库 manifest.json 推导一致", registration.extensionId === report.env.extensionId, JSON.stringify({ registered: registration.extensionId, derived: report.env.extensionId }));

  for (const feature of SESSION_FEATURES) {
    if (!FEATURE_FILTER.has(feature)) continue;
    const casesToRun = selected.filter((c) => c.feature === feature);
    if (!casesToRun.length) continue;
    if (feature !== "off" && !featureAvailable()) {
      for (const c of casesToRun) {
        report.cases.push({
          id: c.id,
          title: c.title,
          stage: c.stage,
          feature,
          status: "BLOCKED",
          blocked: { code: "binary-lacks-feature", deps: ["Agent J: patch 028 编译进 content.dll/chrome.dll"], reason: "当前构建二进制不含 " + FEATURE + " 字符串，Feature on 无法生效。" },
          checks: [],
          evidence: [],
        });
        report.blocked.push({ id: c.id, code: "binary-lacks-feature" });
      }
      continue;
    }
    await runSessionWithCleanup({ feature, casesToRun });
  }

  report.verdict = "PASS";
}

// 包一层：runSession 需要 servers/hostExe/win32，且会话结束后要记录。
async function runSessionWithCleanup({ feature, casesToRun }) {
  const sessionDir = path.join(runDir, "feature-" + feature);
  fs.mkdirSync(sessionDir, { recursive: true });
  const label = "feature-" + feature;
  const profileDir = path.join(sessionDir, "chrome-profile");
  const localAppData = path.join(sessionDir, "localappdata");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

  const sessionReport = {
    feature,
    label,
    startedAt: nowIso(),
    args: [],
    env: {},
    windowPid: null,
    host: null,
    spaces: {},
    windows: {},
    cases: [],
    browserLog: null,
    cleanup: null,
  };
  report.sessions.push(sessionReport);

  // Feature on 同时打开 managed presentation：生产 API 的可用性要求
  // `--browser-cli-background-presentation`（availability 检查 + 受信扩展身份检查都要它）。
  // 该模式下扩展创建的窗口默认 hidden（不上桌面），inputOwnership API 才存在。
  const managed = feature !== "off";
  const featureFlagArgs = managed
    ? ["--enable-features=" + FEATURE, "--browser-cli-background-presentation",
       ...(feature === "on-visible" ? ["--browser-cli-user-explicit-show", "--no-startup-window"] : [])]
    : [];
  const token = runToken + "-" + feature;
  const args = [
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "--load-extension=" + DIST,
    "--disable-extensions-except=" + DIST,
    "--in-process-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-position=100,80",
    "--window-size=1000,760",
    "--site-per-process",
    "--enable-logging=stderr",
    "--v=0",
    ...featureFlagArgs,
    // on-visible：冷启动就带 --browser-cli-user-explicit-show，不能带位置 URL
    // （show producer 会把带 URL 的命令行判为 kBlockedByLaunchArguments）。
    // 其他会话用启动 URL 让扩展 SW/native host 起来（窗口在 managed 模式下 hidden）。
    ...(feature === "on-visible" ? [] : [servers.mainOrigin + "/boot?token=" + token]),
  ];
  sessionReport.managed = managed;
  sessionReport.explicitShow = feature === "on-visible";
  sessionReport.args = args;
  sessionReport.env = { LOCALAPPDATA: localAppData, BROWSERPILOT_HOST_BASE_PORT: String(48900 + Math.floor(Math.random() * 90)) };

  let chrome = null;
  let hostSession = null;

  const ctx = {
    feature,
    token,
    session: sessionReport,
    mainOrigin: servers.mainOrigin,
    frameOrigin: servers.frameOrigin,
    frameOriginMarker: servers.frameOrigin.split("//")[1],
    win32,
    windows: sessionReport.windows,
    spaces: sessionReport.spaces,
    record(id, data) {
      const c = report.cases.find((x) => x.id === id && x.feature === feature);
      if (c) c.evidence.push(data);
    },
    getRecord(id) {
      const c = report.cases.find((x) => x.id === id && x.feature === feature);
      return c?.evidence?.[0] || null;
    },
    async ai(spaceKey, name, args = {}) {
      const request = () => ctx.client.request(name, args, { space: ctx.spaces[spaceKey].spaceId });
      let result = await request();
      if (!result.ok && /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(String(result.error))) {
        // native host 可能因 SW 休眠而退出：先 poke SW，再刷新 host session 并重试一次。
        await ctx.popupSend("input_status", ctx.spaces[spaceKey].spaceId).catch(() => null);
        const refreshed = await ctx.refreshHostClient(30000).catch(() => ({ ok: false }));
        if (refreshed.ok) result = await request();
      }
      return result;
    },
    lastProbeAt: {},
    /** 外观测：读 fixture 每 200ms POST 回来的状态（不经过任何扩展命令，HUMAN 模式也可用）。 */
    async probe(spaceKey) {
      const token = ctx.spaces[spaceKey].token;
      const minAt = ctx.lastProbeAt[spaceKey] || 0;
      const deadline = Date.now() + 8000;
      let last = null;
      while (Date.now() < deadline) {
        const entry = servers.stateFor(token);
        if (entry && entry.state && Number(entry.state.at) > minAt) {
          last = entry.state;
          break;
        }
        await sleep(80);
      }
      if (!last) throw new Error("no fresh beacon state for " + spaceKey + " (token=" + token + ")");
      ctx.lastProbeAt[spaceKey] = Number(last.at);
      return last;
    },
    /** AI 模式下可直接读页面（会经过 js 命令；HUMAN 模式禁止使用）。 */
    async probeJs(spaceKey) {
      const r = await ctx.ai(spaceKey, "js", { expression: "window.__probe()", tabId: ctx.spaces[spaceKey].tabId });
      if (!r.ok) throw new Error("probeJs failed in " + spaceKey + ": " + r.error);
      return r.data.value;
    },
    async waitState(spaceKey, predicate, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await ctx.probe(spaceKey);
        try {
          if (predicate(last)) return last;
        } catch {
          // ignore predicate errors
        }
      }
      return last;
    },
    async inputStatus(spaceKey) {
      return await ctx.client.call("input_status", {}, { space: ctx.spaces[spaceKey].spaceId });
    },
    async handoff(spaceKey) {
      const r = await ctx.client.request("handoff_space", {}, { space: ctx.spaces[spaceKey].spaceId });
      return r.ok;
    },
    async claim(spaceKey) {
      const r = await ctx.client.request("claim_space", {}, { space: ctx.spaces[spaceKey].spaceId });
      return r.ok;
    },
    async focusInput(spaceKey) {
      const r = await ctx.ai(spaceKey, "js", { expression: "(()=>{const el=document.getElementById('input');el.focus();el.value='';return document.activeElement===el;})()", tabId: ctx.spaces[spaceKey].tabId });
      if (!r.ok) throw new Error("focusInput failed: " + r.error);
    },
    async resetMain() {
      const r = await ctx.ai("main", "js", {
        expression: "(()=>{window.__clicks=0;window.__events=[];window.__inputEvents=0;window.__keys=[];window.__drag={down:0,moves:0,movesDown:0,up:0,dstUp:0,trace:[]};window.__childClicks=0;window.__childMsgs=[];window.__wheel=0;window.__wheelEvents=0;window.__lastWheel=null;window.__jsRuns=0;document.getElementById('count').textContent='0';document.getElementById('child').textContent='0';const i=document.getElementById('input');i.value='';i.blur();document.getElementById('scroll').scrollTop=0;return true;})()",
        tabId: ctx.spaces.main.tabId,
      });
      if (!r.ok) throw new Error("resetMain failed: " + r.error);
      await ctx.waitState("main", (st) => st.clicks === 0 && st.inputValue === "" && st.jsRuns === 0 && st.keys.length === 0 && st.childClicks === 0, 6000);
      await sleep(60);
    },
    async resetMulti() {
      const r = await ctx.ai("multi", "js", {
        expression: "(()=>{window.__clicks=0;window.__events=[];window.__inputEvents=0;window.__keys=[];window.__drag={down:0,moves:0,movesDown:0,up:0,dstUp:0,trace:[]};document.getElementById('count').textContent='0';const i=document.getElementById('input');i.value='';i.blur();return true;})()",
        tabId: ctx.spaces.multi.tabId,
      });
      if (!r.ok) throw new Error("resetMulti failed: " + r.error);
      await ctx.waitState("multi", (st) => st.clicks === 0 && st.inputValue === "" && st.keys.length === 0, 6000);
      await sleep(60);
    },
    async resetOopif() {
      const r = await ctx.ai("oopif", "js", {
        expression: "(()=>{window.__clicks=0;window.__childClicks=0;window.__childMsgs=[];window.__events=[];document.getElementById('count').textContent='0';document.getElementById('child').textContent='0';return true;})()",
        tabId: ctx.spaces.oopif.tabId,
      });
      if (!r.ok) throw new Error("resetOopif failed: " + r.error);
      await ctx.waitState("oopif", (st) => st.clicks === 0 && st.childClicks === 0 && st.events.length === 0, 6000);
      await sleep(60);
    },
    pointInFrame(probe) {
      const f = probe.rects.frame;
      const dpr = Number(probe.viewport.dpr) || 1;
      // iframe 有 2px 边框；子帧 #fbtn 中心在内容坐标 (140,70) -> 页面坐标 (142,72)。
      return { x: Math.round((f.x + 142) * dpr), y: Math.round((f.y + 72) * dpr), dpr };
    },
    /**
     * 等价真实人类点击：PostMessage(WM_MOUSEMOVE/WM_LBUTTONDOWN/WM_LBUTTONUP) 到
     * Chrome_RenderWidgetHostHWND。它与 OS 输入走同一条 aura 路径（不带 kFromDebugger）。
     * 一个窗口可能同时存在多个 legacy widget（旧 tab/隐藏 widget），因此逐个候选尝试，
     * 直到页面状态真的变化为止；返回实际生效的候选与尝试次数（作为证据）。
     */
    async humanClick(spaceKey, rect, { expect, real = false, useKnownWidget = false } = {}) {
      const win = ctx.windows[spaceKey];
      if (!win?.hwnd) throw new Error("no window for " + spaceKey);
      const token = ctx.spaces[spaceKey].token;
      const readState = async (minAt) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const entry = servers.stateFor(token);
          if (entry?.state && Number(entry.state.at) > minAt) return entry.state;
          await sleep(80);
        }
        return null;
      };
      const probe0 = await ctx.probe(spaceKey);
      const dpr = Number(probe0.viewport.dpr) || 1;
      const x = Math.round((Number(rect.x) + Number(rect.w) / 2) * dpr);
      const y = Math.round((Number(rect.y) + Number(rect.h) / 2) * dpr);
      const candidates = (useKnownWidget && real && win.widgetHwnd)
        ? [{ hwnd: win.widgetHwnd, visible: true, clientWidth: 0, clientHeight: 0 }]
        : await findWidgetCandidates(win.hwnd);
      // 默认判定：点击带来了任何可观察变化（点击计数或焦点变化）。
      // 仅看 clicks 会把“点击输入框（只改焦点）”误判为失败。
      const isBetter = expect || ((state) => state.clicks > probe0.clicks || state.activeElement !== probe0.activeElement);
      const attempts = [];
      for (const candidate of candidates) {
        const since = Date.now();
        let down, up;
        let realResult = null;
        if (real) {
          realResult = await win32.call("realMouse", { hwnd: candidate.hwnd, x, y });
          down = realResult; up = realResult;
        } else {
          await win32.call("mouse", { hwnd: candidate.hwnd, type: "move", x, y, buttons: 0 });
          await sleep(50);
          down = await win32.call("mouse", { hwnd: candidate.hwnd, type: "down", x, y });
          await sleep(50);
          up = await win32.call("mouse", { hwnd: candidate.hwnd, type: "up", x, y });
        }
        const state = await readState(since);
        const landed = Boolean(state && isBetter(state));
        attempts.push({ hwnd: candidate.hwnd, visible: candidate.visible, w: candidate.clientWidth, h: candidate.clientHeight, down: down?.ok, up: up?.ok, realResult, landed });
        if (landed) {
          win.widgetHwnd = candidate.hwnd;
          ctx.lastProbeAt[spaceKey] = Number(state.at);
          return { x, y, dpr, hwnd: candidate.hwnd, attempts, landed: true };
        }
      }
      return { x, y, dpr, hwnd: null, attempts, landed: false, candidates };
    },
    async humanType(spaceKey, text) {
      const win = ctx.windows[spaceKey];
      if (!win?.hwnd) throw new Error("no window for " + spaceKey);
      // 只支持 [a-z0-9]：WM_KEYDOWN 的 VK 由字符推导，标点需要额外的 VK 映射；
      // 人类键盘证据用纯字母串即可，避免用错误 VK 产生假证据。
      if (!/^[a-z0-9]+$/i.test(text)) throw new Error("humanType 只接受 [a-z0-9]：" + text);
      const token = ctx.spaces[spaceKey].token;
      const base = await ctx.probe(spaceKey);
      const candidates = (useKnownWidget && real && win.widgetHwnd)
        ? [{ hwnd: win.widgetHwnd, visible: true, clientWidth: 0, clientHeight: 0 }]
        : await findWidgetCandidates(win.hwnd);
      const knownIndex = candidates.findIndex((c) => c.hwnd === win.widgetHwnd);
      if (knownIndex > 0) candidates.unshift(candidates.splice(knownIndex, 1)[0]);
      const attempts = [];
      for (const candidate of candidates) {
        const since = Date.now();
        for (const ch of text) {
          const vk = ch.toUpperCase().charCodeAt(0);
          await win32.call("key", { hwnd: candidate.hwnd, vk, down: true });
          await sleep(25);
          await win32.call("key", { hwnd: candidate.hwnd, vk, down: false });
          await sleep(25);
        }
        const deadline = Date.now() + 5000;
        let state = null;
        while (Date.now() < deadline) {
          const entry = servers.stateFor(token);
          if (entry?.state && Number(entry.state.at) > since) { state = entry.state; break; }
          await sleep(80);
        }
        const landed = Boolean(state && state.inputValue !== base.inputValue);
        attempts.push({ hwnd: candidate.hwnd, visible: candidate.visible, w: candidate.clientWidth, h: candidate.clientHeight, landed, value: state?.inputValue ?? null });
        if (landed) {
          win.widgetHwnd = candidate.hwnd;
          ctx.lastProbeAt[spaceKey] = Number(state.at);
          return { typed: text.length, hwnd: candidate.hwnd, attempts, landed: true };
        }
      }
      return { typed: 0, hwnd: null, attempts, landed: false };
    },
    async browserTargets() {
      return await browserTargets(profileDir);
    },
    // ------------------------------------------------------------ kernel API helpers
    async cdp() {
      if (!ctx._browserCdp) ctx._browserCdp = await new BrowserCdp(profileDir).connect();
      return ctx._browserCdp;
    },
    /**
     * 受信扩展页面（popup/index.html）作为 chrome.browserCli.inputOwnership 的真实调用方。
     * 通过浏览器级 CDP 在该页面主世界执行调用：不经过 chrome.debugger（extension:// 页面
     * 不在 host_permissions 覆盖范围内），也不改变页面的扩展上下文。
     */
    async ensurePopup() {
      if (ctx.popup) return ctx.popup;
      const extId = report.env.extensionId;
      if (!extId) throw new Error("extension id unknown");
      const url = "chrome-extension://" + extId + "/popup/index.html";
      const data = await ctx.client.call("open_space", { name: "popup-" + token, url });
      const info = { spaceId: data.spaceId, tabId: data.tabId, windowId: data.windowId, url, kind: "extension-page" };
      const cdp = await ctx.cdp();
      const target = await cdp.findTarget("chrome-extension://" + extId + "/popup/", "page");
      info.targetId = target.targetId;
      info.sessionId = await cdp.attach(target.targetId);
      let probe = null;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        probe = await cdp
          .evaluate(
            info.sessionId,
            "({href: location.href, " +
              "api: (typeof chrome !== 'undefined' && (chrome.browserCli || chrome.browserCliInputOwnership)) ? true : false, " +
              "ns: (typeof chrome !== 'undefined' && chrome.browserCliInputOwnership) ? 'browserCliInputOwnership' : " +
              "((typeof chrome !== 'undefined' && chrome.browserCli && chrome.browserCli.inputOwnership) ? 'browserCli.inputOwnership' : null), " +
              "io: (typeof chrome !== 'undefined' && chrome.browserCliInputOwnership) ? Object.keys(chrome.browserCliInputOwnership) : " +
              "((typeof chrome !== 'undefined' && chrome.browserCli && chrome.browserCli.inputOwnership) ? Object.keys(chrome.browserCli.inputOwnership) : null), " +
              "caps: (typeof chrome !== 'undefined' && chrome.browserCli && chrome.browserCli.getCapabilities) ? 'fn' : 'missing', " +
              "runtimeError: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : null})",
          )
          .catch((error) => ({ error: String(error) }));
        if (probe && probe.api === true && probe.io) break;
        await sleep(200);
      }
      info.probe = probe;
      ctx.popup = info;
      return info;
    },
    /**
     * API 调用上下文：普通会话用 popup 页面（可见窗口，便于观察）；
     * on-visible 会话用扩展 service worker（不额外创建窗口，避免干扰 show 的唯一候选）。
     */
    async ensureApiContext() {
      if (ctx.apiContext) return ctx.apiContext;
      if (feature === "off") {
        const popup = await ctx.ensurePopup();
        ctx.apiContext = { kind: "popup", ...popup };
        return ctx.apiContext;
      }
      const cdp = await ctx.cdp();
      const targets = await cdp.targets();
      const sw = targets.find((t) => t.type === "service_worker" && String(t.url || "").includes(report.env.extensionId));
      if (!sw) throw new Error("extension service worker target not found for on-visible session");
      const sessionId = await cdp.attach(sw.targetId);
      let probe = null;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        probe = await cdp.evaluate(
          sessionId,
          "({api: !!(typeof chrome !== 'undefined' && chrome.browserCliInputOwnership), " +
            "io: (typeof chrome !== 'undefined' && chrome.browserCliInputOwnership) ? Object.keys(chrome.browserCliInputOwnership) : null, " +
            "ns: (typeof chrome !== 'undefined' && chrome.browserCliInputOwnership) ? 'browserCliInputOwnership' : null})",
        ).catch((error) => ({ error: String(error) }));
        if (probe && probe.api === true && Array.isArray(probe.io)) break;
        await sleep(200);
      }
      ctx.apiContext = { kind: "service_worker", targetId: sw.targetId, sessionId, probe };
      return ctx.apiContext;
    },
    /** 调用 browserCli.inputOwnership.<method>(request, cb)；返回 {result,lastError} 或错误标记。 */
    async apiCall(method, request = {}) {
      let apiCtx = await ctx.ensureApiContext();
      const cdp = await ctx.cdp();
      const expr =
        "new Promise((resolve) => {" +
        "  const io = (typeof chrome !== 'undefined') ? (chrome.browserCliInputOwnership || (chrome.browserCli && chrome.browserCli.inputOwnership) || null) : null;" +
        "  if (!io || typeof io[" + JSON.stringify(method) + "] !== 'function') {" +
        "    resolve({__bpMissing: true, method: " + JSON.stringify(method) + ", keys: io ? Object.keys(io) : null});" +
        "    return;" +
        "  }" +
        "  try {" +
        "    io[" + JSON.stringify(method) + "](" + JSON.stringify(request) + ", (result) => resolve({" +
        "      result: result === undefined ? null : result," +
        "      lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null," +
        "    }));" +
        "  } catch (e) { resolve({__bpThrown: String((e && e.message) || e)}); }" +
        "})";
      // hidden 扩展页面可能被冻结导致 Runtime.evaluate 超时：丢弃上下文并重试一次。
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await cdp.evaluate(apiCtx.sessionId, expr);
          return raw;
        } catch (error) {
          if (attempt === 1) return { __bpCdpError: String(error && error.message ? error.message : error) };
          ctx.apiContext = null;
          if (apiCtx.kind === "popup") ctx.popup = null;
          else ctx.swSessionId = null;
          await sleep(400);
          apiCtx = await ctx.ensureApiContext();
        }
      }
      return { __bpCdpError: "api context retry exhausted" };
    },
    /** 便捷：成功时返回 result，失败/受限时返回 null 并把原始响应写进 evidence。 */
    async apiOk(method, request = {}) {
      const raw = await ctx.apiCall(method, request);
      if (raw && raw.result && !raw.lastError && !raw.__bpMissing && !raw.__bpThrown && !raw.__bpCdpError && raw.result.accepted !== false && raw.result.granted !== false && raw.result.ok !== false) {
        return { ok: true, result: raw.result, raw };
      }
      return { ok: false, result: raw?.result || null, raw };
    },
    async attachOn(spaceKey) {
      const r = await ctx.ai(spaceKey, "tab_cdp_call", { method: "Runtime.enable", tabId: ctx.spaces[spaceKey].tabId });
      if (!r.ok) throw new Error("attach failed on " + spaceKey + ": " + r.error);
      return true;
    },
    async detachOn(spaceKey) {
      return await ctx.ai(spaceKey, "detach", { tabId: ctx.spaces[spaceKey].tabId });
    },
    /** 新开一个 fixture tab，且不对它发任何 AI 命令（因此 chrome.debugger 未 attach）。 */
    async openFresh(key) {
      if (ctx.spaces[key]) return ctx.spaces[key];
      const name = key;
      const url = servers.mainOrigin + "/" + key + "?token=" + token + "-" + name;
      const data = await ctx.client.call("open_space", { name, url });
      ctx.spaces[key] = { spaceId: data.spaceId, tabId: data.tabId, windowId: data.windowId, url, token: token + "-" + name };
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const entry = servers.stateFor(token + "-" + name);
        if (entry?.state?.token === token + "-" + name) return ctx.spaces[key];
        await sleep(150);
      }
      throw new Error("fresh tab beacon not ready: " + key);
    },
    /** 从受信扩展页面调用 chrome.debugger.getTargets()，证明扩展会话已 attach。 */

    /** 冷启动 show 的可见窗口：枚举 Win32 窗口找 visible=true 的 top-level 浏览器窗口。 */
    async findColdStartVisibleWindow(timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let last = [];
      while (Date.now() < deadline) {
        const listing = await win32.call("listWindows", { pid: chrome.record.pid });
        last = Array.isArray(listing.windows) ? listing.windows : listing.windows ? [listing.windows] : [];
        const hit = last.find((w) => w.className === "Chrome_WidgetWin_1" && w.visible === true);
        if (hit) {
          const kids = await win32.call("children", { hwnd: hit.hwnd });
          const candidates = (Array.isArray(kids.children) ? kids.children : kids.children ? [kids.children] : [])
            .filter((c) => c.className === "Chrome_RenderWidgetHostHWND")
            .filter((c) => Number(c.clientWidth) * Number(c.clientHeight) > 20000)
            .sort((a, b) => Number(b.clientWidth) * Number(b.clientHeight) - Number(a.clientWidth) * Number(a.clientHeight));
          return { window: hit, widget: candidates[0] || null, allWindows: last };
        }
        await sleep(250);
      }
      return { window: null, allWindows: last };
    },
    /** 用 popup 的 chrome.tabs API 找到初始 tab 并导航到 fixture。 */
    async navigateInitialTab(url, tokenValue, timeoutMs = 30000, expectBeacon = true) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      const found = await cdp.evaluate(
        popup.sessionId,
        "new Promise((resolve) => chrome.tabs.query({}, (tabs) => {" +
          "  const list = tabs || [];" +
          "  const t = list.find((x) => /^(chrome:\\/\\/newtab|about:blank|chrome:\\/\\/startpage)/.test(String(x.url || ''))) || list[0];" +
          "  resolve(t ? {tabId: t.id, windowId: t.windowId, url: t.url} : {missing: true});" +
          "}))",
      );
      if (!found || found.missing) return { ok: false, reason: "no initial tab", found };
      await cdp.evaluate(
        popup.sessionId,
        "new Promise((resolve) => chrome.tabs.update(" + Number(found.tabId) + ", {url: " + JSON.stringify(url) + "}, () => resolve({ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})))",
      );
      if (!expectBeacon) {
        await sleep(2500);
        return { ok: true, tabId: found.tabId, windowId: found.windowId };
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const entry = servers.stateFor(tokenValue);
        if (entry?.state?.token === tokenValue) return { ok: true, tabId: found.tabId, windowId: found.windowId, state: entry.state };
        await sleep(150);
      }
      return { ok: false, reason: "beacon-not-ready", tabId: found.tabId, windowId: found.windowId, token: tokenValue };
    },


    /** 读取本次会话的浏览器日志里 show producer / presentation policy 的关键行。 */
    async showProducerLog() {
      const file = path.join(artifactsDir, label + "-chrome.log");
      try {
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => /BROWSER_CLI_USER_EXPLICIT_SHOW|human-ownership-granted|user-explicit|presentation-denied/.test(l));
        return lines.slice(-20);
      } catch (error) {
        return ["<log unreadable: " + String(error) + ">"];
      }
    },
    /** 确保 agent TCP 通道可用（host 可能因 SW 休眠退出）。 */
    async ensureAgentChannel(spaceId) {
      const ping = await ctx.client.request("ping", {}).catch(() => ({ ok: false }));
      if (ping.ok === true) return { ok: true, refreshed: false };
      if (spaceId) await ctx.popupSend("input_status", spaceId).catch(() => null);
      const refreshed = await ctx.refreshHostClient(30000);
      return { ok: refreshed.ok, refreshed: true, detail: refreshed };
    },
    /**
     * 在 popup 窗口里新建一个**不属于任何 Task Space** 的 tab。
     * 扩展的周期同步只覆盖 state.spaces，因此这个 tab 不会收到任何扩展心跳；
     * 用来验证内核 30s stale 契约（无需停 SW，避免 SW 自动重启后立刻重放）。
     */
    async createUntrackedWindow(name) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      const tokenValue = token + "-untracked-" + name;
      const url = servers.mainOrigin + "/" + name + "?token=" + tokenValue;
      // 独立窗口（不属于任何 Task Space）：扩展的周期同步按 space.windowId 覆盖，
      // 不会给这个窗口/tab 发 heartbeat。
      const expr =
        "new Promise((resolve) => { try { chrome.windows.create({url: " + JSON.stringify(url) + ", focused: false, state: 'normal'}, (win) => resolve({ok: !chrome.runtime.lastError, windowId: win ? win.id : null, tabId: win && win.tabs && win.tabs[0] ? win.tabs[0].id : null, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})); } catch (e) { resolve({ok: false, error: String((e && e.message) || e)}); } })";
      const created = await cdp.evaluate(popup.sessionId, expr, { timeoutMs: 30000 }).catch((error) => ({ ok: false, error: String(error) }));
      if (created?.ok !== true) return { ok: false, created };
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const entry = servers.stateFor(tokenValue);
        if (entry?.state?.token === tokenValue) {
          return { ok: true, tabId: created.tabId, windowId: created.windowId, state: entry.state, token: tokenValue, url };
        }
        await sleep(150);
      }
      return { ok: false, created, reason: "beacon-not-ready", token: tokenValue, url };
    },
    /**
     * 在指定窗口里新建一个 tab（同窗口），用于 K15 即时继承验证。
     * 不经过扩展的 Task Space 同步；新 tab 只应继承窗口账本。
     */
    async createTabInWindow(windowId, name, active = false) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      const tokenValue = token + "-newtab-" + name;
      const url = servers.mainOrigin + "/" + name + "?token=" + tokenValue;
      const expr =
        "new Promise((resolve) => { try { chrome.tabs.create({windowId: " + Number(windowId) + ", url: " + JSON.stringify(url) + ", active: " + (active ? "true" : "false") + "}, (tab) => resolve({ok: !chrome.runtime.lastError, tabId: tab ? tab.id : null, windowId: tab ? tab.windowId : null, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})); } catch (e) { resolve({ok: false, error: String((e && e.message) || e)}); } })";
      const created = await cdp.evaluate(popup.sessionId, expr, { timeoutMs: 30000 }).catch((error) => ({ ok: false, error: String(error) }));
      if (created?.ok !== true) return { ok: false, created, token: tokenValue, url };
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const entry = servers.stateFor(tokenValue);
        if (entry?.state?.token === tokenValue) {
          return { ok: true, tabId: created.tabId, windowId: created.windowId, state: entry.state, token: tokenValue, url };
        }
        await sleep(150);
      }
      return { ok: false, created, reason: "beacon-not-ready", token: tokenValue, url };
    },
    async closeWindow(windowId) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      return await cdp.evaluate(
        popup.sessionId,
        "new Promise((resolve) => { try { chrome.windows.remove(" + Number(windowId) + ", () => resolve({ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})); } catch (e) { resolve({ok: false, error: String((e && e.message) || e)}); } })",
      ).catch((error) => ({ ok: false, error: String(error) }));
    },
    async closeTab(tabId) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      return await cdp.evaluate(
        popup.sessionId,
        "new Promise((resolve) => { try { chrome.tabs.remove(" + Number(tabId) + ", () => resolve({ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})); } catch (e) { resolve({ok: false, error: String((e && e.message) || e)}); } })",
      ).catch((error) => ({ ok: false, error: String(error) }));
    },
    /** 从 popup 页面直接 attach chrome.debugger（SW 停掉后用于产生 AI 输入）。 */
    async popupDebuggerAttach(tabId) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      const expr =
        "new Promise((resolve) => { try { chrome.debugger.attach({tabId: " + Number(tabId) + "}, '1.3', () => resolve({attached: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})); } catch (e) { resolve({attached: false, error: String((e && e.message) || e)}); } })";
      return await cdp.evaluate(popup.sessionId, expr).catch((error) => ({ attached: false, error: String(error) }));
    },
    async popupDebuggerDetach(tabId) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      return await cdp.evaluate(
        popup.sessionId,
        "new Promise((resolve) => { try { chrome.debugger.detach({tabId: " + Number(tabId) + "}, () => resolve({ok: !chrome.runtime.lastError, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})); } catch (e) { resolve({ok: false, error: String((e && e.message) || e)}); } })",
      ).catch((error) => ({ ok: false, error: String(error) }));
    },
    async popupDebuggerSend(tabId, method, params) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      const expr =
        "new Promise((resolve) => { try { chrome.debugger.sendCommand({tabId: " + Number(tabId) + "}, " +
        JSON.stringify(method) + ", " + JSON.stringify(params) + ", (result) => resolve({ok: !chrome.runtime.lastError, result: result === undefined ? null : result, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null})); } catch (e) { resolve({ok: false, error: String((e && e.message) || e)}); } })";
      return await cdp.evaluate(popup.sessionId, expr, { timeoutMs: 30000 }).catch((error) => ({ ok: false, error: String(error) }));
    },
    /** popup 页面上下文里发真实用户消息（SW 内 markInternalCommand）。 */
    async popupSend(kind, spaceId, timeoutMs = 30000) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      const expr =
        "new Promise((resolve) => { try { chrome.runtime.sendMessage(" +
        JSON.stringify({ kind, spaceId }) +
        ", (response) => resolve({ ok: true, response: response === undefined ? null : response, " +
        "lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })); } catch (e) { " +
        "resolve({ ok: false, error: String((e && e.message) || e) }); } })";
      try {
        return await cdp.evaluate(popup.sessionId, expr, { timeoutMs });
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    /** 在 popup 页面里点击真实 UI 控件（验证按钮接线）。 */
    async popupClick(selector) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      return await cdp.evaluate(
        popup.sessionId,
        "(() => { const el = document.querySelector(" + JSON.stringify(selector) + "); if (!el) return { clicked: false, reason: 'missing' }; const disabled = !!el.disabled; el.click(); return { clicked: true, disabled, text: String(el.textContent || '').slice(0, 80) }; })()",
      ).catch((error) => ({ clicked: false, error: String(error) }));
    },
    async popupSelectSpace(spaceId) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      return await cdp.evaluate(
        popup.sessionId,
        "(() => { const sel = document.getElementById('space-select'); if (!sel) return { ok: false, reason: 'missing' }; sel.value = " + JSON.stringify(spaceId) + "; sel.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, value: sel.value, options: Array.from(sel.options).map((o) => o.value).slice(0, 20) }; })()",
      ).catch((error) => ({ ok: false, error: String(error) }));
    },
    async popupText(id) {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      return await cdp.evaluate(popup.sessionId, "String((document.getElementById(" + JSON.stringify(id) + ") || {}).textContent || '')").catch(() => "");
    },
    /** 在扩展 service worker 上下文执行表达式（用于 SW 重启/事件桥验证）。 */
    async swEval(expression, timeoutMs = 20000) {
      const cdp = await ctx.cdp();
      let sessionId = ctx.swSessionId;
      if (!sessionId) {
        const targets = await cdp.targets();
        const sw = targets.find((t) => t.type === "service_worker" && String(t.url || "").includes(report.env.extensionId));
        if (!sw) return { __swMissing: true };
        sessionId = await cdp.attach(sw.targetId);
        ctx.swSessionId = sessionId;
        ctx.swTargetId = sw.targetId;
      }
      try {
        return await cdp.evaluate(sessionId, expression, { timeoutMs });
      } catch (error) {
        // session 可能因 SW 重启失效：下次重新 attach
        ctx.swSessionId = null;
        return { __swError: String(error?.message || error) };
      }
    },
    async stopExtensionWorkers() {
      const cdp = await ctx.cdp();
      const attempts = [];
      // 我们自己的 SW DevTools attach 会让 SW 保持存活；先断开。
      if (ctx.swSessionId) {
        try {
          await cdp.send("Target.detachFromTarget", { sessionId: ctx.swSessionId });
        } catch (error) {
          attempts.push({ method: "detachFromTarget(sw)", error: String(error?.message || error) });
        }
        ctx.swSessionId = null;
      }
      // ServiceWorker 域在 page 会话上可用（browser 会话的 stopAllWorkers 在本构建不存在）
      try {
        const popup = await ctx.ensurePopup();
        await cdp.send("ServiceWorker.enable", {}, popup.sessionId).catch(() => undefined);
        const r = await cdp.send("ServiceWorker.stopAllWorkers", {}, popup.sessionId);
        return { ok: true, method: "ServiceWorker.stopAllWorkers(page-session)", result: r ?? null, attempts };
      } catch (error) {
        attempts.push({ method: "ServiceWorker.stopAllWorkers(page-session)", error: String(error?.message || error), code: error?.code ?? null });
      }
      // (a) ServiceWorker 域（部分构建要求先 enable）
      try {
        await cdp.send("ServiceWorker.enable").catch(() => undefined);
        const r = await cdp.send("ServiceWorker.stopAllWorkers");
        ctx.swSessionId = null;
        return { ok: true, method: "ServiceWorker.stopAllWorkers", result: r ?? null, attempts };
      } catch (error) {
        attempts.push({ method: "ServiceWorker.stopAllWorkers", error: String(error?.message || error), code: error?.code ?? null });
      }
      // (b) stopWorker + versionId（从 workerVersionUpdated 事件收集）
      try {
        const versions = [];
        cdp.onEvent((message) => {
          if (message.method === "ServiceWorker.workerVersionUpdated") {
            for (const v of message.params?.versions || []) {
              if (String(v.scriptURL || "").includes(report.env.extensionId)) versions.push(v.versionId);
            }
          }
        });
        await cdp.send("ServiceWorker.enable");
        await sleep(800);
        if (versions.length) {
          const r = await cdp.send("ServiceWorker.stopWorker", { versionId: versions[versions.length - 1] });
          ctx.swSessionId = null;
          return { ok: true, method: "ServiceWorker.stopWorker", versionId: versions[versions.length - 1], result: r ?? null, attempts };
        }
        attempts.push({ method: "ServiceWorker.stopWorker", error: "no versionId" });
      } catch (error) {
        attempts.push({ method: "ServiceWorker.stopWorker", error: String(error?.message || error), code: error?.code ?? null });
      }
      // (c) 关闭 SW target
      try {
        const targets = await cdp.targets();
        const sw = targets.find((t) => t.type === "service_worker" && String(t.url || "").includes(report.env.extensionId));
        if (!sw) throw new Error("service worker target not found");
        await cdp.send("Target.closeTarget", { targetId: sw.targetId });
        ctx.swSessionId = null;
        return { ok: true, method: "Target.closeTarget", targetId: sw.targetId, attempts };
      } catch (error) {
        attempts.push({ method: "Target.closeTarget", error: String(error?.message || error), code: error?.code ?? null });
      }
      return { ok: false, error: "all stop methods failed", attempts };
    },
    async waitForServiceWorker(timeoutMs = 30000) {
      const cdp = await ctx.cdp();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const targets = await cdp.targets().catch(() => []);
        const sw = targets.find((t) => t.type === "service_worker" && String(t.url || "").includes(report.env.extensionId));
        if (sw) return sw;
        await sleep(300);
      }
      return null;
    },
    /** SW 重启后 native host 会以新 PID/port 重连；刷新 host 客户端。 */
    async refreshHostClient(timeoutMs = 45000) {
      const oldPid = ctx.hostSession?.pid;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const sessions = readSessions(localAppData).filter((sn) => pidAlive(sn.pid) && sn.pid !== oldPid);
        for (const sn of sessions) {
          const r = await tcpRequest(sn.port, sn.authToken, "e2e-a", "ping", {}, { timeoutMs: 2000 }).catch(() => null);
          if (r && r.ok === true && r.data && r.data.pong === true) {
            ctx.client = new HostClient(sn, "e2e-a");
            ctx.clientB = new HostClient(sn, "e2e-b");
            ctx.hostSession = sn;
            return { ok: true, session: { port: sn.port, pid: sn.pid } };
          }
        }
        await sleep(300);
      }
      return { ok: false };
    },
    /** 重新绑定一个已存在窗口（用于冷启动 show 的可见窗口）。 */
    registerWindow(key, hwnd, widgetHwnd, rect, title) {
      ctx.windows[key] = { hwnd, widgetHwnd: widgetHwnd || null, rect: rect || null, title };
      return ctx.windows[key];
    },
    async extensionDebuggerTargets() {
      const popup = await ctx.ensurePopup();
      const cdp = await ctx.cdp();
      const expr =
        "new Promise((resolve) => { try {" +
        "  chrome.debugger.getTargets((targets) => resolve({ok: true, targets: (targets || []).map((t) => ({id: t.id, tabId: t.tabId, attached: t.attached, type: t.type, url: String(t.url || '').slice(0, 100)}))}));" +
        "} catch (e) { resolve({ok: false, error: String((e && e.message) || e)}); } })";
      try {
        return await cdp.evaluate(popup.sessionId, expr);
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    /** 读当前版本并 setOwnership(mode, version+1)。 */
    async bumpMode(spaceKey, mode) {
      const tabId = ctx.spaces[spaceKey].tabId;
      const before = await ctx.apiCall("getOwnership", { target: { tabId } });
      const current = Number(before?.result?.version ?? 0);
      const version = current + 1;
      const raw = await ctx.apiCall("setOwnership", { target: { tabId }, mode, version });
      return { version, previousVersion: current, before, bumped: raw, accepted: raw?.result?.accepted === true };
    },
    markBlocked(blocked) {
      ctx.blocked = blocked;
    },
    /** 内核 API 是否真的能从扩展 JS 调用（binding 是否被安装）。 */
    async kernelApiReady() {
      let apiCtx;
      try {
        apiCtx = await ctx.ensureApiContext();
      } catch (error) {
        return {
          ok: false,
          blocked: {
            code: "extension-page-unreachable",
            deps: ["受信扩展上下文（popup 页面或 service worker）可附加"],
            reason: "无法附加受信扩展上下文：" + String(error?.message || error),
          },
        };
      }
      const io = apiCtx.probe?.io;
      if (apiCtx.probe?.api === true && Array.isArray(io) && io.includes("setOwnership") && io.includes("grantInput")) {
        return { ok: true, popup: apiCtx, apiContext: apiCtx };
      }
      return {
        ok: false,
        blocked: {
          code: "api-not-exposed-to-extension-js",
          deps: ["patch 029 修订：让 chrome.browserCli.inputOwnership 成为可安装的顶层 namespace（避免与父 feature browserCli 的层级冲突，或调整 feature_cache 的父子判定）"],
          reason:
            "chrome.browserCli 存在，但 chrome.browserCli.inputOwnership 在任何扩展 JS 上下文里都不存在" +
            "（上下文=" + String(apiCtx?.kind) + "，keys=" + JSON.stringify(io) + "）。" +
            "根因（旧命名空间 browserCli.inputOwnership）：feature 名有同名前缀的父 feature \"browserCli\"；" +
            "extensions/renderer/feature_cache.cc 跳过所有“父 feature 存在”的条目，因此该 namespace 从未被安装为 " +
            "BindingAccessor。已排除 switch 未转发/feature 未启用（renderer 命令行两者都在）。content 单测不覆盖 renderer 侧暴露。",
        },
      };
    },
    async rendererEvidence() {
      return childProcessCommandLineEvidence(chrome?.record?.pid);
    },
    /** 未跟踪窗口（无扩展心跳）中的一次鼠标 click（popup 直接 chrome.debugger）。 */
    async kernelMouseClick(state) {
      const x = Math.round((state.rects.btn.x + state.rects.btn.w / 2) * (Number(state.viewport.dpr) || 1));
      const y = Math.round((state.rects.btn.y + state.rects.btn.h / 2) * (Number(state.viewport.dpr) || 1));
      const press = await ctx.popupDebuggerSend(state.tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      const release = await ctx.popupDebuggerSend(state.tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      return { press, release, rejected: press.ok === false, error: press.lastError || press.error || null, x, y };
    },
    async bumpModeOnTab(tabId, mode) {
      const before = await ctx.apiCall("getOwnership", { target: { tabId } });
      const current = Number(before?.result?.version ?? 0);
      const version = current + 1;
      const raw = await ctx.apiCall("setOwnership", { target: { tabId }, mode, version });
      return { version, previousVersion: current, before, bumped: raw, accepted: raw?.result?.accepted === true };
    },
    async kernelSnapshotOnTab(tabId) {
      const raw = await ctx.apiCall("getOwnership", { target: { tabId } });
      return { tabId, raw, snapshot: raw?.result || null, lastError: raw?.lastError || null };
    },
    async kernelSnapshot(spaceKey) {
      const tabId = ctx.spaces[spaceKey].tabId;
      const raw = await ctx.apiCall("getOwnership", { target: { tabId } });
      return { tabId, raw, snapshot: raw?.result || null, lastError: raw?.lastError || null };
    },
    /** 第二个 CDP session（浏览器级），用于跨会话注入测试。 */
    async secondSession(needle) {
      const cdp = await ctx.cdp();
      const target = await cdp.findTarget(needle, "page");
      const sessionId = await cdp.attach(target.targetId);
      return { cdp, target, sessionId };
    },
  };

  function targetRectFor(index) {
    const positions = [
      [80, 80, 940, 700],
      [140, 120, 940, 700],
      [200, 160, 940, 700],
    ];
    return positions[index % positions.length];
  }

  async function findWindowByToken(pid, titleNeedle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listing = await win32.call("listWindows", { pid });
      const windows = Array.isArray(listing.windows) ? listing.windows : listing.windows ? [listing.windows] : [];
      // managed 模式下窗口以 hidden 创建（title 正确、visible=false）。
      // 优先可见窗口；否则接受隐藏窗口，由后续 moveAndSettle(SWP_SHOWWINDOW) 尝试显示。
      const matches = windows.filter((w) => String(w.title || "").includes(titleNeedle));
      const hit = matches.find((w) => w.visible) || matches[0];
      if (hit) return hit;
      await sleep(250);
    }
    return null;
  }

  async function findWidgetCandidates(topHwnd) {
    const kids = await win32.call("children", { hwnd: topHwnd });
    const list = Array.isArray(kids.children) ? kids.children : kids.children ? [kids.children] : [];
    return list
      .filter((c) => c.className === "Chrome_RenderWidgetHostHWND")
      .filter((c) => Number(c.clientWidth) * Number(c.clientHeight) > 20000)
      .sort((a, b) => {
        const va = a.visible === true ? 1 : 0;
        const vb = b.visible === true ? 1 : 0;
        if (va !== vb) return vb - va;
        return Number(b.clientWidth) * Number(b.clientHeight) - Number(a.clientWidth) * Number(a.clientHeight);
      });
  }
  async function findWidgetHwnd(topHwnd) {
    const candidates = await findWidgetCandidates(topHwnd);
    return candidates[0] || null;
  }

  async function openSpace(key, name, url) {
    const data = await ctx.client.call("open_space", { name, url });
    ctx.spaces[key] = { spaceId: data.spaceId, tabId: data.tabId, windowId: data.windowId, url, token: token + "-" + name };
    // list_tabs 在导航刚开始时可能只有 pendingUrl/空 url；轮询到 tab 命中且加载结束。
    const listDeadline = Date.now() + 20000;
    let listing = null;
    let hit = null;
    while (Date.now() < listDeadline) {
      listing = await ctx.client.call("list_tabs", {}, { space: data.spaceId });
      hit = (listing.tabs || []).find((t) =>
        String(t.url || "").includes("token=" + token + "-" + name) ||
        String(t.pendingUrl || "").includes("token=" + token + "-" + name));
      if (hit && String(hit.url || "").includes("token=" + token + "-" + name)) break;
      await sleep(250);
    }
    if (!hit) throw new Error("list_tabs 未找到 " + name + " 的 fixture tab: " + JSON.stringify(listing));
    ctx.spaces[key].tabId = hit.tabId;
    ctx.spaces[key].windowId = hit.windowId;
    // 等外观测 beacon 就绪（不依赖 js，HUMAN/Feature-on 也成立）。
    const deadline = Date.now() + 45000;
    let lastState = null;
    while (Date.now() < deadline) {
      const entry = servers.stateFor(token + "-" + name);
      if (entry?.state?.token === token + "-" + name) {
        lastState = entry.state;
        break;
      }
      await sleep(150);
    }
    if (!lastState) throw new Error("fixture beacon 未就绪: " + name);
    const win = await findWindowByToken(chrome.record.pid, "ia-" + token + "-" + name, 45000);
    if (!win) throw new Error("找不到窗口 ia-" + token + "-" + name + " (last probe: " + JSON.stringify(last) + ")");
    const settled = await moveAndSettle(win32, win.hwnd, targetRectFor(Object.keys(ctx.spaces).length - 1));
    const widget = await findWidgetHwnd(settled.hwnd);
    ctx.windows[key] = { hwnd: settled.hwnd, widgetHwnd: widget?.hwnd || null, rect: settled.rect, widget };
    console.log("[window] " + key + " hwnd=" + settled.hwnd + " widget=" + (widget?.hwnd || "none") + " rect=" + JSON.stringify(settled.rect));
    return ctx.spaces[key];
  }

  try {
    chrome = launchChrome({ profileDir, localAppData, args, label, logFile: path.join(artifactsDir, label + "-chrome.log") });
    startedChrome.push(chrome);
    sessionReport.windowPid = chrome.record.pid;
    mustCheck("[" + label + "] 可见 Chrome 已启动（非 headless / 非 --no-sandbox）", chrome.record.pid > 0 && !args.includes("--headless") && !args.includes("--no-sandbox"), process.platform);
    hostSession = await waitForHostSession(localAppData, { timeoutMs: 90000 });
    const hostExeActual = processExecutablePath(hostSession.pid);
    sessionReport.host = {
      session: { port: hostSession.port, pid: hostSession.pid, file: hostSession.file },
      actualExe: hostExeActual,
      expectedExe: report.env.hostExe,
      matches: !!hostExeActual && path.resolve(hostExeActual).toLowerCase() === path.resolve(report.env.hostExe).toLowerCase(),
    };
    mustCheck("[" + label + "] connectNative 拉起本次构建的 host exe", sessionReport.host.matches, JSON.stringify(sessionReport.host));
    ctx.hostSession = hostSession;
    ctx.client = new HostClient(hostSession, "e2e-a");
    ctx.clientB = new HostClient(hostSession, "e2e-b");
    const ping = await ctx.client.call("ping");
    mustCheck("[" + label + "] host ping=pong", ping?.pong === true, JSON.stringify(ping));

    sessionReport.boot = { args };
    if (feature !== "on-visible") {
      await openSpace("main", "main", servers.mainOrigin + "/main?token=" + token + "-main");
      await openSpace("oopif", "oopif", servers.mainOrigin + "/oopif?token=" + token + "-oopif&frame=" + encodeURIComponent(servers.frameOrigin + "/frame.html"));
      await openSpace("multi", "multi", servers.mainOrigin + "/multi?token=" + token + "-multi");
    }
    sessionReport.spaceSummary = Object.fromEntries(
      Object.entries(ctx.spaces).map(([k, v]) => [k, { spaceId: v.spaceId, tabId: v.tabId, windowId: v.windowId, url: v.url }]),
    );
    sessionReport.windows = Object.fromEntries(
      Object.entries(ctx.windows).map(([k, v]) => [k, { hwnd: v.hwnd, widgetHwnd: v.widgetHwnd, rect: v.rect }]),
    );

    for (const testCase of casesToRun) {
      const caseReport = {
        id: testCase.id,
        title: testCase.title,
        stage: testCase.stage,
        feature,
        status: "RUNNING",
        checks: [],
        evidence: [],
        error: null,
      };
      sessionReport.cases.push(caseReport);
      report.cases.push(caseReport);
      const logStart = checkLog.length;
      const failStart = failures.length;
      ctx.blocked = null;
      console.log("\n--- [" + label + "] " + testCase.id + " " + testCase.title);
      try {
        await testCase.run(ctx);
        if (ctx.blocked) {
          caseReport.status = "BLOCKED";
          caseReport.blocked = ctx.blocked;
          report.blocked.push({ id: testCase.id, ...ctx.blocked });
        } else {
          caseReport.status = failures.length === failStart ? "PASS" : "FAIL";
        }
      } catch (error) {
        caseReport.status = "FAIL";
        caseReport.error = error instanceof Error ? error.stack || error.message : String(error);
        failed++;
        failures.push(testCase.id + " threw: " + (error instanceof Error ? error.message : String(error)));
        console.error("[case " + testCase.id + "] threw: " + caseReport.error);
      }
      caseReport.checks = checkLog.slice(logStart);
      caseReport.finishedAt = nowIso();
      // 用例收尾：把可能残留的 HUMAN 状态恢复成 agent，避免污染后续用例。
      for (const key of ["main", "multi"]) {
        try {
          if (ctx.spaces[key] && (await ctx.inputStatus(key)).mode !== "ai") {
            await ctx.claim(key);
          }
        } catch {
          // ignore: 会话可能已不可用
        }
      }
    }
  } finally {
    const cleanup = { at: nowIso() };
    if (chrome) {
      if (KEEP_OPEN && failed > 0) {
        cleanup.keptOpen = true;
      } else {
        cleanup.chromeStop = chrome.stop();
        if (cleanup.chromeStop?.refused) {
          failed++;
          failures.push("[" + label + "] chrome stop refused");
        }
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          let alive = true;
          try { alive = isAlive(chrome.record); } catch { alive = false; }
          if (!alive) break;
          await sleep(250);
        }
        try { cleanup.chromeAliveAfterStop = isAlive(chrome.record); } catch { cleanup.chromeAliveAfterStop = false; }
      }
    }
    if (hostSession) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && pidAlive(hostSession.pid)) await sleep(200);
      if (pidAlive(hostSession.pid) && report.env.hostExe) {
        cleanup.hostStop = stopVerifiedPid({ pid: hostSession.pid, expectedExePath: report.env.hostExe, reason: label + ".host" });
      } else {
        cleanup.hostExitedOnItsOwn = true;
      }
      cleanup.hostAliveAfterStop = pidAlive(hostSession.pid);
    }
    let logText = "";
    try { logText = fs.readFileSync(path.join(artifactsDir, label + "-chrome.log"), "utf8"); } catch {}
    const patterns = { fatal: /FATAL/g, checkFailed: /Check failed/gi, rendererCrash: /Renderer process (crashed|gone|killed)/gi, gpuCrash: /GPU process (crashed|gone|killed)/gi };
    const matches = {};
    for (const [key, re] of Object.entries(patterns)) {
      const lines = logText.split(/\r?\n/).filter((l) => re.test(l));
      matches[key] = { count: lines.length, samples: lines.slice(0, 5).map((l) => l.slice(0, 300)) };
    }
    try {
      if (ctx._browserCdp) {
        ctx._browserCdp.close();
        cleanup.browserCdpClosed = true;
      }
    } catch (error) {
      cleanup.browserCdpCloseError = String(error);
    }
    sessionReport.browserLog = { file: path.join(artifactsDir, label + "-chrome.log"), bytes: logText.length, patterns: matches };
    sessionReport.cleanup = cleanup;
    sessionReport.finishedAt = nowIso();
    console.log("[" + label + "] cleanup " + JSON.stringify(cleanup));
  }
}

function launchChrome({ profileDir, localAppData, args, label, logFile }) {
  const env = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    BROWSERPILOT_HOST_BASE_PORT: String(48900 + Math.floor(Math.random() * 90)),
  };
  const record = launchTestProcess({
    exe: CHROME,
    args,
    env,
    marker: profileDir,
    label,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = record.child;
  const log = fs.createWriteStream(logFile, { flags: "a" });
  let stderr = "";
  const stdout = "";
  child.stdout.on("data", (d) => log.write(d));
  child.stderr.on("data", (d) => {
    stderr += d;
    if (stderr.length > 400000) stderr = stderr.slice(-400000);
    log.write(d);
  });
  child.on("exit", (code) => {
    log.write("\n[exit] code=" + code + "\n");
    log.end();
  });
  return {
    record,
    child,
    args,
    env: { LOCALAPPDATA: env.LOCALAPPDATA, BROWSERPILOT_HOST_BASE_PORT: env.BROWSERPILOT_HOST_BASE_PORT },
    logFile,
    stderrTail: () => stderr.split(/\r?\n/).slice(-20).join("\n"),
    stop: () => stopTestProcess(record, { reason: label + ".stop" }),
  };
}

async function moveAndSettle(w, hwnd, desiredRect, { attempts = 5, raise = true } = {}) {
  let rect = [...desiredRect];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const moved = await w.call("move", { hwnd, x: rect[0], y: rect[1], width: rect[2], height: rect[3], noActivate: !raise });
    await sleep(700);
    const state = await w.call("state", { hwnd });
    const current = state.window.rect;
    if (current && current[0] === rect[0] && current[1] === rect[1] && current[2] === rect[2] && current[3] === rect[3]) {
      return { hwnd, rect: current, window: state.window, foreground: state.foreground, attempts: attempt, stable: true, move: moved };
    }
    if (current) rect = [...current];
  }
  const state = await w.call("state", { hwnd });
  return { hwnd, rect: state.window.rect, window: state.window, foreground: state.foreground, attempts, stable: false };
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error("[test] fatal: " + message);
  report.error = message;
  report.blockedReason = error instanceof Error ? error.message : String(error);
  report.verdict = report.sessions.length ? "PARTIAL" : "BLOCKED";
} finally {
  if (!MATRIX) {
    // 注册表回滚（先停 Chrome 已在上面的 finally 完成）
    try {
      if (registration?.backupFile) {
        const rollback = runPowerShellFile(UNREGISTER_PS1, ["-BackupFile", registration.backupFile]);
        let afterRollback = registryDefault(REGISTRY_KEY);
        let healed = false;
        if (report.registration?.staleOurManifestDetected && report.registration.restoreTargetKnown && looksLikeOurManifest(afterRollback)) {
          // 备份里的 previousDefault 本身就是上次残留值：直接写回历史回溯出的原始值。
          forceRestoreRegistry(report.registration.restoreTarget);
          afterRollback = registryDefault(REGISTRY_KEY);
          healed = true;
          console.log("[registry] 已把残留值回滚到历史原始值: " + JSON.stringify(afterRollback));
        }
        const expectedBefore =
          report.registration?.restoreTargetKnown
            ? report.registration.restoreTarget === null
              ? "<missing>"
              : report.registration.restoreTarget
            : report.registration?.beforeValue;
        report.registration = {
          ...(report.registration || {}),
          rollback: { status: rollback.status, json: rollback.json, stderrTail: (rollback.stderr || "").slice(-600) },
          afterRollback,
          healedFromStale: healed,
          restored: afterRollback === expectedBefore,
        };
        check("unregister.ps1 恢复注册表到测试前值（含残留自愈）", afterRollback === expectedBefore, JSON.stringify({ afterRollback, expected: expectedBefore, healed }));
      } else {
        report.cleanup = { ...(report.cleanup || {}), registry: { skipped: "no backup" } };
      }
    } catch (error) {
      failed++;
      failures.push("registry rollback failed");
      console.error("[test] registry rollback failed: " + (error instanceof Error ? error.message : String(error)));
    }
    try {
      if (win32?.child) await win32.stop();
    } catch (error) {
      console.error("[test] win32 helper stop failed: " + (error instanceof Error ? error.message : String(error)));
    }
    try {
      servers?.close();
    } catch {}
    // 残留检查（只针对本会话自己的路径）
    const cleanup = { ...(report.cleanup || {}), at: nowIso() };
    cleanup.chromeAliveFinal = startedChrome.some((c) => {
      try { return isAlive(c.record); } catch { return false; }
    });
    for (const s of report.sessions) {
      if (s.cleanup && !s.cleanup.keptOpen) {
        check("[" + s.label + "] 清理后测试 Chrome 进程不存在", s.cleanup.chromeAliveAfterStop !== true, JSON.stringify(s.cleanup));
      }
    }
    report.cleanup = cleanup;
  }

  report.finishedAt = nowIso();
  report.checks = { passed, failed, failures: [...failures], log: checkLog };
  report.matrix = CASES.map((c) => {
    const executed = report.cases.filter((x) => x.id === c.id);
    return {
      id: c.id,
      stage: c.stage,
      feature: c.feature || null,
      title: c.title,
      status: c.blocked ? "blocked" : executed.length ? executed.map((e) => e.status).join("+") : "not-run",
      dependsOn: c.blocked ? c.blocked.deps : [],
      reason: c.blocked ? c.blocked.reason : null,
    };
  });
  if (!MATRIX) {
    const executed = report.cases.filter((c) => c.status === "PASS" || c.status === "FAIL");
    const blockedCount = report.cases.filter((c) => c.status === "BLOCKED").length;
    const failedCount = report.cases.filter((c) => c.status === "FAIL").length;
    if (report.error && !executed.length) report.verdict = "BLOCKED";
    else if (executed.length === 0 && blockedCount > 0) {
      report.verdict = "BLOCKED";
      report.blockedReason = "所有被选中的用例都 blocked（没有任何真实执行）";
    } else if (failedCount > 0 || report.error) report.verdict = "PARTIAL";
    else if (blockedCount > 0) report.verdict = "PARTIAL";
    else report.verdict = executed.length ? "PASS" : "BLOCKED";
    // P0 回归（例如 managed hidden 截图）不计入输入仲裁失败，但也不允许出现 PASS。
    if (report.verdict === "PASS" && report.p0Regressions.length > 0) {
      report.verdict = "PARTIAL";
      report.blockedReason = "存在单列的 P0 回归（见 p0Regressions），输入仲裁用例本身全部通过。";
    }
    report.summary = {
      executed: executed.length,
      pass: report.cases.filter((c) => c.status === "PASS").length,
      fail: failedCount,
      blocked: blockedCount,
      checks: { passed, failed },
    };
  }
  const reportFile = path.join(LOG_DIR, "input-arbitration-e2e-" + nowIso().replace(/[:.]/g, "-") + ".json");
  try {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
    report.reportFile = reportFile;
    console.log("\nreport -> " + reportFile);
  } catch (error) {
    console.error("[test] report write failed: " + (error instanceof Error ? error.message : String(error)));
  }
  saveArtifact("report.json", report);
  console.log("\n" + passed + "/" + (passed + failed) + " checks passed");
  console.log("VERDICT: " + report.verdict);
  if (failures.length) console.log("failed: " + failures.join("; "));
  process.exit(report.verdict === "PASS" || report.verdict === "MATRIX" ? 0 : 1);
}
