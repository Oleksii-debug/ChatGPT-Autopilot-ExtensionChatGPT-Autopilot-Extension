# Changelog

## Unreleased — v0.1 development

### Added

- Initial Manifest V3 Core, accessible options UI, ChatGPT interaction adapter, and deterministic test suites composed from the active A2, A3, A4, and A5 lanes.
- Options-page and content-script manifest wiring.
- Durable UI command controller with version checks, bounded logs, session lifecycle commands, master pause/resume, and active ChatGPT URL ownership protection.
- Content-script message bridge with fail-closed error sanitization.
- Runtime integration tests and keyboard-only unpacked installation instructions.

### Changed

- Serialized storage repository updates to prevent lost concurrent revisions.
- Normalized `www.chatgpt.com` conversation URLs to the canonical `chatgpt.com` origin.
- Preserved unresolved operation checkpoints when a session is stopped.

### Known incomplete work

- The automatic Core execution loop is not yet connected to the content adapter's durable insert/pre-send/submit/verify phases.
- No human Chrome/NVDA acceptance run has occurred.
- No release ZIP is qualified.
