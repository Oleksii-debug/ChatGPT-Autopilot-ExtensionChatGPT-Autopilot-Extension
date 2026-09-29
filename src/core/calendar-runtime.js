import {
  CalendarCatchUp,
  calendarScheduleRevision,
  commitCalendarOccurrence,
  nextCalendarOccurrence,
  normalizeCalendarSchedule,
  occurrenceId,
} from './calendar-schedule.js';

const DAILY_RECURRENCE_PROBE_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const WEEKLY_RECURRENCE_PROBE_LOOKBACK_MS = 9 * 24 * 60 * 60 * 1000;

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

function catchUpProbeRuntime(runtime, schedule, probeSchedule, now) {
  const revision = calendarScheduleRevision(schedule);
  const probeRevision = calendarScheduleRevision(probeSchedule);
  const cursor = Number.isFinite(runtime.reconciledThroughByRevision?.[revision])
    ? runtime.reconciledThroughByRevision[revision]
    : runtime.recurrenceRevision === revision && Number.isFinite(runtime.reconciledThrough)
      ? runtime.reconciledThrough
      : null;
  if (cursor != null) {
    return {
      ...runtime,
      reconciledThroughByRevision: { ...(runtime.reconciledThroughByRevision || {}), [probeRevision]: cursor },
    };
  }
  // Bounded recurrence may have ended entirely before the lookback window.
  // Probe it from its real start so OFF can durably record MISSED_SKIPPED.
  // With the canonical direct candidate finder this is O(1) for DAILY and at
  // most seven local dates for WEEKLY; it does not enumerate historical days.
  if ((schedule.kind === 'DAILY' || schedule.kind === 'WEEKLY')
    && (schedule.endDate || schedule.maxOccurrences != null)) {
    return runtime;
  }
  // Unbounded recurring catch-up ON normally starts at startDate. For an
  // OFF-policy missed/not-missed probe we only need to know whether a recent
  // occurrence precedes now. Three elapsed days cover DAILY across a skipped
  // DST wall time; nine elapsed days cover every selected WEEKLY weekday.
  // Both keep probe work bounded independently of schedule age.
  if (schedule.kind === 'DAILY' || schedule.kind === 'WEEKLY') {
    const lookbackMs = schedule.kind === 'DAILY'
      ? DAILY_RECURRENCE_PROBE_LOOKBACK_MS
      : WEEKLY_RECURRENCE_PROBE_LOOKBACK_MS;
    return {
      ...runtime,
      reconciledThroughByRevision: {
        ...(runtime.reconciledThroughByRevision || {}),
        [probeRevision]: now - lookbackMs,
      },
    };
  }
  return runtime;
}

function reconcileMissedThrough(session, schedule, occurrence, now) {
  assertOccurrenceBelongsToSession(session, schedule, occurrence);
  const revision = occurrence.revision;
  const reconciledThrough = Math.max(occurrence.scheduledAt, now - 1);
  const committed = commitCalendarOccurrence(session.calendarRuntime || {}, occurrence);
  session.calendarRuntime = {
    ...committed,
    recurrenceRevision: revision,
    reconciledThrough,
    reconciledThroughByRevision: {
      ...(committed.reconciledThroughByRevision || {}),
      [revision]: reconciledThrough,
    },
    lastOccurrence: {
      id: occurrence.id,
      revision,
      scheduledFor: occurrence.scheduledAt,
      executedAt: now,
      state: CalendarOccurrenceState.MISSED_SKIPPED,
      reconciledThrough,
    },
  };
  return session;
}

/** Thin admission adapter over the canonical calendar scheduler. */
export function calendarAdmissionForSession(session, now = Date.now()) {
  if (!session?.calendarSchedule) return { kind: 'UNSCHEDULED', occurrence: null };
  const schedule = normalizeCalendarSchedule(session.calendarSchedule);
  const runtime = session.calendarRuntime || {};

  // OFF must never replay downtime backlog. Probe once with catch-up enabled to
  // prove at least one missed occurrence exists, then advance the canonical
  // revision cursor through the instant before `now`.
  if (schedule.catchUp === CalendarCatchUp.OFF) {
    const probeSchedule = { ...schedule, catchUp: CalendarCatchUp.ON };
    const missed = nextCalendarOccurrence({
      sessionId: session.id,
      schedule: probeSchedule,
      runtime: catchUpProbeRuntime(runtime, schedule, probeSchedule, now),
      now,
    });
    if (missed?.scheduledAt < now) {
      const revision = calendarScheduleRevision(schedule);
      const occurrence = { ...missed, id: occurrenceId(session.id, missed.scheduledAt, revision), revision, catchUp: false };
      reconcileMissedThrough(session, schedule, occurrence, now);
      return { kind: CalendarOccurrenceState.MISSED_SKIPPED, occurrence, reconciledThrough: now - 1 };
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
