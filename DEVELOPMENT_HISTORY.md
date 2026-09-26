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
- OWNER_WINDOWS_CHROME_VERIFIED=false.

### Secrets and rollback
- No API keys, OAuth credentials, token.json, cookies, browser profiles, private conversation bodies or private diagnostic text are committed.
- #420 pre-rebase bytes remain recoverable through the backup branch above.
- Frozen 0.9.19 SOURCE_TRUTH.json is intentionally left unchanged until a Pilot 10 candidate is actually built and its hashes/qualification are known.

### Next gate
Qualify the exact Pilot 10 candidate head in GitHub Actions; repair any release-test assumptions that still hardcode 0.9.19; build deterministic Ubuntu and Windows candidates; only then update SOURCE_TRUTH.json with measured 0.10.0 artifact hashes and run the real installed-extension multi-chat acceptance.

## 2026-09-26 — Daily Pilot identity policy

- User-facing builds use one whole-number Pilot identity per development day.
- 2026-09-26 is Pilot 10. Same-day fixes do not create 10.1/10.2/etc.; only the archive timestamp changes.
- Friendly archive format: `10 Пілот HHMM DDMM.zip`, timestamped from the exact source commit in Europe/Bratislava.
- The next development day advances to the next whole Pilot number.
- Chrome/npm technical constraints use `10.0.0`; manifest `version_name` exposes `10` as the human-facing release number.
- This file is the concise English technical handoff ledger; append material changes with date/time, exact SHA, problem, repair and verification state.
- Drive history mirrors material checkpoints; user-facing archives do not carry parallel historical release names.

## 2026-09-26 — High-effort pre-insert gate and interaction regression repair

### Requirement
- Every automatic ChatGPT prompt must run with reasoning effort High or higher.
- The extension must verify/select effort before it inserts the prompt, not after Send.
- Extra High satisfies the policy and must not be downgraded.

### Implementation
- Added replay-safe `ENSURE_HIGH_EFFORT` between `CHECK_ONLY` and `INSERT_ONLY`.
- Added semantic detection for direct thinking/reasoning controls and model-picker layouts.
- High selection is re-verified; missing/ambiguous/unproven controls fail closed with zero prompt insertion and zero Send.
- Picker cleanup runs on failed proof paths.
- Fixed inherited #418 nested-user-message acknowledgement regression by keeping the established body selector query separate from the new Work user-bubble query.

### Verification checkpoint
- Implementation/test checkpoint before this ledger commit: `4c6d654314731c8f13c3c363a5b84145aa77b09d`.
- The first #422 Interaction CI exposed two failures: Ukrainian `Середній` normalization and inherited #418 nested-body acknowledgement.
- Ukrainian normalization now uses NFKC so Cyrillic `й` is preserved.
- Nested-body acknowledgement selector compatibility is repaired.
- Exact post-repair CI remains authoritative; no PASS is claimed until terminal success.

### Integration authority
- PR #422 is the only final Pilot 10 integration/package target.
- Source PRs #418/#420 and closed #421 are provenance only.


## 2026-09-26 03:54 Europe/Bratislava — Pilot 10 CI repair and live-main convergence

### Problem
- High-effort enforcement changed the intentional executor sequence, while older deterministic fixtures still modeled CHECK_ONLY -> INSERT_ONLY.
- Owner-requested concise UI removed tutorial/help prose, while older UI tests still required those paragraphs and aria-describedby targets.
- Release tests still contained stale 0.9.19/version-boundary assumptions.
- Standalone CHAT_CYCLE tests still expected a manufactured second generation, contrary to the one-sequence-per-physical-chat contract.
- Pilot 10 was 13 commits behind live main because parallel workers had landed native filesystem/companion work.

### Repair
- Updated Core/reliability/parallel fake transports to model CHECK_ONLY -> ENSURE_HIGH_EFFORT -> INSERT_ONLY without weakening product fail-closed behavior.
- Updated UI contracts to require native controls and concise status while forbidding field-help/notice/tutorial prose.
- Scenario import reports a short per-chat message count dynamically.
- Version tests derive technical identity from package.json / manifest.version_name; Unicode Pilot README boundary fixed.
- Release security fixture now carries daily Pilot version_name so the forbidden gateway runtime-state check reaches its intended assertion.
- Standalone CHAT_CYCLE manager tests now assert one physical sequence and no automatic replacement generation.
- Copied exact current-main blobs for the six disjoint native filesystem/companion files and tests, then merged current-main ancestry without force-push.

### Verification
- Pre-main-convergence repair head 27e6e92d82161e5c36581889e43c2d8f6c1badf1: Core deterministic tests SUCCESS.
- Interaction High-effort suite had already passed on the preceding canonical Pilot 10 implementation.
- Main convergence head 42fb45f03cd074937c35625a6460669b06e688a2: behind current main = 0, merge-base = b7cf6dd3e505a574b52d3409aa79f48a64953c59.
- Full exact-head UI / Interaction / Linux+Windows release qualification remains authoritative; queued is not PASS.
- OWNER_WINDOWS_CHROME_VERIFIED=false.


## 2026-09-26 04:20 Europe/Bratislava — Pilot 10 release-gate reliability harness repair

### Problem
- Exact head `ccb4e27a0f5608bc54e0b1925dffef22ebc5788d` had Core, Interaction and UI workflows green.
- Release package qualification had one remaining failure in `agentic-multisession-matrix.test.js`.
- The product executor correctly required `CHECK_ONLY -> ENSURE_HIGH_EFFORT -> INSERT_ONLY`, but this reliability fake transport still implemented the older sequence and rejected `ENSURE_HIGH_EFFORT`, preventing four one-pass Sessions from terminating.

### Repair
- Added explicit `ENSURE_HIGH_EFFORT` support to the reliability transport fixture.
- Fixture returns deterministic READY evidence with `effortLevel=high` and `EFFORT_HIGH_CONFIRMED`.
- No product bypass or downgrade of the High-effort gate was introduced.

### Verification
- Repair commit: `18aa6f0e6231fcb424ecba027e6e88c7a65180e8`.
- Previous exact-head evidence: Core SUCCESS; Interaction SUCCESS; UI SUCCESS; Windows release package gate SUCCESS; Linux/package job blocked only by this reliability harness failure.
- Exact post-repair Actions remain authoritative; no final release PASS or installed-Chrome claim until terminal CI and owner acceptance.
