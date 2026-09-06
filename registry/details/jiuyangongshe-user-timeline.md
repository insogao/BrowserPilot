# 韭研公社账号时间线

> 抓取某个韭研公社作者主页的最新文章列表。需要微信登录态。

- ID: `jiuyangongshe-user-timeline`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `jiuyangongshe.com`
- Intents: `finance.timeline`, `account.watch`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:cca80cc601090652e9d9b5181e7cf630873a6cf5edfe07193a42d011ced25926`

## 输入

- `uid` (string, required): 作者主页路径 /u/<hash> 中的 hash（在文章页点作者名可得）
- `limit` (number): 最多条数

## 输出

- `posts` (array): title/url

## 发现信息

- Keywords: 韭研公社, 韭研公社, 作者, 大V, 账号
- Aliases: 韭研公社作者, 公社大V
- BrowserPilot: `未声明`

## 详细说明

抓取某个公社作者主页的最新文章列表。
## 功能一览

- **功能**：抓取某个韭研公社作者主页的最新文章列表。需要微信登录态。
- **输入**：`uid`(string, 必填)、`limit`(number)
- **返回**：`posts`
- **站点**：jiuyangongshe.com ｜ **风险**：read ｜ **版本**：v1.0.0



## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| uid | string | 是 | 作者主页 `/u/<hash>` 中的 hash |
| limit | number | 否 | 最多条数（默认 15） |

## 组合用法

文章链接交给 `jiuyangongshe-article` 爬正文、`jiuyangongshe-comments` 爬评论。

## 权威定义

[`template.json`](../templates/jiuyangongshe-user-timeline/template.json)

