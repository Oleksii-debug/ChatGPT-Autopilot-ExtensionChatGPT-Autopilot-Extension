import {
  CalendarCatchUp,
  calendarScheduleRevision,
  commitCalendarOccurrence,
  nextCalendarOccurrence,
  normalizeCalendarSchedule,
  occurrenceId,
} from './calendar-schedule.js';

export const CalendarOccurrenceState = Object.freeze({
  WAITING: 'WAITING',
  DUE: 'DUE',
  MISSED_WAITING_CATCHUP: 'MISSED_WAITING_CATCHUP',
  MISSED_SKIPPED: 'MISSED_SKIPPED',
  COMPLETED: 'COMPLETED',
});

function assertOccurrenceBelongsToSession(session, schedule, occurrence) {
  if (!occurrence?.id || !occurrence?.revision || !Number.isFinite(occurrence?.scheduledAt)) {
    throw new Error('Calendar occurrence required');
  }
  const revision = calendarScheduleRevision(schedule);
  const expectedId = occurrenceId(session.id, occurrence.scheduledAt, revision);
  if (occurrence.revision !== revision || occurrence.id !== expectedId) {
    throw new Error('Calendar occurrence does not belong to current Session schedule');
  }
}

function commitOccurrenceState(session, schedule, occurrence, state, executedAt) {
  assertOccurrenceBelongsToSession(session, schedule, occurrence);
  const runtime = commitCalendarOccurrence(session.calendarRuntime || {}, occurrence);
  session.calendarRuntime = {
    ...runtime,
    lastOccurrence: {
      id: occurrence.id,
      revision: occurrence.revision,
      scheduledFor: occurrence.scheduledAt,
      executedAt,
      state,
    },
  };
  return session;
}

/**
 * Derive the owner-visible calendar admission decision for one Session.
 *
 * This is deliberately a thin adapter over calendar-schedule.js. It does not
 * own a timer, durable store, retry loop or recovery engine. The caller must
 * persist returned runtime state through the canonical Session repository and
 * use the existing autopilot-core-wake alarm.
 */
export function calendarAdmissionForSession(session, now = Date.now()) {
  if (!session?.calendarSchedule) return { kind: 'UNSCHEDULED', occurrence: null };

  const schedule = normalizeCalendarSchedule(session.calendarSchedule);
  const runtime = session.calendarRuntime || {};

  // OFF must not execute an occurrence missed while the app was stopped. Probe
  // the same canonical scheduler with catch-up enabled so the missed identity
  // can be durably reconciled instead of disappearing only because `now` moved.
  if (schedule.catchUp === CalendarCatchUp.OFF) {
    const missed = nextCalendarOccurrence({
      sessionId: session.id,
      schedule: { ...schedule, catchUp: CalendarCatchUp.ON },
      runtime,
      now,
    });
    if (missed?.scheduledAt < now) {
      // The probe changes catchUp, hence its revision. Rebind the canonical
      // scheduled instant to the owner's actual OFF schedule before committing.
      const revision = calendarScheduleRevision(schedule);
      const occurrence = {
        ...missed,
        id: occurrenceId(session.id, missed.scheduledAt, revision),
        revision,
        catchUp: false,
      };
      commitOccurrenceState(session, schedule, occurrence, CalendarOccurrenceState.MISSED_SKIPPED, now);
      return { kind: CalendarOccurrenceState.MISSED_SKIPPED, occurrence };
    }
  }

  const occurrence = nextCalendarOccurrence({
    sessionId: session.id,
    schedule,
    runtime: session.calendarRuntime || runtime,
    now,
  });

  if (!occurrence) return { kind: 'EXHAUSTED', occurrence: null };
  if (!occurrence.due) {
    return {
      kind: CalendarOccurrenceState.WAITING,
      occurrence,
      wakeAt: occurrence.scheduledAt,
    };
  }

  if (occurrence.catchUp && schedule.catchUp === CalendarCatchUp.ON) {
    return { kind: CalendarOccurrenceState.MISSED_WAITING_CATCHUP, occurrence };
  }
  return { kind: CalendarOccurrenceState.DUE, occurrence };
}

/**
 * Commit only after the canonical effect lifecycle has verified the scheduled
 * run. Calling this before VERIFIED would turn an ambiguous effect into a
 * silent skip, so callers must bind it to verified completion only.
 */
export function commitVerifiedCalendarOccurrence(session, occurrence, executedAt = Date.now()) {
  if (!session?.calendarSchedule) throw new Error('Calendar schedule required');
  const schedule = normalizeCalendarSchedule(session.calendarSchedule);
  return commitOccurrenceState(session, schedule, occurrence, CalendarOccurrenceState.COMPLETED, executedAt);
}
