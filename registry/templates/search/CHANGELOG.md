# Changelog

## 1.0.0

- Initial runtime package extracted from compiled-in fallback.
- Added `rootSelectors` to `@results` step so `searchResultsExpr()` normalizes `/goto?url=` links on regional Google domains.
- Added `linkSelector: "h3"` to filter result heading links and exclude non-result links.
- Added region handling for google.com.hk, google.co.jp, google.co.uk.
