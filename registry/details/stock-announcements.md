# 个股公告

> 按股票代码抓取东方财富的最新公告列表（标题/类型/日期/详情链接）。无需登录。

- ID: `stock-announcements`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `eastmoney.com`
- Intents: `finance.announcements`, `stock.disclosure`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:587725e71caa768f6ba9605d56241b2357eaea4a43c72e112207904792270f61`

## 输入

- `code` (string, required): 6 位股票代码（如 600519）
- `limit` (number): 最多条数（1-50）

## 输出

- `announcements` (array): title/url/type/date

## 发现信息

- Keywords: 公告, 东财, announcements, 信息披露, 巨潮替代
- Aliases: 股票公告, 公司公告
- BrowserPilot: `未声明`

## 详细说明

按股票代码抓取东方财富个股公告列表：标题、类型（财报/其他等）、日期、详情页链接。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| code | string | 是 | 6 位股票代码 |
| limit | number | 否 | 最多条数（默认 20） |

## 说明

- 详情页链接可交给通用 `open_tab`+`snapshot`/`readText` 阅读正文（公告正文为独立页面）。
- 公告为低频慢变量，正常使用无需限速担忧。

## 权威定义

[`template.json`](../templates/stock-announcements/template.json)

