# X账号时间线

> 抓取某个 X（Twitter）账号主页的最新推文（文本/时间/链接），支持滚动加载。需要浏览器已有 X 登录态。

- ID: `x-user-timeline`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `x.com`, `twitter.com`
- Intents: `social.timeline`, `account.watch`
- Capabilities: `js`, `open_tab`, `waitForTimeout`, `waitForURL`
- 功能指纹: `sha256:df8e5566645b90382a6eda351fc3cfc1f8baa06529ad8bebbb110282f23b811c`

## 输入

- `handle` (string, required): X 用户名（不含 @，如 elonmusk）
- `maxScrolls` (number): 滚动加载轮数（1-10，越多抓得越深）

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

