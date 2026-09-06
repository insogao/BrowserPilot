# 雪球搜索

> 在雪球搜索关键词，返回相关讨论帖（作者+时间+链接+摘要）与页面信息（含股票行情卡文本）。需浏览器已有雪球登录态。

- ID: `xueqiu-search`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `xueqiu.com`
- Intents: `search`, `finance.search`, `stock.discussion`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:b4b41ac511639c7d2af72b93b69a71c0a337d531143c3fb32efa4426081440ce`

## 输入

- `query` (string, required): 搜索关键词（股票名/代码/话题）

## 输出

- `count` (number): 
- `links` (array): author/time/url/excerpt
- `text` (string): 页面文本（含股票行情卡）

## 发现信息

- Keywords: 雪球, xueqiu, 股票讨论, 投资搜索
- Aliases: 雪球搜索, xueqiu 搜索
- BrowserPilot: `未声明`

## 详细说明

在雪球（xueqiu.com）搜索关键词，返回讨论帖流（作者、时间、帖子链接、摘要）与页面文本（含匹配到的股票行情卡）。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 关键词（股票名/代码/话题） |

## 前提与边界

- 需要浏览器已有雪球登录态（BrowserPilot 与用户共享 cookie）；未登录时雪球会弹出登录墙，此时记 blocked 而不是绕过。
- 每次运行只抓取当前第一页结果，步间有自然加载等待；请低频使用，不要用于批量扫描。
- 帖子链接可直接交给 `xueqiu-article` 爬取全文。

## 权威定义

[`template.json`](../templates/xueqiu-search/template.json)

