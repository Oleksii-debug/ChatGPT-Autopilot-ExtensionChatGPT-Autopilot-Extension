import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CalendarOccurrenceState,
  calendarAdmissionForSession,
  commitVerifiedCalendarOccurrence,
} from '../src/core/calendar-runtime.js';

const utc = value => Date.parse(value);
function session(schedule, id = 'session-calendar') { return { id, calendarSchedule: schedule, calendarRuntime: {} }; }

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
});

test('catch-up OFF durably skips missed backlog and advances to subsequent occurrence after restart', () => {
  const s = session({ kind: 'EXPLICIT', timeZone: 'UTC', catchUp: 'OFF', occurrences: [
    { date: '2026-09-21', time: '08:00' }, { date: '2026-09-21', time: '09:00' }, { date: '2026-09-21', time: '14:00' },
  ] });
  const now = utc('2026-09-21T12:00:00Z');
  const skipped = calendarAdmissionForSession(s, now);
  assert.equal(skipped.kind, CalendarOccurrenceState.MISSED_SKIPPED);
  assert.equal(s.calendarRuntime.lastOccurrence.state, CalendarOccurrenceState.MISSED_SKIPPED);
  assert.equal(s.calendarRuntime.reconciledThrough, now - 1);
  const persistedRuntime = structuredClone(s.calendarRuntime);
  const restarted = { id: s.id, calendarSchedule: s.calendarSchedule, calendarRuntime: persistedRuntime };
  const next = calendarAdmissionForSession(restarted, utc('2026-09-21T12:01:00Z'));
  assert.equal(next.kind, CalendarOccurrenceState.WAITING);
  assert.equal(next.occurrence.scheduledAt, utc('2026-09-21T14:00:00Z'));
});

test('catch-up OFF DAILY with old startDate reconciles historical backlog in one admission', () => {
  const s = session({ kind: 'DAILY', timeZone: 'UTC', catchUp: 'OFF', startDate: '2020-01-01', times: ['08:00', '12:00', '18:00'] });
  const now = utc('2026-09-21T15:00:00Z');
  const skipped = calendarAdmissionForSession(s, now);
  assert.equal(skipped.kind, CalendarOccurrenceState.MISSED_SKIPPED);
  assert.equal(s.calendarRuntime.reconciledThrough, now - 1);
  assert.equal(s.calendarRuntime.lastOccurrence.reconciledThrough, now - 1);
  const next = calendarAdmissionForSession(s, now);
  assert.equal(next.kind, CalendarOccurrenceState.WAITING);
  assert.equal(next.occurrence.scheduledAt, utc('2026-09-21T18:00:00Z'));
});

test('catch-up OFF DAILY probe stays age-independent across DST zone', () => {
  const old = session({ kind: 'DAILY', timeZone: 'Europe/Bratislava', catchUp: 'OFF', startDate: '2000-01-01', times: ['08:00', '12:00', '18:00'] });
  const recent = session({ kind: 'DAILY', timeZone: 'Europe/Bratislava', catchUp: 'OFF', startDate: '2026-10-23', times: ['08:00', '12:00', '18:00'] }, 'recent');
  const now = utc('2026-10-26T14:00:00Z');
  const oldResult = calendarAdmissionForSession(old, now);
  const recentResult = calendarAdmissionForSession(recent, now);
  assert.equal(oldResult.kind, CalendarOccurrenceState.MISSED_SKIPPED);
  assert.equal(recentResult.kind, CalendarOccurrenceState.MISSED_SKIPPED);
  assert.ok(oldResult.occurrence.scheduledAt >= now - 3 * 24 * 60 * 60 * 1000);
  assert.ok(recentResult.occurrence.scheduledAt >= now - 3 * 24 * 60 * 60 * 1000);
  assert.equal(old.calendarRuntime.reconciledThrough, now - 1);
  assert.equal(recent.calendarRuntime.reconciledThrough, now - 1);
});

test('catch-up OFF DAILY with future start does not synthesize a missed occurrence', () => {
  const s = session({ kind: 'DAILY', timeZone: 'UTC', catchUp: 'OFF', startDate: '2026-09-22', times: ['08:00', '18:00'] });
  const result = calendarAdmissionForSession(s, utc('2026-09-21T15:00:00Z'));
  assert.equal(result.kind, CalendarOccurrenceState.WAITING);
  assert.equal(result.occurrence.scheduledAt, utc('2026-09-22T08:00:00Z'));
  assert.deepEqual(s.calendarRuntime, {});
});

