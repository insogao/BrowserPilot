# 模板开发规范（Template Authoring Guide）

> 面向：往本插件**新增一个操作模板**（新站点 or 新流程）时照着写的规约。
> 对齐代码：`src/shared/template-schema.ts`（schema/校验）、`src/background/templates.ts`（内置模板 + run_template 执行）。
> 外部用法：`run_template` 一次命令拿结果，见 `第一版插件-技术路径.md` §5.4。

---

## 0. 一句话

一个模板 = **一段编排描述**：把「打开页面 → 观测 → 动作 → 回收结果」写成一条命令序列（`steps:"commands"`）。
外部 AI/CLI 发 `run_template {id, params}` 即可，命中即返回结果；跑不通会返回**结构化失败上下文**（failback）。

## 1. 三种载体类型（`steps`）

| `steps` | `body` 类型 | v1 现状 |
|---|---|---|
| `commands` | `TemplateStep[]` | **主要用这个**，逐条走 commands.ts 分派 |
| `script` | `string` | v2 才执行（`run_script` sandbox 内核），v1 抛错 |
| `prompt` | `string` | 不执行，返回拼好的 prompt 字符串（`{kind:"prompt", prompt}`） |

## 2. Template 对象字段（schema）

```ts
{
  id: string;                 // 唯一标识，如 "gemini-ask"。内置模板直接当 id 用
  name: string;               // 中文名，如 "Gemini 提问"
  description: string;        // 一句话说明（外部 AI 决定何时用）
  category: "search" | "ai-chat" | "generic" | string;
  inputs: TemplateInput[];    // 入参声明（run_template 的 params 按此校验必填）
  steps: "commands" | "script" | "prompt";
  body: TemplateStep[] | string;
  tokenStrategy?: { defaultL0?: boolean; useCache?: boolean };  // 默认 defaultL0=true（先 L0 观测，省 token）
  scope?: { sites?: string[] };
}
```

`TemplateInput`：`{ name, type: "string"|"number"|"boolean"|"url", required?, default?, description? }`
（`required` 且未提供时，`run_template` 会直接报「缺少必填参数」）。

## 3. commands 载体的步骤字段（`TemplateStep`）

| 字段 | 说明 |
|---|---|
| `name` | 命令名（`CommandName`，见 `types.ts`） |
| `args` | 命令参数；值可含占位符 `$name` 或 `{{name}}`，run_template 用 params 代入 |
| `retry` | 失败额外重试次数（0=不重试）；重试间隔 1.2s |
| `expect` | 若设置，步骤成功结果 `JSON.stringify` 后须含此子串，否则视为失败（触发 failback） |
| `note` | 仅供人类阅读的说明 |
| `skipWhenParam` | 若 `params[该参数]` 为真值则跳过本步，如 `skipWhenParam:"tabId"`（已给 tabId 就不再新开标签） |

### 占位符代入规则
- `$name` / `{{name}}` —— 在 `args` 的任何字符串里都会替换成 `params[name]`；未提供则保留原样（`substValue`）。
- **特殊表达式占位**（放在 `js` 步骤的 `args.expression` 里，替换成一段现成 JS；由 `@` 开头）：

| 占位 | 展开为 | 用途 |
|---|---|---|
| `@focus` | `focusBestExpr(GOOGLE_CANDS)` | 等待并聚焦页面上可见输入区，打上 `data-bp-focus` 标（供 fill 命中）；返回布尔，**配 `expect:"true"`** |
| `@results` | `googleResultsExpr()` | 抓 Google 搜索结果：等 ≥3 条真实链接后取前 10（`{count,links,text}`） |
| `@write` | `aiWriteExpr(mode, $prompt)`（**需 `mode` 参数**） | 把 prompt 安全写入富文本编辑器，并记录回复基线 `window.__bpPrevMsg`（发送前最后一条消息容器的消息 ID 锚点） |
| `@chatCollect` | `aiCollectExpr(mode)`（**需 `mode` 参数**） | 回收「基线后新增的**全部** AI 回复容器」（Gemini Choice A/B 各一个 `.markdown` 全收、多图一次集齐不漏图；去前缀/后缀，流式稳定≈5s 后返回 `{text, images[], url, title}`） |
| `@collect` | `collectFeedbackExpr(responseSelector)` | 通用整页/指定容器文本回收（非站点特定） |
| `@verifyConv` | `verifyConversationExpr($conversationUrl)` | **续问前置校验**：确认当前标签 URL 仍指向目标会话（`conversationUrl` 空则跳过）；**配 `expect:"__BP_CONV_OK__"`** |

