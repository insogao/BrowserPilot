# 百度搜索

> 在百度搜索一个关键词，取回前10条结果（标题+链接+正文摘要）。

- ID: `baidu-search`
- 版本: `1.2.0`
- 风险: `read`
- 适用站点: `baidu.com`
- Intents: `search`, `web.search`
- Capabilities: `fill`, `js`, `open_tab`, `waitForURL`
- 功能指纹: `sha256:c0dbeb07a0f8f02c3d8acc430b640ae95f2c5ae5e556c4a6a67358afc7d21b42`

## 输入

- `query` (string, required): 搜索关键词

## 输出

- `count` (number): 返回结果条数
- `links` (array): 搜索结果列表，每项含title和url
- `text` (string): 结果页纯文本摘要

## 发现信息

- Keywords: 百度, baidu, 搜索, search
- Aliases: baidu, bd-search
- BrowserPilot: `>=0.1.0`

## 详细说明

在百度（www.baidu.com）搜索关键词，返回前10条结果（标题+链接+正文摘要）。
## 功能一览

- **功能**：在百度搜索一个关键词，取回前10条结果（标题+链接+正文摘要）。
- **输入**：`query`(string, 必填)
- **返回**：`count`、`links`、`text`
- **站点**：baidu.com ｜ **风险**：read ｜ **版本**：v1.2.0



## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索关键词 |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| count | number | 返回结果条数 |
| links | array | 搜索结果列表，每项含title和url |
| text | string | 结果页纯文本摘要（最多6000字符） |

## 适用站点

- https://www.baidu.com

## 使用示例

```json
{
  "command": "run_template",
  "args": {
    "id": "baidu-search",
    "params": { "query": "BrowserPilot" }
  }
}
```

## 已知限制

- 不支持百度图片/视频/学术等垂直搜索
- 结果页结构变化可能导致解析失败
- 提交搜索使用 `#form.submit()`（`#chat-textarea` 在表单外，`press Enter` 不可靠）

## 权威定义

[`template.json`](../templates/baidu-search/template.json)

