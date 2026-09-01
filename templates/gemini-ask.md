# Gemini 提问 (`gemini-ask`)

> 向 gemini.google.com/app 提问，等待回复流式结束并回收反馈文本。

- 分类：ai-chat
- 载体类型：commands
- 输入参数：
  - `prompt`（string, 必填）：要问的问题
  - `tabId`（number, 可选）：已打开的 Gemini 标签；提供则复用，不再新开
  - `responseSelector`（string, 可选）：回复容器 CSS 选择器；留空则取整页文本

```json
{
  "id": "gemini-ask",
  "name": "Gemini 提问",
  "category": "ai-chat",
  "description": "向 gemini.google.com/app 提问，等待回复流式结束并回收反馈文本。",
  "inputs": [
    {
      "name": "prompt",
      "type": "string",
      "required": true,
      "description": "要问的问题"
    },
    {
      "name": "tabId",
      "type": "number",
      "required": false,
      "description": "已打开的 Gemini 标签；提供则复用，不再新开"
    },
    {
      "name": "responseSelector",
      "type": "string",
      "required": false,
      "default": "",
      "description": "回复容器 CSS 选择器；留空则取整页文本"
    }
  ],
  "steps": "commands",
  "body": [
    {
      "name": "open_tab",
      "args": {
        "url": "https://gemini.google.com/app"
      },
      "skipWhenParam": "tabId",
      "note": "打开 Gemini"
    },
    {
      "name": "switch_tab",
      "args": {},
      "note": "激活 Gemini 标签（后台标签不渲染回复，需前台）"
    },
    {
      "name": "js",
      "args": {
        "expression": "@write",
        "mode": "gemini"
      },
      "note": "写入问题并记录回复基线（Quill API）"
    },
    {
      "name": "click",
      "args": {
        "selector": "button[aria-label='Send message']"
      },
      "note": "点击发送按钮"
    },
    {
      "name": "js",
      "args": {
        "expression": "@chatCollect",
        "mode": "gemini"
      },
      "note": "回收回复文本（取基线后新增的最后一条回复）"
    }
  ],
  "tokenStrategy": {
    "defaultL0": true
  }
}
```