> `@write` / `@chatCollect` 的 `mode`：`"gemini"` 走 Quill、`"chatgpt"` 走 ProseMirror。**新站点需先探测 DOM 再扩展**（见 §5）。

### tabId 自动注入（关键，免每步手填）
`TAB_SCOPED` 里的命令（`js/click/fill/.../snapshot` 等）执行时，若步骤 `args.tabId` 未给，run_template 会**自动注入 currentTab**。
- 起始 `currentTab` = `params.tabId`（或 `run_template` 顶层 `tabId`）。
- 遇到 `open_tab` 成功返回 `{tabId}` 后，`currentTab` 自动更新为新标签 id。

## 4. 一条谷歌搜索模板长什么样（照抄即可）

```ts
{
  id: "search", name: "谷歌搜索", category: "search",
  description: "在 Google 搜索一个关键词，取回前 10 条结果（标题 + 链接 + 正文摘要）。",
  inputs: [{ name: "query", type: "string", required: true, description: "搜索关键词" }],
  steps: "commands",
  body: [
    { name: "open_tab", args: { url: "https://www.google.com" }, note: "打开 Google 首页" },
    { name: "js", args: { expression: "@focus" }, expect: "true", note: "等待并聚焦搜索框" },
    { name: "fill", args: { selector: "[data-bp-focus]", value: "$query" }, note: "填入关键词" },
    { name: "press", args: { key: "Enter" }, note: "提交搜索" },
    { name: "waitForURL", args: { pattern: "google.com/search", partial: true, timeoutMs: 20000 }, note: "等待结果页加载" },
    { name: "js", args: { expression: "@results" }, note: "抓取搜索结果" },
  ],
  tokenStrategy: { defaultL0: true },
}
```

## 5. AI 聊天模板的写/回收规范（重点）

站点 DOM 各不相同，**必须先实机探测**再写表达式。已适配的两个站点：

### Gemini（Quill 富文本）
- 编辑器：`rich-textarea.__quill`；**写入用 `q.setText(text,'user')`**。
  - ⚠️ 关键：`Input.insertText` 只改 DOM、不进 Quill Delta 模型，**必须用 source='user'** 才能点亮发送按钮。
- 发送按钮：`button[aria-label='Send message']`。
- 回复容器：**`.markdown`**（实测=每条助手回复；`.model-response` 类时有时无、不可靠）。

### ChatGPT（ProseMirror 富文本）
- 编辑器：`.ProseMirror[contenteditable="true"]`（`#prompt-textarea` 包裹）；**写入用 `document.execCommand('insertText',false,text)`**（ProseMirror 监听 beforeinput/input 从而写进编辑 state）。
- 发送按钮：`button[data-testid='send-button']`（aria="发送提示"）。
- 回复容器：`div[data-message-author-role='assistant']` 内取 `.markdown`。

### 基线机制（防长会话误取旧回复）
- 写步骤把发送前最后一条消息容器的消息 ID 写入 `window.__bpPrevMsg`（在 `aiWriteExpr` 内完成）。
- 回收只取「**基线之后新增**的最后一条回复」，避免复用长会话时把上一条旧回复当成本次回复。

