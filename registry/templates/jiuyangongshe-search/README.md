# 韭研公社搜索模板

在韭研公社（原韭菜公社，jiuyangongshe.com）搜索关键词，返回文章列表。
## 功能一览

- **功能**：在韭研公社（jiuyangongshe.com，原韭菜公社）搜索关键词，返回相关文章列表（标题+链接）。需要浏览器已有微信登录态。
- **输入**：`query`(string, 必填)、`sort`(string)
- **返回**：`count`、`links`、`text`
- **站点**：jiuyangongshe.com ｜ **风险**：read ｜ **版本**：v1.2.0



## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 关键词 |

## 前提与边界

- **需要微信扫码登录态**（BrowserPilot 与用户共享 cookie）；未登录时站点内容受限，记 blocked 不绕过。
- 部分文章为积分/权限内容，爬取正文时可能只有摘要——以 `jiuyangongshe-article` 的实际返回为准。
- 单页低频使用。
