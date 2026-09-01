// 命令协议：CLI ↔ native host ↔ SW 三端共用同一 schema。
// 结构对齐功能文档 F0-2 与技术路径 §4.4。

export type CommandName =
  // 基础 / 握手
  | "ping"
  | "version"
  | "get_profile" // 探测当前 profile（profile 感知，F1-1）
  | "export_guide" // 导出使用文档 Markdown（F1-2/F1-3）
  // 观测
  | "snapshot" // {level: "L0"|"L1", scope?}
  | "readText"
  | "screenshot" // {format?} 视口截图(返回 base64)
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
  | "pageInfo"
  | "drainEvents"
  | "tab_cdp_call" // {tabId?, method, params?} 任意底层 CDP 透传（交给外部 AI/CLI 全权使用）
  // Task Space / 浏览器级接管（v1.2 定案，M7 实现）
  | "list_tabs" // {space?} 列出浏览器所有窗口/标签（Space=整台浏览器）
  | "open_tab" // {url, newWindow?} 开新标签/窗口并聚焦
  | "close_tab" // {tabId} 关标签
  | "switch_tab" // {tabId} 聚焦到某标签
  | "list_spaces" // 兼容旧名，返回全部 space 状态
  | "open_space" // v2 保留：专属窗口空间（chrome.windows.create，用完即关）
  | "close_space" // v2 保留
  // 插件化操作模版（新需求，M9）
  | "import_template"
  | "list_templates"
  | "export_template"
  | "run_template"
  // 模拟人工防限流（新需求，M10）
  | "set_humanize"
  // 人工接管遮罩（新需求，参考 Manus ActionMask）：拦截用户 + 蓝色半透明 + 「人工接管」按钮
  | "start_mask" // {tabId?} 开启遮罩（冻结用户，AI 用 CDP 操作）
  | "stop_mask" // {tabId?} 关闭遮罩 / 清除接管状态（人类解决验证码后 AI 继续）
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
    | "take_over" // 接管当前标签
    | "get_guide" // 返回使用文档 markdown（popup 负责写剪贴板）
    | "stop";
}
export interface PopupStatus {
  attached: boolean;
  tabId?: number;
  layer?: string;
  profile?: ProfileInfo;
  hostPort?: number;
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
  title: string;
  url: string;
  content: string; // Markdown 可点击树
  refs: Record<string, L0NodeInfo>; // ref("@N") -> 节点信息
}