### 回收清洗
- 去前缀：`Gemini said` / `ChatGPT said` / `You said`。
- 去尾部：`Flash` / `Gemini is AI` / `Dictate` / `Copy` / `Listen` / `Retry` / `Show drafts`；ChatGPT 侧另加 `ChatGPT 也可能会犯错` / `ChatGPT can make mistakes` / `思考`。
- 流式结束判定：长度连续 ≈5s（`stable>=5000`）不增长即视为结束。

### 新增站点的适配套路
1. 打开站点 → `snapshot L0` / 实机截图观察输入框 & 发送按钮 & 回复容器选择器。
2. 写步骤：找到该站编辑器 API（Quill/ProseMirror/纯 textarea/...），复刻 `geminiQuillCore()`/`chatgptProseCore()` 的写法，**写完后轮询等发送按钮就绪**（30×250ms）再返回，避免「写后立即 click 因按钮未渲染定位失败」。
3. 回收步骤：用基线机制 + 新增那一条回复 + 去前缀/后缀 + 流式稳定。
4. 在 `aiWriteExpr(mode,...)` / `aiCollectExpr(mode,...)` / `mode` 分支里加新站点，或直接另写专用表达式占位。

### 追问（同一会话续问）
每个聊天会话都有一个**唯一 ID 的 URL 锚点**（Gemini `app/<16位hex>`、ChatGPT `c/<uuid>`），这是比 `tabId` 更稳的会话标识：用户在标签里改 URL/导航后，`tabId` 仍指向同一标签但已不是原会话。

- 续问流程：
  1. 首次 `run_template` 的 `@chatCollect` 返回 `{url}`，即该会话 URL。
  2. 再追问时把该 `url` 作为 **`conversationUrl`** 传入：`run_template {id, params:{prompt, tabId, conversationUrl}}`。
  3. 模板里 `@verifyConv` 步在 `@write` 前用 `location.href` 与 `conversationUrl` 比对；一致则继续，不一致则 failback（提示外部 AI 用该 `conversationUrl` 重新定位）。
- 不带 `conversationUrl`（仅 `tabId`）时 `@verifyConv` 跳过校验，走基线机制兜底（适合首次提问或确认无歧义场合）。
- **新写聊天模版时**：在 `@write` 前加一步 `{name:"js", args:{expression:"@verifyConv", expected:"$conversationUrl"}, expect:"__BP_CONV_OK__"}`，并在 `inputs` 加 `conversationUrl`（url, 可选）。
- **已实现并测试（端到端）**：内置 `gemini-ask`/`chatgpt-ask` 已带 `conversationUrl` 入参 + `@verifyConv` 步（代码 `src/background/templates.ts`）；真机验证：①`pass`/`fail`/无参三分支在真实页面分别返回 `__BP_CONV_OK__` / `__BP_CONV_BAD__` / 跳过；②用**错误 conversationUrl** 实跑 `gemini-ask` 时 `@verifyConv` 在 `@write` **发消息之前**即 failback（`template_failed` 事件 + 现场快照 + 提示），未向会话发消息。模版文件：`templates/gemini-ask.md`、`templates/chatgpt-ask.md`。

