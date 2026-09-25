import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CalendarScheduleKind,
  calendarScheduleRevision,
  commitCalendarOccurrence,
  nextCalendarOccurrence,
  normalizeCalendarSchedule,
} from '../src/core/calendar-schedule.js';
import { CalendarOccurrenceState, calendarAdmissionForSession } from '../src/core/calendar-runtime.js';

const utc = value => Date.parse(value);

test('WEEKLY normalizes selected weekdays, multiple times, and recurrence bounds deterministically', () => {
  const schedule = normalizeCalendarSchedule({
    kind: 'weekly',
    startDate: '2026-09-21',
    weekdays: ['WEDNESDAY', 1, 'MO', 'wed'],
    times: ['14:00', '09:00', '09:00:00'],
    timeZone: 'UTC',
    catchUp: 'on',
    endDate: '2026-10-31',
    maxOccurrences: 20,
  });
  assert.deepEqual(schedule, {
    kind: CalendarScheduleKind.WEEKLY,
    timeZone: 'UTC',
    catchUp: 'ON',
    startDate: '2026-09-21',
    weekdays: [1, 3],
    times: ['09:00:00', '14:00:00'],
    endDate: '2026-10-31',
    maxOccurrences: 20,
  });
  assert.equal(calendarScheduleRevision(schedule), calendarScheduleRevision({ ...schedule, weekdays: [3, 1, 'MONDAY'] }));
});

test('WEEKLY emits selected weekdays and multiple clock times in chronological order', () => {
  const schedule = {
    kind: 'WEEKLY', startDate: '2026-09-21', weekdays: ['MO', 'WE'],
    times: ['09:00', '14:00'], timeZone: 'UTC', catchUp: 'ON',
  };
  let runtime = {};
  const seen = [];
  for (let index = 0; index < 5; index += 1) {
    const item = nextCalendarOccurrence({ sessionId: 'weekly', schedule, runtime, now: utc('2026-10-01T00:00:00Z') });
    seen.push(new Date(item.scheduledAt).toISOString());
    runtime = commitCalendarOccurrence(runtime, item);
  }
  assert.deepEqual(seen, [
    '2026-09-21T09:00:00.000Z',
    '2026-09-21T14:00:00.000Z',
    '2026-09-23T09:00:00.000Z',
    '2026-09-23T14:00:00.000Z',
    '2026-09-28T09:00:00.000Z',
  ]);
});

test('recurrence maxOccurrences is exact across DAILY multiple times', () => {
  const schedule = {
    kind: 'DAILY', startDate: '2026-09-20', times: ['09:00', '17:00'],
    timeZone: 'UTC', catchUp: 'ON', maxOccurrences: 3,
  };
  let runtime = {};
  for (let index = 0; index < 3; index += 1) {
    const item = nextCalendarOccurrence({ sessionId: 'bounded', schedule, runtime, now: utc('2026-10-01T00:00:00Z') });
    assert.ok(item);
    runtime = commitCalendarOccurrence(runtime, item);
  }
  assert.equal(nextCalendarOccurrence({ sessionId: 'bounded', schedule, runtime, now: utc('2026-10-01T00:00:00Z') }), null);
});

test('WEEKLY endDate is inclusive and exhausts after the final selected local date', () => {
  const schedule = {
    kind: 'WEEKLY', startDate: '2026-09-21', weekdays: ['MO', 'WE'],
    times: ['09:00'], timeZone: 'UTC', catchUp: 'ON', endDate: '2026-09-23',
  };
  let runtime = {};
  const first = nextCalendarOccurrence({ sessionId: 'end-date', schedule, runtime, now: utc('2026-10-01T00:00:00Z') });
  assert.equal(new Date(first.scheduledAt).toISOString(), '2026-09-21T09:00:00.000Z');
  runtime = commitCalendarOccurrence(runtime, first);
  const second = nextCalendarOccurrence({ sessionId: 'end-date', schedule, runtime, now: utc('2026-10-01T00:00:00Z') });
  assert.equal(new Date(second.scheduledAt).toISOString(), '2026-09-23T09:00:00.000Z');
  runtime = commitCalendarOccurrence(runtime, second);
  assert.equal(nextCalendarOccurrence({ sessionId: 'end-date', schedule, runtime, now: utc('2026-10-01T00:00:00Z') }), null);
});

test('WEEKLY catch-up OFF marks downtime backlog missed then advances to the next future occurrence', () => {
  const session = {
    id: 'catch-off',
    calendarSchedule: {
      kind: 'WEEKLY', startDate: '2026-09-21', weekdays: ['MO'],
      times: ['09:00'], timeZone: 'UTC', catchUp: 'OFF',
    },
    calendarRuntime: {},
  };
  const now = utc('2026-09-24T12:00:00Z');
  const missed = calendarAdmissionForSession(session, now);
  assert.equal(missed.kind, CalendarOccurrenceState.MISSED_SKIPPED);
  assert.equal(new Date(missed.occurrence.scheduledAt).toISOString(), '2026-09-21T09:00:00.000Z');
  const next = calendarAdmissionForSession(session, now);
  assert.equal(next.kind, CalendarOccurrenceState.WAITING);
  assert.equal(new Date(next.occurrence.scheduledAt).toISOString(), '2026-09-28T09:00:00.000Z');
});

test('WEEKLY preserves fail-closed DST handling for nonexistent local wall time', () => {
  const schedule = {
    kind: 'WEEKLY', startDate: '2026-03-29', weekdays: ['SU'],
    times: ['02:30'], timeZone: 'Europe/Bratislava', catchUp: 'ON',
  };
  assert.throws(
    () => nextCalendarOccurrence({ sessionId: 'dst', schedule, now: utc('2026-03-28T00:00:00Z') }),
    /does not exist/,
  );
});

test('recurrence bounds reject invalid ranges and counts', () => {
  assert.throws(() => normalizeCalendarSchedule({
    kind: 'DAILY', startDate: '2026-09-21', times: ['09:00'], timeZone: 'UTC',
    endDate: '2026-09-20',
  }), /precedes startDate/);
  assert.throws(() => normalizeCalendarSchedule({
    kind: 'WEEKLY', startDate: '2026-09-21', weekdays: ['MO'], times: ['09:00'], timeZone: 'UTC',
    maxOccurrences: 0,
  }), /maxOccurrences/);
  assert.throws(() => normalizeCalendarSchedule({
    kind: 'WEEKLY', startDate: '2026-09-21', weekdays: [], times: ['09:00'], timeZone: 'UTC',
  }), /1-7 unique weekdays/);
});
