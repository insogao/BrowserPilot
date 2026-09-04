# Changelog

## 1.0.0 (2026-09-04)

### Added
- Initial runtime template package for ChatGPT (chatgpt.com)
- ProseMirror editor detection with explicit wait for editor readiness
- Send button selector: `button[data-testid='send-button']`
- Response collection via @chatCollect with stability detection (5s stable)
- Conversation URL verification for follow-up questions
- Big image collection (naturalWidth≥512, naturalHeight≥256)

### Fixed
- Replaces compiled-in fallback which failed to locate send button due to missing editor readiness check
