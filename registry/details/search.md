# Google Search

> Search Google and return the top 10 results with title, URL, and snippet.

- ID: `search`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `google.com`, `google.com.hk`, `google.co.jp`, `google.co.uk`
- Intents: `search`, `web.search`
- Capabilities: `fill`, `js`, `open_tab`, `press`, `waitForSelector`
- 功能指纹: `sha256:7292e2457a6434fd9a511b4d485d4164a0c960ac643bef0c7b6879848dac3531`

## 输入

- `query` (string, required): Search query

## 输出

- `count` (number): Number of results returned
- `links` (array): Result list, each with title and url
- `text` (string): Visible text from the result container

## 发现信息

- Keywords: google, search, web search
- Aliases: google, google-search
- BrowserPilot: `>=0.1.0`

## 详细说明

Search Google and return the top 10 results with title, URL, and snippet.

## Category

search

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | string | yes | Search query |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| count | number | Number of results returned |
| links | array | Result list, each with `title` and `url` |
| text | string | Visible text from the result container |

## Region Handling

This template works across regional Google domains (google.com, google.com.hk, google.co.jp, etc.). Regional domains may use `/goto?url=` redirect links instead of `/url?q=`. The template uses `rootSelectors` which triggers `searchResultsExpr()`, properly normalizing relative URLs to absolute URLs via `new URL(href, location.href)`.

## Selector Details

- **Search input**: `textarea[name='q']` (primary), with fallbacks for `input[name='q']`, `input[type='search']`, `input[type='text']`
- **Result container**: `#search`, `#rso`, `#center_col`
- **Link selector**: `a` (default) — targets anchor elements within result containers. The `searchResultsExpr` runtime normalizes `/url?q=` and `/goto?url=` redirect links to absolute URLs.

## Known Limitations

- Google may show CAPTCHA or rate-limit after repeated automated queries
- Video results and featured snippets may not be captured by the standard link extraction
- The `url` field contains the Google redirect URL (`/goto?url=...`), not the final destination URL

## Example

```json
{
  "command": "run_template",
  "args": {
    "id": "search",
    "params": { "query": "BrowserPilot" }
  }
}
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md)

## 权威定义

[`template.json`](../templates/search/template.json)

