# Google Scholar Search

> Search Google Scholar for academic papers and return top results with title, URL, and visible text summary.

- ID: `google-scholar-search`
- 版本: `1.2.0`
- 风险: `read`
- 适用站点: `scholar.google.com`
- Intents: `search.academic`, `search.scholar`, `search.web`
- Capabilities: `fill`, `js`, `open_tab`, `press`, `screenshot`, `waitForURL`
- 功能指纹: `sha256:9fa51c12e99fd3086d7af638e547ef872f58a1cfe7bda25af5b8bb5d2f6a96bd`

## 输入

- `query` (string, required): Academic search query (paper title, keywords, author, etc.)

## 输出

- `count` (number): Number of results returned.
- `links` (array): Search results with title and url.
- `text` (string): Visible text from the results container, including snippets.

## 发现信息

- Keywords: google scholar, academic, paper, research, scholar, citation, journal, search
- Aliases: scholar, gs-search, academic-search
- BrowserPilot: `>=0.1.0`

## 详细说明

Search Google Scholar (scholar.google.com) for academic papers and return top results with title, URL, and visible text summary.
## 功能一览

- **功能**：Search Google Scholar for academic papers and return top results with title, URL, and visible text summary.
- **输入**：`query`(string, 必填)
- **返回**：`count`、`links`、`text`
- **站点**：scholar.google.com ｜ **风险**：read ｜ **版本**：v1.2.0



## Input Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | Yes | Academic search query (paper title, keywords, author, etc.) |

## Output Fields

| Field | Type | Description |
|-------|------|-------------|
| count | number | Number of results returned |
| links | array | Search results with title and url |
| text | string | Visible text from the results container, including snippets (max 6000 chars) |

## Applicable Sites

- https://scholar.google.com

## Usage Example

```json
{
  "command": "run_template",
  "args": {
    "id": "google-scholar-search",
    "params": { "query": "deep learning transformers" }
  }
}
```

## How It Works

1. Opens Google Scholar home page
2. Declarative `@focus` selects the search input (`#gs_hdr_tsi`, `input[name=q]`)
3. Fills the query and submits via Enter
4. Waits for results URL (`scholar.google.com/scholar`)
5. Takes a screenshot for visual verification
6. Declarative `@results` collects up to 10 result links from `.gs_rt a` and page text

## Known Limitations

- **Anti-bot protection**: Google Scholar actively detects and blocks automated browser interactions. When detected, it displays a "Sorry..." page with the message: "your computer or network may be sending automated queries." This is the most common failure mode. The template now includes anti-bot detection to fail fast with a clear error message.
- **Captcha**: Google Scholar may present a CAPTCHA after repeated queries. The template stops and reports; it does not attempt to bypass captcha.
- **Rate limiting**: Rapid successive searches trigger temporary blocks. Use bounded waits between queries; do not run parallel searches.
- **Library links**: Some results show `[PDF] from university.edu` or similar library access links. These are not parsed as separate entries; they appear in the `text` field.
- **Login-gated content**: Some papers require institutional login or payment. The template returns the link but cannot access gated full text.
- **Citation counts**: Citation metadata (e.g., "Cited by 123") is not extracted as structured data; it appears in the `text` field only.
- **Advanced search**: No advanced search operators (author:, source:, date range) are supported in this basic template.
- **DOM stability**: Google Scholar DOM may change without notice, which could break selector-based extraction.

## Runtime Smoke Status

**Blocked**: Google Scholar anti-bot protection prevents automated queries from completing.

Runtime verification with `npm run smoke:template -- google-scholar-search` fails because Google Scholar detects the automated browser interaction and returns a "Sorry..." page instead of search results. The template correctly detects this condition and returns a clear error message: "your computer or network may be sending automated queries."

This is a known limitation that cannot be resolved through selector changes or template modifications. The template is working as designed - it will either return search results or a clear anti-bot protection error.

## Replaces

- `search-demo` — for academic use cases specifically

## 权威定义

[`template.json`](../templates/google-scholar-search/template.json)

