# 雪球评论爬取

> 爬取一篇雪球帖子下的评论（用户/内容/点赞/时间），支持分页。需雪球登录态。

- ID: `xueqiu-comments`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `xueqiu.com`
- Intents: `crawl`, `finance.comments`
- Capabilities: `js`
- 功能指纹: `sha256:ba4f90ba08b96cd9b23acdb2faed062d79ddbe2d820bf100a1868e00e9787905`

## 输入

- `url` (url): 雪球帖子链接；不填则用当前标签页
- `page` (number): 评论页码
- `limit` (number): 每页条数（1-100）

## 输出

- `comments` (array): user/text/likes/time
- `page` (number): 
- `total` (number): 

## 发现信息

- Keywords: 雪球, 评论, 回复, comments
- Aliases: 雪球评论, 帖子评论
- BrowserPilot: `未声明`

## 详细说明

爬取一篇雪球帖子下的评论列表（用户、内容、点赞数、时间），支持翻页。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | url | 否 | 帖子链接；不填则用当前标签页 |
| page | number | 否 | 页码，默认 1 |
| limit | number | 否 | 每页条数（1-100，默认 20） |

## 说明

- 走雪球官方评论接口 `statuses/comments.json`（页面上下文带登录态），结构化程度最高。
- 与 `xueqiu-search`/`xueqiu-article` 组成完整链条：搜索 → 帖子全文 → 评论。
- 请低频翻页，尊重站点。

## 权威定义

[`template.json`](../templates/xueqiu-comments/template.json)

