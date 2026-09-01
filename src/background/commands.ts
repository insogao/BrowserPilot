// 命令分派表 + 参数校验。参考技术路径 §4.4（ChatGPT zod 命令协议）。
// M1/M2 落地：ping / version / get_profile / export_guide / stop；观测与动作先在 M3~M5 填充。
import type { Command, CommandName, ProfileInfo } from "../shared/types";
import { loadState, clearAllSpaces } from "./state";
import { drainEvents } from "./events";
import * as sp from "./spaces";
import { resolveTargetTab } from "./tab-resolver";
import { getL0Snapshot, readTextFromTab } from "./content-bridge";
import { captureScreenshot, scrollCaptureScreenshot, ensureAttach } from "./cdp";
import { sendCommand } from "./debugger-bridge";
import * as act from "./actions";
import * as ev from "./eval";
import { maskOn, maskOff, isHumanTakeover, hasTakeover, touchMaskActivity, endMaskActivity, resetAllMasks } from "./mask";
import { detachAll, listAttachedTabs } from "./debugger-bridge";
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
  pageInfo: async (cmd) => ev.pageInfo(await resolveTargetTab(cmd)),

  drainEvents: async (cmd) => {
    const args = (cmd.args ?? {}) as { after_sequence?: number; methods?: string[]; limit?: number };
    return drainEvents(args);
  },

  open_space: () => Promise.reject("open_space 在 v2 实现（chrome.windows.create 专属窗口空间，用完即关）"),
  close_space: () => Promise.reject("close_space 在 v2 实现"),
  list_tabs: (cmd) => sp.list_tabs(cmd),
  open_tab: (cmd) => sp.open_tab(cmd),
  close_tab: (cmd) => sp.close_tab(cmd),
  switch_tab: (cmd) => sp.switch_tab(cmd),
  list_spaces: () => sp.list_spaces(),

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

  stop: async () => {
    tpl.cancelTemplateRuns();
    const attachedTabs = listAttachedTabs();
    await Promise.all(attachedTabs.map((tabId) => import("./debugger-bridge").then(({ interruptTab }) => interruptTab(tabId))));
    const [maskedTabs, detachedTabs] = await Promise.all([resetAllMasks(), detachAll()]);
    await clearAllSpaces();
    return { stopped: true, detachedTabs, maskedTabs };
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
  // 人工接管保护：对动作命令，若目标 tab 处于接管态则拒绝（平时从无接管，零开销）。
  if (ACTION_NAMES.has(name) && hasTakeover()) {
    const tabId = await resolveTargetTab(cmd).catch(() => undefined);
    if (tabId !== undefined && isHumanTakeover(tabId)) {
      throw new Error("human_takeover_in_progress");
    }
  }
  // 命名空间归属（F6）：operation 记录在对应 space 状态里（M7 完善）。
  touchMaskActivity();
  try {
    return await KNOWN[name](cmd);
  } finally {
    endMaskActivity();
  }
}