### 图片：识别 vs 下载
- **识别**：`@chatCollect` 收集**基线后新增的全部**回复容器内 `img` 的 `currentSrc||src` 去重进返回的 `images` 数组（`data:`/`http:`/`blob:` 均可；Gemini 一次 Choice A/B 各是一个独立 `.markdown`，全收不漏图）。
- **下载（推荐 `download_resource`，通道 B）**：`images` 只是**图片地址**，不落盘。用 `download_resource {url?|urls[]?|selector?, filename?, tabId?}`（`src/background/download-resource.ts`）保存——在**页面上下文**取字节（blob 图 canvas 全尺寸无损提取为 PNG；登录态 http 用页面内 `fetch(credentials:'include')` 带 cookie 转 data URL；data 透传；selector 取元素 `currentSrc/src/href`），data URL 在 SW 内部交 `chrome.downloads.download` 落盘，**文件名可控**；**`urls[]` 一次下多张**（AI 一次生成多张/Gemini Choice A/B 全下，多张时 filename 去扩展名做前缀自动编号 `stem-1.ext`/`stem-2.ext`，单张失败不拖垮其余、返回 `{count,total,results,failures}`）。
- **`download_image`（备用）**：只下 `data:`/`http:`（`blob:` 明确拒绝），且对登录态 `http:` 的 `chrome.downloads.download` 不带 cookie 会「假成功」，故大图/登录态图请用 `download_resource`。
- **已实现并测试（真机闭环）**：`gemini-ask` 会话生成图（blob:，1024×559）→ `download_resource {url:<blob>}` 得全尺寸无损 PNG（1233728B）；`chatgpt-ask` 会话生成图（同源 http，1536×1024）→ `download_resource {url}` 得完整原图（3252157B）；`data:` 地址自测成功（70B）。**多图**：`gemini-ask` 会话一次生成两张 1024×559（Gemini Choice A/B，各是一个独立 `.markdown`，md[1]/md[2]），`@chatCollect`（base=1）返回 `images:[两 blob]`；`download_resource {urls:[blobA,blobB], filename:"gemini-choice.png"}` → 两张全落盘（`gemini-choice-1.png` 1233728B、`-2.png` 1327643B），中文名 `夏天.png` → `夏天-1.png`/`夏天-2.png`。**绕开两个坑**：① native messaging 命令 1MB 上限——data URL 只经 CDP Runtime.evaluate 在 SW 内存往返再落盘；② 登录态 http 假成功——换页面上下文 fetch 带 cookie。**测试文件按用户最新指示「阶段开发完再一次性删」，暂留作证据、未删**。

## 6. failback（跑不通时返回什么）

任一步失败，`run_template` 会：
- 发事件：`{type:"event", name:"template_failed", args:{id, step, step_note, error}}`
- 抛结构化错误（`ok:false`, `error` = 一段 JSON）：
```json
{
  "template_failed": true, "id": "xxx", "step": "js", "step_note": "...",
  "error": "错误原因",
  "snapshot_content": "<现场 L0 快照节选>",
  "hint": "模版失灵：以上是现场快照与出错步骤。外部 AI 可据此重写为_新 id 的模版并 import_template 后再次运行（failback）。"
}
```
外部 AI 据此**现场写新模板 → import_template → 重试**。

## 7. 新增模板的两条路

### A. 运行时模板（不改代码，推荐先用这个试）
- 组装一个 Template 对象，转成 JSON（或 markdown 内嵌 ```json``` 块）。
- 发 `import_template {content: "<JSON>"}` → 存进 `storage.local`（`browserpilot.templates.v1`）。
- 之后 `run_template {id, params}` 即可。无需重建、无需重载 SW。

```json
{"type":"command","name":"import_template","args":{"content":"{\"id\":\"my-bing\",\"name\":\"必应搜索\",\"category\":\"search\",\"inputs\":[{\"name\":\"query\",\"type\":\"string\",\"required\":true}],\"steps\":\"commands\",\"body\":[{\"name\":\"open_tab\",\"args\":{\"url\":\"https://www.bing.com\"}},{\"name\":\"js\",\"args\":{\"expression\":\"@focus\"},\"expect\":\"true\"},{\"name\":\"fill\",\"args\":{\"selector\":\"[data-bp-focus]\",\"value\":\"$query\"}},{\"name\":\"press\",\"args\":{\"key\":\"Enter\"}},{\"name\":\"waitForURL\",\"args\":{\"pattern\":\"bing.com/search\",\"partial\":true,\"timeoutMs\":20000}},{\"name\":\"js\",\"args\":{\"expression\":\"@results\"}}]}"},"requestId":"1"}
```

