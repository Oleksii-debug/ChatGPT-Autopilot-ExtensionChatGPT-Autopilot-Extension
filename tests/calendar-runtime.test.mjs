import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CalendarOccurrenceState,
  calendarAdmissionForSession,
  commitVerifiedCalendarOccurrence,
} from '../src/core/calendar-runtime.js';

const utc = value => Date.parse(value);

function session(schedule) {
  return { id: 'session-calendar', calendarSchedule: schedule, calendarRuntime: {} };
}

test('one-time future occurrence waits on canonical wake timestamp', () => {
  const s = session({ kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-21', time: '09:00' });
  const result = calendarAdmissionForSession(s, utc('2026-09-21T08:00:00Z'));
  assert.equal(result.kind, CalendarOccurrenceState.WAITING);
  assert.equal(result.wakeAt, utc('2026-09-21T09:00:00Z'));
});

test('one-time occurrence is due exactly at scheduled instant', () => {
  const s = session({ kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'OFF', date: '2026-09-21', time: '09:00' });
  const result = calendarAdmissionForSession(s, utc('2026-09-21T09:00:00Z'));
  assert.equal(result.kind, CalendarOccurrenceState.DUE);
  assert.equal(result.occurrence.scheduledAt, utc('2026-09-21T09:00:00Z'));
});

test('catch-up ON exposes missed occurrence without silently committing it', () => {
  const s = session({ kind: 'EXPLICIT', timeZone: 'UTC', catchUp: 'ON', occurrences: [
    { date: '2026-09-21', time: '09:00' },
    { date: '2026-09-21', time: '14:00' },
  ] });
  const result = calendarAdmissionForSession(s, utc('2026-09-21T12:00:00Z'));
  assert.equal(result.kind, CalendarOccurrenceState.MISSED_WAITING_CATCHUP);
  assert.equal(result.occurrence.scheduledAt, utc('2026-09-21T09:00:00Z'));
  assert.deepEqual(s.calendarRuntime, {});
});

test('verified commit advances durable occurrence identity exactly once', () => {
  const s = session({ kind: 'EXPLICIT', timeZone: 'UTC', catchUp: 'ON', occurrences: [
    { date: '2026-09-21', time: '09:00' },
    { date: '2026-09-21', time: '14:00' },
  ] });
  const first = calendarAdmissionForSession(s, utc('2026-09-21T12:00:00Z')).occurrence;
  commitVerifiedCalendarOccurrence(s, first, utc('2026-09-21T12:01:00Z'));
  assert.equal(s.calendarRuntime.lastOccurrence.id, first.id);
  assert.equal(s.calendarRuntime.lastOccurrence.state, CalendarOccurrenceState.COMPLETED);
  const next = calendarAdmissionForSession(s, utc('2026-09-21T12:02:00Z'));
  assert.equal(next.kind, CalendarOccurrenceState.WAITING);
  assert.equal(next.occurrence.scheduledAt, utc('2026-09-21T14:00:00Z'));
});

test('unscheduled sessions remain backward compatible', () => {
  assert.deepEqual(calendarAdmissionForSession({ id: 'legacy' }, 0), { kind: 'UNSCHEDULED', occurrence: null });
});
