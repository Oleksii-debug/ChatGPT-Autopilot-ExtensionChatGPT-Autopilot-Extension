import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFromUi } from '../src/core/commands.js';
import { createEmptyState, validateState } from '../src/core/schema.js';

function baseConfig(overrides = {}) {
  return {
    id: 'calendar-ui-session',
    version: 1,
    name: 'Calendar session',
    promptMode: 'shared',
    urlMode: 'shared',
    sharedPrompt: 'hello',
    runMode: 'continuous',
    configuredTaskCount: 1,
    tasks: [{ id: 'task-1', enabled: true, url: 'https://chatgpt.com/', promptOverride: '' }],
    minimumSendIntervalValue: 2,
    minimumSendIntervalUnit: 'minutes',
    preSendDelaySeconds: 5,
    busyCheckDelaySeconds: 2,
    retryBackoffSeconds: 30,
    retryPolicy: 'safe',
    tabStrategy: 'keep-open',
    ...overrides,
  };
}

test('sessionFromUi admits and normalizes calendar schedule into canonical Session state', () => {
  const session = sessionFromUi(baseConfig({
    calendarSchedule: {
      kind: 'weekly',
      startDate: '2026-09-21',
      weekdays: ['WEDNESDAY', 'MO'],
      times: ['14:00', '09:00'],
      timeZone: 'Europe/Bratislava',
      catchUp: 'on',
      endDate: '2026-12-31',
      maxOccurrences: 12,
    },
  }), 1000);
  assert.deepEqual(session.calendarSchedule, {
    kind: 'WEEKLY',
    timeZone: 'Europe/Bratislava',
    catchUp: 'ON',
    startDate: '2026-09-21',
    weekdays: [1, 3],
    times: ['09:00:00', '14:00:00'],
    endDate: '2026-12-31',
    maxOccurrences: 12,
  });
  assert.deepEqual(session.calendarRuntime, {});

  const state = createEmptyState(1000);
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  assert.doesNotThrow(() => validateState(state));
});

test('sessionFromUi fails closed on malformed calendar schedule instead of silently dropping it', () => {
  assert.throws(() => sessionFromUi(baseConfig({
    calendarSchedule: {
      kind: 'WEEKLY',
      startDate: '2026-09-21',
      weekdays: [],
      times: ['09:00'],
      timeZone: 'UTC',
      catchUp: 'OFF',
    },
  }), 1000), /1-7 unique weekdays/);
});

test('sessionFromUi keeps ordinary unscheduled Sessions backward compatible', () => {
  const session = sessionFromUi(baseConfig(), 1000);
  assert.equal(session.calendarSchedule, null);
  assert.deepEqual(session.calendarRuntime, {});
});
