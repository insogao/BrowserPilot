# Changelog

## 1.2.0

- Removed `waitForSelector` step that caused timeouts when anti-bot protection was detected.
- Template now correctly detects and reports anti-bot protection with clear error message.
- Updated README to document anti-bot protection as primary failure mode.
- Added runtime smoke status documentation.

## 1.1.0

- Refactored to declarative `@results` with `rootSelectors`/`linkSelector`/`minResults`/`limit`/`textLimit`.
- Added `waitForSelector` for `#gs_res_ccl` between URL wait and result extraction.
- Added `screenshot` step for visual verification of results page state.
- Removed monolithic inline JS extraction; snippets are captured in the `text` field.
- Fixed `discovery.replaces` to reference `search-demo` for academic use.

## 1.0.0

- Initial version: Google Scholar academic search template.
- Declarative `@focus` selectors for search input (`#gs_hdr_tsi`, `input[name=q]`).
- Enter key submission with `waitForURL` for result page.
- Custom inline JS for result extraction with snippet fields.
- Returns up to 10 results with title, URL, and snippet text.
- Known limitations documented: captcha, rate-limit, library links, login-gated content.
