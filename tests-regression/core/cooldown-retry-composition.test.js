import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';
import { selectNextTask } from '../../src/core/scheduler.js';
import { computeNextWake, reconcileAlarm } from '../../src/core/recovery.js';

function runningSession({ now, cooldownAt, retryOffsets }) {
  const tasks = retryOffsets.map((offset, index) => {
    const task = createTask({ id: `t${index + 1}`, url: `https://chatgpt.com/c/cooldown-retry-${index + 1}` });
    task.retryAfterAt = offset == null ? 0 : now + offset;
    return task;
  });
  const session = createSession({
    id: 's1',
    name: 'Cooldown retry composition',
    tasks,
    minimumSendIntervalMs: 120000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  session.nextAllowedSendAt = cooldownAt;
  return session;
}

function stateWith(session) {
  const state = createEmptyState(1);
  state.sessionsById[session.id] = session;
  state.sessionOrder = [session.id];
  return state;
}

test('cooldown ending before every task retry sleeps directly until the earliest actionable retry', async () => {
  const now = 100000;
  const session = runningSession({ now, cooldownAt: now + 5000, retryOffsets: [30000, 60000] });

  assert.deepEqual(selectNextTask(session, now), { kind: 'COOLDOWN', wakeAt: now + 30000 });
  assert.equal(computeNextWake(stateWith(session), now), now + 30000);

  const calls = [];
  const chrome = { alarms: {
    clear: async name => calls.push(['clear', name]),
    create: async (name, options) => calls.push(['create', name, options.when]),
  } };
  await reconcileAlarm(chrome, stateWith(session), now);
  assert.deepEqual(calls, [['create', 'autopilot-core-wake', now + 30000]]);
});

test('cooldown remains authoritative when a task retry expires earlier', () => {
  const now = 200000;
  const session = runningSession({ now, cooldownAt: now + 30000, retryOffsets: [5000, 60000] });

  assert.deepEqual(selectNextTask(session, now), { kind: 'COOLDOWN', wakeAt: now + 30000 });
  assert.equal(computeNextWake(stateWith(session), now), now + 30000);

  const due = selectNextTask(session, now + 30000);
  assert.equal(due.kind, 'TASK');
  assert.equal(due.task.id, 't1');
});

test('ready task behind cooldown keeps the exact cooldown deadline and stable cursor order', () => {
  const now = 300000;
  const session = runningSession({ now, cooldownAt: now + 10000, retryOffsets: [null, 30000] });
  session.currentTaskIndex = 0;

  assert.deepEqual(selectNextTask(session, now), { kind: 'COOLDOWN', wakeAt: now + 10000 });
  const due = selectNextTask(session, now + 10000);
  assert.equal(due.kind, 'TASK');
  assert.equal(due.task.id, 't1');
});

test('irrelevant disabled retry deadline cannot become scheduler wake authority', () => {
  const now = 400000;
  const session = runningSession({ now, cooldownAt: 0, retryOffsets: [5000, 30000] });
  session.tasksById.t1.enabled = false;

  assert.deepEqual(selectNextTask(session, now), { kind: 'WAIT', wakeAt: now + 30000 });
  assert.equal(computeNextWake(stateWith(session), now), now + 30000);
});
