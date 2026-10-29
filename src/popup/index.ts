// popup：展示真实 Agent 活跃状态 + P3 输入权用户入口。
//
// 用户入口身份不在消息里：popup 只发 {kind, spaceId}，SW 在进程内构造命令并
// markInternalCommand()（见 src/background/popup-entry.ts）。popup 不读取、不发送
// `_clientId` / `internal` / URL 参数等任何身份字段。
import type {
  PopupInputView,
  PopupRequest,
  PopupSpaceOption,
  PopupStatus,
} from "../shared/types";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const MODE_LABELS: Record<PopupInputView["mode"], string> = {
  human: "HUMAN（用户接管）",
  assist: "ASSIST（人类在场）",
  ai: "AI（Agent 自主）",
};
const OWNERSHIP_LABELS: Record<string, string> = {
  agent: "Agent",
  user: "用户",
  inactive: "已结束",
  unknown: "未知",
};

let selectedSpaceId: string | undefined;
let spacesSignature = "";

function toast(msg: string): void {
  $("toast").textContent = msg;
}

/** 操作结果（带稳定错误码，供自动化断言）。 */
function actionToast(text: string, options: { code?: string; ok?: boolean } = {}): void {
  const el = $("input-toast");
  el.textContent = text;
  el.classList.toggle("error", options.ok === false);
  el.classList.toggle("ok", options.ok === true);
  if (options.code) el.dataset.code = options.code;
  else delete el.dataset.code;
  el.dataset.ok = options.ok === false ? "0" : options.ok === true ? "1" : "";
}

function errorInfo(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code: typeof code === "string" && code ? code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
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

async function send<T extends object = Record<string, unknown>>(msg: PopupRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(msg)) as
    | (T & { __bpError?: string; __bpErrorCode?: string })
    | undefined;
  if (!response || typeof response !== "object") throw new Error("扩展后台未响应");
  if (typeof response.__bpError === "string") {
    const error = new Error(response.__bpError) as Error & { code?: string };
    error.code = response.__bpErrorCode;
    throw error;
  }
  return response as T;
}

/** 选择 space：显式选择优先；否则用 SW 解析出的活动目标；只有一个空间时自动选中。 */
function renderSpaces(s: PopupStatus): void {
  const spaces: PopupSpaceOption[] = s.spaces ?? [];
  const ids = spaces.map((space) => space.spaceId);
  const signature = ids.join("|");
  const select = $("space-select") as HTMLSelectElement;
  if (signature !== spacesSignature) {
    spacesSignature = signature;
    select.textContent = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = spaces.length ? "选择 Task Space…" : "先 open_space 或选择一个 Task Space";
    select.appendChild(placeholder);
    for (const space of spaces) {
      const option = document.createElement("option");
      option.value = space.spaceId;
      option.textContent = (space.name || space.spaceId) + (space.mode ? " · " + space.mode : "");
      select.appendChild(option);
    }
  }
  if (selectedSpaceId && !ids.includes(selectedSpaceId)) selectedSpaceId = undefined;
  if (!selectedSpaceId) {
    const preferred = s.target?.spaceId;
    if (preferred && ids.includes(preferred)) selectedSpaceId = preferred;
    else if (ids.length === 1) selectedSpaceId = ids[0];
  }
  select.value = selectedSpaceId ?? "";
  const disabled = !selectedSpaceId;
  for (const id of ["human-presence", "grant-input", "show-window"]) {
    ($(id) as HTMLButtonElement).disabled = disabled;
  }
}

function renderInput(s: PopupStatus): void {
  const input = s.input;
  if (!input) {
    $("input-mode").textContent = "-";
    $("input-ownership").textContent = "-";
    $("input-grant").textContent = "-";
    $("input-kernel").textContent = "-";
    $("input-target").textContent = "-";
  } else {
    $("input-mode").textContent = MODE_LABELS[input.mode] ?? input.mode;
    $("input-ownership").textContent = OWNERSHIP_LABELS[input.ownership] ?? input.ownership;
    if (input.grantActionsRemaining === null) {
      $("input-grant").textContent = "无（未授权）";
    } else {
      const expires = typeof input.assistExpiresAt === "number"
        ? "，" + Math.max(0, Math.ceil((input.assistExpiresAt - Date.now()) / 1000)) + "s 后过期"
        : "";
      $("input-grant").textContent = input.grantActionsRemaining + " 次" + expires;
    }
    const kernel = input.kernel;
    $("input-kernel").textContent = kernel
      ? kernel.state === "ready"
        ? kernel.degraded ? "degraded（fail closed）" : "ready"
        : kernel.state + (kernel.reason ? "（" + kernel.reason + "）" : "")
      : "-";
    const space = (s.spaces ?? []).find((item) => item.spaceId === input.spaceId);
    $("input-target").textContent =
      (space?.name || input.spaceId) + (input.tabId !== undefined ? " / tab " + input.tabId : "");
  }

  const hint = $("input-hint");
  hint.classList.toggle("error", !!s.inputError);
  if (s.inputError) {
    hint.textContent = s.inputError.code + ": " + s.inputError.message;
  } else if (!selectedSpaceId) {
    hint.textContent = "先 open_space 或选择一个 Task Space（不会自动创建窗口）";
  } else {
    hint.textContent = "";
  }
}

async function refresh(): Promise<void> {
  const s = await send<PopupStatus>({ kind: "get_status", spaceId: selectedSpaceId });
  setStatus(s);
  renderSpaces(s);
  renderInput(s);
}

