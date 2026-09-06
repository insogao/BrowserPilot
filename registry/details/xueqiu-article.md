# 雪球文章爬取

> 爬取一篇雪球帖子/文章的全文（标题+正文，最多8000字符）。需浏览器已有雪球登录态。

- ID: `xueqiu-article`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `xueqiu.com`
- Intents: `crawl`, `finance.article`
- Capabilities: `js`
- 功能指纹: `sha256:0e792905f29431487c01983795ee42bc8bd2ac8fd7bf2343902d9d89490c1bb1`

## 输入

- `url` (url): 雪球帖子链接（xueqiu.com/<uid>/<postid>）；不填则在当前标签页爬取

## 输出

- `title` (string): 
- `content` (string): 
- `url` (url): 

## 发现信息

- Keywords: 雪球, xueqiu, 爬文章, 帖子全文
- Aliases: 雪球文章, 雪球全文
- BrowserPilot: `未声明`

## 详细说明

爬取一篇雪球帖子的全文。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | url | 否 | 帖子链接；不填则在当前标签页爬取 |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| title | string | 标题 |
| content | string | 正文（最多 8000 字符） |
| url | string | 实际文章地址 |

## 边界

- 需登录态；无权限/被删帖时返回结构化错误（no-content），不做绕过。
- 单篇爬取设计；批量扫描请控制频率，尊重站点。
- 相关模板：`xueqiu-search`。

## 权威定义

[`template.json`](../templates/xueqiu-article/template.json)

