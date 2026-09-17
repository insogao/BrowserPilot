# 模板一览（自动生成）

> 由 `npm run registry:build` 生成，**勿手改**。权威定义在各自包内 `template.json`；机器可读目录为 [`registry/catalog.json`](./catalog.json)，逐模板详情在 [`registry/details/`](./details/)。
> 共 31 个模板。

## ai-chat

| 模板 ID | 名称 | 版本 | Tag | 功能 | 风险 | 包目录 |
|---|---|---|---|---|---|---|
| `chatgpt-ask` | ChatGPT 提问 | 1.3.1 | ai | 向 chatgpt.com 提问，等待回复流式结束并回收反馈文本。需要登录 ChatGPT 账号。 | write | [templates/chatgpt-ask/](templates/chatgpt-ask/) |
| `deepseek-ask` | DeepSeek 提问 | 1.3.1 | ai | 向 DeepSeek（chat.deepseek.com）提问，等待流式回复结束并回收回复文本。支持 conversationUrl 续问（同一会话多轮）。需要浏览器已有 DeepSeek 登录态。 | write | [templates/deepseek-ask/](templates/deepseek-ask/) |
| `gemini-ask` | Gemini 提问 | 1.1.0 | ai | 向 gemini.google.com/app 提问，等待回复流式结束并回收反馈文本。需要登录 Google 账号，且所在地区需支持 Gemini 聊天功能。 | write | [templates/gemini-ask/](templates/gemini-ask/) |

## finance

| 模板 ID | 名称 | 版本 | Tag | 功能 | 风险 | 包目录 |
|---|---|---|---|---|---|---|
| `cls-telegraph` | 财联社电报 | 1.1.0 | finance, news | 抓取财联社电报页最新快讯（时间/标题/正文），返回指定条数（默认 20，最多 100；滚动加载）。无需登录。 | read | [templates/cls-telegraph/](templates/cls-telegraph/) |
| `google-finance-search` | Google Finance Search | 1.2.0 | finance, search | Search Google Finance (zh/en UI) for a ticker symbol or company name, return matching quote links with ticker, company, price, and change data. | read | [templates/google-finance-search/](templates/google-finance-search/) |
| `guba-article` | 股吧帖子爬取 | 1.1.0 | finance | 爬取一篇股吧帖子的正文（标题+内容，最多8000字符）。无需登录。 | read | [templates/guba-article/](templates/guba-article/) |
| `guba-list` | 个股吧帖子流 | 1.1.0 | finance | 按股票代码打开个股吧列表页，返回指定条数（默认 30，最多 100）。无需登录。 | read | [templates/guba-list/](templates/guba-list/) |
| `guba-search` | 股吧搜索 | 1.2.0 | finance, search | 在东方财富股吧搜索关键词，返回指定条数帖子（标题+链接+摘要，默认 15，最多 100）。无需登录。 | read | [templates/guba-search/](templates/guba-search/) |
| `jiuyangongshe-article` | 韭研公社文章爬取 | 1.1.2 | finance | 爬取一篇韭研公社文章的标题与正文（最多8000字符）。需要微信登录态；积分/权限内容可能仅返回可见部分。 | read | [templates/jiuyangongshe-article/](templates/jiuyangongshe-article/) |
| `jiuyangongshe-comments` | 韭研公社评论爬取 | 1.1.0 | finance | 爬取一篇韭研公社文章下的评论，返回指定条数（默认 30，最多 100；滚动加载）。需要微信登录态。 | read | [templates/jiuyangongshe-comments/](templates/jiuyangongshe-comments/) |
| `jiuyangongshe-search` | 韭研公社搜索 | 1.3.0 | finance, search | 在韭研公社搜索关键词，返回指定条数文章（标题+链接，默认 15，最多 100）。需要微信登录态。 | read | [templates/jiuyangongshe-search/](templates/jiuyangongshe-search/) |
| `jiuyangongshe-user-timeline` | 韭研公社账号时间线 | 1.1.0 | finance | 抓取韭研公社作者主页的最新文章，返回指定条数（默认 15，最多 100；滚动加载）。需要微信登录态。 | read | [templates/jiuyangongshe-user-timeline/](templates/jiuyangongshe-user-timeline/) |
| `stock-announcements` | 个股公告 | 1.1.0 | finance, news | 按股票代码抓取东方财富最新公告（标题/类型/日期/链接），返回指定条数（默认 20，最多 100）。无需登录。 | read | [templates/stock-announcements/](templates/stock-announcements/) |
| `xueqiu-article` | 雪球文章爬取 | 1.1.0 | finance | 爬取一篇雪球帖子/文章的全文（标题+正文，最多8000字符）。需浏览器已有雪球登录态。 | read | [templates/xueqiu-article/](templates/xueqiu-article/) |
| `xueqiu-comments` | 雪球评论爬取 | 1.0.0 | finance | 爬取一篇雪球帖子下的评论（用户/内容/点赞/时间），支持分页，返回指定条数（默认 20，最多 100）。需雪球登录态。 | read | [templates/xueqiu-comments/](templates/xueqiu-comments/) |
| `xueqiu-search` | 雪球搜索 | 1.3.0 | finance, search | 在雪球搜索关键词，返回指定条数讨论帖（作者+时间+链接+摘要，默认 10，最多 100）。需浏览器已有雪球登录态。 | read | [templates/xueqiu-search/](templates/xueqiu-search/) |
| `xueqiu-user-timeline` | 雪球账号时间线 | 1.1.0 | finance | 抓取雪球用户主页的最新帖子，返回指定条数（默认 10，最多 100；滚动加载直到取够或无法继续）。需雪球登录态。 | read | [templates/xueqiu-user-timeline/](templates/xueqiu-user-timeline/) |

