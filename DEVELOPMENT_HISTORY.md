# ChatGPT Autopilot — development history

## 2026-09-26 — Scenario pool starts survive closing the options page

- Found a separate real launch defect: the Scenario UI previously started pool members in a JavaScript loop with setTimeout between START commands. Closing the options page partway through could strand the remaining slots STOPPED; delayed Core execution could bunch physical first sends after that UI timer.
- Replaced this with one CREATE_SCENARIO_CHAT_POOL command using autoStart=true and staggerSeconds=0..60. The manager persists all slots as RUNNING in one store update, records each slot's initialStartAt, and schedules starts through its existing background alarm. The first launch time and pool-specific spacing survive service-worker restart. A delayed wake releases one overdue initial slot, then waits the requested gap before the next, avoiding a catch-up burst. Explicit physical Send timing still depends on Core and Chrome; installed-browser confirmation remains outstanding.
- Added a seven-chat regression: options page closes after one command, manager restarts, at t+30s only two chats have launched, repeated wake at the same time launches no duplicate, then one more launches at each 10s boundary until seven active chats. Existing five-slot 17-turn, three-slot 10-turn/50-replacement and shared budget regressions remain green; Work interaction 11/11 and current UI 32/32 were also verified locally on relevant source.
- No Orchestration changes. This source-level checkpoint is not a claimed installed Chrome PASS.

## 2026-09-26 — Seven-chat Scenario first-send stall: diagnostic-to-code analysis

- Owner's 0.9.19 report at 23:19:55 UTC: seven Scenario CHAT_CYCLE sessions all RECOVERING with zero confirmed sends; repeated RECOVERY_TEXT_ACK_PENDING. Safe diagnostics said messagesBefore=0, messagesAfter=1, composer empty, mainExactMatches=0, hidden tab. The first physical Send appeared, but exact operation-bound user-message acknowledgement failed. Core therefore never entered response observation and Scenario could not advance to prompt two.
- The attached 0.9.19 adapter searched historical author-role/test-id/article nodes. The supplied ChatGPT Work HTML represents user messages with data-user-message-bubble="true" inside keyed units and has none of those old role/article markers. A cleared composer and new chat URL alone are insufficient to confirm the exact Send.
- Pilot 10 already introduced Work-bubble acknowledgement. This repair chooses Work bubbles as the sole message units when present, reads the precise whitespace-pre-wrap prompt body to exclude surrounding controls, and recognizes a keyed assistant unit ending :assistant when it contains the semantic assistant markdown body. This strengthens Send confirmation and assistant completion before the second prompt.
- Scenario manager code review: completed assistant response marks the same CHAT_CYCLE participant READY, increments the step, preserves chat URL/Core Session, and schedules each pool slot independently. Completed sequence retires that chat and consumes one replacement from the shared budget; there is no all-seven completion barrier.
- Evidence boundary: old diagnostic proves the installed 0.9.19 stall, not an installed Pilot 10 success. Supplied HTML captures thinking but no completed assistant reply; keyed-assistant fallback remains to be verified in installed Chrome. At the owner's explicit request no tests were run for this checkpoint. No orchestration code was changed; ambiguous effects never trigger blind resend.

Additional evidence on this Work-UI repair: user and assistant Work units are restricted to the main conversation surface. The user bubble text is extracted from its prompt body; sidebar copies and action controls are ignored. Focused interaction regressions: 11/11 passed including second/third Send, sidebar exclusion and keyed assistant reply. Scenario Core: five chats ×17 and three uneven chats ×10 with 50 replacements plus shared budget 3/3 passed. Scenario UI/profile: 17/17 passed. These are deterministic source-level checks; installed Pilot 10 Chrome acceptance remains unverified. One copied historical UI options-contract test still expects deleted tutorial prose and orchestration-specific copy (29/32); the current exact-head GitHub UI gate is authoritative for that obsolete fixture.

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


## 2026-09-26 04:43 Europe/Bratislava — High-effort reliability assertion repair

