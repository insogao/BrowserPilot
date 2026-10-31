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
let liveSpaceCount = 0;
let actionSeq = 0;

function toast(msg: string): void {
  $("toast").textContent = msg;
}

/** 操作结果（带稳定错误码与完成信号，供自动化等待）。
 *
 *  成功：`#input-toast[data-ok="true"][data-code=""]`，`data-at` / `data-seq` 单调递增；
 *  失败：`data-ok="false"`，`data-code` 为稳定错误码。 */
function actionToast(
  text: string,
  options: { code?: string; ok?: boolean; action?: string } = {},
): void {
  const el = $("input-toast");
  el.textContent = text;
  el.classList.toggle("error", options.ok === false);
  el.classList.toggle("ok", options.ok === true);
  if (options.ok === true) {
    // 成功时保留空字符串属性：[data-code=""] 可被 CSS 选择器匹配。
    el.dataset.code = "";
    el.dataset.ok = "true";
  } else if (options.ok === false) {
    el.dataset.code = options.code ?? "INTERNAL_ERROR";
    el.dataset.ok = "false";
  } else {
    delete el.dataset.code;
    delete el.dataset.ok;
  }
  if (options.action) el.dataset.action = options.action;
  else delete el.dataset.action;
  actionSeq += 1;
  el.dataset.seq = String(actionSeq);
  el.dataset.at = String(Date.now());
}

/** 当前下拉框的值优先于内存状态：自动化可能只设置 select.value 而不派发 change。 */
function currentSpaceId(): string | undefined {
  const select = $("space-select") as HTMLSelectElement;
  const value = typeof select.value === "string" ? select.value.trim() : "";
  selectedSpaceId = value || undefined;
  return selectedSpaceId;
}

function updateActionButtons(): void {
  // 只有“完全没有 Task Space”时才禁用。存在 space 但下拉框尚未选择时保持可点：
  // 点击会读取 select.value，并以 SPACE_NOT_FOUND 明确报错；不能因为 1s 轮询/初始化
  // 的瞬态 selectedSpaceId 为空就把按钮置灰（自动化点击会静默失效，A1 回归）。
  const disabled = liveSpaceCount === 0;
  for (const id of ["human-presence", "grant-input", "show-window"]) {
    const button = $(id) as HTMLButtonElement;
    // 请求在途时保持禁用，避免轮询把按钮重新打开导致双击。
    button.disabled = disabled || button.dataset.busy === "true";
  }
}

function setBusy(buttonId: string, busy: boolean): void {
  const button = $(buttonId) as HTMLButtonElement;
  if (busy) {
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
  } else {
    delete button.dataset.busy;
    button.removeAttribute("aria-busy");
    updateActionButtons();
  }
}

async function runAction(action: string, buttonId: string, task: () => Promise<void>): Promise<void> {
  setBusy(buttonId, true);
  try {
    await task();
  } catch (e) {
    const info = errorInfo(e);
    actionToast(info.code + ": " + info.message, { code: info.code, ok: false, action });
  } finally {
    setBusy(buttonId, false);
  }
}

function applyMode(mode: PopupInputView["mode"]): void {
  $("input-mode").textContent = MODE_LABELS[mode] ?? mode;
}

