// popup 逻辑：状态展示 + 三按钮（接管/复制使用文档/Stop）。
import type { PopupGuide, PopupRequest, PopupStatus } from "../shared/types";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function toast(msg: string): void {
  const el = $("toast");
  el.textContent = msg;
}

function setStatus(s: PopupStatus): void {
  $("dot").classList.toggle("on", s.mode === "agent" || s.mode === "ready");
  const labels = { idle: "空闲", ready: "已选为目标", agent: "Agent 操作中", human: "人工接管中" } as const;
  $("attached").textContent = labels[s.mode ?? "idle"];
  $("layer").textContent = s.layer ?? "-";
  $("profile").textContent = s.profile?.profileDir ?? s.profile?.detail ?? "-";
  $("port").textContent = s.hostPort != null ? String(s.hostPort) : "-";
}

$("use-current").addEventListener("click", async () => {
  const s = (await send({ kind: "use_current_tab" })) as PopupStatus;
  setStatus(s);
  toast(s.mode === "ready" || s.mode === "agent" ? "已将当前标签设为 Agent 操作目标" : "设置失败（无活动标签）");
});

async function send(msg: PopupRequest): Promise<PopupStatus | PopupGuide> {
  return chrome.runtime.sendMessage(msg) as Promise<PopupStatus | PopupGuide>;
}

async function refresh(): Promise<void> {
  const s = (await send({ kind: "get_status" })) as PopupStatus;
  setStatus(s);
}

$("takeover").addEventListener("click", async () => {
  const s = (await send({ kind: "take_over" })) as PopupStatus;
  setStatus(s);
  toast(s.mode === "human" ? "已暂停 Agent，当前由你操作" : "接管失败（无活动标签）");
});

$("guide").addEventListener("click", async () => {
  try {
    const g = (await send({ kind: "get_guide" })) as PopupGuide;
    await navigator.clipboard.writeText(g.guide);
    toast("使用文档已复制到剪贴板");
  } catch (e) {
    toast("复制失败：" + (e instanceof Error ? e.message : String(e)));
  }
});

$("manage").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

$("stop").addEventListener("click", async () => {
  await send({ kind: "stop" });
  toast("已请求停止");
  await refresh();
});

void refresh();