### Problem
- Exact head `9125a84c59718ad27f565bb50c94bb5443fa93f1` had Core, Interaction and UI workflows PASS, and the Windows release package gate PASS.
- Linux/package reliability still failed in `agentic-multisession-matrix.test.js`.
- The fixture had learned the new `ENSURE_HIGH_EFFORT` mode, but a legacy pre-branch assertion still required every mode except `CHECK_ONLY` to carry the task prompt.
- `ENSURE_HIGH_EFFORT` intentionally carries an empty prompt because effort is proven before insertion, so the fixture threw before reaching its High-effort handler.

### Repair
- Commit `f30e8f45bcc2aaa5675ecfc70001acda1524f9be` excludes both `CHECK_ONLY` and `ENSURE_HIGH_EFFORT` from the prompt-payload assertion.
- Product runtime and fail-closed High enforcement are unchanged.

### Verification state
- Previous head evidence remains: Core PASS; Interaction PASS; UI PASS; Windows release gate PASS.
- Exact post-repair CI on the current head is authoritative and must be checked before final release delivery.

## 2026-09-26 05:05 Europe/Bratislava — Scenario Work five-slot truth and lifecycle

### Owner report and source
- Owner's installed 0.9.19 diagnostic recorded seven Scenario chat sessions in RECOVERING / AMBIGUOUS with zero confirmed sends after their first visible message; subsequent prompts never launched. This evidence predates Pilot 10 and does not prove the same defect in current source.
- Based on canonical Pilot 10 PR #422 head `05f103814fdadfe17ee250326700415f192a396a`; no orchestration code changed.

### Repair and verification
- Scenario state now obtains confirmed Send counts from the Core session and durable retired counts. The UI labels confirmed sends separately from the next prompt position; an ambiguous click does not advance the confirmed count.
- Added a Core-gated five-slot 17-turn regression: independent initial slots, turns 2–17 in the same conversation URL, service-worker restart, single-slot retirement and replacement, old-session disabling despite a temporary tab-close failure, and other slots unchanged. Replaced the stale legacy direct test entry point with this current contract.
- Focused tests: 12/12 passed, including Work second/third prompt recognition, shared replacement budget after restart, three-slot 50-replacement load, and the new five-slot lifecycle. These are simulated deterministic tests, not installed-extension E2E.
- REAL_EXTENSION_E2E=BLOCKED: local Chrome/Chromium with MV3 load-unpacked is unavailable in this execution environment; cloud browser does not expose local extension installation. OWNER_WINDOWS_CHROME_VERIFIED=false.
- GitHub commit/CI/ZIP identity to be filled by the succeeding material checkpoint; do not claim release PASS from an in-progress run.

## 2026-09-26 13:50 Europe/Bratislava — Current model-picker slider blocker

- Read live chatgpt.com model picker in user's secondary profile. Medium status 2/3 and High status 3/3 were observed after ArrowRight. No prompt sent. Adapter now verifies that semantic slider before insertion; 22/22 focused tests passed. Commit 22ccec3dc0d15b5e45088e786c225dc3ecfa74c9.

## 2026-09-26 14:00 Europe/Bratislava — Simplified Sessions insertion stall

- Owner provided two fresh 0.9.19 reports at 11:47 UTC. `трейд.` has cumulative confirmed send count 74; recent 1,000 event slice has 109 INSERTION_NOT_PROVEN retry events and one confirmed Send. `спорт.` has cumulative 112; recent slice has 107 retries and three confirmed Sends. These are old installed-version observations; they do not prove behavior of Pilot 10.
- For both, CHECK_ONLY frequently returns READY, then INSERT_ONLY reports observedLength > expectedLength, equal normalized lengths, normalizedMatch=no. Thus the configured two-minute schedule is not the current bottleneck in the supplied slice; repeated failed exact insertion prevents Send. Logs omit prompt text, so the exact differing character(s) cannot be determined.
- Pilot 10 now attempts one alternate DOM paragraph/input replacement after a failed insertion proof, waits for two consecutive exact editor observations, then allows the normal PREPARE_SEND gate. If editor model remains different, it still fails closed. Safe diagnostic adds compactMatch/nonWhitespaceMatch to separate whitespace reflow and changed characters next time.
- Focused 28/28 tests PASS, including malformed long prompt recovered and model mismatch never sent; physical MV3 E2E remains blocked. This is a candidate repair pending installed Chrome verification.
- Integration correction: the Core accepts insertion proof only under its existing `INSERTION_TEXT_PROVEN` contract. The repaired path now returns that code with `repair=alternate` in safe diagnostics; otherwise Core would have retried forever despite Interaction proving the draft.

