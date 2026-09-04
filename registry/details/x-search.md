# X/Twitter 搜索

> 在 X (x.com) 搜索关键词，返回前10条推文（作者+文本+图片URL+时间）。需要登录 X 账号。

- ID: `x-search`
- 版本: `1.1.0`
- 风险: `read`
- 适用站点: `x.com`, `twitter.com`
- Intents: `search`, `social.search`
- Capabilities: `js`, `open_tab`, `screenshot`, `waitForSelector`, `waitForURL`
- 功能指纹: `sha256:8253732a51e0c8fc11cb5d551fecb26c29a4524f84574e7b818a8565a9434f24`

## 输入

- `query` (string, required): 搜索关键词

## 输出

- `count` (number): 返回推文条数
- `tweets` (array): 推文列表，每项含user、text、time、imgs（图片URL列表，需登录才能查看）

## 发现信息

- Keywords: X, Twitter, 推特, 搜索, search, tweet
- Aliases: x-search, twitter-search
- BrowserPilot: `>=0.1.0`

## 详细说明

在 X (x.com) 搜索关键词，返回前10条推文（作者+文本+图片URL+时间）。

## 前置条件

- **必须登录 X 账号**。未登录时模板会检测到登录墙并返回 `login_required` 错误。
- Chrome 窗口不能处于最小化状态（框架会自动恢复窗口，但 X 的懒加载可能需要滚动触发）。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索关键词 |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| count | number | 返回推文条数 |
| tweets | array | 推文列表，每项含 user、text、time、imgs |

### tweets 结构

| 字段 | 类型 | 说明 |
|------|------|------|
| user | string | 发推用户昵称 |
| text | string | 推文文本（最多500字符） |
| time | string | 发布时间（ISO 8601） |
| imgs | array | 图片 URL 列表（最多4张，需登录才能查看原始图） |

## 执行流程

1. `open_tab` — 打开 X 搜索页
2. `waitForURL` — 等待导航到 `x.com/search`
3. `js` — 检测登录墙、验证码、人机验证（2秒后检测，避免误报）
4. `js` — 滚动触发虚拟列表懒加载（最多6次，每次800px，间隔800ms）
5. `waitForSelector` — 确认 `article[data-testid=tweet]` 可见
6. `screenshot` — 截图确认推文已加载
7. `js` — 提取推文数据（带1次重试）

## 已知限制

- 不支持搜索结果分页
- 图片返回 URL，**不自动下载**；需要原始图片时请使用 `download_resource`
- X 的虚拟列表可能在极端情况下不渲染推文（如网络极慢或被限流）
- 不支持视频内容提取
- Chrome 最小化时可能触发渲染节流；框架会自动恢复窗口，但建议在前台运行

## 错误检测

模板会检测以下状态并返回明确错误：

| 原因 | 说明 |
|------|------|
| `login_required` | 未登录 X 账号，出现登录弹窗 |
| `captcha` | 检测到验证码（reCAPTCHA / Arkose） |
| `verification` | X 要求手机/邮箱验证 |

## 适用站点

- https://x.com
- https://twitter.com

## 使用示例

```json
{
  "command": "run_template",
  "args": {
    "id": "x-search",
    "params": { "query": "AI" }
  }
}
```

## 权威定义

[`template.json`](../templates/x-search/template.json)

