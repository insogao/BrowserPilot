# 韭研公社搜索

> 在韭研公社（九阳公社）搜索关键词，返回相关文章列表（标题+链接）。需要浏览器已有微信登录态。

- ID: `jiuyangongshe-search`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `jiuyangongshe.com`
- Intents: `search`, `finance.research`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:c7a5fd5fff0413c20264a3032251c518a4856d033290394bf0d26d0eaa2e5fde`

## 输入

- `query` (string, required): 搜索关键词

## 输出

- `count` (number): 
- `links` (array): title/url
- `text` (string): 

## 发现信息

- Keywords: 韭研公社, 九阳公社, jiuyangongshe, 公社搜索
- Aliases: 九阳公社搜索, 韭研公社
- BrowserPilot: `未声明`

## 详细说明

在韭研公社（原韭菜公社，jiuyangongshe.com）搜索关键词，返回文章列表。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 关键词 |

## 前提与边界

- **需要微信扫码登录态**（BrowserPilot 与用户共享 cookie）；未登录时站点内容受限，记 blocked 不绕过。
- 部分文章为积分/权限内容，爬取正文时可能只有摘要——以 `jiuyangongshe-article` 的实际返回为准。
- 单页低频使用。

## 权威定义

[`template.json`](../templates/jiuyangongshe-search/template.json)

