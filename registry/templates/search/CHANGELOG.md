# Changelog

## 1.1.0 — 2026-09-17

- 支持 `limit`（1–100，默认 10）与 `maxPages`；结果不足时通过 `#pnnext` 页内自动翻页（≥1.5s 礼貌间隔 + 抖动），合并去重后返回。

## 1.0.0

- Initial runtime package extracted from compiled-in fallback.
- Added `rootSelectors` to `@results` step so `searchResultsExpr()` normalizes `/goto?url=` links on regional Google domains.
- Added `linkSelector: "h3"` to filter result heading links and exclude non-result links.
- Added region handling for google.com.hk, google.co.jp, google.co.uk.
