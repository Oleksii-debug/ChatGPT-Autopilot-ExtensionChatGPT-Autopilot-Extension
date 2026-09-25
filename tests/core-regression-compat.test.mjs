import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireSendLease } from '../src/core/arbiter.js';
import { computeNextWake, reconcileStateForStartup } from '../src/core/recovery.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../src/core/schema.js';

test('0.9.8 retires legacy profile-wide send barrier instead of delaying independent Sessions', () => {
  const state = createEmptyState(0);
  const session = createSession({ id: 's1', name: 's1', tasks: [createTask({ id: 't1', url: 'https://chatgpt.com/' })], sharedPrompt: 'p', now: 0 });
  session.runState = RunState.RUNNING;
  session.operation = {
    operationId: 'op1', sessionId: 's1', taskId: 't1', promptFingerprint: 'fp', promptText: 'p',
    phase: OperationPhase.PRE_SEND_WAIT, targetUrl: 'https://chatgpt.com/', createdAt: 0, updatedAt: 0,
    preSendDeadline: 9000, submitStartedAt: 0, verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  state.sendArbiter.profileNextAllowedSendAt = 12000;
  state.sendArbiter.lastSentSessionId = '';
  assert.equal(acquireSendLease(state, { sessionId: 's1', operationId: 'op1', now: 10000 }), true);
  assert.equal(computeNextWake(state, 10000), 10000);
  reconcileStateForStartup(state, 10000);
  assert.equal(state.sendArbiter.profileNextAllowedSendAt, 0);
  assert.equal(state.sendArbiter.lease, null);
});
