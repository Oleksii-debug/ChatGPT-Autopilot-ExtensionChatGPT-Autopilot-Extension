import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
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

function stateWithOperation(phase, retryAfterAt = 0) {
  const state = createEmptyState(0);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/pre-submit-recovery' });
  task.retryAfterAt = retryAfterAt;
  const session = createSession({
    id: 's1',
    name: 'pre-submit recovery',
    tasks: [task],
    sharedPrompt: 'continue',
    retryBackoffMs: 30000,
    now: 0,
  });
  session.runState = RunState.RECOVERING;
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp1',
    promptText: 'continue',
    phase,
    targetUrl: task.normalizedUrl,
    createdAt: 10,
    updatedAt: 20,
    preSendDeadline: 0,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  return state;
}

function executorFor(repo, now) {
  const chromeApi = { tabs: {
    async get() { throw new Error('tab lookup must not run during executor fail-safe recovery'); },
    async query() { throw new Error('tab query must not run during executor fail-safe recovery'); },
    async create() { throw new Error('tab creation must not run during executor fail-safe recovery'); },
  } };
  const transport = {
    async execute() { throw new Error('Interaction transport must not run during executor fail-safe recovery'); },
  };
  return new AutomaticSessionExecutor(repo, chromeApi, transport, {
    now: () => now,
    cryptoApi: webcrypto,
  });
}

test('interrupted INSERTED remains durable until its existing retry deadline', async () => {
  const repo = new Repo(stateWithOperation(OperationPhase.INSERTED, 5000));
  const executor = executorFor(repo, 1000);

  const result = await executor.runSessionOnce('s1');
  const after = await repo.load();

  assert.deepEqual(result, {
    kind: 'WAIT_PRE_SUBMIT_RECOVERY',
    phase: OperationPhase.INSERTED,
    wakeAt: 5000,
  });
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.INSERTED);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 5000);
});

test('expired interrupted INSERTED fails safe without Interaction or Send', async () => {
  const repo = new Repo(stateWithOperation(OperationPhase.INSERTED, 5000));
  const executor = executorFor(repo, 5000);

  const result = await executor.runSessionOnce('s1');
  const after = await repo.load();

  assert.deepEqual(result, { kind: 'PRE_SUBMIT_RECOVERY_HELD', wakeAt: 35000 });
  assert.equal(after.sessionsById.s1.operation.operationId, 'op1');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.FAILED_SAFE);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 35000);
  assert.equal(after.sessionsById.s1.runState, RunState.RECOVERING);
});

for (const phase of [
  OperationPhase.CHECKING,
  OperationPhase.READY,
  OperationPhase.INSERTING,
]) {
  test(`${phase} remains delegated to the canonical runtime recovery owner`, async () => {
    const repo = new Repo(stateWithOperation(phase, 5000));
    const executor = executorFor(repo, 5000);

    const result = await executor.runSessionOnce('s1');
    const after = await repo.load();

    assert.deepEqual(result, { kind: 'OPERATION_IN_PROGRESS', phase });
    assert.equal(after.sessionsById.s1.operation.phase, phase);
    assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 5000);
  });
}

test('SUBMITTING is never downgraded by executor pre-submit recovery', async () => {
  const repo = new Repo(stateWithOperation(OperationPhase.SUBMITTING, 0));
  const executor = executorFor(repo, 5000);

  const result = await executor.runSessionOnce('s1');
  const after = await repo.load();

  assert.deepEqual(result, { kind: 'OPERATION_IN_PROGRESS', phase: OperationPhase.SUBMITTING });
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.SUBMITTING);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 0);
});
