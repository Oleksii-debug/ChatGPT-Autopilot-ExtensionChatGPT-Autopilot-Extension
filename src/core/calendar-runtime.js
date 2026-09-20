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
  if (!occurrence?.id || !occurrence?.revision || !Number.isFinite(occurrence?.scheduledAt)) throw new Error('Calendar occurrence required');
  const revision = calendarScheduleRevision(schedule);
  const expectedId = occurrenceId(session.id, occurrence.scheduledAt, revision);
  if (occurrence.revision !== revision || occurrence.id !== expectedId) throw new Error('Calendar occurrence does not belong to current Session schedule');
}

function commitOccurrenceState(session, schedule, occurrence, state, executedAt) {
  assertOccurrenceBelongsToSession(session, schedule, occurrence);
  const runtime = commitCalendarOccurrence(session.calendarRuntime || {}, occurrence);
  session.calendarRuntime = {
    ...runtime,
    lastOccurrence: { id: occurrence.id, revision: occurrence.revision, scheduledFor: occurrence.scheduledAt, executedAt, state },
  };
  return session;
}

function catchUpProbeRuntime(runtime, schedule, probeSchedule) {
  const revision = calendarScheduleRevision(schedule);
  const probeRevision = calendarScheduleRevision(probeSchedule);
  const cursor = Number.isFinite(runtime.reconciledThroughByRevision?.[revision])
    ? runtime.reconciledThroughByRevision[revision]
    : runtime.recurrenceRevision === revision && Number.isFinite(runtime.reconciledThrough)
      ? runtime.reconciledThrough
      : null;
  if (cursor == null) return runtime;
  return {
    ...runtime,
    reconciledThroughByRevision: { ...(runtime.reconciledThroughByRevision || {}), [probeRevision]: cursor },
  };
}

/** Thin admission adapter over the canonical calendar scheduler. */
export function calendarAdmissionForSession(session, now = Date.now()) {
  if (!session?.calendarSchedule) return { kind: 'UNSCHEDULED', occurrence: null };
  const schedule = normalizeCalendarSchedule(session.calendarSchedule);
  const runtime = session.calendarRuntime || {};

  // OFF must not execute an occurrence missed while the app was stopped. Probe
  // the same scheduler with catch-up enabled, then bind the missed instant back
  // to the actual OFF revision before durably reconciling it as skipped.
  if (schedule.catchUp === CalendarCatchUp.OFF) {
    const probeSchedule = { ...schedule, catchUp: CalendarCatchUp.ON };
    const missed = nextCalendarOccurrence({
      sessionId: session.id,
      schedule: probeSchedule,
      runtime: catchUpProbeRuntime(runtime, schedule, probeSchedule),
      now,
    });
    if (missed?.scheduledAt < now) {
      const revision = calendarScheduleRevision(schedule);
      const occurrence = { ...missed, id: occurrenceId(session.id, missed.scheduledAt, revision), revision, catchUp: false };
      commitOccurrenceState(session, schedule, occurrence, CalendarOccurrenceState.MISSED_SKIPPED, now);
      return { kind: CalendarOccurrenceState.MISSED_SKIPPED, occurrence };
    }
  }

  const occurrence = nextCalendarOccurrence({ sessionId: session.id, schedule, runtime: session.calendarRuntime || runtime, now });
  if (!occurrence) return { kind: 'EXHAUSTED', occurrence: null };
  if (!occurrence.due) return { kind: CalendarOccurrenceState.WAITING, occurrence, wakeAt: occurrence.scheduledAt };
  if (occurrence.catchUp && schedule.catchUp === CalendarCatchUp.ON) return { kind: CalendarOccurrenceState.MISSED_WAITING_CATCHUP, occurrence };
  return { kind: CalendarOccurrenceState.DUE, occurrence };
}

/** Commit only after the canonical effect lifecycle has verified the scheduled run. */
export function commitVerifiedCalendarOccurrence(session, occurrence, executedAt = Date.now()) {
  if (!session?.calendarSchedule) throw new Error('Calendar schedule required');
  const schedule = normalizeCalendarSchedule(session.calendarSchedule);
  return commitOccurrenceState(session, schedule, occurrence, CalendarOccurrenceState.COMPLETED, executedAt);
}
