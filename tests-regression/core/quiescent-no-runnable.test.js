import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';
import { selectNextTask } from '../../src/core/scheduler.js';
import { computeNextWake, reconcileAlarm } from '../../src/core/recovery.js';

function continuousSession(tasks, overrides = {}) {
  const session = createSession({
    id: overrides.id || 's1',
    name: overrides.name || 'Quiescent',
    tasks,
    busyCheckDelayMs: 5000,
    minimumSendIntervalMs: 120000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  Object.assign(session, overrides);
  return session;
}

function stateWith(...sessions) {
  const state = createEmptyState(1);
  for (const session of sessions) {
    state.sessionsById[session.id] = session;
    state.sessionOrder.push(session.id);
  }
  return state;
}

test('continuous all-manual-review session is quiescent and owns no canonical alarm', async () => {
  const now = 100000;
  const t1 = createTask({ id: 't1', url: 'https://chatgpt.com/c/manual-1' });
  const t2 = createTask({ id: 't2', url: 'https://chatgpt.com/c/manual-2' });
  t1.manualReviewReason = 'AUTH_REQUIRED';
  t1.status = 'MANUAL_REVIEW';
  t2.manualReviewReason = 'MANUAL_REVIEW_REQUIRED';
  t2.status = 'MANUAL_REVIEW';
  const session = continuousSession([t1, t2], { nextAllowedSendAt: now + 120000 });

  assert.deepEqual(selectNextTask(session, now), { kind: 'IDLE' });
  assert.equal(computeNextWake(stateWith(session), now), null);

  const calls = [];
  const chrome = { alarms: {
    clear: async name => calls.push(['clear', name]),
    create: async (name, options) => calls.push(['create', name, options.when]),
  } };
  await reconcileAlarm(chrome, stateWith(session), now);
  assert.deepEqual(calls, [['clear', 'autopilot-core-wake']]);
});

test('continuous all-disabled legacy active state does not poll busyCheckDelay forever', () => {
  const now = 200000;
  const t1 = createTask({ id: 't1', url: 'https://chatgpt.com/c/disabled-1', enabled: false });
  const t2 = createTask({ id: 't2', url: 'https://chatgpt.com/c/disabled-2', enabled: false });
  const session = continuousSession([t1, t2]);

  assert.deepEqual(selectNextTask(session, now), { kind: 'IDLE' });
  assert.equal(computeNextWake(stateWith(session), now), null);
});

test('manual-review tasks do not suppress a schedulable future retry in the same session', () => {
  const now = 300000;
  const held = createTask({ id: 'held', url: 'https://chatgpt.com/c/held' });
  held.manualReviewReason = 'UNKNOWN_UI';
  held.status = 'MANUAL_REVIEW';
  const retry = createTask({ id: 'retry', url: 'https://chatgpt.com/c/retry' });
  retry.retryAfterAt = now + 30000;
  retry.status = 'RETRY_WAIT';
  const session = continuousSession([held, retry]);

  assert.deepEqual(selectNextTask(session, now), { kind: 'WAIT', wakeAt: now + 30000 });
  assert.equal(computeNextWake(stateWith(session), now), now + 30000);
});

test('quiescent manual-review session cannot hide another session actionable now', () => {
  const now = 400000;
  const held = createTask({ id: 'held', url: 'https://chatgpt.com/c/held-only' });
  held.manualReviewReason = 'AUTH_REQUIRED';
  const quiescent = continuousSession([held], { id: 'held-session' });

  const ready = createTask({ id: 'ready', url: 'https://chatgpt.com/c/ready' });
  const active = continuousSession([ready], { id: 'active-session' });

  assert.deepEqual(selectNextTask(quiescent, now), { kind: 'IDLE' });
  assert.equal(selectNextTask(active, now).kind, 'TASK');
  assert.equal(computeNextWake(stateWith(quiescent, active), now), now);
});
