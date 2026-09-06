# 股吧搜索

> 在东方财富股吧搜索关键词，返回相关帖子（标题+链接+摘要）。无需登录即可访问。

- ID: `guba-search`
- 版本: `1.1.1`
- 风险: `read`
- 适用站点: `eastmoney.com`, `guba.eastmoney.com`
- Intents: `search`, `finance.forum`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:84de08c63ed395a75dd3d16b67f73a352e39c0f7265cc53d2f619a75974a415d`

## 输入

- `query` (string, required): 搜索关键词（股票名/话题）
- `sort` (string): 排序：latest=按时间；留空=默认（相关度）

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

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 关键词 |

## 说明

- 走东方财富统一搜索的股吧频道（`so.eastmoney.com/tiezi/s`）。
- 每次只取第一页；请低频使用。

## 权威定义

[`template.json`](../templates/guba-search/template.json)

