# 股吧帖子爬取

> 爬取一篇股吧帖子的正文（标题+内容，最多8000字符）。无需登录。

- ID: `guba-article`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `guba.eastmoney.com`
- Intents: `crawl`, `finance.forum`
- Capabilities: `js`
- 功能指纹: `sha256:c9b8ee440a0bf11961cc5a0e21a7e40348da22a42a4aff5214cb6a6d41923dd2`

## 输入

- `url` (url): 股吧帖子链接（guba.eastmoney.com/news,代码,帖子id.html）；不填则在当前标签页爬取

## 输出

- `title` (string): 
- `content` (string): 
- `url` (url): 

## 发现信息

- Keywords: 股吧, guba, 帖子正文, 爬取
- Aliases: 股吧帖子, 股吧正文
- BrowserPilot: `未声明`

## 详细说明

爬取一篇股吧帖子的标题与正文。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | url | 否 | 帖子链接；不填则在当前标签页爬取 |

## 说明

- 正文容器为 `#newscontent`（2026-09 新版页面实测）。
- 单篇设计；回复区不在本模板范围。
- 相关模板：`guba-search`。

## 权威定义

[`template.json`](../templates/guba-article/template.json)

