# 视频语音转文本模板（Groq Whisper）

下载媒体 → 抽音轨降采样（16kHz 单声道）→ 压缩 MP3 48kbps → Groq Whisper 转写。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | url | 是 | **媒体直链**（MP4/MP3/WAV）。注意：是 CDN 直链（playAddr），不是视频页地址 |
| language | string | 否 | 语言代码（zh/en/ja），留空自动检测 |
| model | string | 否 | Whisper 模型（默认 whisper-large-v3-turbo） |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| text | string | 完整转写文本 |
| durationSec | number | 音频时长 |
| audioKB | number | 压缩后音频大小 |

## 前提

- 需要先在**插件弹窗**配置 Groq API Key（gsk_ 开头）——Key 存插件本地，不经过模板/日志。
- 媒体直链获取：B站用 `bilibili-download-video` 同款提取（视频页 `window.__pinia` 的 playAddr）；TikTok 用视频页 rehydration 的 playAddr。直链有时效，提取后尽快转写。
- Groq 音频上限 25MB（MP3 48kbps ≈ 69 分钟音频）；超限返回 audio-too-large。
- 仅限你有权限访问的内容。

## 完整链路示例（B站）

1. `run_template bilibili-favlist` / `bilibili-user-videos` → 拿视频列表
2. 打开视频页 + js 提取 playAddr（或 `bilibili-download-video` 的内部逻辑）
3. `run_template groq-transcribe { url: playAddr }` → 转写文本
