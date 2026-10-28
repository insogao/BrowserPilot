// 真实浏览器并发测试（P0，2026-10-28）。
//
// 不是 mock：启动独立临时 profile 的 headless Chromium，加载本仓库 dist/ 扩展，
// 经已注册的 native host（TCP loopback）派发真实命令，窗口/截图/DOM 都是真的。
//
// 覆盖：
//   A. 两个独立 Task Space 同时跑「开页 → 操作 → 截图 → 长截图 → 关页」：
//      记录每条命令 start/end，断言时间区间真实重叠，且总耗时明显小于串行和。
//   B. 两个 space 同时 run_template（模板内部含操作 + 截图）：
//      证明 run_template 不再整段持有进程级租约。
//   C. 同一 space 互斥：run_template 持有 space 租约期间，同 space 的 open_tab /
//      第二个 run_template 明确失败 FOREGROUND_BUSY；不同 space 的 open_tab 成功。
//   D. 8 窗口压力：8 个 space 并发执行完整流程，断言全部成功、无死锁、无崩溃，
//      且 wall time 明显小于串行和。
//
// 安全边界：只使用独立临时 --user-data-dir；只结束自己启动的 chrome 进程树与
// 自己的 native host pid；不使用 --no-sandbox；不碰用户真实 Chrome/profile。
//
// 用法：node scripts/test-concurrency-live.mjs [--windows=8] [--port=48900] [--no-build] [--keep]
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const WINDOWS = Math.max(2, Math.min(16, Number(value("windows", "8"))));
const BASE_PORT = Number(value("port", "48900"));
const SKIP_BUILD = flag("no-build");
const KEEP_PROFILE = flag("keep");
const CHROME = process.env.BP_CHROME || "D:\\work\\wt\\browser-cli-baseline\\chrome.exe";
const DIST = path.join(root, "dist");

if (!fs.existsSync(CHROME)) throw new Error("找不到测试浏览器: " + CHROME + "（可用 BP_CHROME 覆盖）");
if (!fs.existsSync(path.join(DIST, "background.js"))) throw new Error("dist/ 未构建：先运行 node scripts/build.js");

function now() { return performance.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function round(ms) { return Math.round(ms * 10) / 10; }

function sessionDir() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "BrowserPilot", "sessions");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "BrowserPilot", "sessions");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "BrowserPilot", "sessions");
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function findSession(since) {
  const dir = sessionDir();
  for (let port = BASE_PORT; port < BASE_PORT + 50; port++) {
    const file = path.join(dir, port + ".json");
    if (!fs.existsSync(file)) continue;
    try {
      const session = JSON.parse(fs.readFileSync(file, "utf8"));
      if (session.port === port && Number(session.updatedAt) >= since && pidAlive(session.pid)) return { ...session, file };
    } catch { /* 半写入/旧文件：跳过 */ }
  }
  return undefined;
}

class HostClient {
  constructor(port, authToken, agentId) {
    this.port = port;
    this.authToken = authToken;
    this.agentId = agentId;
    this.seq = 0;
    this.pending = new Map();
    this.socket = undefined;
    this.events = [];
    this.closed = false;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: this.port });
      this.socket = socket;
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("connect", resolve);
      socket.on("error", (error) => {
        this.failAll("socket error: " + error.message);
        reject(error);
      });
      socket.on("close", () => {
        this.closed = true;
        this.failAll("socket closed");
      });
      socket.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message?.type === "event") {
            this.events.push(message);
            continue;
          }
          const entry = this.pending.get(message?.requestId);
          if (!entry) continue; // 迟到的/未知结果：丢弃，不污染其它请求
          this.pending.delete(message.requestId);
          clearTimeout(entry.timer);
          entry.resolve({
            ok: message.ok === true,
            data: message.data,
            error: message.error,
            errorCode: message.errorCode,
            command: entry.command,
            args: entry.args,
            start: entry.start,
            end: now(),
            duration: now() - entry.start,
            agent: this.agentId,
          });
        }
      });
    });
  }

  failAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: reason, timedOut: false, command: entry.command, args: entry.args, start: entry.start, end: now(), duration: now() - entry.start, agent: this.agentId });
    }
    this.pending.clear();
  }

  send(command, commandArgs = {}, timeoutMs = 120_000) {
    if (!this.socket || this.closed) return Promise.resolve({ ok: false, error: "not connected", command, args: commandArgs, start: now(), end: now(), duration: 0, agent: this.agentId });
    const requestId = this.agentId + "-" + (++this.seq);
    const start = now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: "client timeout after " + timeoutMs + "ms", timedOut: true, command, args: commandArgs, start, end: now(), duration: now() - start, agent: this.agentId });
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer, start, command, args: commandArgs });
      this.socket.write(JSON.stringify({
        type: "command",
        name: command,
        args: commandArgs,
        requestId,
        agentId: this.agentId,
        authToken: this.authToken,
      }) + "\n");
    });
  }

  close() {
    try { this.socket?.end(); } catch { /* ignore */ }
  }
}

