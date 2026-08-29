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

const chromeApi = { tabs: {
  async get() { return { id: 7, url: 'https://chatgpt.com/c/example' }; },
  async query() { return [{ id: 7, url: 'https://chatgpt.com/c/example' }]; },
  async create({ url }) { return { id: 8, url }; },
} };

function setupRunning() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/example' });
  const session = createSession({
    id: 's1',
    name: 'S',
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

function setupExpiredPreSendWait(now) {
  const state = setupRunning();
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
  const state = setupRunning();
  const session = state.sessionsById.s1;
  const task = session.tasksById.t1;
  session.runState = RunState.RECOVERING;
  session.operation = {
    operationId: 'op-ambiguous', sessionId: 's1', taskId: 't1', promptFingerprint: 'fp-ambiguous', promptText: 'hello',
    phase: OperationPhase.AMBIGUOUS, targetUrl: task.normalizedUrl, createdAt: 1, updatedAt: 2,
    preSendDeadline: 0, submitStartedAt: 2, verificationDeadline: 5000,
  };
  return state;
}

test('PAUSE committed during CHECK_ONLY is a quiescent barrier before INSERT_ONLY', async () => {
  const repo = new Repo(setupRunning());
  const modes = [];
  const transport = { async execute(_tabId, request) {
    modes.push(request.mode);
    if (request.mode === 'CHECK_ONLY') {
      await repo.update(draft => { draft.sessionsById.s1.runState = RunState.PAUSED; return draft; });
      return { status: InteractionResult.READY };
    }
    return { status: InteractionResult.INSERTED_NOT_SENT, composerState: 'VISIBLE_NONEMPTY', safeDiagnosticCode: 'INSERTION_TEXT_PROVEN' };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.deepEqual(modes, ['CHECK_ONLY']);
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.ok(!after.sessionsById.s1.operation || [OperationPhase.NONE, OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE].includes(after.sessionsById.s1.operation.phase));
});

test('STOP committed during PREPARE_SEND prevents SUBMITTING, send lease, and SUBMIT_EXISTING', async () => {
  const now = 100000;
  const repo = new Repo(setupExpiredPreSendWait(now));
  const modes = [];
  let submitCalls = 0;
  const transport = { async execute(_tabId, request) {
    modes.push(request.mode);
    if (request.mode === 'PREPARE_SEND') {
      await repo.update(draft => { draft.sessionsById.s1.runState = RunState.STOPPED; return draft; });
      return { status: InteractionResult.READY };
    }
    if (request.mode === 'SUBMIT_EXISTING') { submitCalls += 1; return { status: InteractionResult.SENT_VERIFIED }; }
    throw new Error(`unexpected mode ${request.mode}`);
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now, cryptoApi: webcrypto });
  await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.deepEqual(modes, ['PREPARE_SEND']);
  assert.equal(submitCalls, 0);
  assert.equal(after.sessionsById.s1.runState, RunState.STOPPED);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
  assert.equal(after.sendArbiter.lease, null);
});

test('PAUSE committed during ambiguous-send verification must not be overwritten by recovery success', async () => {
  const repo = new Repo(setupAmbiguous());
  const modes = [];
  const transport = { async execute(_tabId, request) {
    modes.push(request.mode);
    assert.equal(request.mode, 'VERIFY_AFTER_UNCERTAIN_SUBMIT');
    await repo.update(draft => { draft.sessionsById.s1.runState = RunState.PAUSED; return draft; });
    return { status: InteractionResult.SENT_VERIFIED };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.deepEqual(modes, ['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.SENT_VERIFIED);
});

test('STOP committed during ambiguous-send verification must not be resurrected to RUNNING when prompt is still pending', async () => {
  const repo = new Repo(setupAmbiguous());
  const modes = [];
  const transport = { async execute(_tabId, request) {
    modes.push(request.mode);
    assert.equal(request.mode, 'VERIFY_AFTER_UNCERTAIN_SUBMIT');
    await repo.update(draft => { draft.sessionsById.s1.runState = RunState.STOPPED; return draft; });
    return { status: InteractionResult.INSERTED_NOT_SENT };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => 100, cryptoApi: webcrypto });
  await executor.runSessionOnce('s1');
  const after = await repo.load();
  assert.deepEqual(modes, ['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
  assert.equal(after.sessionsById.s1.runState, RunState.STOPPED);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
});
