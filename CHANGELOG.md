# Changelog

## Unreleased — v0.1 development

### Added

- Initial Manifest V3 Core, accessible options UI, ChatGPT interaction adapter, and deterministic test suites composed from the active production and reliability lanes.
- Options-page and content-script manifest wiring.
- Durable UI command controller with version checks, bounded logs, session lifecycle commands, master pause/resume, and active ChatGPT URL ownership protection.
- Content-script message bridge with fail-closed error sanitization.
- Durable phased automatic executor plus service-worker startup/alarm runtime wiring, still protected by the release gate.
- Deterministic release packager producing the canonical unpacked folder and `ChatGPT-Autopilot-Extension-v0.1.zip` from an explicit product allowlist.
- Release tests proving manifest-resource completeness, minimal package contents, canonical root naming, and byte-for-byte ZIP reproducibility.
- GitHub Actions release-candidate artifact generation.
- Keyboard-only Windows 11/NVDA installation and unpacked-upgrade instructions.

### Changed

- Serialized storage repository updates to prevent lost concurrent revisions.
- Normalized `www.chatgpt.com` conversation URLs to the canonical `chatgpt.com` origin.
- Preserved unresolved operation checkpoints when a session is stopped.
- Runtime safety remains fail closed while `EXECUTION_AVAILABLE=false`; the executor is wired but automatic Send is not released until integrated gates are green.
- Release packaging now replaces the same canonical candidate name instead of creating ambiguous `final`/`fixed`/`new` variants.

### Known incomplete work

- `EXECUTION_AVAILABLE` remains false pending exact integrated production acceptance.
- Current production PRs and composed release gates must converge before v0.1 can be declared ready.
- No human Chrome/Windows 11/NVDA acceptance run has occurred.
- A generated ZIP is a candidate artifact only until the exact candidate SHA passes the release and human acceptance gates.

`HUMAN_TESTED=false`

`NVDA_VERIFIED=false`

`V01_READY=false`
