// popup 逻辑：状态展示 + 三按钮（接管/复制使用文档/Stop）。
import type { PopupGuide, PopupRequest, PopupStatus } from "../shared/types";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function toast(msg: string): void {
  const el = $("toast");
  el.textContent = msg;
}

function setStatus(s: PopupStatus): void {
  $("dot").classList.toggle("on", s.attached);
  $("attached").textContent = s.attached ? "已接管" : "未接管";
  $("layer").textContent = s.layer ?? "-";
  $("profile").textContent = s.profile?.profileDir ?? s.profile?.detail ?? "-";
  $("port").textContent = s.hostPort != null ? String(s.hostPort) : "-";
}

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
  toast(s.attached ? "已接管当前标签" : "接管失败（无活动标签）");
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

$("stop").addEventListener("click", async () => {
  await send({ kind: "stop" });
  toast("已请求停止");
  await refresh();
});

void refresh();
