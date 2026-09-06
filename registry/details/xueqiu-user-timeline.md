# 雪球账号时间线

> 抓取某个雪球用户主页的最新帖子（内容摘要+互动数+帖子链接）。需雪球登录态。

- ID: `xueqiu-user-timeline`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `xueqiu.com`
- Intents: `finance.timeline`, `account.watch`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:904a7c7a5ea93ebb7a92d7efff07cb98aaac4591d1e3576263796742deb2f5ef`

## 输入

- `uid` (string, required): 雪球用户数字 ID（主页链接 xueqiu.com/<uid> 中的数字）
- `limit` (number): 最多条数

## 输出

- `posts` (array): author/time/url/excerpt/reposts/replies/likes

## 发现信息

- Keywords: 雪球, 大V, 账号, 时间线, 用户动态
- Aliases: 雪球大V, 雪球用户, 雪球动态
- BrowserPilot: `未声明`

## 详细说明

抓取某个雪球用户主页的最新帖子流（与搜索页同款结构：摘要 + 转发/评论/赞 + 帖子链接）。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| uid | string | 是 | 雪球数字用户 ID（用户主页 URL 里的数字） |
| limit | number | 否 | 最多条数（默认 10） |

## 组合用法

帖子链接可交给 `xueqiu-article` 爬全文、`xueqiu-comments` 爬评论——**大V订阅的完整链路**。

## 权威定义

[`template.json`](../templates/xueqiu-user-timeline/template.json)

