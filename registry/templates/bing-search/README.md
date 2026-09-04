# 必应搜索模板

在必应（www.bing.com）搜索关键词，返回前10条结果（标题+链接+正文摘要）。

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索关键词 |

## 输出字段

| 字段 | 类型 | 说明 |
|------|------|------|
| count | number | 返回结果条数 |
| links | array | 搜索结果列表，每项含title和url |
| text | string | 结果页纯文本摘要（最多6000字符） |

## 适用站点

- https://www.bing.com

## 使用示例

```json
{
  "command": "run_template",
  "args": {
    "id": "bing-search",
    "params": { "query": "BrowserPilot" }
  }
}
```

## 已知限制

- 不支持必应图片/视频/学术等垂直搜索
- 结果页结构变化可能导致解析失败
- 使用 `type` 逐字输入关键词（确保输入事件触发），再用 `press Enter` 提交（`#sb_form_q` 在表单内，Enter 可靠）