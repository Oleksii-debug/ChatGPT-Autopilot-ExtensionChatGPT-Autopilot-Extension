import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { reconcileStateForStartup, computeNextWake, reconcileAlarm, ALARM_NAME } from '../../src/core/recovery.js';
import { acquireSendLease, releaseSendLease } from '../../src/core/arbiter.js';

function stateWithSession(now = 1_000) {
  const state = createEmptyState(now);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/1' });
  const session = createSession({ id: 's1', name: 'S1', tasks: [task], now });
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return { state, session, task };
}

test('startup converts persisted RUNNING session to RECOVERING', () => {
  const { state, session } = stateWithSession();
  session.runState = RunState.RUNNING;
  reconcileStateForStartup(state, 10_000);
  assert.equal(session.runState, RunState.RECOVERING);
});

test('startup converts interrupted SUBMITTING operation to AMBIGUOUS and never auto-resends', () => {
  const { state, session } = stateWithSession();
  session.runState = RunState.RUNNING;
  session.operation = { phase: OperationPhase.SUBMITTING, operationId: 'op1' };
  reconcileStateForStartup(state, 10_000);
  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
});

test('startup clears only expired send lease', () => {
  const { state } = stateWithSession();
  state.sendArbiter.lease = { ownerSessionId: 's1', operationId: 'op1', expiresAt: 9_999 };
  reconcileStateForStartup(state, 10_000);
  assert.equal(state.sendArbiter.lease, null);

  state.sendArbiter.lease = { ownerSessionId: 's1', operationId: 'op2', expiresAt: 12_000 };
  reconcileStateForStartup(state, 10_000);
  assert.equal(state.sendArbiter.lease.operationId, 'op2');
});

test('alarm reconciliation recreates a single wake from persisted deadlines', async () => {
  const { state, session } = stateWithSession();
  session.runState = RunState.RUNNING;
  session.nextAllowedSendAt = 20_000;
  const calls = [];
  const chromeApi = { alarms: {
    async clear(name) { calls.push(['clear', name]); return true; },
    async create(name, info) { calls.push(['create', name, info]); }
  }};
  const wakeAt = await reconcileAlarm(chromeApi, state, 10_000);
  assert.equal(wakeAt, 20_000);
  assert.deepEqual(calls, [
    ['clear', ALARM_NAME],
    ['create', ALARM_NAME, { when: 20_000 }]
  ]);
});

test('computeNextWake returns null when no session may auto-run', () => {
  const { state, session } = stateWithSession();
  session.runState = RunState.PAUSED;
  assert.equal(computeNextWake(state, 10_000), null);
});

test('profile send arbiter excludes competing sessions and enforces post-send gap', () => {
  const state = createEmptyState(0);
  assert.equal(acquireSendLease(state, { sessionId: 's1', operationId: 'a', now: 1_000, ttlMs: 5_000 }), true);
  assert.equal(acquireSendLease(state, { sessionId: 's2', operationId: 'b', now: 1_001, ttlMs: 5_000 }), false);
  assert.equal(releaseSendLease(state, { sessionId: 's1', operationId: 'a', now: 2_000, profileGapMs: 1_000 }), true);
  assert.equal(acquireSendLease(state, { sessionId: 's2', operationId: 'b', now: 2_999, ttlMs: 5_000 }), false);
  assert.equal(acquireSendLease(state, { sessionId: 's2', operationId: 'b', now: 3_000, ttlMs: 5_000 }), true);
});
