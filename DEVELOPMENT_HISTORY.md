# ChatGPT Autopilot — development history

This file is the repository-local handoff ledger for material product repairs and release checkpoints. It supplements Git history and the Drive documents `09_ІСТОРІЯ_ЗМІН` and `01_CURRENT_STATUS`. Never treat a status line as acceptance unless the listed evidence gate is actually complete.

## 2026-09-26 — Scenario Work real-run recovery and version integrity

### User evidence
- Supplied installable archive reports version 0.9.19.
- Supplied diagnostic report came from a real 7-chat Scenario Work pool.
- Intended per-chat sequence: startup prompt ×1, continuation ×10, final prompt ×1 = 12 messages.
- Observed: each real ChatGPT Work chat accepted the first prompt, but the extension did not send the second prompt.
- Durable diagnostic state: 0 confirmed sends; SUBMISSION_UNCERTAIN / AMBIGUOUS; repeated RECOVERY_TEXT_ACK_PENDING.
- UI also displayed 1/60 because the 12-message sequence was multiplied by legacy rounds=5.

### Canonical source at start
- Repository: Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension
- main: 372cf294eec087fa7c355d14885140af1ad9f13d
- Last frozen canonical release metadata: 0.9.19.
- The user-supplied 0.9.19 ZIP hash did not match the frozen canonical 0.9.19 installable hash in SOURCE_TRUTH.json, so it is evidence/input rather than source authority.

### Root causes
1. Current ChatGPT Work uses semantic message surfaces not counted by the older acknowledgement selector set. A real Send could consume the composer and create a conversation while verification still saw no canonical user turn, holding the operation in ambiguous recovery.
2. CHAT_CYCLE reused generic rounds-per-generation semantics. That multiplied the prompt sequence even though the product intent is one configured sequence per physical chat.
3. Version identity was duplicated across manifest.json, package.json, package-release.mjs, package-source.mjs, and hardcoded GitHub Actions artifact paths. That allowed materially later development bytes to keep the old 0.9.19 label.

### Repair lanes
- PR #418 / `fix/work-ui-ack-and-five-chat-cycle`
  - previous inspected head: 3fc4dd9303281b9f40480eab7ad2b1e003e04f6c
  - repaired head: fc10ac376255f174e35f5e44b0a5834df746e41a
  - owns Work acknowledgement, shared persistent pool, one-sequence CHAT_CYCLE semantics, migrated persisted pool config, status clarity and regressions.
- PR #420 / `feat/scenario-profile-import-20260925`
  - pre-rebase head: 059c462b7211d9e5d459600eef1f9320ffa6b164
  - rollback branch: `backup/scenario-profile-import-20260926-059c462`
  - reconverged head before release prep: 91097879c3757e753d1484a7407414926f27e9a0
  - owns portable Scenario Work JSON, downloadable 12-message template, import/export and related UI/profile tests.
- Release-prep lane: `release/0.10.0-candidate`
  - stacked on #420.
  - owns unique version identity, release/source packager version authority, dynamic CI artifact naming, candidate changelog/QA and this history ledger.

### Verification state
- #418 exact-head Core / Interaction / UI / Release workflows were queued when last checked.
- #420 exact-head UI / Release workflows were queued when last checked.
- No green result is inferred from queue state.
- No installed-extension Windows/Chrome acceptance has been run from this release-prep lane yet.
- HUMAN_TESTED=false.
- NVDA_VERIFIED=false.
- OWNER_WINDOWS_CHROME_VERIFIED=false.

### Secrets and rollback
- No API keys, OAuth credentials, token.json, cookies, browser profiles, private conversation bodies or private diagnostic text are committed.
- #420 pre-rebase bytes remain recoverable through the backup branch above.
- Frozen 0.9.19 SOURCE_TRUTH.json is intentionally left unchanged until a 0.10.0 candidate is actually built and its hashes/qualification are known.

### Next gate
Qualify the exact 0.10.0 candidate head in GitHub Actions; repair any release-test assumptions that still hardcode 0.9.19; build deterministic Ubuntu and Windows candidates; only then update SOURCE_TRUTH.json with measured 0.10.0 artifact hashes and run the real installed-extension multi-chat acceptance.
