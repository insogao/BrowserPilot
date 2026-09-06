# 财联社电报

> 抓取财联社电报页最新快讯（时间/标题/正文），A股分钟级时效信息源。无需登录。

- ID: `cls-telegraph`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `cls.cn`
- Intents: `finance.flash`, `news.flash`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:5f3f2b30b547b835fedbe35df7c622a5bbe5fae51ede88230e0eed11b92a8932`

## 输入

- `limit` (number): 最多条数（1-50）

## 输出

- `items` (array): time/title/content

## 发现信息

- Keywords: 财联社, cls, 电报, 快讯, flash news
- Aliases: 财联社快讯, cls 电报
- BrowserPilot: `未声明`

## 详细说明

抓取财联社电报页（cls.cn/telegraph）的最新快讯流：每条含时间（HH:MM:SS）、【标题】、正文。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 最多条数（默认 20，上限 50） |

## 说明

- 首屏 SPA 渲染较慢，模板内置 3.5s 等待。
- 电报条目容器为工具类（`.p-t-20.p-b-20`），站点改版时此选择器可能失效——以真实 smoke 为准。
- 相关：`stock-announcements`（个股公告，慢变量）。

## 权威定义

[`template.json`](../templates/cls-telegraph/template.json)

