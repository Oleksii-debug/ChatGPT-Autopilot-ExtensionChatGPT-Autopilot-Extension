import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionToUi } from '../src/core/commands.js';
import { createEmptyState, createSession, createTask } from '../src/core/schema.js';

test('sessionToUi exposes derived next/last calendar status without mutating durable runtime', () => {
  const now = Date.parse('2026-09-24T08:00:00Z');
  const state = createEmptyState(now);
  const session = createSession({
    id: 'calendar-projection',
    name: 'calendar projection',
    tasks: [createTask({ id: 'task', url: 'https://chatgpt.com/' })],
    sharedPrompt: 'hello',
    now,
  });
  session.calendarSchedule = {
    kind: 'WEEKLY',
    startDate: '2026-09-21',
    weekdays: [4],
    times: ['09:00:00'],
    timeZone: 'UTC',
    catchUp: 'OFF',
  };
  session.calendarRuntime = {};
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);

  const before = structuredClone(session.calendarRuntime);
  const ui = sessionToUi(session, state, now);
  assert.equal(ui.calendar.enabled, true);
  assert.equal(ui.calendar.scheduleKind, 'WEEKLY');
  assert.equal(ui.calendar.admissionState, 'WAITING');
  assert.equal(ui.calendar.nextOccurrence.scheduledFor, Date.parse('2026-09-24T09:00:00Z'));
  assert.deepEqual(session.calendarRuntime, before);
});
