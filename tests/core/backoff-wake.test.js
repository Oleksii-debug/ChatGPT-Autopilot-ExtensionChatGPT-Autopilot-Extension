import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextWake, reconcileAlarm, ALARM_NAME } from '../../src/core/recovery.js';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';

function runningSession(now, retryOffsets = [30_000, 60_000]) {
  const tasks = retryOffsets.map((offset, index) => {
    const task = createTask({ id: `t${index + 1}`, url: `https://chatgpt.com/c/${index + 1}` });
    task.retryAfterAt = offset == null ? 0 : now + offset;
    return task;
  });
  const session = createSession({
    id: 's1',
    name: 'scheduler wake parity',
    tasks,
    sharedPrompt: 'continue',
    now: 1,
  });
  session.runState = RunState.RUNNING;
  session.nextAllowedSendAt = 0;
  return session;
}

function stateWithSession(session) {
  const state = createEmptyState(1);
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  return state;
}

test('all tasks in retry backoff wake at the earliest retry rather than now', () => {
  const now = 100_000;
  const state = stateWithSession(runningSession(now));
  assert.equal(computeNextWake(state, now), now + 30_000);
});

test('expired session cooldown cannot defeat task retry backoff', () => {
  const now = 200_000;
  const session = runningSession(now);
  session.nextAllowedSendAt = now - 5_000;
  const state = stateWithSession(session);
  assert.equal(computeNextWake(state, now), now + 30_000);
});

test('canonical alarm replaces same-name wake without clearing it first', async () => {
  const now = 300_000;
  const state = stateWithSession(runningSession(now));
  const calls = [];
  const chromeApi = {
    alarms: {
      async clear(name) { calls.push(['clear', name]); return true; },
      async create(name, options) { calls.push(['create', name, options.when]); },
    },
  };

  const wakeAt = await reconcileAlarm(chromeApi, state, now);
  assert.equal(wakeAt, now + 30_000);
  assert.deepEqual(calls, [
    ['create', ALARM_NAME, now + 30_000],
  ]);
});

test('failed alarm replacement never clears the previous canonical wake first', async () => {
  const now = 350_000;
  const state = stateWithSession(runningSession(now));
  const calls = [];
  const chromeApi = {
    alarms: {
      async clear(name) { calls.push(['clear', name]); return true; },
      async create(name, options) {
        calls.push(['create', name, options.when]);
        throw new Error('synthetic alarm create failure');
      },
    },
  };

  await assert.rejects(
    reconcileAlarm(chromeApi, state, now),
    /synthetic alarm create failure/,
  );
  assert.deepEqual(calls, [
    ['create', ALARM_NAME, now + 30_000],
  ]);
});

test('quiescent durable state clears the canonical alarm', async () => {
  const now = 375_000;
  const calls = [];
  const chromeApi = {
    alarms: {
      async clear(name) { calls.push(['clear', name]); return true; },
      async create(name, options) { calls.push(['create', name, options.when]); },
    },
  };

  const wakeAt = await reconcileAlarm(chromeApi, createEmptyState(1), now);
  assert.equal(wakeAt, null);
  assert.deepEqual(calls, [['clear', ALARM_NAME]]);
});

test('a currently eligible task still requests an immediate runtime cycle', () => {
  const now = 400_000;
  const session = runningSession(now, [null, 60_000]);
  const state = stateWithSession(session);
  assert.equal(computeNextWake(state, now), now);
});
