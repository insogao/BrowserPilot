# 个股吧帖子流

> 按股票代码打开个股吧列表页，返回最新帖子流（标题/链接/阅读数/评论数/时间），默认按时间排序。无需登录。

- ID: `guba-list`
- 版本: `1.0.1`
- 风险: `read`
- 适用站点: `guba.eastmoney.com`
- Intents: `finance.forum`, `stock.posts`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:db2029cacf246102fd5541dc77c9c8f6a04ed60d52d09332c1349986c30912d2`

## 输入

- `code` (string, required): 6 位股票代码（如 600519）；或用 params.url 传含代码的链接
- `limit` (number): 最多条数

## 输出

- `posts` (array): title/url/reads/replies/time

## 发现信息

- Keywords: 股吧, 个股吧, 帖子列表, 最新帖
- Aliases: 股吧列表, 个股吧
- BrowserPilot: `未声明`

## 详细说明

打开个股吧列表页，返回最新帖子（标题、链接、**阅读数、评论数**、时间）——列表级互动数据以本模板为准（搜索结果页不渲染互动数）。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| code | string | 是 | 6 位股票代码（600519） |
| limit | number | 否 | 最多条数（默认 30） |

## 说明

- 列表页默认即按时间排序。
- 帖子正文用 `guba-article`；**帖子回复区当前受限**：新改版股吧回复列表为 API 懒加载（页面外调用被 CORS 拦截），回复内容暂不可爬，已记录为已知限制。

## 权威定义

[`template.json`](../templates/guba-list/template.json)

