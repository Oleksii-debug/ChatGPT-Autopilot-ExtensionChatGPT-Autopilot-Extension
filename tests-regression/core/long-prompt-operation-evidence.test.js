import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
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

function state() {
  const root = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/example' });
  const session = createSession({
    id: 's1', name: 'S', tasks: [task], sharedPrompt: 'very large prompt',
    preSendDelayMs: 1000, minimumSendIntervalMs: 5000, now: 1,
  });
  session.runState = RunState.RUNNING;
  root.sessionsById.s1 = session;
  root.sessionOrder.push('s1');
  return root;
}

const chromeApi = { tabs: {
  async get() { return { id: 7, url: 'https://chatgpt.com/c/example' }; },
  async query() { return [{ id: 7, url: 'https://chatgpt.com/c/example' }]; },
  async create({ url }) { return { id: 8, url }; },
} };

test('executor accepts only explicit operation-bound accepted-representation evidence', async () => {
  const repo = new Repo(state());
  const transport = { async execute(_tab, request) {
    if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY };
    assert.equal(request.mode, 'INSERT_ONLY');
    return {
      status: InteractionResult.INSERTED_NOT_SENT,
      composerState: 'ACCEPTED_ATTACHMENT_LIKE',
      insertionEvidence: 'OPERATION_BOUND_ACCEPTED_REPRESENTATION',
      safeDiagnosticCode: 'INSERTION_ATTACHMENT_OPERATION_BOUND',
    };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  assert.equal(result.kind, 'WAIT_PRE_SEND');
  assert.equal((await repo.load()).sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
});

test('attachment-like status without operation-bound evidence fails closed', async () => {
  const repo = new Repo(state());
  const transport = { async execute(_tab, request) {
    if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY };
    return {
      status: InteractionResult.INSERTED_NOT_SENT,
      composerState: 'ACCEPTED_ATTACHMENT_LIKE',
      safeDiagnosticCode: 'INSERTION_ATTACHMENT_OPERATION_BOUND',
    };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  assert.equal(result.kind, 'INSERTION_HELD');
  assert.equal(result.result.status, InteractionResult.MANUAL_REVIEW_REQUIRED);
});

test('unproven text insertion before Send schedules automatic retry without pausing the session', async () => {
  const repo = new Repo(state());
  const transport = { async execute(_tab, request) {
    if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY };
    return {
      status: InteractionResult.INSERTED_NOT_SENT,
      composerState: 'VISIBLE_NONEMPTY',
      safeDiagnosticCode: 'INSERTION_NOT_PROVEN',
      safeDiagnosticMessage: 'observed editor text differed before Send',
    };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  const after = (await repo.load()).sessionsById.s1;

  assert.equal(result.kind, 'INSERTION_RETRY');
  assert.equal(after.runState, RunState.RUNNING);
  assert.equal(after.tasksById.t1.status, 'RETRY_WAIT');
  assert.equal(after.tasksById.t1.manualReviewReason, '');
  assert.equal(after.operation.phase, OperationPhase.FAILED_SAFE);
  assert.ok(after.tasksById.t1.retryAfterAt > 100);
});

test('shared-URL insertion mismatch holds every sibling cycle but keeps session running', async () => {
  const root = createEmptyState(1);
  const tasks = [1,2,3].map(n => createTask({ id: `t${n}`, url: 'https://chatgpt.com/' }));
  const session = createSession({
    id: 's1', name: 'Shared cycles', tasks, sharedPrompt: 'prompt', retryBackoffMs: 15000, now: 1,
  });
  session.runState = RunState.RUNNING;
  session.urlMode = 'shared';
  root.sessionsById.s1 = session;
  root.sessionOrder.push('s1');
  const repo = new Repo(root);
  const sharedChrome = { tabs: {
    async get() { return { id: 7, url: 'https://chatgpt.com/' }; },
    async query() { return [{ id: 7, url: 'https://chatgpt.com/' }]; },
    async create({ url }) { return { id: 8, url }; },
  } };
  const transport = { async execute(_tab, request) {
    if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY };
    return {
      status: InteractionResult.INSERTED_NOT_SENT,
      composerState: 'VISIBLE_NONEMPTY',
      safeDiagnosticCode: 'INSERTION_NOT_PROVEN',
    };
  } };
  const executor = new AutomaticSessionExecutor(repo, sharedChrome, transport, { now: () => 100, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  const after = (await repo.load()).sessionsById.s1;

  assert.equal(result.kind, 'INSERTION_RETRY');
  assert.equal(after.runState, RunState.RUNNING);
  assert.equal(after.currentTaskIndex, 0);
  assert.deepEqual(after.taskOrder.map(id => after.tasksById[id].retryAfterAt), [15100,15100,15100]);
});
