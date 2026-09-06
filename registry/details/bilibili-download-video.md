# B站视频下载

> 下载当前/指定B站视频为单个 MP4 文件（音视频已合成，720P，落盘到浏览器下载目录）。仅下载你有权限访问的内容。

- ID: `bilibili-download-video`
- 版本: `1.0.2`
- 风险: `download`
- 适用站点: `bilibili.com`
- Intents: `download`, `video.download`
- Capabilities: `js`
- 功能指纹: `sha256:ab8fbdce4112015178d9b506dbed28807fc1594d204558df29af86dd82cf5f21`

## 输入

- `url` (url): 视频页链接（bilibili.com/video/BV...）；不填则在当前标签页上下载
- `page` (number): 分P序号，默认 P1

## 输出

- `filename` (string): 落盘文件名（浏览器下载目录）
- `sizeMB` (number): 文件大小
- `quality` (number): 清晰度代号（64=720P）

## 发现信息

- Keywords: bilibili, B站, b站, 下载视频, 视频下载, download video
- Aliases: B站下载, bilibili 下载, 下载B站视频
- BrowserPilot: `未声明`

## 详细说明

下载一个B站视频为**单个 MP4 文件**（音视频已合成），保存到浏览器默认下载目录。
## 功能一览

- **功能**：下载当前/指定B站视频为单个 MP4 文件（音视频已合成，720P，落盘到浏览器下载目录）。仅下载你有权限访问的内容。
- **输入**：`url`(url)、`page`(number)
- **返回**：`filename`、`sizeMB`、`quality`
- **站点**：bilibili.com ｜ **风险**：download ｜ **版本**：v1.0.2



## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | url | 否 | 视频页链接（bilibili.com/video/BV...）；不填则在当前标签页上下载 |
| page | number | 否 | 分P序号，默认 P1 |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| downloaded | boolean | 是否触发下载成功 |
| filename | string | 落盘文件名 |
| sizeMB | number | 文件大小 |
| quality | number | 清晰度代号（64=720P） |

## 能力与限制（2026-09-05 真机验证）

- 走 B站自己的 playurl 接口（`platform=html5&high_quality=1`），**单文件 MP4、音视频已合成**，最高 **720P**。
  1080P 及以上是 DASH 音视频分离流，合成需要 ffmpeg，超出浏览器插件能力范围——本模板不提供。
- 登录态来自浏览器（BrowserPilot 与用户共享 cookie），未登录时清晰度可能降为 360/480P。
- 仅下载当前账号有权限观看的内容；不绕过充电专属、付费、地区限制。此类视频 playurl 会返回结构化错误。
- 文件经页面内 fetch 拉流后由浏览器另存，大于 2GB 拒绝（防内存失控）。
- 番剧（bangumi）、互动视频不支持（playurl 无 HTML5 durl，返回结构化错误）。
- 下载由页面锚点触发，文件出现在系统下载目录（macOS: ~/Downloads）。

## 相关模板

- `bilibili-search`：搜索视频，拿到链接后可交给本模板下载。

## 权威定义

[`template.json`](../templates/bilibili-download-video/template.json)

