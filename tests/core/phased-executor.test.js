import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class Repo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(fn) { const draft = structuredClone(this.state); const next = await fn(draft) || draft; next.revision = this.state.revision + 1; this.state = structuredClone(next); return this.load(); }
}

function setup() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/example' });
  const session = createSession({ id: 's1', name: 'S', tasks: [task], sharedPrompt: 'hello', preSendDelayMs: 1000, minimumSendIntervalMs: 5000, now: 1 });
  session.runState = RunState.RUNNING;
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

function setupPreSend(now = 100000) {
  const state = setup();
  const session = state.sessionsById.s1;
  const task = session.tasksById.t1;
  session.operation = {
    operationId: 'op1', sessionId: 's1', taskId: 't1', promptFingerprint: 'fp', promptText: 'hello',
    phase: OperationPhase.PRE_SEND_WAIT, targetUrl: task.normalizedUrl, createdAt: 1, updatedAt: 2,
    preSendDeadline: now - 1, submitStartedAt: 0, verificationDeadline: 0,
  };
  return state;
}

function setupAmbiguous() {
  const state = setup();
  const session = state.sessionsById.s1;
  session.runState = RunState.RECOVERING;
  session.operation = {
    operationId:'op1', sessionId:'s1', taskId:'t1', promptFingerprint:'fp', promptText:'hello',
    phase:OperationPhase.AMBIGUOUS, targetUrl:'https://chatgpt.com/c/example', createdAt:1, updatedAt:2,
    preSendDeadline:0, submitStartedAt:2, verificationDeadline:0,
  };
  state.sendArbiter.lease = { ownerSessionId:'s1', operationId:'op1', acquiredAt:2, expiresAt:9999 };
  return state;
}

const chromeApi = { tabs: {
  async get() { return { id: 7, url: 'https://chatgpt.com/c/example' }; },
  async query() { return [{ id: 7, url: 'https://chatgpt.com/c/example' }]; },
  async create({ url }) { return { id: 8, url }; },
} };

test('executor persists pre-send wait after verified insertion', async () => {
  const repo = new Repo(setup());
  const clock = { value: 100 };
  const modes = [];
  const transport = { async execute(_tab, request) {
    modes.push(request.mode);
    if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY };
    return { status: InteractionResult.INSERTED_NOT_SENT, composerState: 'VISIBLE_NONEMPTY', safeDiagnosticCode: 'INSERTION_TEXT_PROVEN' };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => clock.value, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  assert.equal(result.kind, 'WAIT_PRE_SEND');
  assert.deepEqual(modes, ['CHECK_ONLY', 'INSERT_ONLY']);
  assert.equal((await repo.load()).sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
});

test('executor verifies ambiguous operation before any new insertion', async () => {
  const repo = new Repo(setupAmbiguous());
  const modes = [];
  const transport = { async execute(_tab, request) { modes.push(request.mode); return { status: InteractionResult.SENT_VERIFIED }; } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  assert.equal(result.kind, 'RECOVERED_SENT');
  assert.deepEqual(modes, ['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
  assert.equal((await repo.load()).sendArbiter.lease, null);
});

test('pause committed during CHECK_ONLY prevents INSERT_ONLY and new operation creation', async () => {
  const repo = new Repo(setup());
  const modes = [];
  const transport = { async execute(_tab, request) {
    modes.push(request.mode);
    if (request.mode === 'CHECK_ONLY') {
      await repo.update(draft => {
        draft.sessionsById.s1.runState = RunState.PAUSED;
        return draft;
      });
      return { status: InteractionResult.READY };
    }
    throw new Error('INSERT_ONLY must not run after pause');
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.equal(result.kind, 'QUIESCED');
  assert.deepEqual(modes, ['CHECK_ONLY']);
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.ok(!after.sessionsById.s1.operation || [OperationPhase.NONE, OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE].includes(after.sessionsById.s1.operation.phase));
});

test('stop committed during PREPARE_SEND prevents SUBMITTING lease and SUBMIT_EXISTING', async () => {
  const now = 100000;
  const repo = new Repo(setupPreSend(now));
  const modes = [];
  const transport = { async execute(_tab, request) {
    modes.push(request.mode);
    if (request.mode === 'PREPARE_SEND') {
      await repo.update(draft => {
        draft.sessionsById.s1.runState = RunState.STOPPED;
        return draft;
      });
      return { status: InteractionResult.READY };
    }
    throw new Error('SUBMIT_EXISTING must not run after stop');
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.equal(result.kind, 'QUIESCED');
  assert.deepEqual(modes, ['PREPARE_SEND']);
  assert.equal(after.sessionsById.s1.runState, RunState.STOPPED);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
  assert.equal(after.sendArbiter.lease, null);
});

test('pause during ambiguous verification preserves PAUSED while reconciling SENT_VERIFIED', async () => {
  const repo = new Repo(setupAmbiguous());
  const transport = { async execute(_tab, request) {
    assert.equal(request.mode, 'VERIFY_AFTER_UNCERTAIN_SUBMIT');
    await repo.update(draft => {
      draft.sessionsById.s1.runState = RunState.PAUSED;
      return draft;
    });
    return { status: InteractionResult.SENT_VERIFIED };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.SENT_VERIFIED);
});

test('stop during ambiguous verification preserves STOPPED while retaining pending prompt evidence', async () => {
  const repo = new Repo(setupAmbiguous());
  const transport = { async execute(_tab, request) {
    assert.equal(request.mode, 'VERIFY_AFTER_UNCERTAIN_SUBMIT');
    await repo.update(draft => {
      draft.sessionsById.s1.runState = RunState.STOPPED;
      return draft;
    });
    return { status: InteractionResult.INSERTED_NOT_SENT };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.runState, RunState.STOPPED);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
});

test('stale ambiguous verification cannot reconcile a replacement operation', async () => {
  const repo = new Repo(setupAmbiguous());
  const transport = { async execute(_tab, request) {
    assert.equal(request.mode, 'VERIFY_AFTER_UNCERTAIN_SUBMIT');
    assert.equal(request.requestId, 'op1');
    await repo.update(draft => {
      const live = draft.sessionsById.s1;
      live.operation = {
        ...live.operation,
        operationId: 'op2',
        promptFingerprint: 'fp2',
        promptText: 'hello again',
        phase: OperationPhase.AMBIGUOUS,
        updatedAt: 50,
      };
      live.tasksById.t1.status = 'SUBMISSION_UNCERTAIN';
      return draft;
    });
    return { status: InteractionResult.SENT_VERIFIED };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  const result = await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.equal(result.kind, 'OPERATION_CHANGED');
  assert.equal(after.sessionsById.s1.operation.operationId, 'op2');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s1.tasksById.t1.status, 'SUBMISSION_UNCERTAIN');
  assert.equal(after.sendArbiter.lease.operationId, 'op1');
});
