# DeepSeek 提问

> 向 DeepSeek（chat.deepseek.com）提问，等待流式回复结束并回收回复文本。需要浏览器已有 DeepSeek 登录态。

- ID: `deepseek-ask`
- 版本: `1.0.0`
- 风险: `write`
- 适用站点: `chat.deepseek.com`
- Intents: `ai.ask`
- Capabilities: `js`, `open_tab`, `press`, `waitForTimeout`
- 功能指纹: `sha256:6bfc1ab95272e5e89d57f427d04feb960e40333338276b3f9ff4abc9326080fb`

## 输入

- `prompt` (string, required): 要问的问题

## 输出

- `text` (string): 回复文本（≤8000 字符）
- `url` (url): 对话地址（可用于续问上下文）

## 发现信息

- Keywords: deepseek, AI, 提问, 对话
- Aliases: DeepSeek 对话, ds 提问
- BrowserPilot: `未声明`

## 详细说明

向 DeepSeek 网页版提问并回收回复文本。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| prompt | string | 是 | 要问的问题 |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| text | string | 回复文本（≤8000 字符） |
| url | string | 本次对话地址 |

## 说明

- 需要浏览器已有 DeepSeek 登录态；未登录时 @write 返回结构化 no-textarea，不做绕过。
- prompt 经核心 `@write`（textarea 模式）的 JSON.stringify 安全通道注入，含引号/换行的提问也不会破坏表达式。
- 发送用 Enter（textarea 聚焦状态）；回复等待以 4 秒文本无增长为流式结束判定，上限 120s。
- 深度思考开/关沿用你页面的当前设置（模板不改动开关）；回复取最后一个 `.ds-markdown`（思考过程块在正式回复之前）。
- 续问：把返回的 url 交给 `open_tab` 后再调用本模板？——**不行**，本模板每次都开新对话；多轮对话场景建议把历史写进 prompt。

## 权威定义

[`template.json`](../templates/deepseek-ask/template.json)