## generic

| 模板 ID | 名称 | 版本 | Tag | 功能 | 风险 | 包目录 |
|---|---|---|---|---|---|---|
| `browserpilot-example-prompt` | 示例 Prompt 模板 | 1.1.0 | ai | 把输入主题整理为一个不执行网页动作的示例提示词。 | read | [templates/browserpilot-example-prompt/](templates/browserpilot-example-prompt/) |

## media

| 模板 ID | 名称 | 版本 | Tag | 功能 | 风险 | 包目录 |
|---|---|---|---|---|---|---|
| `bilibili-download-video` | B站视频下载 | 1.0.2 | video, download | 下载当前/指定B站视频为单个 MP4 文件（音视频已合成，720P，落盘到浏览器下载目录）。仅下载你有权限访问的内容。 | download | [templates/bilibili-download-video/](templates/bilibili-download-video/) |
| `bilibili-favlist` | B站收藏夹列表 | 1.1.0 | video | 列出B站登录用户收藏夹中的视频，返回指定条数（默认 30，最多 100；滚动加载）。需要B站登录态。 | read | [templates/bilibili-favlist/](templates/bilibili-favlist/) |
| `bilibili-user-videos` | B站用户投稿列表 | 1.1.0 | video | 抓取B站用户空间的投稿视频，返回指定条数（默认 30，最多 100；滚动加载）。配合 bilibili-download-video 可逐个下载。 | read | [templates/bilibili-user-videos/](templates/bilibili-user-videos/) |
| `groq-transcribe` | 视频语音转文本（Groq Whisper） | 1.1.1 | video, ai | 转写视频的语音为文本（B站视频页链接或媒体直链）→ 抽音轨压缩为 48kbps 单声道 MP3 → Groq Whisper 转写。需要先在插件弹窗配置 Groq API Key。 | read | [templates/groq-transcribe/](templates/groq-transcribe/) |
| `tiktok-video-download` | TikTok 视频下载 | 1.0.0 | video, download | 下载一个 TikTok 视频为 MP4 文件（页面内拉流落盘到浏览器下载目录）。需要浏览器可访问 TikTok；受限视频返回结构化错误。 | download | [templates/tiktok-video-download/](templates/tiktok-video-download/) |

## search

| 模板 ID | 名称 | 版本 | Tag | 功能 | 风险 | 包目录 |
|---|---|---|---|---|---|---|
| `baidu-search` | 百度搜索 | 1.3.0 | search | 在百度搜索关键词，返回指定条数结果（默认 10，最多 100；不足时自动翻页，页间有礼貌间隔）。 | read | [templates/baidu-search/](templates/baidu-search/) |
| `bilibili-search` | B站搜索 | 1.1.0 | video, search | 在B站搜索关键词，返回指定条数视频结果（标题/作者/链接，默认 10，最多 100；不足时自动翻页）。 | read | [templates/bilibili-search/](templates/bilibili-search/) |
| `bing-search` | 必应搜索 | 1.3.0 | search | 在必应搜索关键词，返回指定条数结果（默认 10，最多 100；不足时自动翻页，页间有礼貌间隔）。 | read | [templates/bing-search/](templates/bing-search/) |
| `google-scholar-search` | Google Scholar Search | 1.3.0 | search | Search Google Scholar for academic papers and return a specified number of results (default 10, up to 100; auto-paginates with polite delays). | read | [templates/google-scholar-search/](templates/google-scholar-search/) |
| `search` | Google Search | 1.1.0 | search | 在 Google 搜索关键词，返回指定条数结果（默认 10，最多 100；不足时自动翻页，页间有礼貌间隔）。 | read | [templates/search/](templates/search/) |
| `search-demo` | Search Demo Template | 1.1.0 | search | 可复制的搜索适配示例：演示运行时模板选择器 + 指定条数/自动翻页。 | read | [templates/search-demo/](templates/search-demo/) |
| `x-search` | X/Twitter 搜索 | 1.2.0 | search, social | 在 X (x.com) 搜索关键词，返回指定条数推文（作者+文本+时间，默认 10，最多 100；滚动加载直到取够或无法继续）。需要登录 X 账号。 | read | [templates/x-search/](templates/x-search/) |

## social

| 模板 ID | 名称 | 版本 | Tag | 功能 | 风险 | 包目录 |
|---|---|---|---|---|---|---|
| `x-user-timeline` | X账号时间线 | 1.1.0 | social | 抓取 X 账号主页的最新推文，返回指定条数（默认 10，最多 100；滚动加载直到取够或无法继续）。需要 X 登录态。 | read | [templates/x-user-timeline/](templates/x-user-timeline/) |

