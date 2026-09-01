# 谷歌搜索 (`search`)

> 在 Google 搜索一个关键词，取回前 10 条结果（标题 + 链接 + 正文摘要）。

- 分类：search
- 载体类型：commands
- 输入参数：
  - `query`（string, 必填）：搜索关键词

```json
{
  "id": "search",
  "name": "谷歌搜索",
  "category": "search",
  "description": "在 Google 搜索一个关键词，取回前 10 条结果（标题 + 链接 + 正文摘要）。",
  "inputs": [
    {
      "name": "query",
      "type": "string",
      "required": true,
      "description": "搜索关键词"
    }
  ],
  "steps": "commands",
  "body": [
    {
      "name": "open_tab",
      "args": {
        "url": "https://www.google.com"
      },
      "note": "打开 Google 首页"
    },
    {
      "name": "js",
      "args": {
        "expression": "@focus"
      },
      "expect": "true",
      "note": "等待并聚焦搜索框"
    },
    {
      "name": "fill",
      "args": {
        "selector": "[data-ego-focus]",
        "value": "$query"
      },
      "note": "填入关键词"
    },
    {
      "name": "press",
      "args": {
        "key": "Enter"
      },
      "note": "提交搜索"
    },
    {
      "name": "waitForURL",
      "args": {
        "pattern": "google.com/search",
        "partial": true,
        "timeoutMs": 20000
      },
      "note": "等待结果页加载"
    },
    {
      "name": "js",
      "args": {
        "expression": "@results"
      },
      "note": "抓取搜索结果"
    }
  ],
  "tokenStrategy": {
    "defaultL0": true
  }
}
```