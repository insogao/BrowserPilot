# 韭研公社评论爬取

> 爬取一篇韭研公社文章下的评论（用户/时间/内容）。需要微信登录态；无评论时返回空列表。

- ID: `jiuyangongshe-comments`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `jiuyangongshe.com`
- Intents: `crawl`, `finance.comments`
- Capabilities: `js`
- 功能指纹: `sha256:5d410ef704f76c204d818745eb6f98b4b24da8f49fd717612d8d8d7d3e8439b2`

## 输入

- `url` (url): 文章链接；不填则用当前标签页
- `limit` (number): 最多抓取条数（1-100）

## 输出

- `comments` (array): user/time/raw

## 发现信息

- Keywords: 韭研公社, 九阳公社, 评论
- Aliases: 九阳公社评论, 公社评论
- BrowserPilot: `未声明`

## 详细说明

爬取一篇公社文章下的评论。需要微信登录态。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | url | 否 | 文章链接；不填则用当前标签页 |
| limit | number | 否 | 最多条数（默认 30） |

## 说明

- 评论区为懒加载，模板会先滚动全页触发渲染。
- 评论以 raw 规范化文本返回（含用户/时间/内容/点赞，源自站点 `.comment-content`）。
- 无评论时返回空列表（不是错误）。

## 权威定义

[`template.json`](../templates/jiuyangongshe-comments/template.json)

