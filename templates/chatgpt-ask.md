# ChatGPT 提问 (`chatgpt-ask`)

> 向 chatgpt.com 提问，等待回复流式结束并回收反馈文本。

- 分类：ai-chat
- 载体类型：commands
- 输入参数：
  - `prompt`（string, 必填）：要问的问题
  - `tabId`（number, 可选）：已打开的 ChatGPT 标签；提供则复用，不再新开
  - `responseSelector`（string, 可选）：回复容器 CSS 选择器；留空则取整页文本

```json
{
  "id": "chatgpt-ask",
  "name": "ChatGPT 提问",
  "category": "ai-chat",
  "description": "向 chatgpt.com 提问，等待回复流式结束并回收反馈文本。",
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
      "description": "已打开的 ChatGPT 标签；提供则复用，不再新开"
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
        "url": "https://chatgpt.com/"
      },
      "skipWhenParam": "tabId",
      "note": "打开 ChatGPT"
    },
    {
      "name": "switch_tab",
      "args": {},
      "note": "激活 ChatGPT 标签（后台标签不渲染回复，需前台）"
    },
    {
      "name": "js",
      "args": {
        "expression": "@write",
        "mode": "chatgpt"
      },
      "note": "写入问题并记录回复基线（ProseMirror）"
    },
    {
      "name": "click",
      "args": {
        "selector": "button[data-testid='send-button']"
      },
      "note": "点击发送按钮"
    },
    {
      "name": "js",
      "args": {
        "expression": "@chatCollect",
        "mode": "chatgpt"
      },
      "note": "回收回复文本"
    }
  ],
  "tokenStrategy": {
    "defaultL0": true
  }
}
```