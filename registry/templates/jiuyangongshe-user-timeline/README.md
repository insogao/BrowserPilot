# 韭研公社账号时间线模板

抓取某个公社作者主页的最新文章列表。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| uid | string | 是 | 作者主页 `/u/<hash>` 中的 hash |
| limit | number | 否 | 最多条数（默认 15） |

## 组合用法

文章链接交给 `jiuyangongshe-article` 爬正文、`jiuyangongshe-comments` 爬评论。
