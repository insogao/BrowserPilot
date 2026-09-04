# B站搜索模板

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
