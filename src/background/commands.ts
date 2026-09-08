// 命令分派表 + 参数校验。参考技术路径 §4.4（ChatGPT zod 命令协议）。
// M1/M2 落地：ping / version / get_profile / export_guide / stop；观测与动作先在 M3~M5 填充。
import type { Command, CommandName, ProfileInfo } from "../shared/types";
import { loadState, clearAllSpaces, mutateState, patchSpace } from "./state";
import { drainEvents } from "./events";
import * as sp from "./spaces";
import { commandClientId } from "./spaces";
import { acquireForegroundLease } from "./foreground-lease";
import { resolveTargetTab } from "./tab-resolver";
import { getL0Snapshot, readTextFromTab } from "./content-bridge";
import { captureScreenshot, scrollCaptureScreenshot, ensureAttach } from "./cdp";
import { sendCommand } from "./debugger-bridge";
import * as act from "./actions";
import * as ev from "./eval";
import { maskOn, maskOff, isHumanTakeover, hasTakeover, touchMaskActivity, endMaskActivity, resetAllMasks, resetMasksForTabs } from "./mask";
import { detach, detachAll, listAttachedTabs } from "./debugger-bridge";
import * as tpl from "./templates";
import { downloadResource } from "./download-resource";

function getManifestVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "0.1.0";
  }
}