test('catch-up ON exposes missed occurrence without silently committing it', () => {
  const s = session({ kind: 'EXPLICIT', timeZone: 'UTC', catchUp: 'ON', occurrences: [
    { date: '2026-09-21', time: '09:00' }, { date: '2026-09-21', time: '14:00' },
  ] });
  const result = calendarAdmissionForSession(s, utc('2026-09-21T12:00:00Z'));
  assert.equal(result.kind, CalendarOccurrenceState.MISSED_WAITING_CATCHUP);
  assert.deepEqual(s.calendarRuntime, {});
});

test('verified commit advances durable occurrence identity exactly once', () => {
  const s = session({ kind: 'EXPLICIT', timeZone: 'UTC', catchUp: 'ON', occurrences: [
    { date: '2026-09-21', time: '09:00' }, { date: '2026-09-21', time: '14:00' },
  ] });
  const first = calendarAdmissionForSession(s, utc('2026-09-21T12:00:00Z')).occurrence;
  commitVerifiedCalendarOccurrence(s, first, utc('2026-09-21T12:01:00Z'));
  assert.equal(s.calendarRuntime.lastOccurrence.state, CalendarOccurrenceState.COMPLETED);
  const next = calendarAdmissionForSession(s, utc('2026-09-21T12:02:00Z'));
  assert.equal(next.kind, CalendarOccurrenceState.WAITING);
  assert.equal(next.occurrence.scheduledAt, utc('2026-09-21T14:00:00Z'));
});

test('verified commit rejects occurrence from another Session', () => {
  const schedule = { kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'ON', date: '2026-09-21', time: '09:00' };
  const foreign = session(schedule, 'foreign');
  const local = session(schedule, 'local');
  const occurrence = calendarAdmissionForSession(foreign, utc('2026-09-21T09:00:00Z')).occurrence;
  assert.throws(() => commitVerifiedCalendarOccurrence(local, occurrence), /does not belong/);
  assert.deepEqual(local.calendarRuntime, {});
});

test('verified commit rejects occurrence from superseded schedule revision', () => {
  const s = session({ kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'ON', date: '2026-09-21', time: '09:00' });
  const stale = calendarAdmissionForSession(s, utc('2026-09-21T09:00:00Z')).occurrence;
  s.calendarSchedule = { kind: 'ONE_TIME', timeZone: 'UTC', catchUp: 'ON', date: '2026-09-22', time: '09:00' };
  assert.throws(() => commitVerifiedCalendarOccurrence(s, stale), /does not belong/);
  assert.deepEqual(s.calendarRuntime, {});
});

test('unscheduled sessions remain backward compatible', () => {
  assert.deepEqual(calendarAdmissionForSession({ id: 'legacy' }, 0), { kind: 'UNSCHEDULED', occurrence: null });
});


test('catch-up OFF INTERVAL skips offline backlog and wakes at first future interval', () => {
  const s = session({ kind: 'INTERVAL', timeZone: 'UTC', catchUp: 'OFF', startDate: '2026-09-25', startTime: '04:00', intervalSeconds: 3600 });
  const now = utc('2026-09-25T06:30:00Z');
  const skipped = calendarAdmissionForSession(s, now);
  assert.equal(skipped.kind, CalendarOccurrenceState.MISSED_SKIPPED);
  assert.equal(s.calendarRuntime.reconciledThrough, now - 1);
  const next = calendarAdmissionForSession(s, now);
  assert.equal(next.kind, CalendarOccurrenceState.WAITING);
  assert.equal(next.occurrence.scheduledAt, utc('2026-09-25T07:00:00Z'));
});

test('catch-up ON INTERVAL exposes oldest missed occurrence without auto-commit', () => {
  const s = session({ kind: 'INTERVAL', timeZone: 'UTC', catchUp: 'ON', startDate: '2026-09-25', startTime: '04:00', intervalSeconds: 3600 });
  const result = calendarAdmissionForSession(s, utc('2026-09-25T06:30:00Z'));
  assert.equal(result.kind, CalendarOccurrenceState.MISSED_WAITING_CATCHUP);
  assert.equal(result.occurrence.scheduledAt, utc('2026-09-25T04:00:00Z'));
  assert.deepEqual(s.calendarRuntime, {});
});