async function refreshInput(): Promise<void> {
  const s = await send<PopupStatus>({ kind: "input_status", spaceId: selectedSpaceId });
  setStatus(s);
  renderSpaces(s);
  renderInput(s);
}

function requireSpaceId(): string {
  if (!selectedSpaceId) {
    throw Object.assign(new Error("先 open_space 或选择一个 Task Space"), { code: "SPACE_NOT_FOUND" });
  }
  return selectedSpaceId;
}

// ---------------------------------------------------------------------------
// 现有操作
// ---------------------------------------------------------------------------

$("takeover").addEventListener("click", async () => {
  try {
    const resume = (($("takeover") as HTMLButtonElement).dataset.action === "resume");
    const s = await send<PopupStatus>({ kind: resume ? "resume_agent" : "take_over" });
    setStatus(s);
    toast(s.mode === "human" ? "Agent 已暂停" : s.mode === "agent" ? "Agent 已恢复" : "当前没有 Agent 连接");
    void refresh().catch(() => {});
  } catch (e) {
    toast("操作失败：" + errorInfo(e).message);
  }
});

$("guide").addEventListener("click", async () => {
  try {
    const g = await send<{ skill: string }>({ kind: "get_skill" });
    await navigator.clipboard.writeText(g.skill);
    toast("技能安装引导已复制（含本机连接信息）");
  } catch (e) {
    toast("复制失败：" + errorInfo(e).message);
  }
});

$("manage").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// 输入权用户入口（P3）：三个动作都只发 {kind, spaceId}
// ---------------------------------------------------------------------------

interface GrantResponse {
  spaceId: string;
  mode: PopupInputView["mode"];
  tabId?: number;
  grant: { token: string; actions: number; expiresAt: number };
}

interface PresenceResponse {
  spaceId: string;
  mode: PopupInputView["mode"];
  changed: boolean;
  reason?: string;
}

interface ShowResponse {
  presented: true;
  tabId: number;
  windowId: number;
  state?: string;
  focused?: boolean;
  managedMode?: boolean;
}

$("human-presence").addEventListener("click", async () => {
  try {
    const spaceId = requireSpaceId();
    const result = await send<PresenceResponse>({ kind: "human_presence", spaceId });
    const text = result.mode === "human"
      ? "当前 mode=human（用户已接管，未改 ownership）"
      : result.mode === "assist"
        ? "已进入 ASSIST：Agent 输入需要你点「允许一次输入」"
        : "当前 mode=" + result.mode;
    actionToast(text, { ok: true });
    await refreshInput();
  } catch (e) {
    const info = errorInfo(e);
    actionToast(info.code + ": " + info.message, { code: info.code, ok: false });
  }
});

$("grant-input").addEventListener("click", async () => {
  try {
    const spaceId = requireSpaceId();
    const result = await send<GrantResponse>({ kind: "grant_input", spaceId });
    const seconds = Math.max(0, Math.ceil((result.grant.expiresAt - Date.now()) / 1000));
    actionToast("已允许 " + result.grant.actions + " 次输入（" + seconds + "s 内有效）", { ok: true });
    await refreshInput();
  } catch (e) {
    const info = errorInfo(e);
    actionToast(info.code + ": " + info.message, { code: info.code, ok: false });
  }
});

$("show-window").addEventListener("click", async () => {
  try {
    const spaceId = requireSpaceId();
    const result = await send<ShowResponse>({ kind: "ensure_visible", spaceId });
    actionToast(
      "已请求显示窗口（state=" + (result.state ?? "-") + "，focus=" + String(result.focused === true) + "）",
      { ok: true },
    );
    await refreshInput();
  } catch (e) {
    const info = errorInfo(e);
    actionToast(info.code + ": " + info.message, { code: info.code, ok: false });
  }
});

$("input-refresh").addEventListener("click", async () => {
  try {
    await refreshInput();
    actionToast("输入权已刷新", { ok: true });
  } catch (e) {
    const info = errorInfo(e);
    actionToast(info.code + ": " + info.message, { code: info.code, ok: false });
  }
});

($("space-select") as HTMLSelectElement).addEventListener("change", () => {
  const value = ($("space-select") as HTMLSelectElement).value;
  selectedSpaceId = value || undefined;
  actionToast("已选择 Task Space: " + (selectedSpaceId ?? "未选择"));
  void refresh().catch((e) => {
    const info = errorInfo(e);
    actionToast(info.code + ": " + info.message, { code: info.code, ok: false });
  });
});

// Groq API Key 设置（存 chrome.storage.local，用于 groq_transcribe 命令；不进日志/模板）
const groqKeyInput = document.getElementById("groq-key") as HTMLInputElement;
const groqKeyState = document.getElementById("groq-key-state")!;

async function loadGroqKey(): Promise<void> {
  const st = await chrome.storage.local.get("groqApiKey");
  const v = (st.groqApiKey as string) || "";
  groqKeyState.textContent = v ? "已配置" : "未配置";
}

document.getElementById("save-groq-key")!.addEventListener("click", async () => {
  const v = groqKeyInput.value.trim();
  if (!v) { toast("请输入 Groq API Key"); return; }
  await chrome.storage.local.set({ groqApiKey: v });
  groqKeyInput.value = "";
  await loadGroqKey();
  toast("Groq API Key 已保存");
});

void loadGroqKey();

void refresh().catch((e) => {
  const info = errorInfo(e);
  actionToast(info.code + ": " + info.message, { code: info.code, ok: false });
});
setInterval(() => void refresh().catch(() => {}), 1000);