const KNOWN: Record<CommandName, (cmd: Command) => Promise<unknown>> = {
  ping: () => Promise.resolve({ pong: true, at: Date.now() }),
  version: () =>
    Promise.resolve({ name: "BrowserPilot", version: getManifestVersion() }),

  get_profile: async () => {
    const s = await loadState();
    return s.profile ?? { ok: false, detail: "host 尚未上报 profile" };
  },

  export_guide: async () => {
    const s = await loadState();
    return buildGuideFromCmd(s.profile, s.hostPort, s.hostToken);
  },

  snapshot: async (cmd) => {
    const tabId = await resolveTargetTab(cmd);
    const level = (cmd.args?.level as string) ?? "L0";
    if (level === "L1") throw new Error("snapshot L1 在 M4 实现（AX 语义快照）");
    const snap = await getL0Snapshot(tabId);
    return { tabId, ...snap };
  },
  readText: async (cmd) => {
    const tabId = await resolveTargetTab(cmd);
    const { ref, selector } = (cmd.args ?? {}) as { ref?: string; selector?: string };
    const text = await readTextFromTab(tabId, { ref, selector });
    return { tabId, text };
  },
  screenshot: async (cmd) => { const tabId = await resolveTargetTab(cmd); const format = ((cmd.args ?? {}) as { format?: string }).format ?? "png"; const base64 = await captureScreenshot(tabId, format); return { tabId, format, base64 }; },
  scroll_screenshot: async (cmd) => {
    const tabId = await resolveTargetTab(cmd);
    const { pages, gap, format } = (cmd.args ?? {}) as { pages?: number; gap?: number; format?: string };
    const r = await scrollCaptureScreenshot(tabId, { pages, gap, format });
    return { tabId, ...r };
  },
  tab_cdp_call: async (cmd) => {
    const tabId = await resolveTargetTab(cmd);
    const { method, params } = (cmd.args ?? {}) as { method?: string; params?: Record<string, unknown> };
    if (!method) throw new Error("tab_cdp_call 需要 args.method");
    await ensureAttach(tabId);
    const result = await sendCommand(tabId, method, params ?? {});
    return { tabId, method, result };
  },
  download_image: async (cmd) => {
    const { url, filename } = (cmd.args ?? {}) as { url?: string; filename?: string; tabId?: number };
    if (!url) throw new Error("download_image 需要 args.url");
    if (/^blob:/i.test(url)) throw new Error("download_image 暂不支持 blob: URL，请在页面上下文 fetch 后转 data:/http: 再下载");
    const options: chrome.downloads.DownloadOptions = { url };
    if (typeof filename === "string" && filename.trim()) options.filename = filename.trim();
    const downloadId = await chrome.downloads.download(options);
    return { downloaded: true, downloadId, url, filename: options.filename };
  },
  download_resource: (cmd) => downloadResource(cmd),
  getElementInfo: () => Promise.reject("getElementInfo 在 M4 实现（L1）"),

  click: async (cmd) => act.click(await resolveTargetTab(cmd), cmd.args ?? {}),
  dblclick: async (cmd) => act.dblclick(await resolveTargetTab(cmd), cmd.args ?? {}),
  hover: async (cmd) => act.hover(await resolveTargetTab(cmd), cmd.args ?? {}),
  drag: async (cmd) => act.drag(await resolveTargetTab(cmd), cmd.args ?? {}),
  wheel: async (cmd) => act.wheel(await resolveTargetTab(cmd), cmd.args ?? {}),
  down: async (cmd) => act.down(await resolveTargetTab(cmd), cmd.args ?? {}),
  up: async (cmd) => act.up(await resolveTargetTab(cmd), cmd.args ?? {}),
  press: async (cmd) => act.press(await resolveTargetTab(cmd), cmd.args ?? {}),
  type: async (cmd) => act.typeText(await resolveTargetTab(cmd), cmd.args ?? {}),
  fill: async (cmd) => act.fill(await resolveTargetTab(cmd), cmd.args ?? {}),
  selectOption: async (cmd) => act.selectOption(await resolveTargetTab(cmd), cmd.args ?? {}),
  check: async (cmd) => act.check(await resolveTargetTab(cmd), cmd.args ?? {}),
  uncheck: async (cmd) => act.uncheck(await resolveTargetTab(cmd), cmd.args ?? {}),
  setChecked: async (cmd) => act.setChecked(await resolveTargetTab(cmd), cmd.args ?? {}, !!(cmd.args as { checked?: boolean })?.checked),

  js: async (cmd) => ev.jsEval(await resolveTargetTab(cmd), cmd.args ?? {}),
  waitForURL: async (cmd) => ev.waitForURL(await resolveTargetTab(cmd), cmd.args ?? {}),
  waitForSelector: async (cmd) => ev.waitForSelector(await resolveTargetTab(cmd), cmd.args ?? {}),
  waitForTimeout: async (cmd) => ev.waitForTimeout(await resolveTargetTab(cmd), cmd.args ?? {}),
  wait_dom_idle: async (cmd) => ev.waitDomIdle(await resolveTargetTab(cmd), cmd.args ?? {}),
  pageInfo: async (cmd) => ev.pageInfo(await resolveTargetTab(cmd)),

  drainEvents: async (cmd) => {
    const args = (cmd.args ?? {}) as { after_sequence?: number; methods?: string[]; limit?: number };
    return drainEvents(args);
  },

  open_space: (cmd) => sp.open_space(cmd),
  use_space: (cmd) => sp.use_space(cmd),
  claim_space: (cmd) => sp.claim_space(cmd),
  handoff_space: (cmd) => sp.handoff_space(cmd),
  complete_space: (cmd) => sp.complete_space(cmd),
  close_space: (cmd) => sp.close_space(cmd),
  list_tabs: (cmd) => sp.list_tabs(cmd),
  open_tab: (cmd) => sp.open_tab(cmd),
  close_tab: (cmd) => sp.close_tab(cmd),
  switch_tab: (cmd) => sp.switch_tab(cmd),
  ensure_visible: (cmd) => sp.ensure_visible(cmd),
  list_spaces: (cmd) => sp.list_spaces(cmd),

  import_template: (cmd) => tpl.importTemplate(cmd),
  install_template: (cmd) => tpl.installTemplate(cmd),
  list_templates: () => tpl.listTemplates(),
  export_template: (cmd) => tpl.exportTemplate(cmd),
  run_template: (cmd) => tpl.runTemplate(cmd),
  uninstall_template: (cmd) => tpl.uninstallTemplate(cmd),
  set_template_enabled: (cmd) => tpl.setTemplateEnabled(cmd),
  check_template_update: (cmd) => tpl.checkTemplateUpdate(cmd),
  list_template_catalog: (cmd) => tpl.listTemplateCatalog(cmd),
  sync_registry: (cmd) => tpl.syncRegistry(cmd),
  search_templates: (cmd) => tpl.searchTemplates(cmd),
  get_template_detail: (cmd) => tpl.getTemplateDetail(cmd),
  compare_templates: (cmd) => tpl.compareTemplates(cmd),
  update_template: (cmd) => tpl.updateTemplate(cmd),
  rollback_template: (cmd) => tpl.rollbackTemplate(cmd),

  set_humanize: () => Promise.reject("set_humanize 在 M10 实现（模拟人工操作防限流，默认 off）"),

  start_mask: async (cmd) => {
    const tabId = await resolveTargetTab(cmd);
    const masked = await maskOn(tabId);
    return { masked, tabId };
  },
  stop_mask: async (cmd) => {
    const tabId = await resolveTargetTab(cmd);
    await maskOff(tabId);
    return { masked: false, tabId };
  },

  // 开发热更新：先应答，再延迟触发 SW 重载（避免把本次响应吃掉）。
  reload: async () => {
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch (e) {
        console.warn("[commands] reload 失败:", (e as Error).message);
      }
    }, 300);
    return { reloading: true, afterMs: 300 };
  },

  stop: async (cmd) => {
    // 作用域语义：popup/options（无 Agent 身份 → browserpilot-internal）= 用户全局停止；
    // 带 Agent 身份的 stop 只清理该 Agent 自己的空间/租约/遮罩，不影响其他 Agent 与用户。
    const clientId = commandClientId(cmd);
    if (clientId === "browserpilot-internal") {
      tpl.cancelTemplateRuns();
      const attachedTabs = listAttachedTabs();
      await Promise.all(attachedTabs.map((tabId) => import("./debugger-bridge").then(({ interruptTab }) => interruptTab(tabId))));
      const [maskedTabs, detachedTabs] = await Promise.all([resetAllMasks(), detachAll()]);
      await clearAllSpaces();
      return { stopped: true, scoped: false, detachedTabs, maskedTabs };
    }

    const state = await loadState();
    const ownSpaces = Object.values(state.spaces).filter(
      (space) => space.ownerClientId === clientId && space.ownership !== "inactive",
    );
    const ownSpaceIds = new Set(ownSpaces.map((space) => space.spaceId));
    const ownWindowIds = new Set(ownSpaces.map((space) => space.windowId).filter((w) => w !== undefined));

    // 自己窗口里的 attach/遮罩先清理，再关窗口（关掉后 tabs 不复存在）。
    const ownAttached: number[] = [];
    for (const tabId of listAttachedTabs()) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab?.windowId !== undefined && ownWindowIds.has(tab.windowId)) ownAttached.push(tabId);
    }
    await Promise.all(ownAttached.map((tabId) => import("./debugger-bridge").then(({ interruptTab }) => interruptTab(tabId))));
    const [maskedTabs] = await Promise.all([resetMasksForTabs(ownAttached), Promise.all(ownAttached.map((tabId) => detach(tabId).catch(() => undefined)))]);
    for (const space of ownSpaces) {
      if (space.windowId !== undefined) await chrome.windows.remove(space.windowId).catch(() => {});
      await patchSpace(space.spaceId, { ownership: "inactive", windowId: undefined, tabId: undefined, attached: false });
    }
    // 模板运行权=前台租约：只有自己持有时取消运行代际，才不会误伤正在跑模板的其他 Agent。
    if (state.foregroundLease?.ownerClientId === clientId) tpl.cancelTemplateRuns();
    await mutateState((s) => {
      if (s.foregroundLease?.ownerClientId === clientId) delete s.foregroundLease;
      if (s.activeSpaceIds?.[clientId]) delete s.activeSpaceIds[clientId];
      if (s.activeSpaceId && ownSpaceIds.has(s.activeSpaceId)) delete s.activeSpaceId;
    });
    return { stopped: true, scoped: true, closedSpaces: [...ownSpaceIds], detachedTabs: ownAttached, maskedTabs };
  },
};

