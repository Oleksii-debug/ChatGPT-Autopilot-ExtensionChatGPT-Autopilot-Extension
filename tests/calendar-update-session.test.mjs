import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher, sessionFromUi } from '../src/core/commands.js';
import { createEmptyState, validateState } from '../src/core/schema.js';

class MemoryRepo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    this.state = await mutator(draft) || draft;
    this.state.revision = Number(this.state.revision || 0) + 1;
    validateState(this.state);
    return structuredClone(this.state);
  }
}

function config(calendarSchedule) {
  return {
    id: 'calendar-update',
    version: 1,
    name: 'Calendar update',
    promptMode: 'shared',
    urlMode: 'shared',
    sharedPrompt: 'hello',
    runMode: 'continuous',
    configuredTaskCount: 1,
    tasks: [{ id: 'task', enabled: true, url: 'https://chatgpt.com/', promptOverride: '' }],
    minimumSendIntervalValue: 2,
    minimumSendIntervalUnit: 'minutes',
    preSendDelaySeconds: 5,
    busyCheckDelaySeconds: 2,
    retryBackoffSeconds: 30,
    retryPolicy: 'safe',
    tabStrategy: 'keep-open',
    calendarSchedule,
  };
}

test('UPDATE_SESSION preserves durable calendarRuntime when calendar remains enabled', async () => {
  const schedule = {
    kind: 'WEEKLY',
    startDate: '2026-09-21',
    weekdays: ['MO', 'WE'],
    times: ['09:00'],
    timeZone: 'UTC',
    catchUp: 'ON',
  };
  const state = createEmptyState(1000);
  const session = sessionFromUi(config(schedule), 1000);
  session.calendarRuntime = {
    committedOccurrenceIds: ['already-done'],
    reconciledThroughByRevision: { old: 1234 },
    lastOccurrence: { state: 'COMPLETED', scheduledFor: 1200, executedAt: 1234 },
  };
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  const repo = new MemoryRepo(state);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);

  const result = await dispatcher.execute('UPDATE_SESSION', {
    sessionId: session.id,
    expectedVersion: session.version,
    config: { ...config(schedule), name: 'Calendar update renamed' },
  });

  assert.equal(result.session.name, 'Calendar update renamed');
  assert.deepEqual(result.session.calendarRuntime, session.calendarRuntime);
  assert.equal(result.session.calendarSchedule.kind, 'WEEKLY');
  const stored = await repo.load();
  assert.deepEqual(stored.sessionsById[session.id].calendarRuntime, session.calendarRuntime);
});

test('UPDATE_SESSION clears stale calendarRuntime when calendar is disabled', async () => {
  const schedule = {
    kind: 'DAILY',
    startDate: '2026-09-21',
    times: ['09:00'],
    timeZone: 'UTC',
    catchUp: 'OFF',
  };
  const state = createEmptyState(1000);
  const session = sessionFromUi(config(schedule), 1000);
  session.calendarRuntime = { committedOccurrenceIds: ['old'], reconciledThrough: 999 };
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  const repo = new MemoryRepo(state);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);

  const result = await dispatcher.execute('UPDATE_SESSION', {
    sessionId: session.id,
    expectedVersion: session.version,
    config: config(null),
  });

  assert.equal(result.session.calendarSchedule, null);
  assert.deepEqual(result.session.calendarRuntime, {});
});


test('UPDATE_SESSION rejects a changed calendar revision without explicit owner confirmation', async () => {
  const schedule = {
    kind: 'DAILY', startDate: '2026-09-21', times: ['09:00'],
    timeZone: 'UTC', catchUp: 'ON',
  };
  const state = createEmptyState(1000);
  const session = sessionFromUi(config(schedule), 1000);
  session.calendarRuntime = { committedOccurrenceIds: ['proof'], reconciledThroughByRevision: { old: 1000 } };
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  const repo = new MemoryRepo(state);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  const changed = { ...schedule, timeZone: 'Europe/Bratislava' };

  await assert.rejects(
    dispatcher.execute('UPDATE_SESSION', {
      sessionId: session.id,
      expectedVersion: session.version,
      config: config(changed),
    }),
    /Confirm the new calendar revision/,
  );
  const unchanged = await repo.load();
  assert.equal(unchanged.sessionsById[session.id].calendarSchedule.timeZone, 'UTC');

  const accepted = await dispatcher.execute('UPDATE_SESSION', {
    sessionId: session.id,
    expectedVersion: session.version,
    config: config(changed),
    confirmCalendarRevisionChange: true,
  });
  assert.equal(accepted.session.calendarSchedule.timeZone, 'Europe/Bratislava');
  assert.deepEqual(accepted.session.calendarRuntime, session.calendarRuntime);
});