const tracelog = [];
function record(result) {
  tracelog.push(result);
  return result;
}

async function call(client, command, commandArgs = {}, timeoutMs) {
  return record(await client.send(command, commandArgs, timeoutMs));
}

function overlapMs(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function timeline(results, t0) {
  return results
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((r) => ({
      agent: r.agent,
      command: r.command,
      start: round(r.start - t0),
      end: round(r.end - t0),
      duration: round(r.duration),
      ok: r.ok,
      error: r.errorCode ?? r.error,
    }));
}

const startedAtWall = Date.now();
const runT0 = now();
let profileDir;
let chrome;
let chromeStderr = "";
let hostSession;

function stopChromeTree() {
  if (!chrome || chrome.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { chrome.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

async function cleanup() {
  try {
    if (hostSession && pidAlive(hostSession.pid)) {
      try { process.kill(Number(hostSession.pid)); } catch { /* ignore */ }
      await sleep(300);
    }
    if (hostSession?.file) {
      try {
        const current = JSON.parse(fs.readFileSync(hostSession.file, "utf8"));
        if (current.pid === hostSession.pid) fs.unlinkSync(hostSession.file);
      } catch { /* ignore */ }
    }
  } finally {
    stopChromeTree();
    await sleep(800);
    if (profileDir && !KEEP_PROFILE) {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch { await sleep(400); }
      }
    }
  }
}

function launchBrowser() {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-concurrency-"));
  chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--in-process-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions-update-check",
    "--user-data-dir=" + profileDir,
    "--disable-extensions-except=" + DIST,
    "--load-extension=" + DIST,
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: { ...process.env, BROWSERPILOT_HOST_BASE_PORT: String(BASE_PORT) },
  });
  chrome.stderr.on("data", (chunk) => {
    chromeStderr += chunk.toString("utf8");
    if (chromeStderr.length > 20_000) chromeStderr = chromeStderr.slice(-20_000);
  });
}

async function waitForHostAndExtension() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error("Chromium 提前退出（code=" + chrome.exitCode + "）\n" + chromeStderr.slice(-3000));
    hostSession = findSession(startedAtWall);
    if (!hostSession) { await sleep(400); continue; }
    const probe = new HostClient(hostSession.port, hostSession.authToken, "probe");
    try {
      await probe.connect();
      // version 由扩展 SW 处理：能返回说明 SW 已就绪且 native 通道通了。
      const version = await probe.send("version", {}, 5_000);
      if (version.ok) {
        probe.close();
        return hostSession;
      }
    } catch { /* host 刚启动/端口未就绪，重试 */ }
    probe.close();
    await sleep(400);
  }
  throw new Error("60s 内未等到扩展/native host 就绪。session=" + JSON.stringify(hostSession) + "\n" + chromeStderr.slice(-3000));
}

async function installTemplate(client, template) {
  const res = await call(client, "install_template", { content: JSON.stringify(template) });
  if (!res.ok) throw new Error("install_template 失败: " + (res.error ?? JSON.stringify(res)));
  return res;
}

function assertOk(result, label) {
  if (!result.ok) throw new Error(label + " 失败: " + (result.errorCode ? result.errorCode + " " : "") + (result.error ?? "unknown"));
  return result;
}

function countMaxConcurrency(intervals) {
  const points = [];
  for (const item of intervals) {
    points.push({ t: item.start, delta: 1 });
    points.push({ t: item.end, delta: -1 });
  }
  points.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let current = 0;
  let max = 0;
  for (const p of points) {
    current += p.delta;
    if (current > max) max = current;
  }
  return max;
}

const report = {
  generatedAt: new Date().toISOString(),
  browser: CHROME,
  windows: WINDOWS,
  basePort: BASE_PORT,
  phases: {},
  commands: [],
};

