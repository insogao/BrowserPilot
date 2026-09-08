# TikTok 视频下载模板

下载一个 TikTok 视频为 MP4 文件（含音频），保存到浏览器下载目录。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | url | 是 | 视频页链接（tiktok.com/@user/video/<id>） |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| downloaded | boolean | 是否触发下载成功 |
| filename | string | 落盘文件名 |
| sizeMB | number | 文件大小 |
| durationSec | number | 视频时长 |

## 说明与限制

- 数据源为视频页内嵌的 rehydration 数据（最高码率 playAddr），页面上下文带 cookie 拉流（2026-09-09 真机验证 206 拉流正常）。
- 仅下载公开可访问的视频；私密/受限视频返回结构化错误（statusCode 10204 等），不做绕过。
- TikTok 官方账号（@tiktok 等）的部分视频有地区限制，会返回 restricted 错误——换普通用户的视频即可。
- 需要浏览器可访问 TikTok；IP/地区被 TikTok 屏蔽的环境无法使用。
