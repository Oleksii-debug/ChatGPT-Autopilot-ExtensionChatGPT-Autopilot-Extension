import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunMode, RunState } from '../../src/core/schema.js';
import { selectNextTask, advanceAfterVerifiedSend } from '../../src/core/scheduler.js';
import { computeNextWake, reconcileAlarm } from '../../src/core/recovery.js';

function onePassSession() {
  const session = createSession({
    id: 's1',
    name: 'One pass cooldown',
    tasks: [createTask({ id: 't1', url: 'https://chatgpt.com/c/one-pass-cooldown' })],
    runMode: RunMode.ONE_PASS,
    minimumSendIntervalMs: 120000,
    now: 0,
  });
  session.runState = RunState.RUNNING;
  return session;
}

function stateWith(session) {
  const state = createEmptyState(0);
  state.sessionsById[session.id] = session;
  state.sessionOrder = [session.id];
  return state;
}

test('one-pass completion is not delayed by the cooldown created by its final verified send', async () => {
  const session = onePassSession();
  const selected = selectNextTask(session, 1000);
  assert.equal(selected.kind, 'TASK');

  advanceAfterVerifiedSend(session, selected.index, 1000);
  assert.equal(session.nextAllowedSendAt, 121000);
  assert.deepEqual(selectNextTask(session, 1001), { kind: 'COMPLETE' });
  assert.equal(computeNextWake(stateWith(session), 1001), 1001);

  const calls = [];
  const chrome = { alarms: {
    clear: async name => calls.push(['clear', name]),
    create: async (name, options) => calls.push(['create', name, options.when]),
  } };
  await reconcileAlarm(chrome, stateWith(session), 1001);
  assert.deepEqual(calls[1], ['create', 'autopilot-core-wake', 1501]);
});

test('one-pass cooldown still blocks an unfinished eligible task', () => {
  const session = createSession({
    id: 's2',
    name: 'One pass unfinished',
    tasks: [
      createTask({ id: 't1', url: 'https://chatgpt.com/c/one-pass-first' }),
      createTask({ id: 't2', url: 'https://chatgpt.com/c/one-pass-second' }),
    ],
    runMode: RunMode.ONE_PASS,
    minimumSendIntervalMs: 120000,
    now: 0,
  });
  session.runState = RunState.RUNNING;
  session.onePassCompletedTaskIds = ['t1'];
  session.currentTaskIndex = 1;
  session.nextAllowedSendAt = 5000;

  assert.deepEqual(selectNextTask(session, 1000), { kind: 'COOLDOWN', wakeAt: 5000 });
  const due = selectNextTask(session, 5000);
  assert.equal(due.kind, 'TASK');
  assert.equal(due.task.id, 't2');
});
