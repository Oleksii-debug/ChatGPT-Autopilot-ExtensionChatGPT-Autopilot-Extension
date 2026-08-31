# Codex live acceptance — 2026-08-31

## Verdict

`LIVE_PASS` — the pre-operation navigation failure was reproduced, diagnosed, fixed, covered by regression tests, rebuilt, reloaded, and verified against the real signed-in ChatGPT service through Chrome DevTools Protocol on Windows.

- `CODEX_AUTOMATED_LIVE_VERIFIED=true`
- `REAL_CHATGPT_SEND_VERIFIED=true`
- `EXACTLY_ONCE_VERIFIED=true`
- `NVDA_VERIFIED=false`
- `HUMAN_MANUAL_ACCEPTANCE=false`
- `V01_READY=false` (the repository's separate human/release gate was not asserted)

The ten existing chess chats were not used. All Send and BUSY checks ran in one temporary ChatGPT test chat.

## Recovered GitHub state

- Canonical repository: `Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension`
- Default branch: `main`
- Live `main` at start: `4c3b50a1a3c25413d160ded0f81d077011862935`
- Local base matched `origin/main` exactly.
- PR #112: merged, merge SHA `39bd29344d1fc6ff89085210760fb84879fe63bf`
- PR #113: merged, merge SHA `d97cdffb748343f9d8c10bb7d8f134b0cfd37c1c`
- PR #114: merged, merge SHA `22593456a8d7f27f0d2a10b9b175430f5048ac6b`
- PR #115: merged, merge SHA `4c3b50a1a3c25413d160ded0f81d077011862935`
- PR #115 exact head `cda2cbc7f62ff48a3682eaaeaea4340a0162d795` had successful Core, Interaction, and Release package workflows.

## Root cause

Two consecutive readiness gaps existed before the durable Send operation was created:

1. `tabs.create()` and worker-tab `tabs.update()` can return while the target document still has `status: loading`.
2. Core immediately issued `CHECK_ONLY` through `tabs.sendMessage()`.
3. The first failure was `Could not establish connection. Receiving end does not exist.`
4. The prior receiver-recovery code immediately injected into the changing document and failed with the reproduced exception `Frame with ID 0 was removed.`
5. Because this happened before the durable operation was created, the observed operation phase correctly remained `NONE`.
6. Runtime discarded the exception identity, persisted only the generic retry message, and incorrectly used the Session Send-cooldown field for the pre-operation retry.
7. After the document-readiness fix, live worker navigation exposed a second gap: Chrome reported the document `complete` before the React composer finished hydrating. The first read-only `CHECK_ONLY` returned `TEMPORARY_ERROR / COMPOSER_NOT_READY`.

This explains the reported combination of `RECOVERING`, Task `WAITING`, operation `NONE`, no successful Send, and a generic retry message. Neither defect was a Send-button selector failure.

## Fix

- Added a bounded pre-`CHECK_ONLY` tab gate that waits for the exact normalized ChatGPT URL and a completed document.
- Re-checks document readiness before the one allowed zero-effect receiver restoration attempt.
- Added bounded polling only for read-only `CHECK_ONLY` while ChatGPT returns `COMPOSER_NOT_READY` during hydration.
- Kept receiver injection/retry restricted to `CHECK_ONLY`.
- Kept `SUBMIT_EXISTING` fail-closed: a missing receiver is never injected or retried for an effectful request.
- Added stable safe diagnostic codes for tab readiness, transport, receiver restoration, content-script exceptions, and uncertain submit outcomes.
- Persisted safe diagnostic codes in `lastError` and the bounded Session log without persisting raw exception details, URLs, or prompts.
- Bound pre-operation failures to the selected Task and its retry deadline; runtime failure no longer manufactures a Send cooldown.
- Preserved uncertain physical-send outcomes as `SUBMISSION_UNCERTAIN` with no blind resend.
- Clear stale runtime diagnostics only after verified forward progress or `SENT_VERIFIED`.

## Branch, SHA, PR, and CI

- Branch: `codex-live-pass-20260831`
- Base SHA: `4c3b50a1a3c25413d160ded0f81d077011862935`
- Implementation/live-evidence SHA: recorded after commit
- PR: recorded after creation
- Exact-head CI: recorded after the PR head completes

## Files changed

- `src/core/automatic-executor.js`
- `src/core/execution.js`
- `src/core/interaction-transport.js`
- `src/core/runner.js`
- `src/core/runtime-execution.js`
- `src/core/state-machine.js`
- `src/core/tabs.js`
- `src/interaction/content-script.js`
- `src/ui/uk-localization.js`
- `tests/core/interaction-transport.test.js`
- `tests/core/runner.test.js`
- `tests/core/runtime-execution.test.js`
- `tests/integration/runtime-wiring.test.js`
- `tests/ui/ukrainian-localization.test.js`
- `docs/CODEX_LIVE_ACCEPTANCE_2026-08-31.md`

## Deterministic test evidence

- Baseline before changes: 312/312 PASS.
- Red pre-fix regression reproduced `Frame with ID 0 was removed.` after a speculative receiver recovery on a loading tab.
- Initial fixed suite before the live hydration finding: 314/314 PASS.
- Final focused transport/runtime/runner/wiring suite: 30/30 PASS.
- Final full deterministic suite: 316/316 PASS, 0 failed, 0 skipped.
- Release build: 33 allowlisted files.
- Candidate ZIP: `dist/ChatGPT-Autopilot-Extension-v0.1.zip`
- Candidate ZIP SHA-256: `684e4bb8d4f2e25bb2d96c32792949df1c8e1833a7f66f958edd3dee75f7b938`

## Real Chrome and ChatGPT environment

- A separate workspace profile, `chrome-test-profile-cdp`, was used. No existing Chrome profile was opened, edited, or closed.
- Installed branded Google Chrome `151.0.7922.175` was verified through CDP, but that channel suppresses the unpacked `--load-extension` switch.
- No global Chrome policy or user profile was changed to bypass that product restriction.
- The final Google test used official **Google Chrome for Testing 152.0.7977.64** from the workspace, with `--remote-debugging-port=9222`, the isolated profile, and the unpacked release folder.
- CDP protocol: 1.3.
- Extension id: `dkacmbcckjnhnhfmbngkmhplpikchbjd`.
- The Autopilot MV3 service worker target and signed-in ChatGPT composer were both observed through CDP.
- The final Chrome user agent reported `Chrome/152.0.0.0` on Windows 10/11 x64 compatibility identity.

## Exactly-once evidence

First required message: `AUTOPILOT_LIVE_ACCEPTANCE_20260831`.

- Independent page capture recorded exactly one physical click on `data-testid="send-button"`, `aria-label="Надіслати запит"`.
- Independent DOM capture recorded exactly one matching user message.
- Core transitions included `INSERTING -> PRE_SEND_WAIT -> SUBMITTING -> SENT_VERIFIED`.
- `lastSuccessfulSendAt`: `1788171536675`.
- `nextAllowedSendAt`: `1788171656675`.
- Cooldown delta: exactly `120000 ms`.
- One-pass stopped automatically and recorded the Task as completed.
- No duplicate Send was observed.

The rebuilt/reloaded final code was then verified with a distinct recheck message. In official Google Chrome for Testing, `AUTOPILOT_CHROME_152_LIVE_RECHECK_20260831` produced:

- one physical Send click;
- one matching DOM user message;
- zero Stop clicks;
- `INSERTING -> PRE_SEND_WAIT -> SUBMITTING -> SENT_VERIFIED -> STOPPED`;
- `lastSuccessfulSendAt`: `1788173195711`;
- `nextAllowedSendAt`: `1788173315711`;
- cooldown delta: exactly `120000 ms`.

## BUSY / Stop safety

While real ChatGPT generation was active:

- the visible control was `data-testid="stop-button"`, `aria-label="Зупинити відповідь"`;
- an extension `CHECK_ONLY` returned `BUSY` with `safeDiagnosticCode="STOP_CONTROL_VISIBLE"`;
- the independent click capture recorded `stopClicks=0`;
- no Send operation or cooldown was created by the BUSY check.

The same BUSY result and zero-Stop-click evidence were reproduced in official Google Chrome for Testing.

## Reload, restart, navigation, lifecycle, and retry evidence

- Extension reload changed the service-worker target and preserved durable state.
- After reload, the existing ChatGPT tab first produced `Receiving end does not exist`; production transport restored only the read-only receiver and returned `READY` in 22 ms.
- A forced service-worker target stop removed the old target; the next Core read woke a new worker target and preserved the Send timestamps/cooldown.
- Worker-tab live navigation reproduced `tabs.update()` returning `status: loading`.
- Before the hydration fix that live check returned `COMPOSER_NOT_READY`.
- After rebuild/reload, the identical new-tab worker navigation reached the exact URL, `status: complete`, and `READY`; the temporary tab was then closed.
- Pause, Resume, and Stop each committed their authoritative state without an additional Send.
- Live safe-failure injection produced `TEMPORARY_RUNTIME_ERROR / LIVE_TEST_RUNTIME_FAILURE`, Task `RETRY_WAIT`, and exactly `180000 ms` retry backoff.
- That retry left `nextAllowedSendAt=0` and `lastSuccessfulSendAt=0`, proving it did not manufacture a Send cooldown.
- The temporary retry Session and temporary navigation tab were cleaned up after evidence capture.

## Not verified

- NVDA or another screen-reader workflow was not run.
- No human manual acceptance was claimed; all live evidence was collected programmatically through CDP.
- The standard branded Chrome 151 channel was not used for the unpacked live Send because it suppresses `--load-extension`; the official Google Chrome for Testing channel was used instead.
- `V01_READY` remains subject to the repository's separate human/integrated release policy.
