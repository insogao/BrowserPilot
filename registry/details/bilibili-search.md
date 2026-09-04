# B站搜索

> 在B站搜索关键词，取回前10条视频结果（标题+链接+页面摘要）。

- ID: `bilibili-search`
- 版本: `1.0.2`
- 风险: `read`
- 适用站点: `bilibili.com`
- Intents: `search`, `video.search`
- Capabilities: `js`, `open_tab`, `waitForSelector`
- 功能指纹: `sha256:202205919c79fc01036a505916a9773c77fedff54fe175e68450ee98cc424ea6`

## 输入

- `query` (string, required): 搜索关键词

## 输出

- `count` (number): 结果条数
- `links` (array): 标题+链接+作者列表
- `text` (string): 页面文本摘要

## 发现信息

- Keywords: bilibili, B站, b站, 视频搜索, bilibili search
- Aliases: B站视频搜索, bilibili 搜索
- BrowserPilot: `未声明`

## 详细说明

在B站（search.bilibili.com）搜索关键词，返回前10条视频结果（标题+链接+页面文本摘要）。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索关键词 |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| count | number | 结果条数 |
| links | array | 每项 {title, url} |
| text | string | 页面文本摘要（≤6000 字符） |

## 说明

- 直接打开 `search.bilibili.com/all?keyword=` 结果页，不经过首页输入框，规避首页改版影响。
- 结果限定在 `.bili-video-card` 卡片内的链接，站内导航/UI 链接天然排除（2026-09 真机验证 42 张卡片结构）。
- 需要 `waitForSelector .bili-video-card` 守卫：搜索页为 SPA 渲染。
- 相关模板：`bilibili-download-video`（下载某个视频为 MP4）。

## 权威定义

[`template.json`](../templates/bilibili-search/template.json)

