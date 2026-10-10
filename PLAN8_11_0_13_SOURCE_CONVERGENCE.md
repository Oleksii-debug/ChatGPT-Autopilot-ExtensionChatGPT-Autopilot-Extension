# Plan 8 — 11.0.13 High source convergence (candidate; not terminal DONE)

Source archive: `ChatGPT-Autopilot-11.0.13-HIGH-PostSend-Background-FIXED.zip`, Google Drive ID `1HHd4rNxf7Hlt0RqRzoBUX3M0JGF3usW2`.
Audited SHA-256: `ddf0527d03ca5b68c3b50e96dd3413e2d26afb0b7737ae3f502a3f960ae3c329`, 308 archive entries with CRC verified by earlier source baseline audit.
Exact Git 11.0.13 High source head: `ca7062e1f8e47b26d7e024c46bb432d341621dd4`, original PR #654, manifest/package version 11.0.13.
Main source ancestor before merge candidate: `2000dd3571323f7c98c6fb67c9d4aa9ff395897f`, manifest/package 0.9.19. Main coordination registries are intentionally preserved.

Source method: 2-parent git commit on live main and exact 11.x source head; overlay 282 divergent source/test/companion/config/history files using immutable Git blob SHAs, 794 selected source blobs assessed. Retain 57 main-only source/test files including non-conflicting earlier contributions. Existing binary release ZIP files remain in Git history, not duplicated in the new main tree. No other Drive plan was changed.

Gate state at candidate creation: SECTION 1 IN_PROGRESS / NOT TERMINAL DONE; SECTION 2 WAITING_UPSTREAM / NOT TERMINAL DONE. This source integration candidate is not a passing test, release, or physical Windows/NVDA claim. Required: exact-head Ubuntu/Windows/Chrome/release negative and recovery qualification, CI success or explicit defect repairs, main integration readback, then dependent Plan 1–7 convergence into the same source line. Plan 5 is deferred by owner but mandatory for the final whole-product gate.

Provenance is based on prior exact archive audit and existing #654 package SHA evidence; this operation itself did not recompute the raw ZIP SHA-256.

## 2026-10-10 exact-head S1 compatibility checkpoint — 3e837a3c

Status: SECTION 1 ACTIONABLE/IN_PROGRESS/NOT TERMINAL DONE; SECTION 2 WAITING_UPSTREAM/NOT DONE. This file is a scoped evidence mirror, not permission to merge failed tests or a substitute for the shared MULTI_PLAN_CLOSURE_STATE.md registry. Scope exclusively Plan 8.

Repair history on the existing plan8 PR #716 candidate:

- `783f79a70a626053076234f944c5329b02c2f66d`: reject signed negative zero on canonical external-effect checkpoint ledger revisions; exact readback source blob `dddec5dce2269999c52ed2772841fddb567f498a`.
- `567cc694569a0de23839b06bdbff280e19d41834`: restore pre-existing Agent Definition form/model policy compatibility APIs without introducing another policy/Agent authority; exact readback blob `b9a69e8e19664ba824d5571233a8fee192b4d61f`.
- `3e837a3c92f7bb3a6b4280e16ee915c58e6adccd`: validate/copy Specialist delegation form profiles through the existing canonical profile normalizer; strict boolean and integer UI admission and `hybrid-auto` owner default; exact readback blob `12b1ec850270efca5d7dfd196c1cad26484a6ade`.

Exact-head run evidence at `3e837a3c92f7bb3a6b4280e16ee915c58e6adccd`:

- UI accessibility https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/actions/runs/38049392550: SUCCESS.
- Interaction https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/actions/runs/38049392587: SUCCESS.
- Native Chrome https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/actions/runs/38049392618: SUCCESS.
- Core https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/actions/runs/38049392556: FAILURE, 483 tests; 466 passed, 17 failed, no cancelled.
- Release https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/actions/runs/38049392549: Windows release packaging gate SUCCESS; Ubuntu aggregate FAILURE, 3585 tests; 3256 passed, 318 failed, 11 cancelled. This is three fewer failures than previous SHA 567cc694569a0de23839b06bdbff280e19d41834 (321), not aggregate PASS.