### B. 内置模板（稳定后固化成代码，随包分发）
1. 在 `src/background/templates.ts` 的 `builtinTemplates()` 里加一个对象（照 §4 格式）。
2. `npm run typecheck` + `node scripts/build.js` 重建 `dist/`。
3. 重载扩展 SW（`reload` 命令或手动），发 `export_template {id, as:"md"}` 把 markdown 存到 `templates/<id>.md` 作为权威产物。

### 建议流程
先用 **A 在真机试跑**，调通后再走 **B 固化**，避免反复改代码/重打包。

## 8. Registry 与命令参考

模板看板位于扩展 options 页。安装记录保存在 `browserpilot.templates.v2`，旧 v1 数据自动迁移；GitHub 来源保存 `repo/path/ref`，用于后续检查更新。只有模板 JSON/Markdown **定义文件**最大 1MB，外部图片/音视频资源与 `download_resource` 不受此 Registry 限制。commands 模板使用明确 allowlist，不能调用 reload/stop/Registry 管理命令。

| 命令 | args | 返回 |
|---|---|---|
| `run_template` | `{id, params?, tabId?}` | 最后一步结果；prompt 载体返回 `{kind:"prompt",prompt}`；失败抛 failback 错误 |
| `list_templates` | `{}` | `[{id,name,description,category,inputs,steps,scope}]` |
| `export_template` | `{id, as?:"md"|"json"}` | `{id,name,template,markdown}`（markdown 可存成 `templates/<id>.md`）|
| `import_template` | `{id}`（内置）或 `{content}`（自定义）| `{imported,id,builtin,name}` |
| `install_template` | `{content}` / `{url}` / `{source:{type:"github",repo,path,ref}}` | 安装或覆盖升级，保存 hash/source/revision |
| `set_template_enabled` | `{id,enabled}` | 启用或停用已安装模板 |
| `check_template_update` | `{id}` | 比较远端 hash/version |
| `list_template_catalog` | `{repo,ref?,path?}` | 读取 GitHub `registry/catalog.json` |
| `sync_registry` | `{repo?,ref?,path?}` | 同步并缓存 Registry 目录 |
| `search_templates` | `{query,repo?,ref?,limit?}` | 动态搜索功能、站点、intent、关键词和能力 |
| `get_template_detail` | `{id,repo?,ref?}` | 读取安装模板或远端模板的权威定义与生成详情 |
| `compare_templates` | `{ids?,candidate?}` | 按语义字段计算相似度，创建前检查重复 |
| `update_template` | `{id}` | 从已绑定来源升级并保留上一 revision |
| `rollback_template` | `{id}` | 在当前与上一 revision 间回滚 |
| `uninstall_template` | `{id}` | 删除已安装模板；内置模板不可卸载 |

Registry Protocol v1.1 规定每个公开模板使用目录包 `registry/templates/<id>/`，其中 `template.json` 是唯一真源，README/CHANGELOG/examples/tests 为配套资源。catalog 和详情 Markdown 通过 `npm run registry:build` 生成，CI 运行 `npm run registry:check`，禁止手工维护两套功能列表与详情数据。

> `run_template` 顶层 `tabId` 会并入 params，使 `skipWhenParam:"tabId"` 与 `TAB_SCOPED` 注入生效（复用标签、不新开）。

## 9. 注意事项 / 坑

- **JS 表达式别用正则**：`apiWriteExpr`/`collectExpr` 是字符串拼的，正则 `\\n`/`\\s` 双层转义易报 "Invalid regular expression"，用 `split/join/indexOf`。
- **后台标签不渲染回复**：模板里对 AI 聊天库建议加一步 `switch_tab`（把目标标签激活到前台），否则回收不到流式回复。
- **长轮询先触发客户端 socket 超时**：外部 CLI 等待时用 node 侧 sleep，别在页内 JS 里无限 while。
- **端口每次 reload 必变**：外部连入前先 `export_guide` 拿最新端口。
- **Gemini 会话级限流**：连发/复测前后留冷却时间。
- **校验**：`validateTemplate` 会抛可读错误；`steps` 为 commands 时必须 body 是数组且每步有 `name`。
