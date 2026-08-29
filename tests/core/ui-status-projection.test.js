import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { sessionToUi } from '../../src/core/commands.js';
import { appendLog } from '../../src/core/logger.js';

function makeState(taskStatus) {
  const state = createEmptyState(0);
  const task = createTask({ id: 't1', label: 'Primary chat', url: 'https://chatgpt.com/c/runtime-status' });
  const session = createSession({ id: 's1', name: 'Runtime status', tasks: [task], now: 0 });
  session.runState = RunState.RECOVERING;
  session.tasksById.t1.status = taskStatus;
  session.tasksById.t1.retryAfterAt = 12_345;
  session.tasksById.t1.manualReviewReason = taskStatus === 'MANUAL_REVIEW' ? 'UNKNOWN_UI' : '';
  session.operation = {
    operationId: 'op1', sessionId: 's1', taskId: 't1', promptFingerprint: 'fp',
    phase: taskStatus === 'SUBMISSION_UNCERTAIN' ? OperationPhase.AMBIGUOUS : OperationPhase.PRE_SEND_WAIT,
    targetUrl: task.url, createdAt: 1, updatedAt: 2, preSendDeadline: 0, submitStartedAt: 0, verificationDeadline: 0
  };
  session.nextAllowedSendAt = 9_000;
  session.lastSuccessfulSendAt = 8_000;
  session.lastError = taskStatus === 'RETRY_WAIT' ? 'Temporary navigation failure' : '';
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  appendLog(state, 's1', `Runtime task status ${taskStatus}`, { at: 777 });
  return { state, session };
}

test('Core UI read model exposes current task, retry, operation and last-action truth', () => {
  const { state, session } = makeState('SUBMISSION_UNCERTAIN');
  const view = sessionToUi(session, state);
  assert.equal(view.runState, RunState.RECOVERING);
  assert.equal(view.status.currentTaskLabel, 'Primary chat');
  assert.equal(view.status.currentTaskUrl, 'https://chatgpt.com/c/runtime-status');
  assert.equal(view.status.currentTaskStatus, 'SUBMISSION_UNCERTAIN');
  assert.equal(view.status.currentTaskRetryAt, 12_345);
  assert.equal(view.status.operationPhase, OperationPhase.AMBIGUOUS);
  assert.equal(view.status.lastAction, 'Runtime task status SUBMISSION_UNCERTAIN');
  assert.equal(view.status.lastActionAt, 777);
  assert.equal(view.status.nextAllowedSendAt, 9_000);
  assert.equal(view.status.lastSuccessfulSendAt, 8_000);
  assert.deepEqual(view.log, state.logs.s1);
});

test('Core read model passes special task states through unchanged', () => {
  for (const taskStatus of ['RATE_LIMITED', 'RETRY_WAIT', 'MANUAL_REVIEW', 'SUBMISSION_UNCERTAIN']) {
    const { state, session } = makeState(taskStatus);
    const view = sessionToUi(session, state);
    assert.equal(view.status.currentTaskStatus, taskStatus);
    assert.equal(view.status.currentTaskRetryAt, 12_345);
  }
});

test('Core read model keeps canonical session states separate from task runtime states', () => {
  for (const runState of [RunState.RUNNING, RunState.RECOVERING, RunState.PAUSED, RunState.STOPPED, RunState.ERROR]) {
    const { state, session } = makeState('IDLE');
    session.runState = runState;
    assert.equal(sessionToUi(session, state).runState, runState);
  }
});

test('Core UI action availability exposes Start for every state accepted by START_SESSION', () => {
  for (const runState of [RunState.STOPPED, RunState.ERROR]) {
    const { state, session } = makeState('IDLE');
    session.runState = runState;
    assert.equal(sessionToUi(session, state).actionAvailability.start, true, `${runState} must expose Start`);
  }
  for (const runState of [RunState.RUNNING, RunState.RECOVERING, RunState.PAUSED]) {
    const { state, session } = makeState('IDLE');
    session.runState = runState;
    assert.equal(sessionToUi(session, state).actionAvailability.start, false, `${runState} must not expose Start`);
  }
});

test('Core UI preserves the configured retry duration and exposes an exact readable unit', () => {
  const { state, session } = makeState('RATE_LIMITED');
  session.retryBackoffMs = 5 * 60 * 1000;
  let view = sessionToUi(session, state);
  assert.equal(view.retryBackoffSeconds, 300);
  assert.equal(view.retryBackoffUnit, 'minutes');

  session.retryBackoffMs = 45 * 1000;
  view = sessionToUi(session, state);
  assert.equal(view.retryBackoffSeconds, 45);
  assert.equal(view.retryBackoffUnit, 'seconds');
});