function applyGrant(actions: number, expiresAt: number): void {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  $("input-grant").textContent = actions + " 次，" + seconds + "s 后过期";
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

/** 选择 space：DOM 当前值 > 内存选择 > SW 解析出的活动目标 > 唯一空间。 */
function renderSpaces(s: PopupStatus): void {
  const spaces: PopupSpaceOption[] = s.spaces ?? [];
  const ids = spaces.map((space) => space.spaceId);
  liveSpaceCount = ids.length;
  const signature = ids.join("|");
  const select = $("space-select") as HTMLSelectElement;
  // 重建 option 会清空 select.value；先记住自动化/用户设置的值，重建后若仍有效就恢复。
  // （space 的 mode/名称变化或顺序变化都会触发重建，不能因此丢掉当前选择。）
  const domBefore = typeof select.value === "string" ? select.value.trim() : "";
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
    if (domBefore && ids.includes(domBefore)) select.value = domBefore;
  }
  // 以 DOM 的当前值为准：自动化/用户可能只设置 select.value 而没有派发 change。
  const domValue = typeof select.value === "string" ? select.value.trim() : "";
  if (domValue && ids.includes(domValue)) selectedSpaceId = domValue;
  if (selectedSpaceId && !ids.includes(selectedSpaceId)) selectedSpaceId = undefined;
  if (!selectedSpaceId) {
    const preferred = s.target?.spaceId;
    if (preferred && ids.includes(preferred)) selectedSpaceId = preferred;
    else if (ids.length === 1) selectedSpaceId = ids[0];
  }
  select.value = selectedSpaceId ?? "";
  updateActionButtons();
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

async function fetchStatus(kind: "get_status" | "input_status"): Promise<PopupStatus> {
  const requested = currentSpaceId();
  try {
    return await send<PopupStatus>({ kind, spaceId: requested });
  } catch (e) {
    if (!requested) throw e;
    const info = errorInfo(e);
    if (info.code !== "SPACE_NOT_FOUND" && info.code !== "SPACE_INACTIVE") throw e;
    // 选中的 space 已关闭：清空选择，回退到 SW 的活动目标（不自动创建窗口）。
    selectedSpaceId = undefined;
    ($("space-select") as HTMLSelectElement).value = "";
    return send<PopupStatus>({ kind });
  }
}

async function refresh(): Promise<void> {
  const s = await fetchStatus("get_status");
  setStatus(s);
  renderSpaces(s);
  renderInput(s);
}

async function refreshInput(): Promise<void> {
  const s = await fetchStatus("input_status");
  setStatus(s);
  renderSpaces(s);
  renderInput(s);
}

function requireSpaceId(): string {
  const spaceId = currentSpaceId();
  if (!spaceId) {
    throw Object.assign(new Error("先 open_space 或选择一个 Task Space"), { code: "SPACE_NOT_FOUND" });
  }
  return spaceId;
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

$("human-presence").addEventListener("click", () => {
  void runAction("human_presence", "human-presence", async () => {
    try {
      const spaceId = requireSpaceId();
      const result = await send<PresenceResponse>({ kind: "human_presence", spaceId });
      applyMode(result.mode);
      const text = result.mode === "human"
        ? "当前 mode=human（用户已接管，未改 ownership）"
        : result.mode === "assist"
          ? "已进入 ASSIST：Agent 输入需要你点「允许一次输入」"
          : "当前 mode=" + result.mode;
      actionToast(text, { ok: true, action: "human_presence" });
      void refreshInput().catch(() => {});
    } catch (e) {
      const info = errorInfo(e);
      actionToast(info.code + ": " + info.message, { code: info.code, ok: false, action: "human_presence" });
    }
  });
});

$("grant-input").addEventListener("click", () => {
  void runAction("grant_input", "grant-input", async () => {
    try {
      // 点击时读取下拉框当前值：自动化可能只设置 select.value 而不派发 change，
      // 内存里的 selectedSpaceId 可能仍是初始化/自动选择的空间。
      const spaceId = requireSpaceId();
      const result = await send<GrantResponse>({ kind: "grant_input", spaceId });
      applyMode(result.mode);
      applyGrant(result.grant.actions, result.grant.expiresAt);
      const seconds = Math.max(0, Math.ceil((result.grant.expiresAt - Date.now()) / 1000));
      actionToast("已允许 " + result.grant.actions + " 次输入（" + seconds + "s 内有效）", {
        ok: true,
        action: "grant_input",
      });
      // 成功信号先落地，再异步刷新状态（不要 await，避免自动化等待轮询）。
      void refreshInput().catch(() => {});
    } catch (e) {
      const info = errorInfo(e);
      actionToast(info.code + ": " + info.message, { code: info.code, ok: false, action: "grant_input" });
    }
  });
});

$("show-window").addEventListener("click", () => {
  void runAction("ensure_visible", "show-window", async () => {
    try {
      const spaceId = requireSpaceId();
      const result = await send<ShowResponse>({ kind: "ensure_visible", spaceId });
      actionToast(
        "已请求显示窗口（state=" + (result.state ?? "-") + "，focus=" + String(result.focused === true) + "）",
        { ok: true, action: "ensure_visible" },
      );
      void refreshInput().catch(() => {});
    } catch (e) {
      const info = errorInfo(e);
      actionToast(info.code + ": " + info.message, { code: info.code, ok: false, action: "ensure_visible" });
    }
  });
});

$("input-refresh").addEventListener("click", () => {
  void runAction("input_status", "input-refresh", async () => {
    try {
      await refreshInput();
      actionToast("输入权已刷新", { ok: true, action: "input_status" });
    } catch (e) {
      const info = errorInfo(e);
      actionToast(info.code + ": " + info.message, { code: info.code, ok: false, action: "input_status" });
    }
  });
});

($("space-select") as HTMLSelectElement).addEventListener("change", () => {
  const value = ($("space-select") as HTMLSelectElement).value;
  selectedSpaceId = value || undefined;
  updateActionButtons();
  actionToast("已选择 Task Space: " + (selectedSpaceId ?? "未选择"), { action: "select" });
  void refresh().catch((e) => {
    const info = errorInfo(e);
    actionToast(info.code + ": " + info.message, { code: info.code, ok: false, action: "select" });
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
