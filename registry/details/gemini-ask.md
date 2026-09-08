# Gemini 提问

> 向 gemini.google.com/app 提问，等待回复流式结束并回收反馈文本。需要登录 Google 账号，且所在地区需支持 Gemini 聊天功能。

- ID: `gemini-ask`
- 版本: `1.1.0`
- 风险: `write`
- 适用站点: `gemini.google.com`
- Intents: `ai.chat`, `ask`, `question`
- Capabilities: `click`, `js`, `open_tab`, `switch_tab`, `wait_dom_idle`
- 功能指纹: `sha256:d251320b9a827ab2b1631775501203e3897054574f4be32d68abc352d366bba6`

## 输入

- `prompt` (string, required): 要问的问题
- `tabId` (number): 已打开的 Gemini 标签；提供则复用，不再新开
- `responseSelector` (string): 回复容器 CSS 选择器；留空则取整页文本
- `conversationUrl` (url): 会话 URL（上次提问返回的 url）；续问传入以校验仍指向同一会话

## 输出

- `text` (string): Gemini 回复文本
- `images` (array): 回复中的图片 URL 列表
- `url` (string): 当前会话 URL（可用于续问）
- `title` (string): 页面标题

## 发现信息

- Keywords: Gemini, AI, 聊天, 提问, chat, ask, Google
- Aliases: gemini-ask, gemini-chat
- BrowserPilot: `>=0.1.0`

## 详细说明

> 向 gemini.google.com/app 提问，等待回复流式结束并回收反馈文本。
## 功能一览

- **功能**：向 gemini.google.com/app 提问，等待回复流式结束并回收反馈文本。需要登录 Google 账号，且所在地区需支持 Gemini 聊天功能。
- **输入**：`prompt`(string, 必填)、`tabId`(number)、`responseSelector`(string)、`conversationUrl`(url)
- **返回**：`text`、`images`、`url`、`title`
- **站点**：gemini.google.com ｜ **风险**：write ｜ **版本**：v1.0.0



## 分类

- 类别：ai-chat
- 载体类型：commands

## 前提条件

1. 已登录 Google 账号（gemini.google.com 会自动跳转到登录页）
2. 所在地区需支持 Gemini 聊天功能（部分国家/地区会显示 "Gemini isn't currently supported in your country"）
3. 已安装 BrowserPilot 扩展并连接到 BrowserPilot Host

## 输入参数

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| `prompt` | string | 是 | - | 要问的问题 |
| `tabId` | number | 否 | - | 已打开的 Gemini 标签；提供则复用，不再新开 |
| `responseSelector` | string | 否 | `""` | 回复容器 CSS 选择器；留空则取整页文本 |
| `conversationUrl` | url | 否 | - | 会话 URL（上次提问返回的 url）；续问传入以校验仍指向同一会话 |

## 输出字段

| 字段 | 类型 | 描述 |
|------|------|------|
| `text` | string | Gemini 回复文本 |
| `images` | array | 回复中的图片 URL 列表 |
| `url` | string | 当前会话 URL（可用于续问） |
| `title` | string | 页面标题 |

## 工作流程

1. `open_tab` 打开 `https://gemini.google.com/app`（如提供 `tabId` 则跳过）
2. `switch_tab` 激活 Gemini 标签
3. `js` 等待 Quill 编辑器就绪（最多 20s）
4. `js` 确认当前标签仍是目标会话 URL（续问校验）
5. `js` 通过 Quill API 写入问题并记录回复基线
6. `click` 点击发送按钮
7. `js` 回收回复文本（取基线后新增的最后一条回复）

## DOM 选择器（已验证）

| 组件 | 选择器 | 说明 |
|------|--------|------|
| 编辑器 | `rich-textarea .ql-editor` | Quill 富文本编辑器（优先） |
| 编辑器备选 | `.ql-editor[contenteditable="true"]` | 标准 Quill 编辑器 |
| 编辑器备选 | `[contenteditable=true][role="textbox"]` | 通用 contenteditable |
| 发送按钮 | `button[aria-label='Send message']` | 发送按钮 |
| 用户消息 | `user-query` | 用户消息容器（自定义 web component） |
| 回复容器 | `.model-response` / `.response-content` | AI 回复容器 |
| 会话容器 | `div.conversation-container` | 每轮对话容器 |

## 已知限制

- **地区限制**：Gemini 聊天功能在部分国家/地区不可用。页面会显示 "Gemini isn't currently supported in your country"，此时模板无法执行。
- **DOM 变更**：Gemini 使用 Angular 框架，DOM 结构可能随版本更新而变化。如模板执行失败，请检查选择器是否仍然有效。
- **Quill 编辑器**：写入依赖 Quill API。如果 Gemini 切换编辑器实现，`@write` 占位符可能需要更新。

## 调试建议

如果模板执行失败：

1. 检查是否已登录 Google 账号
2. 检查页面是否显示地区限制消息
3. 手动导航到 `https://gemini.google.com/app` 确认聊天界面是否加载
4. 使用 BrowserPilot 快照检查编辑器和发送按钮是否存在
5. 检查 `button[aria-label='Send message']` 选择器是否匹配发送按钮

## 权威定义

[`template.json`](../templates/gemini-ask/template.json)

