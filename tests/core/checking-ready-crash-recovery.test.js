import test from 'node:test';
import assert from 'node:assert/strict';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';

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

function stateAtPhase(phase) {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/pre-submit-crash' });
  const session = createSession({
    id: 's1',
    name: 'pre-submit crash',
    tasks: [task],
    sharedPrompt: 'continue',
    retryBackoffMs: 30000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  session.operation = {
    operationId: `op-${phase.toLowerCase()}`,
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: `fp-${phase.toLowerCase()}`,
    promptText: 'continue',
    phase,
    targetUrl: task.normalizedUrl,
    createdAt: 1000,
    updatedAt: 1000,
    preSendDeadline: 0,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
  session.tasksById.t1.retryAfterAt = 10000;
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

function fakeChrome() {
  const calls = [];
  return {
    calls,
    alarms: {
      async clear(name) { calls.push(['clear', name]); return true; },
      async create(name, options) { calls.push(['create', name, options.when]); },
    },
  };
}

for (const phase of [OperationPhase.CHECKING, OperationPhase.READY]) {
  test(`cold restart fail-safes expired ${phase} instead of preserving OPERATION_IN_PROGRESS`, async () => {
    const repo = new Repo(stateAtPhase(phase));
    const chromeApi = fakeChrome();
    const now = 20000;
    let executorCalls = 0;
    const executor = {
      async runSessionOnce() {
        executorCalls += 1;
        return { kind: 'OPERATION_IN_PROGRESS', phase };
      },
    };

    const result = await runRuntimeCycle({
      repository: repo,
      chromeApi,
      executor,
      startup: true,
      executionAvailable: true,
      now: () => now,
    });
    const after = await repo.load();

    assert.equal(executorCalls, 1);
    assert.equal(after.sessionsById.s1.runState, RunState.RECOVERING);
    assert.equal(result.outcomes[0].result.kind, 'PRE_SUBMIT_RECOVERY_RETRY');
    assert.equal(result.outcomes[0].result.phase, phase);
    assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.FAILED_SAFE);
    assert.equal(after.sessionsById.s1.tasksById.t1.status, 'RETRY_WAIT');
    assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 50000);
    assert.equal(result.wakeAt, 50000, 'recovery must use bounded retry rather than an immediate alarm loop');
    assert.equal(after.sessionsById.s1.lastSuccessfulSendAt, 0, 'pre-submit crash must never fake success');
    assert.equal(after.sendArbiter.lease, null, 'pre-submit crash recovery must never acquire Send authority');
  });
}

test('stale READY recovery result cannot fail-safe a replacement operation', async () => {
  const repo = new Repo(stateAtPhase(OperationPhase.READY));
  const chromeApi = fakeChrome();
  const now = 20000;
  const executor = {
    async runSessionOnce() {
      await repo.update(draft => {
        draft.sessionsById.s1.operation = {
          ...draft.sessionsById.s1.operation,
          operationId: 'replacement-op',
          promptFingerprint: 'replacement-fp',
          updatedAt: now,
        };
        return draft;
      });
      return { kind: 'OPERATION_IN_PROGRESS', phase: OperationPhase.READY };
    },
  };

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    executionAvailable: true,
    now: () => now,
  });
  const after = await repo.load();

  assert.equal(result.outcomes[0].result.kind, 'OPERATION_IN_PROGRESS');
  assert.equal(after.sessionsById.s1.operation.operationId, 'replacement-op');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.READY, 'stale recovery must not mutate replacement work');
  assert.equal(after.sessionsById.s1.lastSuccessfulSendAt, 0);
  assert.equal(after.sendArbiter.lease, null);
});
