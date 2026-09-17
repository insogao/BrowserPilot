# Changelog

## 1.2.0 — 2026-09-17

- 选择器改为中英双语：搜索启动按钮支持「搜索股票、ETF 等」/「Search for stocks, ETFs, and more」，输入框改用 `@focus` 顺序优先（尽情提问/Ask about this or search），修复中文界面下 waitForSelector 超时。

## 1.1.1

- Fixed waitForURL pattern from `google.com/finance` to `finance/beta/quote` to prove navigation to a quote-result route and avoid matching the homepage.
- Added `waitForTimeout` after waitForURL to ensure quote page content renders before extraction.
- Replaced hardcoded company name list with generic extraction from page text (line before price).
- Updated tests/smoke.json with `minResults`, `requiredResultFields` (ticker/company/price/change/url), and `resultUrlIncludes`.
- Updated examples/basic.json with proper assertions.

## 1.1.0

- Fixed search flow for responsive maximized layout: click search launcher button, then fill textarea.
- Corrected search input selector from `input[aria-label]` to `textarea[aria-label="Ask about this or search"]`.
- Replaced broken `a[href*="/finance/quote/"]` extraction with title/URL/text parsing on the quote page.
- Added `links` field to extraction output for smoke runner compatibility.
- Runtime smoke passed in maximized Task Space.

## 1.0.1

- Refactored focus to declarative selectors and submission to Enter.
- Scoped extraction to Google Finance quote links.
- Runtime smoke remains pending after responsive-layout investigation.

## 1.0.0

- Initial Google Finance search template.
