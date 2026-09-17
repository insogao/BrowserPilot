# X账号时间线

> 抓取 X 账号主页的最新推文，返回指定条数（默认 10，最多 100；滚动加载直到取够或无法继续）。需要 X 登录态。

- ID: `x-user-timeline`
- 版本: `1.1.0`
- 风险: `read`
- 适用站点: `x.com`, `twitter.com`
- Intents: `social.timeline`, `account.watch`
- Capabilities: `js`, `open_tab`, `waitForTimeout`, `waitForURL`
- 功能指纹: `sha256:c417b7c44c254bd39420be2251bde8dcf5f97e9825f7b9e7a62bf2016c0a09f0`

## 输入

- `handle` (string, required): X 用户名（不含 @，如 elonmusk）
- `maxScrolls` (number): 额外滚动次数；0 或留空=按 limit 自动推导（上限 20）
- `limit` (number): 返回推文条数（默认 10，最多 100）

## 输出

- `tweets` (array): user/text/time/url

## 发现信息

- Keywords: X, Twitter, 推特, 账号, 时间线, 大V
- Aliases: 推特账号, X时间线, 大V动态
- BrowserPilot: `未声明`

## 详细说明

抓取某个 X（Twitter）账号主页的最新推文。
## 功能一览

- **功能**：抓取某个 X（Twitter）账号主页的最新推文（文本/时间/链接），支持滚动加载。需要浏览器已有 X 登录态。
- **输入**：`handle`(string, 必填)、`maxScrolls`(number)
- **返回**：`tweets`
- **站点**：x.com、twitter.com ｜ **风险**：read ｜ **版本**：v1.0.0



## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| handle | string | 是 | 用户名（不含 @） |
| maxScrolls | number | 否 | 滚动加载轮数（默认 4，上限 10） |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| tweets | array | 每条 {user, text, time(ISO), url} |

## 边界

- 需要浏览器已有 X 登录态；未登录时返回结构化 `login_required`，不做绕过。
- 低频使用；不要用本模板做高频轮询。

## 权威定义

[`template.json`](../templates/x-user-timeline/template.json)

