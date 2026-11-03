// 命令协议：CLI ↔ native host ↔ SW 三端共用同一 schema。
// 结构对齐功能文档 F0-2 与技术路径 §4.4。

export type CommandName =
  // 基础 / 握手
  | "ping"
  | "version"
  | "host_capabilities" // 宿主能力探测结果（Phase 7）：enhanced / generic + 降级原因
  | "get_profile" // 探测当前 profile（profile 感知，F1-1）
  | "export_guide" // 导出使用文档 Markdown（F1-2/F1-3）
  // 观测
  | "snapshot" // {level: "L0"|"L1", scope?}
  | "readText"
  | "screenshot" // {format?, timeoutMs?} 视口截图(返回 base64 + 取帧路径/新鲜度)
  | "screenshot_diagnostics" // {tabId?, resetCooldown?} 截图管线只读诊断（冷却/pending/清理计数）
  | "scroll_screenshot" // {tabId?, pages?, gap?, format?} 滚动拼接长截图(返回整图 base64 + pageCount)
  | "getElementInfo"
  // 动作
  | "click"
  | "dblclick"
  | "hover"
  | "drag"
  | "wheel"
  | "down"
  | "up"
  | "press"
  | "type"
  | "fill"
  | "selectOption"
  | "check"
  | "uncheck"
  | "setChecked"
  // 求值 / 等待 / 事件
  | "js"
  | "waitForURL"
  | "waitForSelector"
  | "waitForTimeout"
  | "wait_dom_idle"
  | "groq_transcribe" // {url, language?, model?} 拉媒体→抽音轨压缩→Groq Whisper 语音转文本
 // {idleMs?,timeoutMs?,selector?} AI 聊天流式页静默等待（MutationObserver）
  | "pageInfo"
  | "drainEvents"
  | "tab_cdp_call" // {tabId?, method, params?} 任意底层 CDP 透传（交给外部 AI/CLI 全权使用）
  | "detach" // {tabId?} 释放 chrome.debugger（不关标签；下一次动作会自动重新 attach）
  // Task Space / 浏览器级接管（v1.2 定案，M7 实现）
  | "list_tabs" // {space?} 列出浏览器所有窗口/标签（Space=整台浏览器）
  | "open_tab" // {url, newWindow?} 开新标签/窗口并聚焦
  | "close_tab" // {tabId} 关标签
  | "switch_tab" // {tabId} 聚焦到某标签
  | "ensure_visible" // {tabId?} 恢复窗口为 normal 并聚焦，降低后台/最小化渲染节流
  | "list_spaces" // 兼容旧名，返回全部 space 状态
  | "open_space" // {name?,url?} 创建并选中当前 Agent 独占的窗口空间
  | "use_space" // {spaceId|name} 选择当前 Agent 已拥有的空间
  | "claim_space" // {spaceId|name} 从人工接管状态恢复 Agent 控制
  | "handoff_space" // {spaceId|name?} 把空间交给用户，暂停 Agent 命令
  | "complete_space" // {spaceId|name?,keep?} 保留给用户或关闭空间
  | "close_space" // {spaceId|name?} 关闭当前 Agent 空间
  // 输入权仲裁（P3）：HUMAN/ASSIST/AI 是 ownership(+assist) 的派生视图，不是新的 ownership 取值
  | "grant_input" // {space?,tabId?,actions,ttlMs?} ASSIST 下发放一次性输入 grant（仅用户入口，Agent 不能自证）
  | "input_status" // {space?,tabId?} 返回 mode / assist 到期时间 / 剩余 grant actions
  | "human_presence" // {space?,tabId?,source?,immediate?,debounceMs?} 内核事件/测试入口：进入 ASSIST（仅用户入口/内核桥）
  // 插件化操作模版（新需求，M9）
  | "import_template"
  | "install_template"
  | "list_templates"
  | "export_template"
  | "run_template"
  | "uninstall_template"
  | "set_template_enabled"
  | "check_template_update"
  | "check_registry_updates"
  | "list_template_catalog"
  | "sync_registry"
  | "search_templates"
  | "get_template_detail"
  | "compare_templates"
  | "update_template"
  | "rollback_template"
  // 模拟人工防限流（新需求，M10）
  | "set_humanize"
  // 人工接管遮罩（新需求，参考 Manus ActionMask）：拦截用户 + 蓝色半透明 + 「人工接管」按钮
  | "start_mask" // {tabId?} 开启遮罩（冻结用户，AI 用 CDP 操作）
  | "stop_mask" // {tabId?} 关闭遮罩 / 清除接管状态（人类解决验证码后 AI 继续）
  // AI 虚拟光标（插件级，只画不点）：show/move/hide/remove/state。
  | "cursor"
  // 图片下载：下载页面中的图片（data:/http:）
  | "download_image" // {url, filename?, tabId?} 下载图片到本地
  // 图片下载（通道 B）：页面上下文取字节后落盘（blob canvas 提取 / 登录态 http fetch，绕开 1MB 命令上限与 cookie 假成功）
  | "download_resource" // {url?|urls?...[], selector?, filename?, tabId?} 下载资源到本地（文件名可控；urls[] 多张自动编号，如夏天-1.png/夏天-2.png）
  // 开发热更新：触发扩展 SW 重载（自动加载 dist 最新代码）
  | "reload"
  // 会话
  | "stop"
  ;

