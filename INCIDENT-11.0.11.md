# 11.0.11 — Pilot 10 Send parity — 2026-10-02T15:31:00+02:00

## User evidence and search scope

User reports 11.0.10 sent nothing in all accounts; reinstalling 10.0 worked overnight but admitted too few chats. No nightly diagnostics are available. Connected Drive searches for Autopilot/Автопілот/Пілот and recent files in the known project folder returned our history through 11.0.10. The later Work conversation was not found in personal context. GitHub's latest updated PR was our #650; searches of 11.0 release branches found no later release. Library searches after the release found no later artifact or diagnostic. These search results do not prove that another Work did no local or unsaved work; binary-file search coverage is limited. No such work was overwritten.

## A reproduced regression, not an inferred live root cause

The unchanged Pilot 10 adapter from a4436cf3097c2a8faa6f99a04ad558837a746acd submits a hidden real form via requestSubmit while a supplied native mouse callback is unavailable. The same mock ready form with 11.0.10's scenario activation calls the supplied Chrome native callback and throws NATIVE_INPUT_ATTACH_FAILED before any submit. Prior positive tests omitted that production callback. The corrected adapter uses the form's submission semantics even after activation, or one exact DOM Send click for a non-form control. This does not claim that debugger failure was observed in the deleted nightly reports.

A second deterministic test shows that content-script reinjection kept an old adapter listener even after the adapter object changed. The fix replaces that listener and preserves idempotence. Both before-fix outputs are retained under validation/11.0.11.

## Correctness of the simpler path

The real shipped content-script bridge, real Core StorageRepository, activation/restore functions, and DOM checkpoint function are exercised together with a modeled DOM and unavailable debugger. The form checks that Core persisted the checkpoint before its single requestSubmit; duplicate request delivery produces no second physical Send. A checkpoint itself is never successful delivery. Server-side success still requires the existing operation-bound appended user turn and scenario generation proof. Answer correlation is unchanged.

DOM effect checkpoints survive restart, block native/DOM replay, refuse paused or wrongly owned sessions, and allow observation-only activation of the already submitted conversation. A new explicit pre-Send activation marker prevents a legacy post-Send observation focus lease from being treated as proof of zero effect. Ambiguous old attempts are preserved. These durable markers are necessary to reuse the 10.0 DOM dispatch path without blind retry.

## Quantity and alternatives

The resident-tab/window binding and 15-chat admission fixes remain. We have no nightly 10.0 report to quantify why it admitted fewer launches; actual counts and provider limits are not guessed. A wholesale rollback would reintroduce earlier tab leaks/window mixing and hidden admission caps, so only the known-working dispatch mechanism is restored. No service-limit bypass, broad reload loop, bulk activation or second execution architecture is introduced. Native editor insertion remains, while Send no longer uses debugger coordinates.

## Qualification limits

No Chrome binary is installed in this workspace; no physical Windows Chrome/NVDA/account qualification was performed. Mocked bridge/DOM and pool tests do not prove live server delivery or PC responsiveness. This archive is a field-verification candidate, not a certified night run. Historical counter 46 remains unprovable as 46 server receipts from old reports. See QA-11.0.11.txt for exact results, and dated development history for alternatives and remaining limits.

Validation completed 2026-10-02T15:36:25+02:00: full suite 813 PASS; final runner suite 11 PASS, including one additional unique lost-DOM-checkpoint-acknowledgement case. Aggregate distinct final cases: 814 PASS. Focused 201 PASS overlaps the full suite. Before-fix failures and final outputs retained under validation/11.0.11. Physical Windows/server qualification remains unavailable.
