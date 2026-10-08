# Plan 3 Sections 1–2 — exact-source engineering checkpoint (2026-10-08)

## Authority and selection
- Drive: `3. Третій план`, document `1FgqO_2mbIt3ljvn8GN0hX7G_KZCVkoMqcuTCU6YxViY`.
- GitHub coordination: `AGENTS.md`, `PROJECT_PLAN_INDEX.md`, `MULTI_PLAN_CLOSURE_STATE.md`, `MULTI_PLAN_PARALLELISM_CONTRACT.md`.
- Source: exact 11.0.13 High package `ChatGPT-Autopilot-11.0.13-HIGH-PostSend-Background-FIXED.zip`, SHA-256 `ddf0527d03ca5b68c3b50e96dd3413e2d26afb0b7737ae3f502a3f960ae3c329`.
- Active PR: #656 on `audit/plan3-specialists-subagents-20261008`, based on 11.x PR #654 source commit `ca7062e1f8e47b26d7e024c46bb432d341621dd4`. Stale 0.9.19 main was not used as implementation source.

## Section 1 — Specialist Registry and readiness
- Reused existing trusted resolver, registry, canonical provider binding, policy envelope, dispatch lease and readiness TTL.
- Hardened nested readiness evidence before dispatch: only bounded plain enumerable data; no getter execution, symbol/sparse arrays, cycles, nonfinite values or unbounded strings; reject unexpected inspection fields, fake authority flags and inspection/selection identity mismatches. No second provider, scheduler or authorization authority.
- Production module exact Git blob readback: `b3b0350c144c8495de4a128b11e3aa9a058f796a`.
- Expanded `tests/specialist-provider-dispatch-chronology.test.mjs` with nested accessor/no-secret-leak, sparse arrays, false authority and mismatched inspection cases.
- Local independent focused test source plus earlier 11.0.13 fixtures: six newly authored adversarial tests passed. Confirmed provider callback is not invoked on rejected inputs.

## Section 2 — Subagent topology and delegation recovery
- Reused canonical Orchestration graph/runtime, structure/budget policy, activation ledger and processed event IDs.
- Reproduced a negative case: after an already processed child activation is persisted, topology replay generated its event proposal again; the added regression failed on previous source.
- Repair suppresses proposal when the canonical `processedEventIds` or exact `activationLedger` already records the same event/activation, preserving proposals for as-yet-unprocessed siblings. No second mutation, scheduler, runtime, store, completion or execution authority.
- Production module exact Git blob readback: `79c900a94689a16e268381b51c3134c852d5e1fb`.
- Expanded `tests/subagent-plan3-recovery-fence.test.mjs` with processed-vs-unprocessed durable restart replay checks.
- Regression passed on patched source; ancestor PAUSED denial and exact replay/no-orphan checks preserved.

## Verification and status truth
- Exact source archive checksum verified. GitHub source blobs independently reread and matched locally tested files.
- Local Node 22 combined offline checks: **22/22 PASS**, 0 failures; syntax checks for both modified source modules PASS. Mix of recovered prior Plan 3 fixture probes and new focused tests; **not** a completed exact-PR GitHub Actions result, all-repository acceptance, external verifier certification or physical Windows/NVDA test.
- Existing 11.x specialist UI retains semantic keyboard/NVDA paths; this change adds no novel UI. Physical NVDA verified: **false**.
- Latest checked exact-PR head CI is **QUEUED/PENDING**; no green CI for this patch may be inferred.
- **Section 1: ACTIONABLE / IN_PROGRESS / NOT TERMINAL DONE.**
- **Section 2: ACTIONABLE / IN_PROGRESS / NOT TERMINAL DONE.**
- Blockers: complete exact-head Ubuntu+Windows CI, canonical 11.x branch integration/qualification and post-integration readback; broader readiness and lease/end-to-end acceptance. PR #654 11.x sync remains open and main still advertises 0.9.19. This document does **not** authorize marking either section DONE.

## Closure next action
Qualify Section 1 on exact branch head, converge to canonical synchronized 11.x, verify identity/lease/provider/adversarial and accessible component contracts, read back final integration. Repeat for Section 2 with durable tree and processed-event recovery tests. Mark DONE only after actual evidence; preserve this checkpoint without modifying already-DONE sections or crossing into Section 3.
