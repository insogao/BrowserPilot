# Google Finance Search

> Search Google Finance for a ticker symbol or company name, return matching quote links with ticker, company, price, and change data.

- ID: `google-finance-search`
- 版本: `1.1.0`
- 风险: `read`
- 适用站点: `google.com`
- Intents: `finance.search`, `finance.quote`, `finance.lookup`
- Capabilities: `click`, `fill`, `js`, `open_tab`, `press`, `waitForSelector`, `waitForTimeout`, `waitForURL`
- 功能指纹: `sha256:f2e102ec94288f0346d959a72f6216333fca3bb2ffb122c54f199854f0927c11`

## 输入

- `query` (string, required): Ticker symbol (e.g. AAPL) or company name (e.g. Apple)

## 输出

- `count` (number): Number of quote results returned.
- `results` (array): Quote results, each with ticker, company, price, change, and url.
- `text` (string): Visible text from the results page (max 6000 chars).

## 发现信息

- Keywords: google finance, stock, ticker, quote, finance, investing
- Aliases: gfinance, google-finance, stock-search
- BrowserPilot: `>=0.1.0`

## 详细说明

Search Google Finance for a ticker symbol or company name. Returns matching quote links with ticker, company, price, and percentage change.

## Input Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| query | string | Yes | Ticker symbol or company name |

## Output Fields

`count`, `results` (ticker/company/price/change/url), and visible page `text`.

## Supported Site

- `https://www.google.com/finance`

## Runtime Smoke Status

Passed (2026-09-04). Maximized Task Space, query "MSFT" returned ticker, company, price, change, and URL. Company-name query "Apple" also verified.

## Limitations

- Google Finance uses responsive and experimental layouts; search controls can move or collapse at narrow viewport sizes.
- Region, language, market hours, and exchange may change visible fields.
- Quotes may be delayed. This template is informational and not financial advice.

## 权威定义

[`template.json`](../templates/google-finance-search/template.json)

