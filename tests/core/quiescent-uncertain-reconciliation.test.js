import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { DurableSubmissionCoordinator } from '../../src/core/runner.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class Repo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(fn) {
    const draft = structuredClone(this.state);
    const next = await fn(draft) || draft;
    next.revision = this.state.revision + 1;
    this.state = structuredClone(next);
    return this.load();
  }
}

function activeState() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/quiescent-uncertain' });
  const session = createSession({
    id: 's1',
    name: 'quiescent uncertain',
    tasks: [task],
    sharedPrompt: 'continue',
    preSendDelayMs: 1000,
    retryBackoffMs: 30000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  return state;
}

async function prepareForSubmit(repo, clock) {
  const coordinator = new DurableSubmissionCoordinator(repo, {
    now: () => clock.value,
    cryptoApi: webcrypto,
  });
  clock.value = 10;
  const identity = await coordinator.begin({
    sessionId: 's1',
    taskId: 't1',
    promptText: 'continue',
    generation: 1,
  });
  clock.value = 20;
  await coordinator.markReady({ sessionId: 's1', operationId: identity.operationId });
  clock.value = 30;
  await coordinator.markInserting({ sessionId: 's1', operationId: identity.operationId });
  clock.value = 40;
  await coordinator.markInsertedForPreSend({ sessionId: 's1', operationId: identity.operationId });
  return { coordinator, identity };
}

function ambiguousState() {
  const state = activeState();
  const session = state.sessionsById.s1;
  const task = session.tasksById.t1;
  session.runState = RunState.RECOVERING;
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp1',
    promptText: 'continue',
    phase: OperationPhase.AMBIGUOUS,
    targetUrl: task.normalizedUrl,
    createdAt: 10,
    updatedAt: 20,
    preSendDeadline: 0,
    submitStartedAt: 20,
    verificationDeadline: 0,
  };
  task.status = 'SUBMISSION_UNCERTAIN';
  task.retryAfterAt = 0;
  state.sendArbiter.lease = {
    ownerSessionId: 's1',
    operationId: 'op1',
    acquiredAt: 20,
    expiresAt: 100000,
  };
  return state;
}

for (const quiescentState of [RunState.PAUSED, RunState.STOPPED]) {
  test(`late uncertain physical-send outcome preserves ${quiescentState}`, async () => {
    const repo = new Repo(activeState());
    const clock = { value: 0 };
    const { coordinator, identity } = await prepareForSubmit(repo, clock);
    clock.value = 1040;

    const result = await coordinator.submitWithDurableCheckpoint({
      sessionId: 's1',
      operationId: identity.operationId,
      submit: async () => {
        await repo.update(draft => {
          draft.sessionsById.s1.runState = quiescentState;
          return draft;
        });
        throw new Error('uncertain after physical Send may have happened');
      },
    });

    const after = await repo.load();
    assert.equal(result.status, InteractionResult.SUBMISSION_UNCERTAIN);
    assert.equal(after.sessionsById.s1.runState, quiescentState);
    assert.equal(after.sessionsById.s1.operation.operationId, identity.operationId);
    assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
    assert.equal(after.sessionsById.s1.tasksById.t1.status, 'SUBMISSION_UNCERTAIN');
    assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 31040);
    assert.equal(after.sessionsById.s1.currentTaskIndex, 0);
    assert.equal(after.sessionsById.s1.nextAllowedSendAt, 0);
    assert.equal(after.sendArbiter.lease.operationId, identity.operationId);
  });

  test(`late uncertain verification preserves ${quiescentState}`, async () => {
    const repo = new Repo(ambiguousState());
    const chromeApi = { tabs: {
      async get() { return { id: 7, url: 'https://chatgpt.com/c/quiescent-uncertain' }; },
      async query() { return [{ id: 7, url: 'https://chatgpt.com/c/quiescent-uncertain' }]; },
      async create({ url }) { return { id: 8, url }; },
    } };
    const transport = {
      async execute(_tabId, request) {
        assert.equal(request.mode, 'VERIFY_AFTER_UNCERTAIN_SUBMIT');
        assert.equal(request.requestId, 'op1');
        await repo.update(draft => {
          draft.sessionsById.s1.runState = quiescentState;
          return draft;
        });
        return { status: InteractionResult.SUBMISSION_UNCERTAIN };
      },
    };
    const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, {
      now: () => 100,
      cryptoApi: webcrypto,
    });

    const result = await executor.runSessionOnce('s1');
    const after = await repo.load();
    assert.equal(result.kind, 'RECOVERY_HELD');
    assert.equal(after.sessionsById.s1.runState, quiescentState);
    assert.equal(after.sessionsById.s1.operation.operationId, 'op1');
    assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
    assert.equal(after.sessionsById.s1.tasksById.t1.status, 'SUBMISSION_UNCERTAIN');
    assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 30100);
    assert.equal(after.sendArbiter.lease.operationId, 'op1');
  });
}
