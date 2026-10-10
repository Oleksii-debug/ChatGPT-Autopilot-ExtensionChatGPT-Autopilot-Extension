# Plan 8 — 11.0.13 High source convergence (candidate; not terminal DONE)

Source archive: `ChatGPT-Autopilot-11.0.13-HIGH-PostSend-Background-FIXED.zip`, Google Drive ID `1HHd4rNxf7Hlt0RqRzoBUX3M0JGF3usW2`.
Audited SHA-256: `ddf0527d03ca5b68c3b50e96dd3413e2d26afb0b7737ae3f502a3f960ae3c329`, 308 archive entries with CRC verified by earlier source baseline audit.
Exact Git 11.0.13 High source head: `ca7062e1f8e47b26d7e024c46bb432d341621dd4`, original PR #654, manifest/package version 11.0.13.
Main source ancestor before merge candidate: `2000dd3571323f7c98c6fb67c9d4aa9ff395897f`, manifest/package 0.9.19. Main coordination registries are intentionally preserved.

Source method: 2-parent git commit on live main and exact 11.x source head; overlay 282 divergent source/test/companion/config/history files using immutable Git blob SHAs, 794 selected source blobs assessed. Retain 57 main-only source/test files including non-conflicting earlier contributions. Existing binary release ZIP files remain in Git history, not duplicated in the new main tree. No other Drive plan was changed.

Gate state at candidate creation: SECTION 1 IN_PROGRESS / NOT TERMINAL DONE; SECTION 2 WAITING_UPSTREAM / NOT TERMINAL DONE. This source integration candidate is not a passing test, release, or physical Windows/NVDA claim. Required: exact-head Ubuntu/Windows/Chrome/release negative and recovery qualification, CI success or explicit defect repairs, main integration readback, then dependent Plan 1–7 convergence into the same source line. Plan 5 is deferred by owner but mandatory for the final whole-product gate.

Provenance is based on prior exact archive audit and existing #654 package SHA evidence; this operation itself did not recompute the raw ZIP SHA-256.
