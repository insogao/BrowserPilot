# 韭研公社文章爬取

> 爬取一篇韭研公社文章的标题与正文（最多8000字符）。需要微信登录态；积分/权限内容可能仅返回可见部分。

- ID: `jiuyangongshe-article`
- 版本: `1.1.2`
- 风险: `read`
- 适用站点: `jiuyangongshe.com`
- Intents: `crawl`, `finance.research`
- Capabilities: `js`
- 功能指纹: `sha256:b6e2d108d4559a8482095e5cea03229f7e1e28e91df0b39300a9bcc30f057794`

## 输入

- `url` (url): 文章链接（jiuyangongshe.com/a/<id>）；不填则在当前标签页爬取

## 输出

- `title` (string): 
- `content` (string): 
- `url` (url): 

## 发现信息

- Keywords: 韭研公社, 韭研公社, 公社文章, 爬取
- Aliases: 韭研公社文章, 公社爬取
- BrowserPilot: `未声明`

## 详细说明

爬取一篇公社文章的标题与正文。
## 功能一览

- **功能**：爬取一篇韭研公社文章的标题与正文（最多8000字符）。需要微信登录态；积分/权限内容可能仅返回可见部分。
- **输入**：`url`(url)
- **返回**：`title`、`content`、`url`
- **站点**：jiuyangongshe.com ｜ **风险**：read ｜ **版本**：v1.1.2



## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | url | 否 | 文章链接；不填则在当前标签页爬取 |

## 边界

- 需要微信登录态；积分/权限文章只返回可见部分（站点权限设计，不做绕过）。
- 正文容器 `.detail-container`（含标题/作者/时间/正文文本）。
- 相关模板：`jiuyangongshe-search`。

## 权威定义

[`template.json`](../templates/jiuyangongshe-article/template.json)

