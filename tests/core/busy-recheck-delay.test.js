import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';
import { applyInteractionResult } from '../../src/core/execution.js';
import { selectNextTask } from '../../src/core/scheduler.js';
import { computeNextWake, reconcileAlarm } from '../../src/core/recovery.js';
import { InteractionResult } from '../../src/shared/protocol.js';

function sessionWithTasks(count, busyCheckDelayMs = 5000) {
  const tasks = Array.from({ length: count }, (_, index) => createTask({
    id: `t${index + 1}`,
    url: `https://chatgpt.com/c/busy-${index + 1}`,
  }));
  const session = createSession({
    id: 's1',
    name: 'Busy recheck',
    tasks,
    busyCheckDelayMs,
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

test('single BUSY task sleeps until configured recheck deadline without consuming send cooldown', async () => {
  const session = sessionWithTasks(1, 5000);
  const result = applyInteractionResult(session, 0, { status: InteractionResult.BUSY }, { now: 100 });

  assert.deepEqual(result, { action: 'ADVANCE_NO_COOLDOWN', retryAt: 5100 });
  assert.equal(session.nextAllowedSendAt, 0);
  assert.equal(session.tasksById.t1.retryAfterAt, 5100);
  assert.deepEqual(selectNextTask(session, 100), { kind: 'WAIT', wakeAt: 5100 });
  assert.equal(computeNextWake(stateWith(session), 100), 5100);

  const calls = [];
  const chrome = { alarms: {
    clear: async name => calls.push(['clear', name]),
    create: async (name, options) => calls.push(['create', name, options.when]),
  } };
  await reconcileAlarm(chrome, stateWith(session), 100);
  assert.deepEqual(calls[1], ['create', 'autopilot-core-wake', 5100]);
});

test('round-robin skips each BUSY task immediately, then waits for the earliest per-task recheck', () => {
  const session = sessionWithTasks(3, 5000);

  let selection = selectNextTask(session, 100);
  assert.equal(selection.task.id, 't1');
  applyInteractionResult(session, selection.index, { status: InteractionResult.BUSY }, { now: 100 });

  selection = selectNextTask(session, 200);
  assert.equal(selection.task.id, 't2');
  applyInteractionResult(session, selection.index, { status: InteractionResult.BUSY }, { now: 200 });

  selection = selectNextTask(session, 300);
  assert.equal(selection.task.id, 't3');
  applyInteractionResult(session, selection.index, { status: InteractionResult.BUSY }, { now: 300 });

  assert.equal(session.nextAllowedSendAt, 0);
  assert.deepEqual(selectNextTask(session, 300), { kind: 'WAIT', wakeAt: 5100 });
  assert.equal(computeNextWake(stateWith(session), 300), 5100);

  const due = selectNextTask(session, 5100);
  assert.equal(due.kind, 'TASK');
  assert.equal(due.task.id, 't1');
});
