import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextWake, reconcileStateForStartup } from '../../src/core/recovery.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState, TabStrategy } from '../../src/core/schema.js';

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


function addNativePreEffectLease(state, { dispatched = false, includeOwnedHint = true } = {}) {
  const session = state.sessionsById.s1;
  session.tabStrategy = TabStrategy.OPEN_CLOSE_PER_TASK;
  session.retryBackoffMs = 5000;
  session.operation.previousSendTabId = 3;
  session.operation.previousSendWindowId = 9;
  session.operation.nativeSubmitDispatched = dispatched;
  if (includeOwnedHint) {
    state.tabHintsByTaskId.t1 = {
      tabId: 7,
      sessionId: 's1',
      normalizedUrl: 'https://chatgpt.com/c/example',
      kind: 'TASK',
      ownedByExtension: true,
    };
  }
  return state;
}

test('startup settles exact native pre-effect focus lease to FAILED_SAFE with bounded retry', () => {
  const state = addNativePreEffectLease(stateWithSubmitting(RunState.RUNNING));
  reconcileStateForStartup(state, 100);

  const session = state.sessionsById.s1;
  assert.equal(session.operation.phase, OperationPhase.FAILED_SAFE);
  assert.equal(session.operation.submitStartedAt, 0);
  assert.equal(session.operation.verificationDeadline, 0);
  assert.equal(session.tasksById.t1.status, 'RETRY_WAIT');
  assert.equal(session.tasksById.t1.retryAfterAt, 5100);
  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(computeNextWake(state, 100), 5100);
});

test('startup never downgrades a persisted native effect checkpoint to safe retry', () => {
  const state = addNativePreEffectLease(stateWithSubmitting(RunState.RUNNING), { dispatched: true });
  reconcileStateForStartup(state, 100);

  const session = state.sessionsById.s1;
  assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(session.operation.nativeSubmitDispatched, true);
  assert.notEqual(session.tasksById.t1.status, 'RETRY_WAIT');
  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(computeNextWake(state, 100), 100);
});

test('startup rejects an unbound focus lease as zero-effect proof', () => {
  const state = addNativePreEffectLease(stateWithSubmitting(RunState.RUNNING), { includeOwnedHint: false });
  reconcileStateForStartup(state, 100);

  const session = state.sessionsById.s1;
  assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
  assert.notEqual(session.tasksById.t1.status, 'RETRY_WAIT');
  assert.equal(computeNextWake(state, 100), 100);
});
