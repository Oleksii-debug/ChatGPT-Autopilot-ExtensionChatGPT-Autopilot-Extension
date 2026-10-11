# Incident 11.0.12 — Work DOM send and response-state mismatch

**Recorded:** 2026-10-03 01:33 Europe/Budapest  
**Baseline:** exact published 11.0.11 archive, commit `2bb95b8` recovery checkpoint.  
**Scope:** same owned Chrome tab/window and existing Core send authorization.

## Report evidence

The four supplied Work HTML snapshots show a localized `Надіслати` submit control and a conversation status node with `role=status` and `aria-busy=true`. In two snapshots a draft and Send button coexist while the current conversation is still generating. Stop-button-only detection therefore misses a busy turn and can mistake a draft for readiness. The diagnostic summaries recorded zero or one confirmed sends in several scenario pools; these counters do not establish actual server receipts for unconfirmed operations.

## Changes

- Detect visible `aria-busy=true` response status in the active conversation main area. Ignore hidden status and profile/sidebar activity. This blocks another prompt while a response is still streaming even if the editor already shows Send.
- Permit the already-authorized DOM form submission while the owned tab is backgrounded. Remove the foreground-only requirement and visibility polling which stranded hidden/background scenario tabs. Preserve URL, session, operation, and Core checkpoint validation; never add a second Send after an uncertain effect.
- Keep the configured post-Send dwell. Foreground activation remains best-effort for a positive dwell and for late observation only.
- Diagnostic export now distinguishes Core-persisted DOM and native submit boundaries; these remain diagnostic fields, not user-facing replacement counters.
- Same-document reinjection reuses the release API instance so pending acknowledgement evidence survives reinjection; an actual context reset still begins without in-memory evidence.

## Verification and limitations

Offline Chromium DOM qualification against sanitized copies of the four supplied snapshots: **13/13 passed** (recorded in the preceding execution before the scratch workspace was replaced). Focused Node regression run after restoring the changes: one corrected fixture simulation is pending rerun at recording time. These tests model ChatGPT acknowledgements; they do not submit live prompts, prove server receipt, establish that historical “46 sent” means 46 receipts, or qualify Windows Chrome/NVDA behavior. Do a small supervised live scenario on the target profile before an unattended run.

No automatic retry is added for ambiguous sends. That would risk duplicate prompts. The safe next step for ambiguous results is reconciliation against the exact conversation and operation evidence, without replay.

## Cross-mode audit (2026-10-03)

The regression is visible in Git history: commit `1c3de1e` (11.0.9) added `|| request.requireGenerationAcknowledgement === true` to the background-activation condition. Every managed scenario session sets `scenarioWork.managed = true`; `automatic-executor.request()` then sets `requireGenerationAcknowledgement = true`. Before the change, a real form submitter in a hidden tab could use `requestSubmit` without bringing the OS window forward. After the change, every managed scenario mode could be held waiting for visibility. 11.0.12 removes that visibility prerequisite and keeps the existing durable Core boundary, ownership/window checks, and verification-only recovery.

Cycles, pairs, auditor groups, and auditor pipelines all materialize managed participants as ordinary Core sessions and pass through the same `automatic-executor` phased path (`INSERT_ONLY` → durable Core checkpoint → `SUBMIT_EXISTING` → response verification). The adapter fix therefore applies to each mode. The state planner remains mode-specific: pair affinity, group barriers, and pipeline stages are not bypassed.

The scenario JSON profile importer/exporter accepts all four modes and normalizes each mode's configuration into a fresh stopped scenario. An optional pool preset is intentionally legal only for `CHAT_CYCLE`; pair/group/pipeline participant counts live in their mode-specific config fields instead of a cycle pool. The tests include profile round-trips for all four modes.

Additional validation: 108/108 scenario planner/manager, window-liveness, pipeline, semantic, profile-import/UI, portable-profile, and completion-delay tests passed. Focused send/bridge/runner/reinjection/diagnostics: 205/205. Release qualification suite: 8/8 test files passed after aligning manifest `version_name` with 11.0.12. Chromium snapshot qualification previously recorded 13/13 on the sanitized supplied pages; no live-account send or Windows/NVDA run was performed.

This explains why 10.0 felt better: the later scenario-specific foreground requirement reintroduced an unnecessary OS-window dependency into the DOM form path. Version 11 also accumulated durable coordination, response identity, and window/profile fencing layers; those protect against duplicates and cross-account sends, but made the failure harder to see because status could remain at “inserted” while the final form effect was withheld. The concrete 11.0.9 gate above is the first directly evidenced cause in this incident, not proof that it explains every historical failure.
