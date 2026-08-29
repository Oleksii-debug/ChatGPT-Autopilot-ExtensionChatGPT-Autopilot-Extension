import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { applyInteractionResult } from '../../src/core/execution.js';
import { computeNextWake, reconcileAlarm } from '../../src/core/recovery.js';
import { InteractionResult } from '../../src/shared/protocol.js';

function fixture() {
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/recovery' });
  const session = createSession({
    id: 's1',
    name: 'Recovery',
    tasks: [task],
    retryBackoffMs: 30000,
    now: 0,
  });
  session.runState = RunState.RECOVERING;
  session.operation = {
    operationId: 'op1',
    taskId: 't1',
    phase: OperationPhase.AMBIGUOUS,
    promptFingerprint: 'fp',
    promptText: 'continue',
    updatedAt: 0,
  };
  const state = createEmptyState(0);
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  return { state, session, task };
}

test('submission-uncertain recovery backs off instead of scheduling a 500ms verification hot-loop', async () => {
  const { state, session, task } = fixture();
  const result = applyInteractionResult(session, 0, { status: InteractionResult.SUBMISSION_UNCERTAIN }, { now: 1000 });

  assert.equal(result.action, 'RECOVER_BEFORE_RESEND');
  assert.equal(result.retryAt, 31000);
  assert.equal(task.retryAfterAt, 31000);
  assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(computeNextWake(state, 1000), 31000);

  const calls = [];
  const chrome = { alarms: {
    clear: async name => calls.push(['clear', name]),
    create: async (name, options) => calls.push(['create', name, options.when]),
  } };
  await reconcileAlarm(chrome, state, 1000);
  assert.deepEqual(calls, [['create', 'autopilot-core-wake', 31000]]);
});

test('temporary and rate-limited ambiguous verification honor their task retry deadline', () => {
  for (const [status, expectedWake] of [
    [InteractionResult.TEMPORARY_ERROR, 32000],
    [InteractionResult.RATE_LIMITED, 62000],
  ]) {
    const { state, session } = fixture();
    applyInteractionResult(session, 0, { status }, { now: 2000 });
    assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
    assert.equal(computeNextWake(state, 2000), expectedWake);
  }
});
