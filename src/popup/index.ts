// popup：只展示真实 Agent 活跃状态；主按钮按连接/人工接管动态出现。
import type { PopupGuide, PopupRequest, PopupStatus } from "../shared/types";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function toast(msg: string): void {
  const el = $("toast");
  el.textContent = msg;
}

function setStatus(s: PopupStatus): void {
  const mode = s.mode ?? "idle";
  const hostReady = !!s.hostReady || typeof s.hostPort === "number";
  $("dot").classList.toggle("on", hostReady && mode !== "human");
  $("dot").classList.toggle("paused", mode === "human");
  $("host").textContent = hostReady ? "已就绪" : "未就绪";
  const labels = { idle: "未连接", agent: "操作中", human: "已暂停" } as const;
  $("connection").textContent = labels[mode];
  $("profile").textContent = s.profile?.profileDir ?? s.profile?.detail ?? "-";
  $("hostPort").textContent = typeof s.hostPort === "number" ? String(s.hostPort) : "-";
  const action = $("takeover") as HTMLButtonElement;
  action.hidden = mode === "idle";
  action.dataset.action = mode === "human" ? "resume" : "takeover";
  action.textContent = mode === "human" ? "恢复 Agent" : "人工接管";
  action.classList.toggle("primary", mode === "agent");
  action.classList.toggle("resume", mode === "human");
}

async function send(msg: PopupRequest): Promise<PopupStatus | PopupGuide> {
  return chrome.runtime.sendMessage(msg) as Promise<PopupStatus | PopupGuide>;
}

async function refresh(): Promise<void> {
  const s = (await send({ kind: "get_status" })) as PopupStatus;
  setStatus(s);
}

$("takeover").addEventListener("click", async () => {
  const resume = (($("takeover") as HTMLButtonElement).dataset.action === "resume");
  const s = (await send({ kind: resume ? "resume_agent" : "take_over" })) as PopupStatus;
  setStatus(s);
  toast(s.mode === "human" ? "Agent 已暂停" : s.mode === "agent" ? "Agent 已恢复" : "当前没有 Agent 连接");
});

$("guide").addEventListener("click", async () => {
  try {
    const g = (await send({ kind: "get_guide" })) as PopupGuide;
    await navigator.clipboard.writeText(g.guide);
    toast("BrowserPilot Skill 已复制");
  } catch (e) {
    toast("复制失败：" + (e instanceof Error ? e.message : String(e)));
  }
});

$("manage").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void refresh();
setInterval(() => void refresh().catch(() => {}), 1000);