// 会被用户「人工接管」中断的操作命令（CDP 输入 + 页面求值）。一旦处于接管态则拒绝，防止 AI 在人类操作时乱动。
const ACTION_NAMES = new Set<CommandName>([
  "click", "dblclick", "hover", "drag", "wheel", "down", "up",
  "press", "type", "fill", "selectOption", "check", "uncheck", "setChecked", "js", "tab_cdp_call", "download_image", "download_resource",
]);

export async function dispatch(cmd: Command): Promise<unknown> {
  const name = cmd.name;
  if (!KNOWN[name]) throw new Error(`unknown command: ${String(name)}`);
  // 模板是复合浏览器命令：入口先绑定并验证 space，内部步骤继承相同身份、space 和前台租约。
  if (name === "run_template") await sp.ensureCommandSpace(cmd);
  const foreground = await acquireForegroundLease(cmd);
  touchMaskActivity();
  try {
    // 人工接管保护：对动作命令，若目标 tab 处于接管态则拒绝。
    if (ACTION_NAMES.has(name) && hasTakeover()) {
      const tabId = await resolveTargetTab(cmd).catch(() => undefined);
      if (tabId !== undefined && isHumanTakeover(tabId)) throw new Error("human_takeover_in_progress");
    }
    return await KNOWN[name](cmd);
  } finally {
    endMaskActivity();
    await foreground?.release();
  }
}

