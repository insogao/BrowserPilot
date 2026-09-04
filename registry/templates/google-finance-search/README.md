# Google Finance Search

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
