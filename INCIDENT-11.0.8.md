# 11.0.8 — incident and implementation — 2026-10-01T20:31:02+02:00

Four user-supplied 11.0.7 reports at 17:12:45, 17:14:17, 17:19:21 and 17:26:56 UTC on 2026-10-01 were inspected locally. The 17:12 report splits one pool across windows 1747062009/1747062622; 17:19 splits another across 1747062511/1747062587. The 17:14 report concentrates distinct projects in one window. 17:26 records frozen tabs and held unverified sends. Private attachments/prompts/conversation contents are not published.

## Reproduced causes

createChatTab queried all ChatGPT tabs and chose the most-populated window; failure of a saved window dropped authority and created in the focused window. Per-member preferredWindowId was learned after creation and then overwritten by bound-tab reads. chrome.runtime.openOptionsPage could focus an existing Pilot panel rather than create one per owner window. The same profile could therefore converge different projects into that panel/window. Cross-profile API transfer or attack is not established by those reports, which have no stable profile identity.

observeCompletedTurns skipped every task without lastVerifiedSendAt, including sends whose assistant response was already available after the 45-second ack ledger expired. Core had deliberately disabled FAILED_SAFE sends. A strict read-only current-marker paired-completed-response reconciliation now uses applyInteractionResult, operation identity and exact owned tab/window to count once without replay. Core also fences those physical submissions when reenabled by Start/Resume.

Native adapter restored selection immediately after native input, before acknowledgement; configurable dwell now precedes restoration. Focus remains protected by the existing per-window operation lease. New dwell uses async timers and bounded DOM observations; no memory residency override or unbounded MutationObserver scan was introduced.

## Design decisions

Explicit options source tab → verified local Chrome window → persisted per-pool/per-participant authority. No bound-window fallback. Two independent panels/pools per profile are supported. Migrated old running scenarios pause instead of guessing launch provenance; explicit Start binds/re-homes only positively owned tabs. Missing/moved documents fail closed. Post-Send holds and opening delay persist across restarts. Ordinary positive send and response counts remain distinct.

Simple UI receives cumulative actual sent/received totals; technical retry/replacement/generation metrics remain in exported diagnostics. Two accessible launch lists retain buttons during updates and dispatch exact IDs. Local diagnostic scope ID is storage.local only and exported for future report comparison; it is not account authentication proof.

## Alternatives rejected

Choosing last focused/most-populated window; following a moved tab; using URL alone as Send proof; repeating an unknown physical Send; resetting counters to optimistic click totals; disabling Chrome reclamation on every tab; bulk activating/focusing windows during report polling. No live ChatGPT account operations performed here.

## Remaining limits

Real Windows Chrome/NVDA not available here. Frozen pages can still defer reading until Chrome resumes them; the hard configured chat timeout remains the sole replacement policy. DOM proof is not a server network receipt. Historical incorrect counts cannot be reconstructed from redacted reports alone. Previously documented broader Agent/API qualification gaps remain separate. Browser profile/ChatGPT account isolation must be checked with new locally scoped live reports; no cyberattack attribution is made.


Final profile isolation checkpoint — 2026-10-01T20:39:24+02:00
The local scope ID is also persisted as launch authority, not merely printed. A copied foreign runtime is paused before any operation; explicit restart in a different local scope is rejected even if numeric Chrome tab/window IDs coincide. Startup also fences orphan managed sessions. Scope creation is single-flight per Chrome API instance. Config-only JSON imports stay portable; runtime ownership is not portable. Import-and-start ordinary/simplified launches are pinned before Core execution. Standalone completed scenario restart preserves binding/scope.

Final validation: full Core/Scenario/global/interaction/UI/release suite797 PASS; final targeted window/profile/UI/runtime wiring126 PASS. Counts concern automated models only. Installer archive byte/CRC/import/syntax validation is documented in QA-11.0.8.txt.
