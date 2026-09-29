import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class Repo {
  constructor(state) {
    this.state = structuredClone(state);
    this.updateCount = 0;
  }
  async load() { return structuredClone(this.state); }
  async update(fn) {
    this.updateCount += 1;
    if (this.updateCount === 2) {
      const live = this.state.sessionsById.s1;
      live.operation = {
        ...live.operation,
        operationId: 'op2',
        promptFingerprint: 'fp2',
        phase: OperationPhase.AMBIGUOUS,
        updatedAt: 50,
      };
      live.tasksById.t1.status = 'SUBMISSION_UNCERTAIN';
      live.tasksById.t1.manualReviewReason = null;
    }
    const draft = structuredClone(this.state);
    const next = await fn(draft) || draft;
    next.revision = this.state.revision + 1;
    this.state = structuredClone(next);
    return this.load();
  }
}

function setupPreSend() {
  const state = createEmptyState(0);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/example' });
  const session = createSession({
    id: 's1',
    name: 'S',
    tasks: [task],
    sharedPrompt: 'hello',
    preSendDelayMs: 1000,
    now: 0,
  });
  session.runState = RunState.RUNNING;
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp1',
    promptText: 'hello',
    phase: OperationPhase.PRE_SEND_WAIT,
    targetUrl: task.normalizedUrl,
    createdAt: 0,
    updatedAt: 0,
    preSendDeadline: 999,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  return state;
}

const chromeApi = { tabs: {
  async get() { return { id: 7, url: 'https://chatgpt.com/c/example' }; },
  async query() { return [{ id: 7, url: 'https://chatgpt.com/c/example' }]; },
  async create({ url }) { return { id: 8, url }; },
} };

async function runStalePrepare(status) {
  const repo = new Repo(setupPreSend());
  const transport = { async execute(_tab, request) {
    assert.equal(request.mode, 'PREPARE_SEND');
    assert.equal(request.requestId, 'op1');
    return { status };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, {
    now: () => 1000,
    cryptoApi: webcrypto,
  });
  return { result: await executor.runSessionOnce('s1'), after: await repo.load() };
}

function assertReplacementUntouched(result, after) {
  assert.equal(result.kind, 'OPERATION_CHANGED');
  assert.equal(after.sessionsById.s1.operation.operationId, 'op2');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s1.tasksById.t1.status, 'SUBMISSION_UNCERTAIN');
  assert.equal(after.sessionsById.s1.tasksById.t1.manualReviewReason, null);
}

test('stale non-ready PREPARE_SEND response cannot mutate replacement operation', async () => {
  const { result, after } = await runStalePrepare(InteractionResult.AUTH_REQUIRED);
  assertReplacementUntouched(result, after);
});

test('stale INSERTED_NOT_SENT PREPARE_SEND response cannot delay replacement operation', async () => {
  const { result, after } = await runStalePrepare(InteractionResult.INSERTED_NOT_SENT);
  assertReplacementUntouched(result, after);
  assert.equal(after.sessionsById.s1.operation.preSendDeadline, 999);
});