Unresolved: core durable route-budget reserve/settle, READ_ASSISTANT_REPORT missing/frozen/discarded tab recovery, Agent form/registry/route-policy/UI and Specialist authorization, 11.x integration into main and postintegration qualification and physical NVDA/authenticated service acceptance. Never treat PR, signed-zero repair, 3 additional passes or Windows-only release gate as terminal DONE; no real provider credentials were used or required for repository engineering.

## Plan 8 S1 integration compatibility fixes — exact code SHA 16bac9bc (2026-10-10; NONTERMINAL)

Only canonical Drive Plan 8, first actionable Section 1; Section 2 remains WAITING_UPSTREAM. Reused existing 11.0.13 High PR #716 and canonical modules. Changes at commits `16242c7`, `becfeb0`, `f893cb3`, `0c3f17d`, `16bac9b`:

- `src/core/subagent-task-envelope.js` preserves optional exact lowercase SHA-256 identity on child source references, so Project Context can verify unmodified immutable bytes across recovery; accessor and noncanonical-hash inputs fail closed. Existing unhashed legacy SourceRefs remain valid. Regression tests assert changed bytes produce changed dispatch identity after JSON recovery.
- `src/core/schema.js` connects existing canonical `TrustedOutcomeVerificationLedgerV1` initial state and validation: legacy missing schema-v2 ledger accepted; explicitly malformed/revision-drift ledger rejected before durable restart. No second ledger.
- `src/core/project-workspace.js` adds non-authorizing `ProjectWorkspaceRepository.resolveContext` reading **the existing** durable workspace and enforcing project/snapshot/capsule/current revision. No second store, source authentication, retrieval, mutation, policy or execution authority. Added two negative and cold-restart tests in `tests/subagent-context-projection.test.mjs`.

Exact source/test blobs independently read back at SHA `16bac9bc50d1884cd9400d4cd29c5e69d2e93dfa`: `0fee3d85de18e965c9ad5454ea70338a1b235ffa`, `e9dc400d58e97b6da25994bb946e182f516e4fcd`, `6708eb9cf36b168b9b58ac9f3f6327d8b72e2397`, `f420fd7dd3e9b9ef2e43a3e6624c9b6e30687b1c`, `8c239be9be2e33449f4e70c89b90b08b6cf032bb` respectively.

CI exact **code** head `16bac9bc50d1884cd9400d4cd29c5e69d2e93dfa`:
- Release #38058349443: Windows packaging SUCCESS, Ubuntu aggregate FAILURE: **3615 tests / 3369 PASS / 235 FAIL / 11 CANCELLED**. Previous exact head 4850b898: 3611 / 3352 PASS / 248 FAIL / 11 CANCELLED. Four new negative/recovery cases PASS; repaired existing ProjectWorkspace cold restart case PASS and trusted-ledger state/restart cases PASS. Full aggregate remains red, never treat partial passing as DONE.
- Core #38058349406 SUCCESS: 483/483 core + 59/59 web deterministic, zero fail/cancelled (job 114231373132).
- UI #38058349285, Interaction #38058349395, Chrome #38058349368 SUCCESS.
- Canonical shared registry `MULTI_PLAN_CLOSURE_STATE.md` updated on Plan8 PR lineage, without changing status of other plans.

**S1 FIRST ACTIONABLE / IN_PROGRESS / NOT TERMINAL DONE; S2 WAITING_UPSTREAM / NOT DONE.** 11.x candidate remains DRAFT / UNMERGED, main manifest is still 0.9.19; outstanding 235 test failures + 11 cancelled, 11.x postmain integration/readback and full required upstream convergence. No physical Windows/NVDA/authenticated provider effects/release assertions. No real provider credentials required for these repository repairs.
