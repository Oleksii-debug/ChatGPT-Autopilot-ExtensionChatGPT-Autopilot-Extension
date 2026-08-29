import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextWake, reconcileAlarm, ALARM_NAME } from '../../src/core/recovery.js';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';

function runningSessionWithRetriedTasks(now) {
  const t1 = createTask({ id: 't1', url: 'https://chatgpt.com/c/1' });
  const t2 = createTask({ id: 't2', url: 'https://chatgpt.com/c/2' });
  t1.retryAfterAt = now + 30_000;
  t2.retryAfterAt = now + 60_000;

  const session = createSession({
    id: 's1',
    name: 'all tasks backoff',
    tasks: [t1, t2],
    sharedPrompt: 'continue',
    now: 1,
  });
  session.runState = RunState.RUNNING;
  session.nextAllowedSendAt = 0;
  return session;
}

function stateWithRetriedTasks(now) {
  const state = createEmptyState(1);
  const session = runningSessionWithRetriedTasks(now);
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  return { state, session };
}

test('all tasks in retry backoff schedule the next wake at earliest retry instead of now', () => {
  const now = 100_000;
  const { state } = stateWithRetriedTasks(now);

  const wakeAt = computeNextWake(state, now);
  assert.equal(wakeAt, now + 30_000,
    'an active session with no currently eligible task must sleep until the earliest retryAfterAt');
});

test('expired session send cooldown does not defeat task retry backoff', () => {
  const now = 200_000;
  const { state, session } = stateWithRetriedTasks(now);
  session.nextAllowedSendAt = now - 5_000;

  const wakeAt = computeNextWake(state, now);
  assert.ok(wakeAt > now, 'expired send cooldown must not create an immediate alarm while every task is backed off');
  assert.equal(wakeAt, now + 30_000);
});

test('canonical alarm is not recreated at the 500ms floor while every task is backed off', async () => {
  const now = 300_000;
  const { state } = stateWithRetriedTasks(now);
  const calls = [];
  const chromeApi = {
    alarms: {
      async clear(name) { calls.push(['clear', name]); return true; },
      async create(name, options) { calls.push(['create', name, options.when]); },
    },
  };

  const wakeAt = await reconcileAlarm(chromeApi, state, now);

  assert.equal(wakeAt, now + 30_000,
    'durable alarm authority must follow the earliest task retry rather than an expired session deadline');
  assert.deepEqual(calls, [
    ['clear', ALARM_NAME],
    ['create', ALARM_NAME, now + 30_000],
  ]);
});
