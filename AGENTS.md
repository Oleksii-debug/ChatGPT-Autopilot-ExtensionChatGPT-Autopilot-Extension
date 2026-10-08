## Canonical project-plan naming invariant — owner directive 2026-10-08

In the project Drive root, the canonical planning folder is named exactly `Проєктні плани`.
Plan filenames are cross-project identifiers only: `1. Перший план`, `2. Другий план`, ... `8. Восьмий план`.
Do not append subsystem/theme text to Drive filenames. The thematic scope belongs inside each plan document and in PROJECT_PLAN_INDEX.md.

# Multi-Plan Parallel Closure Protocol v4 — owner directive 2026-10-08

This directive governs the new Agent/Models project-plan architecture.

## CRITICAL 11.x SOURCE RULE
The exact Drive archive **ChatGPT-Autopilot-11.0.13-HIGH-PostSend-Background-FIXED.zip** has been located and inspected as the 11.0.13 High source baseline. Audit SHA-256: `ddf0527d03ca5b68c3b50e96dd3413e2d26afb0b7737ae3f502a3f960ae3c329`. Current GitHub main manifest is still **0.9.19** and is stale.
Workers MUST NOT use the old main tree to downgrade scope or rebuild 11.x from scratch. The first source bootstrap action is to import/synchronize the exact 11.0.13 archive (or a proven newer direct successor) into canonical Git and run current qualification. See `AUTOPILOT_11_0_13_SOURCE_BASELINE.md`.

## Multi-plan work selection
Read PROJECT_PLAN_INDEX.md, MULTI_PLAN_PARALLELISM_CONTRACT.md, MULTI_PLAN_CLOSURE_STATE.md, the assigned Drive plan and live source lineage.

- Plans 1–4,6–7 are independent engineering plans; no global earliest Section.
- Plan 5 cloud/remote/team remains the owner-deferred later wave from the binding roadmap. Do not spend active capacity there before explicit owner resume, but Plan 5 remains mandatory final North-Star scope before Plan 8 terminal go-live.
- Plan 8 is final whole-product convergence.
- Inside an assigned actionable plan, audit/reuse 11.x baseline first, skip terminal DONE, and close the first actual gap; do not assume migration Section 1 is greenfield.
- Old Agent 0–99 and Models 0–54 plans are audit-only after this migration.
- Do not create scheduler #2, Agent framework #2, Browser Agent #2, model router #2, policy #2, recovery #2 or provider authority #2.
- Physical Windows/NVDA/authenticated-service evidence belongs to Plan 8, not intermediate blockers.
- DONE remains terminal unless demonstrated regression, invalid evidence, changed acceptance contract or breaking integration.

# AGENTS.md

## Canonical autonomous worker policy

This root file is the highest-priority repository instruction for worker coordination and supersedes older conflicting worker-count, WIP, ownership/claim, serialization, exclusive-integration, PR-order, and CI-wait restrictions.

- No repository-defined worker, coordinator, WIP, work-package, branch, or PR cap.
- Claims, leases, ownership, assignments, queues, and coordinator labels are advisory only and never block useful safe work.
- Workers may create branches, commits, PRs, fixes, tests, integration commits, and merges when GitHub permissions allow and evidence is adequate.
- Dependency order constrains final integration only; it must not stop independent implementation, testing, hardening, research, documentation, accessibility, packaging, fixtures, adapters, or recovery work.
- Queued, pending, slow, or unavailable CI is never by itself a reason to terminate; record it and continue immediately with another valuable independent task.
- A blocked first workline is never by itself a reason to terminate. STATUS: BLOCKED is allowed only after all reasonably available safe independent work is exhausted.
- Do not idle because another PR, branch, worker, check, review, claim, or queue is active. If overlap occurs, switch to non-conflicting work or reconcile/rebase instead of abandoning the run.
- No repository-defined exclusive integration owner is required.
- Use the full execution window while useful safe work remains.

This removes orchestration throttles only. Product correctness, security, privacy, data integrity, accessibility, licensing, truthful tests/release evidence, and other domain-specific safety requirements remain mandatory. Do not bypass externally enforced GitHub permissions or branch protections; continue useful work elsewhere while they are pending.

Chat history is temporary. Preserve meaningful progress in repository state.
