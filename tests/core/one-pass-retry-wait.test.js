import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunMode, RunState } from '../../src/core/schema.js';
import { selectNextTask, advanceAfterVerifiedSend } from '../../src/core/scheduler.js';
import { computeNextWake } from '../../src/core/recovery.js';
import { applyInteractionResult } from '../../src/core/execution.js';
import { InteractionResult } from '../../src/shared/protocol.js';

function onePassSession(taskCount = 2) {
  const tasks = Array.from({ length: taskCount }, (_, index) => createTask({
    id: `t${index + 1}`,
    url: `https://chatgpt.com/c/one-pass-${index + 1}`,
  }));
  const session = createSession({
    id: 's1',
    name: 'One pass',
    tasks,
    runMode: RunMode.ONE_PASS,
    minimumSendIntervalMs: 0,
    retryBackoffMs: 30000,
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

test('one-pass waits for an unfinished task retry instead of completing the session', () => {
  const session = onePassSession(2);
  session.onePassCompletedTaskIds.push('t1');
  session.currentTaskIndex = 1;
  session.tasksById.t2.retryAfterAt = 5000;

  assert.deepEqual(selectNextTask(session, 1000), { kind: 'WAIT', wakeAt: 5000 });
  assert.equal(computeNextWake(stateWith(session), 1000), 5000);

  const due = selectNextTask(session, 5000);
  assert.equal(due.kind, 'TASK');
  assert.equal(due.task.id, 't2');

  advanceAfterVerifiedSend(session, due.index, 5000);
  assert.equal(selectNextTask(session, 5000).kind, 'COMPLETE');
});

test('temporary and rate-limited one-pass failures remain retryable rather than becoming COMPLETE', () => {
  for (const [status, expectedRetry] of [
    [InteractionResult.TEMPORARY_ERROR, 30100],
    [InteractionResult.RATE_LIMITED, 60100],
  ]) {
    const session = onePassSession(1);
    const result = applyInteractionResult(session, 0, { status }, { now: 100 });

    assert.equal(result.retryAt, expectedRetry);
    assert.deepEqual(selectNextTask(session, 100), { kind: 'WAIT', wakeAt: expectedRetry });
    assert.equal(computeNextWake(stateWith(session), 100), expectedRetry);
    assert.equal(session.runState, RunState.RUNNING);
  }
});
