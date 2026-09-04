# Changelog

All notable changes to the `gemini-ask` template will be documented in this file.

## [1.0.0] - 2026-09-04

### Added
- Initial runtime template package for Gemini (gemini.google.com/app)
- Quill-based editor detection and text injection via `@write` placeholder
- Send button click with `button[aria-label='Send message']` selector
- Response collection via `@chatCollect` placeholder
- Conversation URL verification via `@verifyConv` placeholder
- Multi-fallback editor selectors for resilience
- Editor readiness wait loop (up to 20s)
- Region restriction detection documented
