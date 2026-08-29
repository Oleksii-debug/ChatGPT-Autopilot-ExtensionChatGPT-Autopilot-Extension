import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextWake } from '../../src/core/recovery.js';
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

test('all tasks in retry backoff schedule the next wake at earliest retry instead of now', () => {
  const now = 100_000;
  const state = createEmptyState(1);
  const session = runningSessionWithRetriedTasks(now);
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);

  const wakeAt = computeNextWake(state, now);
  assert.equal(wakeAt, now + 30_000,
    'an active session with no currently eligible task must sleep until the earliest retryAfterAt');
});

test('expired session send cooldown does not defeat task retry backoff', () => {
  const now = 200_000;
  const state = createEmptyState(1);
  const session = runningSessionWithRetriedTasks(now);
  session.nextAllowedSendAt = now - 5_000;
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);

  const wakeAt = computeNextWake(state, now);
  assert.ok(wakeAt > now, 'expired send cooldown must not create an immediate alarm while every task is backed off');
  assert.equal(wakeAt, now + 30_000);
});