try {
  if (!SKIP_BUILD) {
    const build = spawnSync(process.execPath, [path.join(root, "scripts", "build.js")], { cwd: root, stdio: "inherit", windowsHide: true });
    if (build.status !== 0) throw new Error("build 失败");
  }

  launchBrowser();
  const session = await waitForHostAndExtension();
  console.log("[live] host ready: port=" + session.port + " pid=" + session.pid + " profile=" + profileDir);

  const host = { port: session.port, token: session.authToken };
  const clientFor = async (agentId) => {
    const client = new HostClient(host.port, host.token, agentId);
    await client.connect();
    const v = await client.send("version", {}, 10_000);
    if (!v.ok) throw new Error("agent " + agentId + " 无法连接扩展: " + v.error);
    return client;
  };

  const agentA = await clientFor("conc-a");
  const agentB = await clientFor("conc-b");

  // ---------- 准备：两个独立 space（open_space 是全局呈现操作，顺序创建） ----------
  const spaceA = assertOk(await call(agentA, "open_space", { name: "conc-a" }), "open_space A");
  const spaceB = assertOk(await call(agentB, "open_space", { name: "conc-b" }), "open_space B");
  if (spaceA.data.spaceId === spaceB.data.spaceId) throw new Error("两个 Agent 拿到了同一个 space");
  if (spaceA.data.windowId === spaceB.data.windowId) throw new Error("两个 space 绑定到同一个窗口");
  console.log("[live] spaces: A=" + spaceA.data.spaceId + " win=" + spaceA.data.windowId + ", B=" + spaceB.data.spaceId + " win=" + spaceB.data.windowId);

  // ---------- A. 两个 space 并发跑完整流程（含截图/滚动截图） ----------
  const tallExpr = "(()=>{document.title='conc-flow';document.body.style.margin='0';document.body.innerHTML='<div style=\"height:2600px;background:linear-gradient(#c00,#00c);color:#fff\">concurrency</div>';return {docH:document.documentElement.scrollHeight,viewH:innerHeight};})()";
  const sleepExpr = "(async()=>{await new Promise(r=>setTimeout(r,350));return {slept:true};})()";
  // 对齐屏障：两个页面都等到同一个墙钟时刻再截图，避免“谁先跑完 JS 谁先截”的调度漂移
  // 让 25–35ms 的截图错过重叠窗口。这不是串行化——屏障本身也是并发执行的。
  const flowBarrierAt = Date.now() + 1500;
  const barrierExpr = "(async()=>{const target=" + flowBarrierAt + ";while(Date.now()<target){await new Promise(r=>setTimeout(r,5));}return {waited:true};})()";

  async function flow(client, label) {
    const steps = [];
    steps.push(await call(client, "open_tab", { url: "about:blank" }, 30_000));
    steps.push(await call(client, "js", { expression: tallExpr }, 30_000));
    steps.push(await call(client, "js", { expression: sleepExpr }, 30_000));
    steps.push(await call(client, "js", { expression: barrierExpr }, 30_000));
    steps.push(await call(client, "screenshot", { format: "png" }, 30_000));
    steps.push(await call(client, "scroll_screenshot", { pages: 2, gap: 120 }, 60_000));
    steps.push(await call(client, "js", { expression: "document.title" }, 30_000));
    const tabId = steps[0]?.data?.tabId;
    steps.push(await call(client, "close_tab", { tabId }, 30_000));
    for (const step of steps) assertOk(step, label + " " + step.command);
    return steps;
  }

  const flowT0 = now();
  const [flowA, flowB] = await Promise.all([flow(agentA, "A"), flow(agentB, "B")]);
  const flowWall = now() - flowT0;
  const serialSum = (flowA.at(-1).end - flowA[0].start) + (flowB.at(-1).end - flowB[0].start);

  const byName = (steps, name) => steps.filter((s) => s.command === name);
  const overlapChecks = [];
  for (const name of ["js", "screenshot", "scroll_screenshot", "close_tab"]) {
    const listA = byName(flowA, name);
    const listB = byName(flowB, name);
    for (let i = 0; i < Math.min(listA.length, listB.length); i++) {
      overlapChecks.push({ name: name + "[" + i + "]", overlap: round(overlapMs(listA[i], listB[i])) });
    }
  }
  const screenshotChecks = overlapChecks.filter((c) => c.name.startsWith("screenshot"));
  const scrollChecks = overlapChecks.filter((c) => c.name.startsWith("scroll_screenshot"));
  const screenshotMeta = [...byName(flowA, "screenshot"), ...byName(flowB, "screenshot")].map((s) => ({
    agent: s.agent,
    possiblyStale: s.data?.possiblyStale,
    reason: s.data?.reason,
    durationMs: s.duration,
  }));
  const scrollMeta = [...byName(flowA, "scroll_screenshot"), ...byName(flowB, "scroll_screenshot")].map((s) => ({
    agent: s.agent,
    possiblyStale: s.data?.possiblyStale,
    staleTiles: s.data?.staleTiles,
    staleReasons: s.data?.staleReasons,
    durationMs: s.duration,
  }));
  report.phases.twoSpaceFlow = {
    t0: 0,
    wallMs: round(flowWall),
    serialSumMs: round(serialSum),
    overlap: overlapChecks,
    timeline: timeline([...flowA, ...flowB], flowT0),
    screenshots: screenshotMeta,
    scrollScreenshots: scrollMeta,
  };
  if (!screenshotChecks.some((c) => c.overlap > 0)) throw new Error("两个 space 的 screenshot 时间区间没有重叠（仍被串行化？）: " + JSON.stringify(overlapChecks));
  if (!scrollChecks.some((c) => c.overlap > 0)) throw new Error("两个 space 的 scroll_screenshot 时间区间没有重叠（仍被串行化？）: " + JSON.stringify(overlapChecks));
  if (!(flowWall < serialSum * 0.85)) throw new Error("并发总耗时没有明显小于串行和: wall=" + round(flowWall) + "ms serial=" + round(serialSum) + "ms");
  if (screenshotMeta.some((m) => m.possiblyStale !== false)) throw new Error("截图返回 possiblyStale=true，不能当作最新画面: " + JSON.stringify(screenshotMeta));
  console.log("[live] A) two-space flow: wall=" + round(flowWall) + "ms serialSum=" + round(serialSum) + "ms overlap=" + JSON.stringify(overlapChecks));

  // ---------- B. 两个 space 同时 run_template（模板内含截图） ----------
  const flowTemplate = {
    id: "concurrency-flow",
    name: "Concurrency Flow",
    version: "1.0.0",
    description: "P0 concurrency test: page op + screenshot inside a template.",
    category: "generic",
    inputs: [],
    steps: "commands",
    body: [
      { name: "open_tab", args: { url: "about:blank" } },
      { name: "js", args: { expression: tallExpr } },
      { name: "js", args: { expression: "(async()=>{await new Promise(r=>setTimeout(r,400));return {ok:true};})()" }, expectations: [{ path: "value.ok", equals: true }] },
      { name: "screenshot", args: { format: "png" }, expectations: [{ path: "base64", exists: true }] },
      { name: "close_tab", args: {} },
    ],
  };
  await installTemplate(agentA, flowTemplate);
  const templateT0 = now();
  const [tplA, tplB] = await Promise.all([
    call(agentA, "run_template", { id: "concurrency-flow" }, 120_000),
    call(agentB, "run_template", { id: "concurrency-flow" }, 120_000),
  ]);
  assertOk(tplA, "run_template A");
  assertOk(tplB, "run_template B");
  const tplWall = now() - templateT0;
  const tplSerial = (tplA.end - tplA.start) + (tplB.end - tplB.start);
  const tplOverlap = round(overlapMs(tplA, tplB));
  if (!(tplOverlap > 0)) throw new Error("两个 space 的 run_template 时间区间没有重叠（仍持有全局租约？）");
  if (!(tplWall < tplSerial * 0.85)) throw new Error("run_template 并发没有明显快于串行: wall=" + round(tplWall) + " serial=" + round(tplSerial));
  report.phases.twoSpaceTemplate = {
    wallMs: round(tplWall),
    serialSumMs: round(tplSerial),
    overlapMs: tplOverlap,
    timeline: timeline([tplA, tplB], templateT0),
  };
  console.log("[live] B) two-space run_template: wall=" + round(tplWall) + "ms serialSum=" + round(tplSerial) + "ms overlap=" + tplOverlap + "ms");

  // ---------- C. 同一 space 互斥；不同 space 不受影响 ----------
  const holdTemplate = {
    id: "concurrency-hold",
    name: "Concurrency Hold",
    version: "1.0.0",
    description: "P0 concurrency test: hold the space lease for ~1.2s.",
    category: "generic",
    inputs: [],
    steps: "commands",
    body: [
      { name: "js", args: { expression: "(async()=>{await new Promise(r=>setTimeout(r,1200));return {held:true};})()" }, expectations: [{ path: "value.held", equals: true }] },
    ],
  };
  await installTemplate(agentA, holdTemplate);
  const holdT0 = now();
  const hold = call(agentA, "run_template", { id: "concurrency-hold" }, 60_000);
  await sleep(250); // 确认 hold 已经开始并持有 space:space-a
  const sameSpaceTab = await call(agentA, "open_tab", { url: "about:blank" }, 10_000);
  const sameSpaceTemplate = await call(agentA, "run_template", { id: "concurrency-hold" }, 10_000);
  const otherSpaceTab = await call(agentB, "open_tab", { url: "about:blank" }, 30_000);
  const holdResult = await hold;
  const otherSpaceTabClosed = otherSpaceTab.ok ? await call(agentB, "close_tab", { tabId: otherSpaceTab.data.tabId }, 30_000) : undefined;
  assertOk(holdResult, "hold template");
  assertOk(otherSpaceTab, "other-space open_tab during hold");
  if (otherSpaceTabClosed) assertOk(otherSpaceTabClosed, "other-space close_tab");
  if (sameSpaceTab.ok) throw new Error("同一 space 的 open_tab 没有互斥（应 FOREGROUND_BUSY）");
  if (sameSpaceTemplate.ok) throw new Error("同一 space 的第二个 run_template 没有互斥（应 FOREGROUND_BUSY）");
  if (sameSpaceTab.errorCode !== "FOREGROUND_BUSY") throw new Error("同 space open_tab 错误码不是 FOREGROUND_BUSY: " + sameSpaceTab.errorCode + " " + sameSpaceTab.error);
  if (sameSpaceTemplate.errorCode !== "FOREGROUND_BUSY") throw new Error("同 space run_template 错误码不是 FOREGROUND_BUSY: " + sameSpaceTemplate.errorCode + " " + sameSpaceTemplate.error);
  if (!(sameSpaceTab.start < holdResult.end)) throw new Error("互斥用例没有真正与 hold 重叠（测试无效）");
  // hold 结束后同 space 立即可用（无死锁/无残留租约）
  const afterHoldTab = await call(agentA, "open_tab", { url: "about:blank" }, 30_000);
  assertOk(afterHoldTab, "open_tab after hold");
  assertOk(await call(agentA, "close_tab", { tabId: afterHoldTab.data.tabId }, 30_000), "close_tab after hold");
  report.phases.sameSpaceMutex = {
    hold: { start: round(holdResult.start - holdT0), end: round(holdResult.end - holdT0), duration: round(holdResult.duration), ok: holdResult.ok },
    sameSpaceOpenTab: { start: round(sameSpaceTab.start - holdT0), end: round(sameSpaceTab.end - holdT0), ok: sameSpaceTab.ok, errorCode: sameSpaceTab.errorCode, overlappedHold: sameSpaceTab.start < holdResult.end },
    sameSpaceRunTemplate: { start: round(sameSpaceTemplate.start - holdT0), end: round(sameSpaceTemplate.end - holdT0), ok: sameSpaceTemplate.ok, errorCode: sameSpaceTemplate.errorCode, overlappedHold: sameSpaceTemplate.start < holdResult.end },
    otherSpaceOpenTab: { start: round(otherSpaceTab.start - holdT0), end: round(otherSpaceTab.end - holdT0), ok: otherSpaceTab.ok, duration: round(otherSpaceTab.duration) },
    afterHoldOpenTab: { ok: afterHoldTab.ok, duration: round(afterHoldTab.duration) },
  };
  console.log("[live] C) same-space mutex: open_tab=" + sameSpaceTab.errorCode + ", run_template=" + sameSpaceTemplate.errorCode + ", other space ok=" + otherSpaceTab.ok + " (" + round(otherSpaceTab.duration) + "ms)");

  // ---------- D. N 窗口压力 ----------
  const stressAgents = [];
  for (let i = 1; i <= WINDOWS; i++) {
    const agent = await clientFor("stress-" + i);
    const space = assertOk(await call(agent, "open_space", { name: "stress-" + i }), "stress open_space " + i);
    stressAgents.push({ agent, space: space.data, index: i });
  }
  const stressT0 = now();
  const stressBarrierAt = Date.now() + 1500;
  const stressBarrierExpr = "(async()=>{const target=" + stressBarrierAt + ";while(Date.now()<target){await new Promise(r=>setTimeout(r,5));}return {waited:true};})()";
  const stressRuns = await Promise.all(stressAgents.map(async (item) => {
    const steps = [];
    steps.push(await call(item.agent, "open_tab", { url: "about:blank" }, 30_000));
    steps.push(await call(item.agent, "js", { expression: tallExpr + "" }, 30_000));
    steps.push(await call(item.agent, "js", { expression: "(async()=>{await new Promise(r=>setTimeout(r,250));return {ok:true};})()" }, 30_000));
    steps.push(await call(item.agent, "js", { expression: stressBarrierExpr }, 30_000));
    steps.push(await call(item.agent, "screenshot", { format: "png" }, 60_000));
    steps.push(await call(item.agent, "js", { expression: "({title:document.title,docH:document.documentElement.scrollHeight})" }, 30_000));
    steps.push(await call(item.agent, "close_tab", { tabId: steps[0].data?.tabId }, 30_000));
    return { index: item.index, steps };
  }));
  const stressWall = now() - stressT0;
  const failures = [];
  for (const run of stressRuns) {
    for (const step of run.steps) {
      if (!step.ok) failures.push({ window: run.index, command: step.command, error: step.error, errorCode: step.errorCode });
    }
  }
  if (failures.length) throw new Error("8 窗口压力有失败命令: " + JSON.stringify(failures));
  const allStressSteps = stressRuns.flatMap((r) => r.steps);
  const stressSerial = stressRuns.reduce((sum, r) => sum + (r.steps.at(-1).end - r.steps[0].start), 0);
  if (!(stressWall < stressSerial * 0.85)) throw new Error("8 窗口没有真实并行: wall=" + round(stressWall) + " serialSum=" + round(stressSerial));
  const stressScreens = allStressSteps.filter((s) => s.command === "screenshot");
  const maxScreenConcurrency = countMaxConcurrency(stressScreens);
  if (maxScreenConcurrency < Math.min(4, WINDOWS)) throw new Error("8 窗口截图并发度不足: max=" + maxScreenConcurrency);
  if (stressScreens.some((s) => s.data?.possiblyStale !== false)) throw new Error("8 窗口中有截图被标记 stale: " + JSON.stringify(stressScreens.filter((s) => s.data?.possiblyStale).map((s) => s.agent)));
  // 全部结束后扩展仍存活（无崩溃/死锁）
  const alive = await agentA.send("version", {}, 10_000);
  if (!alive.ok) throw new Error("压力测试后扩展无响应（可能崩溃/死锁）: " + alive.error);
  // 并发关闭所有 space（每个 space 一个 key，应可并行）
  const closeT0 = now();
  const closeResults = await Promise.all(stressAgents.map((item) => call(item.agent, "complete_space", { spaceId: item.space.spaceId }, 30_000)));
  const closeWall = now() - closeT0;
  for (const res of closeResults) assertOk(res, "complete_space");
  report.phases.stress = {
    windows: WINDOWS,
    wallMs: round(stressWall),
    serialSumMs: round(stressSerial),
    maxScreenshotConcurrency: maxScreenConcurrency,
    failures,
    closeSpacesWallMs: round(closeWall),
    perWindow: stressRuns.map((r) => ({
      window: r.index,
      totalMs: round(r.steps.at(-1).end - r.steps[0].start),
      steps: r.steps.map((s) => ({ command: s.command, start: round(s.start - stressT0), end: round(s.end - stressT0), duration: round(s.duration), ok: s.ok })),
    })),
  };
  console.log("[live] D) " + WINDOWS + "-window stress: wall=" + round(stressWall) + "ms serialSum=" + round(stressSerial) + "ms maxScreenshotConcurrency=" + maxScreenConcurrency + " closeSpaces=" + round(closeWall) + "ms");

  // 清理 2 窗口阶段的 space
  assertOk(await call(agentA, "complete_space", {}, 30_000), "complete_space A");
  assertOk(await call(agentB, "complete_space", {}, 30_000), "complete_space B");

  agentA.close();
  agentB.close();
  for (const item of stressAgents) item.agent.close();

  report.commands = tracelog.map((r) => ({
    agent: r.agent,
    command: r.command,
    start: round(r.start - runT0),
    end: round(r.end - runT0),
    duration: round(r.duration),
    ok: r.ok,
    errorCode: r.errorCode,
    error: r.errorCode ? undefined : r.error,
  }));
  report.result = "PASS";
  console.log("[live] PASS: all concurrency phases");
} catch (error) {
  report.result = "FAIL";
  report.error = error instanceof Error ? error.message : String(error);
  console.error("[live] FAIL: " + report.error);
  process.exitCode = 1;
} finally {
  await cleanup();
  console.log("----- CONCURRENCY DATA BEGIN -----");
  console.log(JSON.stringify(report, null, 2));
  console.log("----- CONCURRENCY DATA END -----");
}