export function buildGuideFromCmd(profile: ProfileInfo | undefined, hostPort: number | undefined, hostToken?: string): string {
  const u = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const p = profile ?? ({} as ProfileInfo);
  const profileDir = p.profileDir ?? "Default";
  const exe = p.chromeExe ?? u;
  const port = hostPort ?? 47001;
  const extId = chrome.runtime.id;
  const auth = hostToken ?? "<从 BrowserPilot popup 重新复制使用文档>";

  return [
    "# 浏览器驱动说明（Chrome Agent）",
    "",
    "> 本文档给你（外部 AI / CLI）看，读完就能连上并驱动这台浏览器。",
    "> profile: " + (p.profileDir ?? profileDir) + "  | 浏览器: " + (p.browser ?? "Google Chrome"),
    "",
    "---",
    "",
    "## 0. 一句话",
    "这台浏览器（当前 profile）就是你的操作空间（Space = 整台浏览器，天然共用 cookie/登录态）。你通过一个**本地 TCP 端口**连入，发一行行 JSON 命令，它就去操作真实的标签页。",
    "",
    "## 1. 怎么连",
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
    "- 进（你 → 扩展）：`{\"type\":\"command\",\"name\":\"<命令>\",\"args\":{...},\"requestId\":\"<任意串，用来对号入座>\"}`",
    "- 出（扩展 → 你）成功：`{\"type\":\"result\",\"requestId\":\"<同上>\",\"ok\":true,\"data\":{...}}`",
    "- 出（扩展 → 你）失败：`{\"type\":\"result\",\"requestId\":\"<同上>\",\"ok\":false,\"error\":\"<原因>\"}`",
    "- 事件：`{\"type\":\"event\",\"name\":\"...\",\"args\":{...},\"sequence\":N}`（无 requestId，订阅用 `drainEvents`）",
    "",
    "`requestId` 每次自己编一个（如递增数字），用于把返回对回你的请求。",
    "除 `ping`/开发用 `reload` 外，命令还须带 `authToken`：`" + auth + "`。同一 TCP 长连接首次认证后可省略。",
    "",
    "## 3. 三步上手（第一次必做）",
    "",
    "### 第 1 步：看浏览器里有哪些标签页",
    "",
    "```",
    '{"type":"command","name":"list_tabs","args":{},"requestId":"1","authToken":"' + auth + '"}',
    "→ data:[{\"tabId\":123,\"windowId\":5,\"title\":\"...\",\"url\":\"...\",\"active\":true}, ...]",
    "```",
    "",
    "**Space 就是整台浏览器**——这份清单就是全部操作空间。接下来所有操作都要指定 `tabId`（或 `space?`，或干脆不传 = 当前激活标签）。",
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
    "| `list_tabs` | `{}` | 列出所有窗口/标签 `[{tabId,windowId,title,url,active}]`（Space=整台浏览器） |",
    "| `open_tab` | `{url, newWindow?}` | 开新标签（默认）或新窗口并聚焦，返回 `{tabId}` |",
    "| `close_tab` | `{tabId}` | 关标签 |",
    "| `switch_tab` | `{tabId}` | 聚焦到某标签 |",
    "| `snapshot` | `{level:\"L0\", tabId?}` | Markdown 可点击树 + `snapshotId`；L1 尚未实现 |",
    "| `click` | `{ref,snapshotId\\|selector\\|x,y, tabId?}` | ref 动作必须带快照 ID，过期返回 `page_updated` |",
    "| `fill` | `{ref, snapshotId, value, tabId?}` | 填输入框并触发输入 |",
    "| `press` | `{key, tabId?}` | 按单个键（Enter/Escape/...） |",
    "| `type` | `{text, tabId?}` | 逐字敲入 |",
    "| `js` | `{expression, tabId?}` | Run JS 求值, 返回结果 |",
    "| `waitForURL` / `waitForSelector` / `waitForTimeout` | `{...}` | 等 URL/元素/时间 |",
    "| `drainEvents` | `{after_sequence?, methods?, limit?}` | 拉取事件游标 `{events,cursor,hasMore}` |",
    "| `screenshot` | `{format?}` | 视口截图(返回 base64) |",
    "| `scroll_screenshot` | `{pages?, gap?, format?}` | 滚动拼接长截图「截N屏拼一张」, 返回整图 base64 + pageCount/width/height; pages 缺省=3(建议, 长图别过长), 传 0 表示整页全量 |",
    "| `tab_cdp_call` | `{tabId?, method, params?}` | 任意底层 CDP 透传(如 Network.enable/Network.getResponseBody/Runtime.evaluate), 全权交给 AI/CLI |",
    "| `download_image` | `{url, filename?}` | 下载 URL 到本地(支持 data:/http:), 配合模版回收的 images[] 落盘; blob: 明确拒绝 |",
    "| `download_resource` | `{url?\|urls?...[], selector?, filename?, tabId?}` | 页面上下文取字节后落盘：blob 图用 canvas 全尺寸提取(PNG)、登录态 http 用页面内 fetch 带 cookie；文件名可控；`urls[]` 传多张自动编号（AI 一次出多图 / Gemini Choice A/B 全收） |",
    "| `run_template` | `{id, params?}` | 一键跑流程模版(省 token); 聊天模版续问传 conversationUrl(上次返回的 url) 校验仍指向同一会话; 失灵返回结构化失败上下文 |",
    "| `start_mask` | `{tabId?}` | 开「人工接管遮罩」：蓝色半透明 + 拦截用户 + 底部「人工接管」按钮 |",
    "| `stop_mask` | `{tabId?}` | 关遮罩 / 清除接管态（人解完验证码后让 AI 继续） |",
    "| 事件`mask_takeover` | `{tabId}` | 用户点了遮罩上的「人工接管」→ 暂停 AI，等 `stop_mask` 续跑 |",
    "| `export_guide` | `{}` | 导出本说明 |",
    "| `stop` | `{}` | 断开/清理会话 |",
    "",
    "## 6. 省 token 与稳定性",
    "",
    "- **默认用 L0 观测**（纯文本树），需要精确才升级 L1；别一上来就截图。",
    "- **模版**（`run_template`）：把「搜索→取结果→人机/反馈」这类固定流程封装成一条命令，复用最省 token；跑不通时返回失败上下文，你据此现场写新模版。",
    "- `set_humanize`、L1/AX、脚本型模板当前尚未实现，不应调用。",
    "- **页面已变**：任何动作前若快照过期，返回 `page_updated`，重拍再动，避免盲操作。",
    "",
    "## 7. 本机信息",
    "",
    "- 扩展 ID: `" + extId + "`  host: `com.browserpilot.browseragent`",
    "- profile 目录: `" + profileDir + "`  user-data-dir: `" + (p.userDataDir ?? "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data") + "`",
    "- Chrome: `" + exe + "`",
    '- 启动命令: `"' + exe + '" --profile-directory="' + profileDir + '"`',
    "- 端口: `" + port + "`（若连不上, 说明 host 没起或换了端口, 重新 export_guide 获取最新端口）",
    "",
    "## 8. 常见问题",
    "",
    "- **连接被拒 / ECONNREFUSED**：host 没在跑。让本机的扩展 SW 重连（点一次扩展图标或 `ping` 触发）；再用本说明里的最新端口。",
    "- **返回 `unknown command`**：扩展 SW 版本旧, 需在 `chrome://extensions` 重新加载 `dist/`（或发一条 `{\"type\":\"command\",\"name\":\"reload\"}` 自动重载）。",
    "- **热更新**：本插件支持发 `reload` 命令自动重载 SW（开发期免手动）。重载后 native 连接断、host 重启、端口可能变, 重新 `export_guide` 拿最新端口。",
    "- **操作报 `page_updated`**：页面已导航, 重新 `snapshot` 再动。",
    "- **`ref` 失效**：页面刷新后 `@N` 会变, 重新 snapshot 拿新 ref。",
    "- **权限 / 调试横幅**: 只有用 `L1` 动作时标签页才出现「正在调试此浏览器」横幅, 这是 debugger API 固有, 纯 `L0` 观测无横幅。",
  ].join("\n");
}

// 注入命令调度器给模版 runner（templates.ts 不 import commands.ts，避免循环依赖）。
tpl.setCommandRunner(dispatch);
