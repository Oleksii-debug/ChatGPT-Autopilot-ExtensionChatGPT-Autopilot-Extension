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
