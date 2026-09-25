import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPortableProfile, exportPortableProfile } from '../src/core/portable-profile.js';
import { createEmptyState, createSession, createTask } from '../src/core/schema.js';

function scheduledState() {
  const state = createEmptyState(1);
  const session = createSession({
    id: 'portable-calendar',
    name: 'Portable calendar',
    tasks: [createTask({ id: 'task', url: 'https://chatgpt.com/' })],
    sharedPrompt: 'hello',
    now: 1,
  });
  session.calendarSchedule = {
    kind: 'WEEKLY',
    timeZone: 'Europe/Bratislava',
    catchUp: 'ON',
    startDate: '2026-09-21',
    weekdays: [1, 3],
    times: ['09:00:00', '14:00:00'],
    endDate: '2026-12-31',
    maxOccurrences: 20,
  };
  session.calendarRuntime = {
    committedOccurrenceIds: ['local-runtime-evidence-must-not-export'],
    lastOccurrence: { state: 'COMPLETED', scheduledFor: 10, executedAt: 11 },
  };
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  return state;
}

test('portable profile round-trips calendar configuration but not machine runtime evidence', () => {
  const exported = exportPortableProfile(scheduledState());
  assert.deepEqual(exported.sessions[0].calendarSchedule, {
    kind: 'WEEKLY',
    timeZone: 'Europe/Bratislava',
    catchUp: 'ON',
    startDate: '2026-09-21',
    weekdays: [1, 3],
    times: ['09:00:00', '14:00:00'],
    endDate: '2026-12-31',
    maxOccurrences: 20,
  });
  assert.equal('calendarRuntime' in exported.sessions[0], false);

  const target = createEmptyState(2);
  const result = applyPortableProfile(target, exported, { now: 2, confirmAutoStart: false });
  assert.deepEqual(result.importedSessionIds, ['portable-calendar']);
  assert.deepEqual(target.sessionsById['portable-calendar'].calendarSchedule, exported.sessions[0].calendarSchedule);
  assert.deepEqual(target.sessionsById['portable-calendar'].calendarRuntime, {});
});

test('portable profile fails closed on malformed calendar schedule', () => {
  const exported = exportPortableProfile(scheduledState());
  exported.sessions[0].calendarSchedule.weekdays = [];
  const target = createEmptyState(2);
  assert.throws(() => applyPortableProfile(target, exported, { now: 2 }), /1-7 unique weekdays/);
  assert.deepEqual(target.sessionOrder, []);
});
