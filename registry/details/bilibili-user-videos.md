# B站用户投稿列表

> 抓取某个B站用户空间的投稿视频列表（标题/BV号/链接），滚动加载。配合 bilibili-download-video 可逐个下载。

- ID: `bilibili-user-videos`
- 版本: `1.0.2`
- 风险: `read`
- 适用站点: `bilibili.com`
- Intents: `media.list`, `account.watch`
- Capabilities: `js`, `open_tab`, `waitForTimeout`
- 功能指纹: `sha256:0364d07658e2f492f855885f0041e80a006e5fceb8cec46c5f334c8bb476ac6b`

## 输入

- `uid` (string, required): B站用户 UID（space.bilibili.com/<uid> 的数字）
- `limit` (number): 最多条数（1-60）

## 输出

- `videos` (array): title/bvid/url

## 发现信息

- Keywords: B站, 用户空间, 投稿, UP主, 时间线
- Aliases: B站UP主, 空间投稿
- BrowserPilot: `未声明`

## 详细说明

抓取某个B站用户空间的投稿视频列表（滚动懒加载已处理）。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| uid | string | 是 | B站用户 UID |
| limit | number | 否 | 最多条数（默认 30，上限 60） |

## 组合用法

列表 → 逐个 `bilibili-download-video`。低频使用，尊重UP主与站点。

## 权威定义

[`template.json`](../templates/bilibili-user-videos/template.json)