export interface Command {
  type: "command";
  name: CommandName;
  args?: Record<string, unknown>;
  requestId: string;
  /** Task Space 命名空间：对应 windowId 字符串。缺省 = 当前/主 space。 */
  space?: string;
  /** Host 分配的逻辑客户端身份，形状固定为 `agent:<sanitized-id>`。
   *  外部客户端自报的同名字段会被 host 覆盖；扩展只信任 `agent:` 前缀的形状，
   *  其它值一律视为不可信。**用户入口身份不是消息字段**（见 spaces.ts 的 markInternalCommand）。 */
  _clientId?: string;
  /** 模板子命令继承的插件内部前台租约 token。 */
  _foregroundLeaseToken?: string;
}

export interface ResultOk {
  type: "result";
  requestId: string;
  ok: true;
  data?: unknown;
}

export interface ResultErr {
  type: "result";
  requestId: string;
  ok: false;
  error: string;
  errorCode?: string;
}

export type Result = ResultOk | ResultErr;

export interface EventMsg {
  type: "event";
  name: string;
  args: unknown;
  sequence: number;
}

export type NativeMessage = Command | Result | EventMsg;

// 探测到的 profile 信息（F1-1）
export interface ProfileInfo {
  ok: boolean;
  browser?: string; // "chrome" | "edge" | ...
  userDataDir?: string;
  profileDir?: string; // "Profile 1" / "Default" / ...
  chromeExe?: string;
  detail?: string; // 探测来源说明 / 失败原因
}

// popup ↔ SW 的简单消息
export interface PopupRequest {
  kind:
    | "get_status"
    | "take_over" // 用户人工接管当前标签，暂停 Agent
    | "resume_agent" // 恢复 Agent 操作
    | "get_guide" // 返回使用文档 markdown（popup 负责写剪贴板）
  | "get_skill" // 返回轻量技能引导（GitHub SKILL.md 地址 + 实时连接信息）
    | "template_command" // options 模板看板调用受限模板管理命令
    | "stop"
    // 输入权用户入口（P3）：SW 在进程内构造 Command + markInternalCommand()，
    // 消息里的字段只用于选择目标 space，不构成身份（见 popup-entry.ts）。
    | "input_status" // 只读：当前 space 的输入权视图 + 可选 space 列表
    | "grant_input" // 允许一次输入：ASSIST 下发放 1 次 grant（TTL 默认 60s）
    | "human_presence" // 我在操作：进入 ASSIST（不改 ownership）
    | "ensure_visible"; // 显示窗口：ensure_visible { focus:false }
  /** 目标 Task Space（用户在下拉框选择；缺省按活动 tab/窗口解析）。 */
  spaceId?: string;
  name?: CommandName;
  args?: Record<string, unknown>;
}

/** popup 展示用的输入权视图（派生自 input_status 命令，不落第二份状态）。 */
export interface PopupInputView {
  spaceId: string;
  tabId?: number;
  windowId?: number;
  mode: "human" | "assist" | "ai";
  ownership: "agent" | "user" | "inactive" | "unknown";
  ownerClientId?: string;
  assistSince?: number;
  assistReason?: string;
  assistExpiresAt: number | null;
  grantActionsRemaining: number | null;
  kernel?: {
    state: string;
    supported: boolean;
    degraded: boolean;
    reason?: string;
    effectiveMode?: "human" | "assist" | "ai";
    version?: number;
    kernelVersion?: number;
    kernelMode?: "human" | "assist" | "ai";
    stale?: boolean;
    lastAckAt?: number;
    lastError?: string;
  };
}

/** popup 下拉框中的一个 Task Space 选项。 */
export interface PopupSpaceOption {
  spaceId: string;
  name?: string;
  windowId?: number;
  tabId?: number;
  ownership?: "agent" | "user" | "inactive";
  mode?: "human" | "assist" | "ai";
  updatedAt?: number;
}

/** SW → popup 的稳定错误形状（错误码来自 InputOwnershipError / TaskSpaceError / 本模块）。 */
export interface PopupErrorInfo {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface PopupStatus {
  attached: boolean;
  hostReady?: boolean;
  connected?: boolean;
  clientCount?: number;
  mode?: "idle" | "agent" | "human";
  tabId?: number;
  layer?: string;
  profile?: ProfileInfo;
  hostPort?: number;
  /** 当前/选中的 Task Space 输入权视图；没有活动 Task Space 时为 null。 */
  input?: PopupInputView | null;
  /** 可选择的 Task Space（只含窗口仍存在的非 inactive 空间）。 */
  spaces?: PopupSpaceOption[];
  /** popup 解析出的目标（供自动化断言）。 */
  target?: { spaceId?: string; tabId?: number; windowId?: number };
  /** 读取 input_status 失败时的稳定错误（例如 SPACE_INACTIVE）。 */
  inputError?: PopupErrorInfo;
}
export interface PopupGuide {
  guide: string;
}

// L0 观测（content script 生成，SW/CLI 消费，M3）
export interface L0NodeInfo {
  type: "link" | "click" | "edit" | "select" | "check" | string;
  tag: string;
  label: string;
}
export interface L0Snapshot {
  snapshotId: string; // 动作携带此值；DOM 变化后旧 ref 会安全失效
  title: string;
  url: string;
  content: string; // Markdown 可点击树
  refs: Record<string, L0NodeInfo>; // ref("@N") -> 节点信息
}
