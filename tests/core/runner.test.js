import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { DurableSubmissionCoordinator } from '../../src/core/runner.js';
import { createOperationId, createPromptFingerprint } from '../../src/core/fingerprint.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class FakeRepository {
  constructor(state) {
    this.state = structuredClone(state);
    this.history = [];
  }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const current = this.state;
    const draft = structuredClone(current);
    const next = await mutator(draft) || draft;
    next.revision = current.revision + 1;
    this.state = structuredClone(next);
    this.history.push(structuredClone(next));
    return structuredClone(next);
  }
}

function fixture() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/example' });
  const session = createSession({
    id: 's1',
    name: 'Session',
    tasks: [task],
    sharedPrompt: 'hello',
    preSendDelayMs: 1000,
    minimumSendIntervalMs: 5000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

async function prepareForSubmit(coordinator, clock) {
  clock.value = 10;
  const identity = await coordinator.begin({ sessionId: 's1', taskId: 't1', promptText: 'hello', generation: 1 });
  clock.value = 20;
  await coordinator.markReady({ sessionId: 's1', operationId: identity.operationId });
  clock.value = 30;
  await coordinator.markInserting({ sessionId: 's1', operationId: identity.operationId });
  clock.value = 40;
  await coordinator.markInsertedForPreSend({ sessionId: 's1', operationId: identity.operationId });
  return identity;
}

test('prompt fingerprint is deterministic and binds generation', async () => {
  const args = { sessionId: 's1', taskId: 't1', targetUrl: 'https://www.chatgpt.com/c/example?x=1#hash', promptText: 'exact\nbytes', generation: 7, cryptoApi: webcrypto };
  const a = await createPromptFingerprint(args);
  const b = await createPromptFingerprint(args);
  const c = await createPromptFingerprint({ ...args, generation: 8 });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, c);
  assert.match(createOperationId({ sessionId: 's1', taskId: 't1', generation: 7, promptFingerprint: a }), /^s1:t1:7:[0-9a-f]{16}$/);
});

test('durable phases reach PRE_SEND_WAIT with persisted deadline', async () => {
  const repo = new FakeRepository(fixture());
  const clock = { value: 0 };
  const coordinator = new DurableSubmissionCoordinator(repo, { now: () => clock.value, cryptoApi: webcrypto });
  const identity = await prepareForSubmit(coordinator, clock);
  const state = await repo.load();
  const operation = state.sessionsById.s1.operation;
  assert.equal(operation.operationId, identity.operationId);
  assert.equal(operation.phase, OperationPhase.PRE_SEND_WAIT);
  assert.equal(operation.preSendDeadline, 1040);
  assert.equal(operation.promptText, 'hello');
  assert.equal(operation.generation, 1);
});

test('submit effect observes SUBMITTING and lease already persisted', async () => {
  const repo = new FakeRepository(fixture());
  const clock = { value: 0 };
  const coordinator = new DurableSubmissionCoordinator(repo, { now: () => clock.value, cryptoApi: webcrypto, profileGapMs: 250 });
  const identity = await prepareForSubmit(coordinator, clock);
  clock.value = 1040;

  const result = await coordinator.submitWithDurableCheckpoint({
    sessionId: 's1',
    operationId: identity.operationId,
    submit: async () => {
      const persisted = await repo.load();
      assert.equal(persisted.sessionsById.s1.operation.phase, OperationPhase.SUBMITTING);
      assert.equal(persisted.sendArbiter.lease.operationId, identity.operationId);
      return { status: InteractionResult.SENT_VERIFIED };
    },
  });

  assert.equal(result.status, InteractionResult.SENT_VERIFIED);
  const state = await repo.load();
  assert.equal(state.sessionsById.s1.operation.phase, OperationPhase.SENT_VERIFIED);
  assert.equal(state.sessionsById.s1.currentTaskIndex, 0);
  assert.equal(state.sessionsById.s1.nextAllowedSendAt, 6040);
  assert.equal(state.sessionsById.s1.tasksById.t1.lastVerifiedFingerprint, identity.promptFingerprint);
  assert.equal(state.sendArbiter.lease, null);
  assert.equal(state.sendArbiter.profileNextAllowedSendAt, 1290);
});

test('submit exception becomes ambiguous recovery without cooldown or lease release', async () => {
  const repo = new FakeRepository(fixture());
  const clock = { value: 0 };
  const coordinator = new DurableSubmissionCoordinator(repo, { now: () => clock.value, cryptoApi: webcrypto });
  const identity = await prepareForSubmit(coordinator, clock);
  clock.value = 1040;

  const result = await coordinator.submitWithDurableCheckpoint({
    sessionId: 's1',
    operationId: identity.operationId,
    submit: async () => { throw new Error('simulated crash around send'); },
  });

  assert.equal(result.status, InteractionResult.SUBMISSION_UNCERTAIN);
  const state = await repo.load();
  assert.equal(state.sessionsById.s1.runState, RunState.RECOVERING);
  assert.equal(state.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(state.sessionsById.s1.nextAllowedSendAt, 0);
  assert.equal(state.sendArbiter.lease.operationId, identity.operationId);
});

test('pre-send deadline prevents premature submit before any side effect', async () => {
  const repo = new FakeRepository(fixture());
  const clock = { value: 0 };
  const coordinator = new DurableSubmissionCoordinator(repo, { now: () => clock.value, cryptoApi: webcrypto });
  const identity = await prepareForSubmit(coordinator, clock);
  clock.value = 1039;
  let called = false;
  await assert.rejects(() => coordinator.submitWithDurableCheckpoint({
    sessionId: 's1', operationId: identity.operationId, submit: async () => { called = true; }
  }), /Pre-send delay has not elapsed/);
  assert.equal(called, false);
  const state = await repo.load();
  assert.equal(state.sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
  assert.equal(state.sendArbiter.lease, null);
});

for (const quiescentState of [RunState.PAUSED, RunState.STOPPED]) {
  test(`${quiescentState} committed before durable submit transaction prevents lease and send`, async () => {
    const repo = new FakeRepository(fixture());
    const clock = { value: 0 };
    const coordinator = new DurableSubmissionCoordinator(repo, { now: () => clock.value, cryptoApi: webcrypto });
    const identity = await prepareForSubmit(coordinator, clock);
    clock.value = 1040;

    await repo.update(draft => {
      draft.sessionsById.s1.runState = quiescentState;
      return draft;
    });

    let called = false;
    await assert.rejects(() => coordinator.submitWithDurableCheckpoint({
      sessionId: 's1',
      operationId: identity.operationId,
      submit: async () => {
        called = true;
        return { status: InteractionResult.SENT_VERIFIED };
      },
    }), /Session is not active for submit/);

    const state = await repo.load();
    assert.equal(called, false);
    assert.equal(state.sessionsById.s1.runState, quiescentState);
    assert.equal(state.sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
    assert.equal(state.sendArbiter.lease, null);
  });
}
