# SCHEDULING ACCESSIBILITY + WHOLE-ALGORITHM START CONTRACT

Status: **BINDING OWNER ADDENDUM**  
Date: 2026-09-25  
Parent requirement: GitHub Issue #151

This document extends, but does not replace, the canonical Session calendar scheduler. It MUST reuse the existing calendar/scheduler, durable state, Chrome alarm and exact-effect/recovery authorities. **Do not build scheduler #2.**

## 1. Accessibility law: text-first date/time

Native browser date/time pickers are not the primary interaction for this product.

Every scheduling surface that asks the owner for a date or time MUST offer direct keyboard text entry and MUST remain usable with Windows + NVDA without opening a visual date/time picker.

Canonical owner-friendly local date/time format:

`DD.MM.YYYY HH:MM`

Examples:

`25.09.2026 04:00`

`25.09.2026 09:15`

Canonical time-only format:

`HH:MM`

Example:

`09:15`

For backward/import compatibility, `YYYY-MM-DD HH:MM` and `YYYY-MM-DDTHH:MM` may also be accepted where the value is interpreted as local wall time.

The UI must expose the format in ordinary text help. Invalid/nonexistent local times fail closed with a readable error.

A native picker may exist only as an optional convenience; it cannot be the only way to enter the value.

## 2. Two scheduling semantics must not be confused

### A. Calendar occurrence / message schedule

Meaning: perform a specific Session/Task occurrence at a calendar time.

Examples:
- send once at 25.09.2026 04:00;
- send at explicit times 04:00, 09:15 and 21:00;
- daily at selected times;
- selected weekdays;
- recurring interval when enabled.

Each occurrence has durable identity and exact-effect recovery.

### B. Whole-algorithm scheduled start

Meaning: start an entire Scenario/Orchestration algorithm at a future time.

Example:
- at 04:00 start the five persistent 17-message chat workers;
- after activation, their internal completion-driven 17-turn logic proceeds normally;
- the calendar does **not** gate every internal Send.

A whole-algorithm scheduled start must not create any managed chat/session before the configured start time.

## 3. Session scheduling capability

The final canonical Session scheduler supports:

- NOW / no calendar;
- ONE_TIME exact date/time;
- DAILY with one or many clock times;
- WEEKLY with selected weekdays and one or many clock times;
- EXPLICIT arbitrary date/time list;
- INTERVAL recurrence with a configured start time (required product capability; must reuse the same occurrence authority when implemented);
- optional end date / maximum occurrences where applicable;
- owner-selected timezone for calendar rules;
- explicit **Catch up missed runs** policy.

Multiple times must be representable as plain text, preferably one time or occurrence per line.

## 4. Scenario Work scheduled start

Scenario Work requires a durable one-time `startNotBeforeAt`/equivalent start authority.

Owner behavior:

- empty value = start immediately;
- future value = state `WAITING_SCHEDULE`;
- no managed ChatGPT chat is created before due time;
- the existing Scenario Work Chrome alarm wakes at the exact due time;
- at/after due time the state becomes `RUNNING` and the normal scenario planner takes control;
- Pause/Stop dominate the schedule;
- Pause before due time preserves the future start;
- Resume before due time returns to `WAITING_SCHEDULE`;
- Resume after due time starts immediately;
- Stop cancels the pending start;
- restart/service-worker recovery must preserve the scheduled start.

This start control applies to CHAT_CYCLE, PAIRS, AUDITOR_GROUP and AUDITOR_PIPELINE because it gates the scenario as a whole rather than changing internal mode semantics.

## 5. Orchestration scheduled start

Orchestration must gain the same whole-algorithm start contract using the canonical scheduling foundation.

A future start activates the whole hierarchy/graph at the due time. Internal Director/Manager/Worker transitions remain completion-driven and are not individually calendar-gated unless an explicit future product rule says otherwise.

## 6. Missed start and offline behavior

Local scheduling cannot execute while the PC/Chrome/local runtime is unavailable.

For occurrence schedules, use the canonical #151 catch-up policy:
- catch-up OFF -> missed occurrence becomes skipped;
- catch-up ON -> execute after recovery with original scheduledFor preserved.

For whole-algorithm scheduled starts, a future product control must expose the same owner choice instead of hiding catch-up behavior.

No ambiguous external effect may be blindly resent after restart.

## 7. UI surfaces

Scheduling must be available where it semantically belongs:

- Sessions: full calendar occurrence scheduling;
- Simplified Sessions: simple occurrence scheduling without AI;
- Scenario Work: whole-algorithm scheduled start, plus future recurring campaign triggers if explicitly configured;
- Orchestration: whole-algorithm scheduled start;
- Agent: scheduling may remain, but it is not the only scheduling surface and must use the same accessible text-entry convention.

## 8. Current implementation slice

This branch adds:
- shared text-first date/time parser for owner input;
- Agent start/end and active-window fields converted away from required native date/time pickers;
- Scenario Work one-time future start field;
- durable `WAITING_SCHEDULE` Scenario state;
- exact Scenario alarm wake at the scheduled start;
- no managed scenario chat before due time;
- Pause/Resume/Stop semantics for the pending start;
- backward compatibility for stored Scenario configs missing the new field;
- focused regression tests.

This slice does **not** claim the entire #151 roadmap complete. In particular, canonical interval occurrence scheduling and Orchestration scheduled start remain follow-on work unless already provided by another current-main lineage.

## 9. Non-removal rule

Future workers MUST NOT remove text-first scheduling or Scenario whole-algorithm delayed start as redundant.

They are explicit owner requirements and part of the final keyboard/NVDA product contract.