export function buildGuideFromCmd(profile: ProfileInfo | undefined, hostPort: number | undefined, hostToken?: string): string {
  // 平台相关的展示兜底（profile 未上报时才显示）。
  const defaultUdd =
    navigator.platform.startsWith("Win")
      ? "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data"
      : navigator.platform.startsWith("Mac")
        ? "~/Library/Application Support/Google/Chrome"
        : "~/.config/google-chrome";
  const defaultExe =
    navigator.platform.startsWith("Win")
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : navigator.platform.startsWith("Mac")
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/google-chrome";
  const p = profile ?? ({} as ProfileInfo);
  const profileDir = p.profileDir ?? "Default";
  const exe = p.chromeExe ?? defaultExe;
  const udd = p.userDataDir ?? defaultUdd;
  const port = hostPort ?? 47001;
  const extId = chrome.runtime.id;
  const auth = hostToken ?? "<从 BrowserPilot popup 重新 Copy Skill>";

  return [
    "# BrowserPilot Skill Bootstrap",
    "",
    "> 本文档给外部 AI / CLI 使用：读完即可连上并驱动这台浏览器。",
    "> profile: " + (p.profileDir ?? profileDir) + "  | 浏览器: " + (p.browser ?? "Google Chrome"),
    "",
    "---",
    "",
    "## 0. 一句话",
    "你通过本地 Host 连接 BrowserPilot。每个 Agent 拥有自己的 Task Space（一个独立窗口和其中的标签页），同一 profile 继续共享 cookie/登录态；插件在统一命令入口强制检查所有权。",
    "",
    "## 1. 怎么连",
    "",
    "推荐优先使用项目官方 client：`npm run client -- <command> '<args-json>'`。为每个长期 Agent 设置稳定的环境变量 `BROWSERPILOT_AGENT_ID`；同一个 Agent 的后续命令必须复用同一个值。client 只用 ping 扫描动态端口，找到后真实命令只投递一次。",
    "- client 脚本位于 BrowserPilot 项目目录下 `native-host/client.mjs`；`npm run client` 不可用时可直接 `node <项目目录>/native-host/client.mjs <命令> '<args>' --no-launch`。",
    "",
    "- 地址：`127.0.0.1:" + port + "`（TCP 长连接）。",
    "- 协议：**换行分隔的 JSON**（每行一条消息，以 `\\n` 结尾）。",
    "- 你只能发 `command`；扩展回你 `result`；异步通知是 `event`。",
    "",
    "连好之后，先发一条 ping 确认：",
    "",
    "```",
    '{"type":"command","name":"ping","args":{},"requestId":"1"}',
    '{"type":"result","requestId":"1","ok":true,"data":{"pong":true,...}}',
    "```",
    "",
    "## 2. 消息格式",
    "",
    "- 进（你 → 扩展）：`{\"type\":\"command\",\"name\":\"<命令>\",\"args\":{...},\"requestId\":\"<任意串>\",\"agentId\":\"<稳定 Agent 名>\"}`",
    "- 出（扩展 → 你）成功：`{\"type\":\"result\",\"requestId\":\"<同上>\",\"ok\":true,\"data\":{...}}`",
    "- 出（扩展 → 你）失败：`{\"type\":\"result\",\"requestId\":\"<同上>\",\"ok\":false,\"error\":\"<原因>\"}`",
    "- 事件：`{\"type\":\"event\",\"name\":\"...\",\"args\":{...},\"sequence\":N}`（无 requestId，订阅用 `drainEvents`）",
    "",
    "`requestId` 每次自己编一个（如递增数字），用于把返回对回你的请求。",
    "`agentId` 标识长期 Agent，用于 Task Space 所有权；只能使用字母、数字、点、下划线、冒号和短横线。官方 client 默认是 `browserpilot-cli`。多个 Agent 并行时必须分别设置。",
    "除 `ping`/开发用 `reload` 外，命令还须带 `authToken`：`" + auth + "`。同一 TCP 长连接首次认证后可省略。",
    "",
    "## 3. 第 0 步（最高优先级）：先查模板库——能一条命令就别手写",
    "",
    "写任何操作序列（snapshot→fill→press...）之前，先 `list_templates` 看是否已有现成模板。",
    "已适配：AI 提问（`chatgpt-ask` / `gemini-ask` / `deepseek-ask`，params.prompt）；",
    "搜索（`search` / `baidu-search` / `bing-search` / `x-search` / `bilibili-search`）；",
    "财经（`xueqiu-search` / `guba-search` / `stock-announcements` / `cls-telegraph`）；",
    "下载（`bilibili-download-video` / `tiktok-video-download`，params.url）。",
    "",
    "```",
    '{"type":"command","name":"list_templates","args":{},"requestId":"0"}',
    '{"type":"command","name":"search_templates","args":{"query":"<关键词>"},"requestId":"1"}',
    '{"type":"command","name":"run_template","args":{"id":"chatgpt-ask","params":{"prompt":"<问题>"}},"requestId":"2"}',
    "```",
    "",
    "没有现成模板时，按下面三步手写：",
    "",
    "### 第 1 步：看浏览器里有哪些标签页",
    "",
    "### 第 1 步：看浏览器里有哪些标签页",
    "",
    "```",
    '{"type":"command","name":"list_tabs","args":{},"requestId":"1","authToken":"' + auth + '"}',
    "→ data:{\"spaceId\":\"space-...\",\"tabs\":[{\"tabId\":123,\"windowId\":5,\"title\":\"...\",\"url\":\"...\"}],\"windows\":1}",
    "```",
    "",
    "第一次调用会把当前前台窗口绑定为这个 Agent 的默认 Space。之后 `list_tabs` 只返回该 Space 的标签；传入其他窗口的 `tabId` 会返回 `TAB_OUTSIDE_SPACE`。需要新空间时调用 `open_space`。",
    "",
    "### 第 2 步：看单个页面长什么样（不用 attach，最省 token）",
    "",
    "```",
    '{"type":"command","name":"snapshot","args":{"level":"L0","tabId":123},"requestId":"2"}',
    "→ data:{\"content\":\"## 页面标题\\n- [Click] 链接A @1\\n- [Edit] 输入框 @2 ...\",\"refs\":{...}}",
    "```",
    "",
    "`level:\"L0\"` 给出 Markdown 可点击树和 `snapshotId`（纯文本，最省 token）。L1/AX 尚未实现。",
    "",
    "### 第 3 步：照着上面的 ref 动作",
    "",
    "```",
    '{"type":"command","name":"click","args":{"ref":"@1","snapshotId":"<上一步返回值>","tabId":123},"requestId":"3"}',
    '{"type":"command","name":"fill","args":{"ref":"@2","snapshotId":"<上一步返回值>","value":"hello","tabId":123},"requestId":"4"}',
    '{"type":"command","name":"press","args":{"key":"Enter", tabId:123},"requestId":"5"}',
    '{"type":"command","name":"waitForURL","args":{"pattern":"*result*", tabId:123},"requestId":"6"}',
    '{"type":"command","name":"drainEvents","args":{"after_sequence":0,"limit":50},"requestId":"7"}',
    "```",
    "",
    "## 4. 一次完整的 Google 搜索（照抄即跑）",
    "",
    "```",
    // 步骤 1：找到/打开一个标签
    '{"type":"command","name":"list_tabs","args":{},"requestId":"1"}',
    // 步骤 2：若没有合适的标签, 先打开 Google（open_tab 新开并聚焦；也可省略直接对现有 tab）
    '{"type":"command","name":"open_tab","args":{"url":"https://www.google.com"},"requestId":"2"}',
    // 步骤 3：L0 看页面, 拿到输入框 ref
    '{"type":"command","name":"snapshot","args":{"level":"L0"},"requestId":"3"}',
    // 步骤 4：填进关键词（把 ref 换成实际拿到的, 下例 @2 只是示意）
    '{"type":"command","name":"fill","args":{"ref":"@2","value":"chrome extension automation"},"requestId":"4"}',
    // 步骤 5：回车提交
    '{"type":"command","name":"press","args":{"key":"Enter"},"requestId":"5"}',
    // 步骤 6：等结果页 URL 变化
    '{"type":"command","name":"waitForURL","args":{"pattern":"https://www.google.com/search*"},"requestId":"6"}',
    // 步骤 7：再 L0 看结果
    '{"type":"command","name":"snapshot","args":{"level":"L0"},"requestId":"7"}',
    "```",
    "",
    "> 提示：命令里 `args` 的 `ref` 来自上一步 snapshot 返回的 `@N`；若页面已导航（URL/版本变了），动作会返回 `page_updated`，此时**重新 snapshot 再动**。",
    "",
    "## 5. 命令参考（常用）",
    "",
    "| 命令 | args | 作用 / 返回 |",
    "|---|---|---|",
    "| `ping` | `{}` | 连通性，返回 `{pong:true}` |",
    "| `list_spaces` | `{}` | 只列出当前 Agent 拥有的 Task Spaces |",
    "| `open_space` | `{name?,url?}` | 创建并选中当前 Agent 独占的窗口空间 |",
    "| `use_space` | `{spaceId\|name}` | 切换到当前 Agent 已拥有的空间 |",
    "| `handoff_space` | `{spaceId\|name?}` | 把空间交给用户，后续 Agent 页面命令被硬拦截 |",
    "| `claim_space` | `{spaceId\|name?}` | 用户明确允许后恢复当前 Agent 对空间的控制 |",
    "| `complete_space` | `{spaceId\|name?,keep?}` | `keep:true` 留给用户；否则关闭窗口并结束空间 |",
    "| `list_tabs` | `{}` | 只列出当前 Task Space 的窗口/标签 |",
    "| `open_tab` | `{url}` | 在当前 Task Space 内开新标签并聚焦，返回 `{tabId,spaceId}` |",
    "| `close_tab` | `{tabId}` | 关标签 |",
    "| `switch_tab` | `{tabId}` | 聚焦到某标签 |",
    "| `ensure_visible` | `{tabId?}` | 恢复目标窗口为 normal 并聚焦，降低最小化/后台渲染节流 |",
    "| `snapshot` | `{level:\"L0\", tabId?}` | Markdown 可点击树 + `snapshotId`；L1 尚未实现 |",
    "| `click` | `{ref,snapshotId\\|selector\\|x,y, tabId?}` | ref 动作必须带快照 ID，过期返回 `page_updated` |",
    "| `fill` | `{ref, snapshotId, value, tabId?}` | 填输入框并触发输入 |",
    "| `press` | `{key, tabId?}` | 按单个键（Enter/Escape/...） |",
    "| `type` | `{text, tabId?}` | 逐字敲入 |",
    "| `js` | `{expression, tabId?}` | Run JS 求值, 返回结果 |",
    "| `waitForURL` / `waitForSelector` / `waitForTimeout` | `{...}` | 等 URL/元素/时间 |",
    "| `wait_dom_idle` | `{idleMs?,timeoutMs?,selector?}` | 等 DOM 静默（MutationObserver）：AI 聊天流式输出结束后内容才停止变化；超时返回 idle:false |",
    "| `drainEvents` | `{after_sequence?, methods?, limit?}` | 拉取事件游标 `{events,cursor,hasMore}` |",
    "| `screenshot` | `{format?}` | 视口截图(返回 base64) |",
    "| `scroll_screenshot` | `{pages?, gap?, format?}` | 滚动拼接长截图「截N屏拼一张」, 返回整图 base64 + pageCount/width/height; pages 缺省=3(建议, 长图别过长), 传 0 表示整页全量 |",
    "| `tab_cdp_call` | `{tabId?, method, params?}` | 任意底层 CDP 透传(如 Network.enable/Network.getResponseBody/Runtime.evaluate), 全权交给 AI/CLI |",
    "| `download_image` | `{url, filename?}` | 下载 URL 到本地(支持 data:/http:), 配合模版回收的 images[] 落盘; blob: 明确拒绝 |",
    "| `download_resource` | `{url?\|urls?...[], selector?, filename?, tabId?}` | 页面上下文取字节后落盘：blob 图用 canvas 全尺寸提取(PNG)、登录态 http 用页面内 fetch 带 cookie；文件名可控；`urls[]` 传多张自动编号（AI 一次出多图 / Gemini Choice A/B 全收） |",
    "| `list_templates` | `{}` | 列出全部模板（ID/名称/输入/输出）——**写操作序列前必查** |",
    "| `search_templates` | `{query}` | 按关键词搜索模板 |",
    "| `run_template` | `{id, params?}` | 一键跑流程模版(省 token); 聊天模版续问传 conversationUrl(上次返回的 url) 校验仍指向同一会话; 失灵返回结构化失败上下文 |",
    "| `start_mask` | `{tabId?}` | 开「人工接管遮罩」：蓝色半透明 + 拦截用户 + 底部「人工接管」按钮 |",
    "| `stop_mask` | `{tabId?}` | 关遮罩 / 清除接管态（人解完验证码后让 AI 继续） |",
    "| 事件`mask_takeover` | `{tabId}` | 用户点了遮罩上的「人工接管」→ 暂停 AI，等 `stop_mask` 续跑 |",
    "| `export_guide` | `{}` | 导出本说明 |",
    "| `stop` | `{}` | 清理会话：Agent 身份调用=只清自己的空间/租约/遮罩；popup 全局停止=清全部 |",
    "",
    "## 6. 省 token 与稳定性",
    "",
    "- **默认用 L0 观测**（纯文本树），需要精确才升级 L1；别一上来就截图。",
    "- **模版优先**（`run_template`）：AI 提问（`chatgpt-ask`/`gemini-ask`/`deepseek-ask`）、搜索（`search`/`baidu-search`/`bing-search`/`x-search`/`bilibili-search`）、财经（`xueqiu-search`/`guba-list`/`stock-announcements`/`cls-telegraph`）、下载（`bilibili-download-video`/`tiktok-video-download`）等已适配——先 `list_templates` 查全量，一条命令顶二十行手写；跑不通时返回失败上下文供现场重写。",
    "- **AI 聊天页是流式渲染**：`snapshot`/`js` 返回的都是瞬时快照；用 `wait_dom_idle` 等回答写完再收集，并核对结尾是否为自然句子——「停止按钮消失」只是必要非充分条件。",
    "- **发送验证**：`press` 返回焦点元素与输入框长度前后状态（valueCleared）；AI 模板内置输入框清空检查，输入框未清空=消息未发出。",
    "- `set_humanize`、L1/AX、脚本型模板当前尚未实现，不应调用。",
    "- **页面已变**：任何动作前若快照过期，返回 `page_updated`，重拍再动，避免盲操作。",
    "- **并发保护**：需要前台、截图或输入的命令由插件侧全局前台租约串行化；模板的全部子步骤继承同一租约。异常中断后租约会自动过期。",
    "",
    "## 7. 本机信息",
    "",
    "- 扩展 ID: `" + extId + "`  host: `com.browserpilot.browseragent`",
    "- profile 目录: `" + profileDir + "`  user-data-dir: `" + udd + "`",
    "- Chrome: `" + exe + "`",
    '- 启动命令: `"' + exe + '" --profile-directory="' + profileDir + '"`',
    "- 端口: `" + port + "`（若连不上, 说明 host 没起或换了端口, 重新 export_guide 获取最新端口）",
    "",
    "## 8. 常见问题",
    "",
    "- **连接被拒 / ECONNREFUSED**：host 没在跑。优先用官方 client 重试，它会尝试启动上次缓存的 profile；若是首次使用，先手动启动一次安装了 BrowserPilot 的浏览器 profile，让插件写入缓存。",
    "- **返回 `unknown command`**：扩展 SW 版本旧, 需在 `chrome://extensions` 重新加载 `dist/`（或发一条 `{\"type\":\"command\",\"name\":\"reload\"}` 自动重载）。",
    "- **热更新**：本插件支持发 `reload` 命令自动重载 SW（开发期免手动）。重载后 native 连接断、host 重启、端口可能变, 重新 `export_guide` 拿最新端口。",
    "- **操作报 `page_updated`**：页面已导航, 重新 `snapshot` 再动。",
    "- **`ref` 失效**：页面刷新后 `@N` 会变, 重新 snapshot 拿新 ref。",
    "- **权限 / 调试横幅**: 只有用 `L1` 动作时标签页才出现「正在调试此浏览器」横幅, 这是 debugger API 固有, 纯 `L0` 观测无横幅。",
    "- **`SPACE_NOT_OWNED` / `TAB_OUTSIDE_SPACE`**：不要绕过；选择自己已有的 Space，或用 `open_space` 创建新空间。",
    "- **`SPACE_USER_IN_CONTROL`**：用户已经人工接管，必须等待用户明确允许后再调用 `claim_space`。",
    "- **`FOREGROUND_BUSY`**：另一 Agent 正在进行可见浏览器操作，稍后重试，不要并发开页。",
  ].join("\n");
}

// 注入命令调度器给模版 runner（templates.ts 不 import commands.ts，避免循环依赖）。
tpl.setCommandRunner(dispatch);
