# ChatGPT 提问

> 向 chatgpt.com 提问，等待回复流式结束并回收反馈文本。需要登录 ChatGPT 账号。

- ID: `chatgpt-ask`
- 版本: `1.1.0`
- 风险: `write`
- 适用站点: `chatgpt.com`
- Intents: `ai.chat`, `ask`, `question`
- Capabilities: `click`, `js`, `open_tab`, `switch_tab`, `wait_dom_idle`
- 功能指纹: `sha256:8c56639757878494c5b64ce34d95e2b1ac998259943b3ef9825a7cbfeb5c08a1`

## 输入

- `prompt` (string, required): 要问的问题
- `tabId` (number): 已打开的 ChatGPT 标签；提供则复用，不再新开
- `responseSelector` (string): 回复容器 CSS 选择器；留空则取整页文本
- `conversationUrl` (url): 会话 URL（上次提问返回的 url）；续问传入以校验仍指向同一会话

## 输出

- `text` (string): ChatGPT 回复文本
- `images` (array): 回复中的图片 URL 列表
- `url` (string): 当前会话 URL（可用于续问）
- `title` (string): 页面标题

## 发现信息

- Keywords: ChatGPT, AI, 聊天, 提问, chat, ask, GPT
- Aliases: chatgpt-ask, chatgpt-chat
- BrowserPilot: `>=0.1.0`

## 详细说明

向 ChatGPT (chatgpt.com) 提问，等待回复流式结束并回收反馈文本。
## 功能一览

- **功能**：向 chatgpt.com 提问，等待回复流式结束并回收反馈文本。需要登录 ChatGPT 账号。
- **输入**：`prompt`(string, 必填)、`tabId`(number)、`responseSelector`(string)、`conversationUrl`(url)
- **返回**：`text`、`images`、`url`、`title`
- **站点**：chatgpt.com ｜ **风险**：write ｜ **版本**：v1.0.0



## 前置条件

- 已登录 ChatGPT 账号
- BrowserPilot 扩展已安装并连接

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 要问的问题 |
| `tabId` | number | 否 | 已打开的 ChatGPT 标签 ID；提供则复用 |
| `responseSelector` | string | 否 | 回复容器 CSS 选择器；留空取整页文本 |
| `conversationUrl` | url | 否 | 会话 URL；续问时传入以校验同一会话 |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | string | ChatGPT 回复文本（最多 8000 字符） |
| `images` | array | 回复中的大图 URL 列表 |
| `url` | string | 当前会话 URL（可用于下次续问） |
| `title` | string | 页面标题 |

## 工作流程

1. 打开 chatgpt.com（如未提供 tabId）
2. 激活标签页（确保前台渲染）
3. 等待 ProseMirror 编辑器就绪
4. 校验会话 URL（续问场景）
5. 将 prompt 写入编辑器并等待发送按钮就绪
6. 点击发送按钮
7. 等待回复流式完成（文本+图片稳定 5s）
8. 回收回复文本和图片

## 选择器说明

- **编辑器**: `.ProseMirror[contenteditable="true"]` 或 `#prompt-textarea .ProseMirror`
- **发送按钮**: `button[data-testid='send-button']`（type=submit, class=composer-submit-btn）
- **用户消息**: `[data-message-author-role='user']`
- **助手回复**: `div[data-message-author-role='assistant']`

## 已知限制

- 需要登录 ChatGPT 账号；未登录时页面可能显示登录墙
- 回复等待超时为 120 秒
- 图片仅收集 naturalWidth≥512 且 naturalHeight≥256 的大图
- 不支持需要人工验证（captcha）的场景

## 使用示例

```json
{
  "command": "run_template",
  "args": {
    "id": "chatgpt-ask",
    "params": {
      "prompt": "什么是量子纠缠？"
    }
  }
}
```

## 续问示例

```json
{
  "command": "run_template",
  "args": {
    "id": "chatgpt-ask",
    "params": {
      "prompt": "能举一个具体例子吗？",
      "conversationUrl": "https://chatgpt.com/c/abc123"
    }
  }
}
```

## 权威定义

[`template.json`](../templates/chatgpt-ask/template.json)

