# ChatGPT Autopilot Extension v0.1 — Windows 11 + NVDA Acceptance

Status: manual release gate. This checklist does not claim human verification until every required item is performed on Windows 11 with NVDA and the unpacked extension candidate.

## Preconditions

1. Use Windows 11, current Google Chrome, and current NVDA.
2. Load the exact unpacked candidate from `chrome://extensions` with Developer mode enabled.
3. Confirm the extension opens its ChatGPT Autopilot options/dashboard page.
4. Use only test ChatGPT conversations and non-sensitive prompts during acceptance.
5. Do not test CAPTCHA, account restriction, rate-limit bypass, or unknown security confirmations.

## A. Launch and landmarks

Keyboard only:

1. Open the extension options page.
2. Press `H`/heading navigation in NVDA and confirm the page exposes the `ChatGPT Autopilot` heading, `Sessions`, and the selected Session headings in logical order.
3. Press `D`/landmark navigation and confirm Session navigation and main content are distinguishable.
4. Tab through the first controls. NVDA must announce meaningful names such as `Master pause`, `Create session`, and existing Session buttons.

Pass criteria: no unlabeled focusable control; no mouse-only operation; focus order follows the page structure.

## B. Create and configure a Session

1. Activate `Create session` with Enter/Space.
2. Confirm focus arrives in the new Session workflow and NVDA identifies the Session name field.
3. Enter a Session name.
4. Choose `One shared prompt for all tasks`.
5. Enter a shared prompt.
6. Confirm the first Task exposes an enabled checkbox, optional label, ChatGPT URL field, and Remove Task button.
7. Activate `Add task` repeatedly and confirm focus moves to the newly created Task URL field instead of an unrelated control.
8. Remove a middle Task and confirm focus moves to a nearby remaining Task or `Add task` if none remain.
9. Switch to `Unique prompt for each task`; confirm each Task exposes its own labelled prompt field.
10. Switch back to shared prompt mode and confirm Task ordering is preserved.

Pass criteria: dynamic controls have stable accessible names, ordinal Task context, and predictable focus.

## C. Validation and error navigation

1. Attempt Save with an empty Session name, invalid/empty URL, and missing required prompt.
2. With multiple errors, NVDA focus must move to the error summary and each error link must move focus to the corresponding invalid control.
3. Confirm invalid fields expose `aria-invalid` and the error text through `aria-describedby`.
4. Enter busy-check delay below 1 or above 30 seconds and confirm Save is rejected with an understandable error.
5. Enter retry-backoff below 5 or above 3600 seconds and confirm Save is rejected with an understandable error.
6. Correct all values and Save; NVDA should announce `Session saved.` without unexpected focus loss.

Pass criteria: bounds are enforced by the Save path, not only by browser-native number input behavior.

## D. Session lifecycle controls

Using the newest candidate where production automatic execution is enabled:

1. Start a valid Session.
2. Confirm Start becomes unavailable and Pause/Stop availability reflects the current Core state.
3. Activate Pause. NVDA must announce the action and the displayed State must become `PAUSED`.
4. Activate Resume. State must become `RUNNING` or `RECOVERING` as appropriate.
5. Activate Stop. State must become `STOPPED` and must not silently restart.
6. If automatic execution is intentionally unavailable in the candidate, Start/Resume must fail with a persistent understandable message as well as an NVDA announcement; do not accept a silent failure.

Pass criteria: controls reflect authoritative Core state and no unavailable action is presented as successful.

## E. Runtime status and log

For a running/recovering test Session, inspect the Status section using reading/navigation commands rather than the mouse.

Required readable information:

- Session State (`RUNNING`, `RECOVERING`, `PAUSED`, `STOPPED`, or `ERROR` as applicable);
- current Task/URL or `None`;
- last action;
- last successful send time;
- next eligible send time;
- enabled Task count;
- most recent error;
- current Task runtime condition when available, especially `BUSY`, `RATE_LIMITED`, `RETRY_WAIT`, `MANUAL_REVIEW`, `SUBMISSION_UNCERTAIN`, or inserted/pending state;
- manual-review reason / retry time when relevant.

The Log must be keyboard reachable and readable as plain text. Clearing the log must announce completion.

Pass criteria: a blind user can determine why a Session is waiting without screenshots, color, or icon interpretation.

## F. Background updates must not steal focus

This is release-critical.

For each of the following controls, place the caret/focus there and cause or wait for a background `STATUS_CHANGED` refresh:

- Session name;
- Task URL;
- Task prompt;
- shared prompt;
- minimum send interval;
- pre-send delay;
- busy-check delay;
- retry-backoff;
- Task enabled checkbox;
- Session navigation button.

Pass criteria:

1. Focus remains on the user's control after the status update.
2. Text caret/selection is not unexpectedly reset where applicable.
3. Background status refresh does not jump to the Session heading.
4. Status changes remain discoverable by normal review/navigation without continuous NVDA chatter.

## G. Delete dialog

1. Activate Delete on a Session.
2. Confirm focus moves into the modal dialog and NVDA announces `Delete session?`.
3. Tab/Shift+Tab must remain within the dialog's Delete/Cancel controls.
4. Escape must cancel and return focus to the originating Delete button when it still exists.
5. Confirming Delete must remove the Session and announce completion.

Pass criteria: no keyboard escape into background controls while modal is open.

## H. Master pause

With multiple active test Sessions:

1. Activate `Master pause`.
2. Confirm active Sessions become paused and the announcement is understandable.
3. Confirm individually paused Sessions are not incorrectly presented as running.
4. When a Master Resume control/path is present in the release candidate, confirm only Sessions paused by master pause are automatically resumed.

## I. Restart/recovery accessibility

1. Leave at least one Session in `RUNNING` and one in `PAUSED`.
2. Close Chrome, reopen it, then reopen the extension dashboard.
3. Confirm the formerly running Session is represented as `RECOVERING`/`RUNNING` according to Core reconciliation and the manually paused Session remains `PAUSED`.
4. Confirm the dashboard exposes the recovered state without requiring mouse interaction.
5. Repeat around temporary network loss if the candidate can safely do so.

## J. Final acceptance record

Record the exact candidate SHA/ZIP and fill this table only after real execution:

| Gate | Result | Notes |
| --- | --- | --- |
| Keyboard-only navigation | NOT RUN | |
| NVDA control names/roles | NOT RUN | |
| Dynamic Task focus | NOT RUN | |
| Validation/error summary | NOT RUN | |
| Timing-bound validation | NOT RUN | |
| Lifecycle controls | NOT RUN | |
| Runtime state/status readability | NOT RUN | |
| Background focus preservation | NOT RUN | |
| Delete dialog focus trap/return | NOT RUN | |
| Master pause behavior | NOT RUN | |
| Chrome restart/recovery UI | NOT RUN | |
| Real ChatGPT smoke | NOT RUN | |

Final flags remain:

`HUMAN_TESTED=false`

`NVDA_VERIFIED=false`

until this checklist is executed against the exact release candidate.
