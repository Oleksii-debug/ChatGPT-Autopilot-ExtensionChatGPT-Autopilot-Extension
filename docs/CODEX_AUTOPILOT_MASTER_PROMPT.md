# ChatGPT Autopilot — Codex master development prompt

Canonical repository:

https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension

Objective: minimize `TIME_TO_WHOLE_FINISHED_PRODUCT`. Continue the real product from live GitHub state; do not restart architecture from zero and do not treat a PR, one green check, one commit, one audit comment, or one partially implemented feature as completion.

## Live truth order

1. latest explicit owner instruction;
2. current default-branch `main`, open/recent PRs, current Actions/checks, issues, claims and exact-head evidence;
3. GitHub Issue #150 — swarm live dispatch/ownership;
4. GitHub Issue #149 — whole-product completeness contract;
5. GitHub Issue #151 — calendar/session scheduling requirements;
6. `docs/FINAL_PRODUCT_NORTH_STAR.md`;
7. other current repository contracts referenced by those authorities.

Live reviewed GitHub state overrides stale chat summaries and historical Drive snapshots.

## Start every pulse

- Read the current `main` SHA.
- Read open PRs and current CI/checks.
- Read #150 and restore any valid ownership/lineage you already hold.
- Resume an existing useful lineage before opening a duplicate one.
- If you need source mutation, acquire/obey the live claim/ownership protocol and avoid semantic collision.
- Choose the highest-value safe causally linked work that materially advances the whole product.

## Architecture laws

Reuse existing canonical authorities. Do not create scheduler #2, Session/Task engine #2, durable store #2, recovery engine #2, Browser Agent/browser authority #2, AI Router/Gateway #2, policy/permission engine #2, or generic agent framework #2.

Preserve the generic exact-effect lifecycle:
`PREPARED -> EXECUTING -> OBSERVED -> VERIFIED -> COMMITTED`.

Ambiguous external effects must go through reconciliation; never blindly replay a possibly completed effect.

Owner authority remains `ALLOW | ASK | DENY`; do not add hidden mandatory confirmations that override an explicit owner policy.

## Accessibility

Windows 11 + Chrome + NVDA accessibility is release-critical. Prefer semantic keyboard-first controls and direct text entry where native visual controls are unreliable. Do not claim `NVDA_VERIFIED`, `HUMAN_TESTED`, or physical owner-browser acceptance without real physical evidence.

## Scheduling

Preserve the canonical Session calendar/scheduler and the requirements in #151 and `docs/SCHEDULING_ACCESSIBILITY_AND_ALGORITHM_START.md` when present. Scheduling is not an Agent-only feature. Distinguish individual calendar occurrences from delayed start of a whole Scenario/Orchestration algorithm.

## Execution depth

Work depth-first through the largest safe coherent slice. Implement, test, analyze failures, repair, reconverge with current main, update the canonical PR/claim, and continue while useful independent work remains. Do not generate dummy commits/comments/tests merely to appear active.

## Qualification truth

Report only checks actually run and bind evidence to exact SHAs. A green test does not prove physical NVDA/browser acceptance. Never relabel queued, stale, different-head, simulator-only, or historical evidence as current exact-head proof.

## End of pulse

Leave a concise factual handoff containing:
- exact main/base/head SHA;
- owned scope and PR/branch;
- implemented behavior;
- tests/checks actually run and outcomes;
- unresolved blocker/dependency;
- next causal step.

Then continue with the next safe useful task when the execution window permits.