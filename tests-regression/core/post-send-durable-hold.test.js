import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState, OperationPhase } from '../../src/core/schema.js';
import { DurableSubmissionCoordinator } from '../../src/core/runner.js';
import { normalizeScenarioWorkConfig } from '../../src/core/scenario-work.js';

function fixture(postSendDelayMs) {
  const state = createEmptyState(0);
  const task = createTask({ id: 't', url: 'https://chatgpt.com/' });
  const session = createSession({ id: 's', name: 'S', tasks: [task], postSendDelayMs, now: 0 });
  session.runState = RunState.RUNNING;
  session.operation = { operationId: 'op', sessionId: 's', taskId: 't', phase: OperationPhase.PRE_SEND_WAIT,
    preSendDeadline: 0, submitStartedAt: 0, promptFingerprint: 'test', targetUrl: 'https://chatgpt.com/' };
  state.sessionsById.s = session;
  state.sessionOrder.push('s');
  const repo = {
    load: async () => state,
    update: async change => { change(state); return state; },
  };
  return { state, repo };
}

test('post-Send dwell of two minutes is durable at the submit checkpoint', async () => {
  const { state, repo } = fixture(120000);
  const coordinator = new DurableSubmissionCoordinator(repo, { now: () => 1000 });
  await coordinator.submitWithDurableCheckpoint({
    sessionId: 's', operationId: 'op',
    submit: async () => {
      assert.equal(state.sessionsById.s.operation.phase, OperationPhase.SUBMITTING);
      assert.equal(state.sessionsById.s.operation.postSendHoldUntil, 121000);
      return { status: 'SUBMISSION_UNCERTAIN' };
    },
  });
});

test('post-Send dwell of one hour is not truncated to sixty seconds', async () => {
  const { state, repo } = fixture(3600000);
  const coordinator = new DurableSubmissionCoordinator(repo, { now: () => 7000 });
  await coordinator.submitWithDurableCheckpoint({
    sessionId: 's', operationId: 'op',
    submit: async () => {
      assert.equal(state.sessionsById.s.operation.postSendHoldUntil, 3607000);
      return { status: 'SUBMISSION_UNCERTAIN' };
    },
  });
});

test('scenario post-Send canonical seconds support 60 minutes and preserve zero', () => {
  assert.equal(normalizeScenarioWorkConfig({postSendDelaySeconds:3600}).postSendDelaySeconds,3600);
  assert.equal(normalizeScenarioWorkConfig({postSendDelaySeconds:0}).postSendDelaySeconds,0);
});
