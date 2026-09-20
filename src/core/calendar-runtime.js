import {
  CalendarCatchUp,
  commitCalendarOccurrence,
  nextCalendarOccurrence,
  normalizeCalendarSchedule,
} from './calendar-schedule.js';

export const CalendarOccurrenceState = Object.freeze({
  WAITING: 'WAITING',
  DUE: 'DUE',
  MISSED_WAITING_CATCHUP: 'MISSED_WAITING_CATCHUP',
  COMPLETED: 'COMPLETED',
});

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
  const occurrence = nextCalendarOccurrence({
    sessionId: session.id,
    schedule,
    runtime,
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
  if (!occurrence?.id) throw new Error('Calendar occurrence required');
  const runtime = commitCalendarOccurrence(session.calendarRuntime || {}, occurrence);
  session.calendarRuntime = {
    ...runtime,
    lastOccurrence: {
      id: occurrence.id,
      revision: occurrence.revision,
      scheduledFor: occurrence.scheduledAt,
      executedAt,
      state: CalendarOccurrenceState.COMPLETED,
    },
  };
  return session;
}
