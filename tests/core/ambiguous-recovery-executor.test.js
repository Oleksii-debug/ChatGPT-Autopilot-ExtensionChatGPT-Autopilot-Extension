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

function setupAmbiguousWithBackoff() {
  const state = createEmptyState(0);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/recovery' });
  task.status = 'SUBMISSION_UNCERTAIN';
  task.retryAfterAt = 5000;
  const session = createSession({ id: 's1', name: 'Recovery', tasks: [task], sharedPrompt: 'continue', now: 0 });
  session.runState = RunState.RECOVERING;
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp1',
    promptText: 'continue',
    phase: OperationPhase.AMBIGUOUS,
    targetUrl: task.normalizedUrl,
    createdAt: 0,
    updatedAt: 0,
    preSendDeadline: 0,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  return state;
}

test('unrelated runtime wake cannot bypass ambiguous recovery retry deadline', async () => {
  const repo = new Repo(setupAmbiguousWithBackoff());
  const chromeApi = { tabs: {
    async get() { throw new Error('tab lookup must not run before recovery retry deadline'); },
    async query() { throw new Error('tab query must not run before recovery retry deadline'); },
    async create() { throw new Error('tab creation must not run before recovery retry deadline'); },
  } };
  const transport = { async execute() { throw new Error('verification transport must not run before recovery retry deadline'); } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 1000, cryptoApi: webcrypto });

  const result = await executor.runSessionOnce('s1');
  const after = await repo.load();

  assert.deepEqual(result, { kind: 'WAIT_RECOVERY', wakeAt: 5000 });
  assert.equal(after.sessionsById.s1.operation.operationId, 'op1');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 5000);
});