## 2026-09-26 14:10 Europe/Bratislava — Long-run test models aligned with Pilot 10

- Four older long-run transport fixtures omitted the new ENSURE_HIGH_EFFORT phase. The two-hour ordinary test therefore reported zero sends despite no evidence of a production failure. The fake transport now confirms High as a real adapter would.
- Two-hour cadence regression passes: approximately 60 verified sends in two virtual hours, including an ambiguous Send near turn 30. Diagnostic-derived single-session (>200 sends) and eight-hour six-session regressions also pass.
- The mixed-runtime fixture still described a one-step Scenario Work chat but expected four completed turns; Pilot 10's CHAT_CYCLE correctly executes each configured step once. The fixture now defines eight distinct steps and preserves the same /c/ URL after first Send. Mixed 20-minute run passes across Ordinary Sessions, Scenario Work, Browser Agent and Orchestration simulation, including manager restart and tab-close faults. No production Orchestration code was edited.
- The 12-combination exhaustive fixture also treated ENSURE_HIGH_EFFORT like a prompt-bearing Send phase and held all 36 tasks at zero progress for many simulated retries. It now exempts the pre-insertion phase from prompt equality and confirms High. The matrix passes in 13 seconds; this repaired test harness is a prerequisite for meaningful full-suite CI evidence.

## 2026-09-26 14:20 Europe/Bratislava — Qualification and Mistral Agent handoff

- Full local `npm test` on the current source tree: 3,225/3,225 PASS across 16 groups, zero failures. Deterministic release candidate ZIP built locally; installed Chromium test blocked because /usr/bin/chromium is absent. GitHub exact-head Core PASS; other workflows queued at checkpoint.
- The owner’s Drive Mistral provider document records an active Free workspace and an API key. The secret was neither copied into the repository nor sent to any provider during this work. Windows Gateway already supports a Mistral preset, per-provider DPAPI key file, origin binding, model discovery, and AI Router routes for Browser Agent.
- Fixed the Models page Gateway status to show each named endpoint (Mistral included) and whether its key is loaded; previously only an aggregate compatible-key flag and indistinguishable provider names were displayed. Added a concise Windows setup sequence to the Gateway README. UI 81/81 and Mistral/router focused 29/29 PASS. Live owner Windows Gateway and API acceptance remain unverified.

## 2026-09-26 14:28 Europe/Budapest — First archive delivered; Agent draft work continues

- Owner explicitly requested the archive now and continued Agent work afterward. Delivered the existing deterministic `ChatGPT-Autopilot-10.0.0.zip`, SHA256 `168920e99d1e966e3b88c40b61e3464429f93e3809dc42dbf4ea7d7b95918054`, 4.1 MB, from the Pilot 10 candidate with Simplified Sessions insertion recovery and Scenario Work follow-up fixes. ZIP integrity passed. Saved the same bytes to Drive file `1bxYc28q5PT3RVda_ehx2pcb0U9mqFRNb`. Installed Chrome behavior is not yet proven; this is a candidate for owner testing.
- Subsequently added versioned Agent draft JSON import/export. The importer rejects extra state/credential fields and only fills the goal/policy form, without Core creation or auto-start. The periodic Agent status refresh preserves imported draft policy until a job is selected or launched. The originally delivered archive remains unchanged; these later Agent changes require a future build.
- New draft parser tests 2/2, UI 81/81 and release 22/22 PASS. No production Orchestration changes. Windows Mistral Gateway/API readiness still needs owner machine verification.
- Agent routing audit: Core merges per-job provider/model overrides into legacy slots, but with any configured AI route pool the orchestrator selects route candidates from that pool and passes their endpointId to Gateway. The Agent page now states this precedence next to its fields; Mistral must be configured as a global route with endpoint ID `mistral`. This UI note follows the first delivered ZIP.
