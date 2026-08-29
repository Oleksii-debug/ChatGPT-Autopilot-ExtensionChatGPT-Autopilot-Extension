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
5. Confirm the `Keyboard and startup behavior` section states that there are no extension-specific global shortcuts. Navigation must use standard `Tab`, `Shift+Tab`, `Enter`, and `Space` behavior without a keyboard trap.
6. With at least two Sessions, open one, then review Session navigation without activating another Session. NVDA must expose exactly the opened Session as the current item; the exact spoken wording may vary by NVDA/Chrome.
7. Open a different Session and review Session navigation again. The current marker must move to the newly opened Session and be absent from the previous Session. Rename/Duplicate/Delete controls must not be presented as the current item or as toggle controls.

Pass criteria: no unlabeled focusable control; no mouse-only operation; focus order follows the page structure; exactly one `Open session …` control is exposed as current when a Session is selected, and that state follows the opened Session without inventing toggle semantics.

## B. Create and configure a Session

1. Activate `Create session` with Enter/Space.
2. Confirm focus arrives on the new Session name field, and NVDA identifies the field before its default text is selected.
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
2. With multiple errors, NVDA focus must move to a region named `Configuration errors`; the summary heading/list must be readable and each error link must move focus to the corresponding invalid control.
3. Confirm focusing the summary does not cause a duplicate assertive/alert announcement in addition to the normal validation announcement.
4. Confirm invalid fields expose `aria-invalid` and the error text through `aria-describedby`.
5. Enter busy-check delay below 1 or above 30 seconds and confirm Save is rejected with an understandable error.
6. Test `Retry/backoff unit` with both `Seconds` and `Minutes`. Confirm values below 5 seconds or above 60 minutes are rejected with an understandable error, and that reopening the Session preserves the exact duration.
7. Correct all values and Save; NVDA should announce `Session saved.` without unexpected focus loss.

Pass criteria: bounds are enforced by the Save path, not only by browser-native number input behavior, and error focus always lands on an identifiable target.

## D. Session lifecycle controls

Using the newest candidate where production automatic execution is enabled:

1. Start a valid Session.
2. Confirm Start becomes unavailable and Pause/Stop availability reflects the current Core state.
3. After Start is acknowledged and button availability changes, confirm keyboard focus remains on a deterministic reachable control/result and does not fall to the document body or an undefined location.
4. Activate Pause. NVDA must announce the Core-acknowledged action and the displayed State must become `PAUSED`; focus must remain deterministically recoverable after availability changes.
5. Activate Resume. State must become `RUNNING` or `RECOVERING` as appropriate; focus must not disappear when Resume becomes unavailable.
6. Activate Stop. State must become `STOPPED`, must not silently restart, and keyboard focus must remain on a meaningful enabled control/result.
7. If automatic execution is intentionally unavailable in the candidate, Start/Resume must fail with a persistent understandable message in normal page text as well as an NVDA announcement; do not accept a silent or transient-only failure.

Pass criteria: controls reflect authoritative Core state, no unavailable action is presented as successful, and lifecycle state transitions never leave keyboard/NVDA focus on `body` or an undefined target.

## E. Runtime status and log

For a running/recovering test Session, inspect the Status section using reading/navigation commands rather than the mouse.

Required readable information:

- Session State (`RUNNING`, `RECOVERING`, `PAUSED`, `STOPPED`, or `ERROR` as applicable);
- current Task/URL or `None`;
- last action;
- last successful send time;
- next eligible/allowed Send time;
- enabled Task count;
- most recent error;
- current Task runtime condition when available, especially `BUSY`, `RATE_LIMITED`, `RETRY_WAIT`, `MANUAL_REVIEW`, `SUBMISSION_UNCERTAIN`, or inserted/pending state;
- operation phase when available;
- manual-review reason / retry or backoff time when relevant.

The Log must be keyboard reachable and readable as plain text. Clearing the log must produce an understandable persistent result/announcement. The user must be able to determine that the displayed log is bounded rather than an unlimited history.

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
3. Background status refresh does not jump to the Session heading or command result.
4. Status changes remain discoverable by normal review/navigation without continuous NVDA chatter.
5. Repeated identical connection/status text does not generate repeated `role=status` speech solely because of a background refresh.
6. If the Session list is rebuilt, the current-item marker remains on exactly the opened Session and the refresh does not move keyboard focus to that marker or to another Session.

## G. Delete dialog

1. Activate Delete on a Session and confirm the Delete control's accessible name identifies the target Session.
2. Confirm focus moves into the modal dialog and NVDA announces `Delete session?` together with enough target context to know which Session is being removed.
3. Tab/Shift+Tab must remain within the dialog's Delete/Cancel controls.
4. Escape must cancel and return focus to the originating Delete button when it still exists.
5. Confirming Delete must remove the Session and announce completion.
6. After successful Delete, focus must move to the next surviving Session button, otherwise the previous surviving Session button, otherwise `Create session` when no Sessions remain. It must not fall to `body` or the removed Delete button.
7. If Delete fails, the Core error must remain readable in ordinary page text after the live announcement finishes.

Pass criteria: no keyboard escape into background controls while modal is open, and both cancellation and successful destructive completion have deterministic focus destinations.

## H. Master pause

With multiple active test Sessions:

1. Activate `Master pause`.
2. Confirm active Sessions become paused only after Core acknowledges the command and the result remains understandable in normal page text.
3. Confirm individually paused Sessions are not incorrectly presented as running.
4. When `Resume after master pause` is present, confirm the UI reports success only after Core acknowledgement and only Sessions paused by master pause are automatically resumed.
5. Confirm Master Pause/Resume failures remain readable after the live announcement and do not require mouse review.

## I. Restart/recovery accessibility

1. Leave at least one Session in `RUNNING` and one in `PAUSED`.
2. Close Chrome, reopen it, then reopen the extension dashboard.
3. Confirm the formerly running Session is represented as `RECOVERING`/`RUNNING` according to Core reconciliation and the manually paused Session remains `PAUSED`.
4. Confirm the dashboard exposes the recovered state without requiring mouse interaction.
5. Repeat around temporary network loss if the candidate can safely do so.
6. Confirm the options page accurately states that only `RUNNING`/`RECOVERING` Sessions auto-resume and that `PAUSED`/`STOPPED` Sessions do not.

## J. Final acceptance record

Record the exact candidate SHA/ZIP and fill this table only after real execution:

| Gate | Result | Notes |
| --- | --- | --- |
| Keyboard-only navigation | NOT RUN | |
| NVDA control names/roles | NOT RUN | |
| Current Session navigation state | NOT RUN | |
| Dynamic Task focus | NOT RUN | |
| Validation/error summary | NOT RUN | |
| Timing-bound validation | NOT RUN | |
| Lifecycle controls | NOT RUN | |
| Lifecycle focus restoration | NOT RUN | |
| Runtime state/status readability | NOT RUN | |
| Background focus preservation | NOT RUN | |
| Delete dialog focus trap/return | NOT RUN | |
| Delete success focus restoration | NOT RUN | |
| Master pause/resume behavior | NOT RUN | |
| Chrome restart/recovery UI | NOT RUN | |
| Real ChatGPT smoke | NOT RUN | |

Final flags remain:

`HUMAN_TESTED=false`

`NVDA_VERIFIED=false`

until this checklist is executed against the exact release candidate.
