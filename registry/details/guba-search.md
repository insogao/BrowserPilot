# 股吧搜索

> 在东方财富股吧搜索关键词，返回指定条数帖子（标题+链接+摘要，默认 15，最多 100）。无需登录。

- ID: `guba-search`
- 版本: `1.2.0`
- 风险: `read`
- 适用站点: `eastmoney.com`, `guba.eastmoney.com`
- Intents: `search`, `finance.forum`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:93f12377b4976778adb2dce91be6e7ba6163a241e51bc7d9870a2fc4dab17f5b`

## 输入

- `query` (string, required): 搜索关键词（股票名/话题）
- `sort` (string): 排序：latest=按时间；留空=默认（相关度）
- `limit` (number): 返回帖子条数（默认 15，最多 100）
- `maxPages` (number): 最多翻页数（默认 3，上限 5；仅当结果不足 limit 时才翻页）

## 输出

- `count` (number): 
- `links` (array): title/url/excerpt
- `text` (string): 

## 发现信息

- Keywords: 股吧, 东方财富, guba, 股吧搜索, 帖子搜索
- Aliases: 东方财富股吧, guba 搜索
- BrowserPilot: `未声明`

## 详细说明

在东方财富股吧搜索关键词，返回帖子列表（标题、链接、摘要）。帖子链接可交给 `guba-article` 爬取正文。
## 功能一览

- **功能**：在东方财富股吧搜索关键词，返回相关帖子（标题+链接+摘要）。无需登录即可访问。
- **输入**：`query`(string, 必填)、`sort`(string)
- **返回**：`count`、`links`、`text`
- **站点**：eastmoney.com、guba.eastmoney.com ｜ **风险**：read ｜ **版本**：v1.1.1



## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 关键词 |

## 说明

- 走东方财富统一搜索的股吧频道（`so.eastmoney.com/tiezi/s`）。
- 每次只取第一页；请低频使用。

## 权威定义

[`template.json`](../templates/guba-search/template.json)

