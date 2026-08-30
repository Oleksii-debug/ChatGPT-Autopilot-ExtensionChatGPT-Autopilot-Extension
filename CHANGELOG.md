# Changelog

## Unreleased — v0.1 development

### Added

- Initial Manifest V3 Core, accessible options UI, ChatGPT interaction adapter, and deterministic test suites composed from the active production and reliability lanes.
- Options-page and content-script manifest wiring.
- Durable UI command controller with version checks, bounded logs, session lifecycle commands, master pause/resume, and active ChatGPT URL ownership protection.
- Content-script message bridge with fail-closed error sanitization.
- Durable phased automatic executor plus service-worker startup/alarm runtime wiring.
- Deterministic release packager producing the canonical unpacked folder and `ChatGPT-Autopilot-Extension-v0.1.zip` from an explicit product allowlist.
- Release tests proving manifest-resource completeness, minimal package contents, canonical root naming, and byte-for-byte ZIP reproducibility.
- GitHub Actions release-candidate artifact generation.
- Keyboard-only Windows 11/NVDA installation and unpacked-upgrade instructions.
- Configurable Seconds/Minutes presentation for the per-Session retry/backoff used after the exact acknowledgement and temporary failures.
- In-product keyboard/startup help documenting standard controls, no extension-specific global shortcuts, and automatic recovery of RUNNING/RECOVERING Sessions when Chrome starts.

### Changed

- Serialized storage repository updates to prevent lost concurrent revisions.
- Normalized `www.chatgpt.com` conversation URLs to the canonical `chatgpt.com` origin.
- Preserved unresolved operation checkpoints when a session is stopped.
- Production automatic execution is now enabled after exact integrated deterministic acceptance; explicit injected disabled-mode coverage remains for fail-closed recovery tests.
- Release packaging now replaces the same canonical candidate name instead of creating ambiguous `final`/`fixed`/`new` variants.
- Exact rate-limit acknowledgement now returns `RATE_LIMITED` without adapter/Send work and resumes only through the configured durable scheduler deadline.
- The interaction message bridge now auto-acknowledges only the explicitly whitelisted benign ChatGPT “Too many requests” informational dialog (`Зрозуміло` / `Підтвердити` / `Got it`) before continuing on a later scheduled request; Ukrainian wording variants remain gated by a strong rate-limit signature, while unknown, security, payment, and non-whitelisted dialogs remain fail-closed and are never auto-accepted.
- Send-control compatibility now includes Ukrainian `Надіслати`, `Надіслати повідомлення`, `Надіслати запит`, `Відправити`, `Відправити повідомлення`, and `Відправити запит` labels, plus the existing unique composer-submit fallback.

### Known incomplete work

- Real Chrome/live ChatGPT smoke has not yet been completed against the exact enabled packaged candidate.
- No human Windows 11/NVDA acceptance run has occurred.
- A generated ZIP remains a release candidate until the exact candidate passes the remaining human Chrome/Windows/NVDA acceptance gates.

`HUMAN_TESTED=false`

`NVDA_VERIFIED=false`

`V01_READY=false`
