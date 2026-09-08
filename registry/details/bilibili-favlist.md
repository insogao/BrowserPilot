# B站收藏夹列表

> 列出B站登录用户收藏夹中的视频（标题/BV号/链接），配合 bilibili-download-video 可批量下载自己收藏的内容。需要B站登录态。

- ID: `bilibili-favlist`
- 版本: `1.0.3`
- 风险: `read`
- 适用站点: `bilibili.com`
- Intents: `media.list`, `video.download`
- Capabilities: `js`, `open_tab`
- 功能指纹: `sha256:79b935d4615139c25a8c045afa14e1d7811bf4b5713b41c85771b98ea4215280`

## 输入

- `mid` (string): B站用户 mid；不填则用当前登录账号
- `limit` (number): 最多条数

## 输出

- `videos` (array): title/bvid/url

## 发现信息

- Keywords: B站, 收藏夹, favlist, 批量下载
- Aliases: B站收藏, 收藏夹下载
- BrowserPilot: `未声明`

## 详细说明

列出B站登录用户收藏夹里的视频（标题、BV号、链接）。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mid | string | 否 | B站用户 mid；不填=当前登录账号 |
| limit | number | 否 | 最多条数（默认 30） |

## 组合用法（批量下载自己收藏的内容）

`bilibili-favlist` 拿到列表 → 外部 Agent 逐个调 `bilibili-download-video { url }`。批量大小自己控制（建议 ≤10/次，低频）。

## 边界

- 需要B站登录态；仅限用户自己可见/收藏的内容，不绕过权限。
- 收藏夹文件夹的细分选择（只下某个文件夹）暂不支持——列表页返回全部收藏，Agent 可按标题/顺序过滤。

## 权威定义

[`template.json`](../templates/bilibili-favlist/template.json)

