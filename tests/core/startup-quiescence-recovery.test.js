import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextWake, reconcileStateForStartup } from '../../src/core/recovery.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';

function stateWithSubmitting(runState) {
  const state = createEmptyState(0);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/example' });
  const session = createSession({ id: 's1', name: 'S', tasks: [task], sharedPrompt: 'hello', now: 0 });
  session.runState = runState;
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp1',
    promptText: 'hello',
    phase: OperationPhase.SUBMITTING,
    targetUrl: task.normalizedUrl,
    createdAt: 0,
    updatedAt: 10,
    preSendDeadline: 0,
    submitStartedAt: 10,
    verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  return state;
}

for (const runState of [RunState.PAUSED, RunState.STOPPED]) {
  test(`startup marks ${runState} SUBMITTING evidence ambiguous without resurrecting execution`, () => {
    const state = stateWithSubmitting(runState);
    reconcileStateForStartup(state, 100);

    assert.equal(state.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
    assert.equal(state.sessionsById.s1.runState, runState);
    assert.equal(computeNextWake(state, 100), null);
  });
}

test('startup still recovers an active SUBMITTING session without blind resend', () => {
  const state = stateWithSubmitting(RunState.RUNNING);
  reconcileStateForStartup(state, 100);

  assert.equal(state.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(state.sessionsById.s1.runState, RunState.RECOVERING);
  assert.equal(computeNextWake(state, 100), 100);
});
