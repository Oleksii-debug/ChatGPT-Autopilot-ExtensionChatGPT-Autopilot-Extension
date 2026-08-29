import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
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

function submittingState() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/submitting-restart' });
  const session = createSession({
    id: 's1',
    name: 'repeated submitting restart',
    tasks: [task],
    sharedPrompt: 'continue',
    retryBackoffMs: 30000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  session.operation = {
    operationId: 'op-submit-restart',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp-submit-restart',
    promptText: 'continue',
    phase: OperationPhase.SUBMITTING,
    targetUrl: task.normalizedUrl,
    createdAt: 5000,
    updatedAt: 9000,
    preSendDeadline: 0,
    submitStartedAt: 9000,
    verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  state.sendArbiter.lease = {
    ownerSessionId: 's1',
    operationId: 'op-submit-restart',
    acquiredAt: 9000,
    expiresAt: 12000,
  };
  return state;
}

function fakeChrome() {
  const alarmCalls = [];
  return {
    alarmCalls,
    tabs: {
      async get() { return { id: 7, url: 'https://chatgpt.com/c/submitting-restart' }; },
      async query() { return [{ id: 7, url: 'https://chatgpt.com/c/submitting-restart' }]; },
      async create({ url }) { return { id: 8, url }; },
    },
    alarms: {
      async clear(name) { alarmCalls.push(['clear', name]); return true; },
      async create(name, options) { alarmCalls.push(['create', name, options.when]); },
    },
  };
}

test('repeated cold starts around SUBMITTING stay ambiguous through offline backoff and never resend', async () => {
  const repo = new Repo(submittingState());
  const chromeApi = fakeChrome();
  const clock = { value: 10000 };
  const modes = [];
  let offline = true;
  const transport = {
    async execute(_tabId, request) {
      modes.push(request.mode);
      assert.equal(request.requestId, 'op-submit-restart', 'recovery must remain bound to the original operation');
      assert.equal(request.mode, 'VERIFY_AFTER_UNCERTAIN_SUBMIT', 'uncertain recovery must never call a Send mode');
      if (offline) throw new Error('wifi disconnected during uncertain-submit verification');
      return { status: InteractionResult.SENT_VERIFIED };
    },
  };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, {
    now: () => clock.value,
    cryptoApi: webcrypto,
  });

  const first = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    startup: true,
    executionAvailable: true,
    now: () => clock.value,
  });
  let after = await repo.load();

  assert.equal(first.outcomes[0].result.kind, 'TEMPORARY_RUNTIME_ERROR');
  assert.deepEqual(modes, ['VERIFY_AFTER_UNCERTAIN_SUBMIT']);
  assert.equal(after.sessionsById.s1.runState, RunState.RECOVERING);
  assert.equal(after.sessionsById.s1.operation.operationId, 'op-submit-restart');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 40000);
  assert.equal(first.wakeAt, 40000);
  assert.equal(after.sendArbiter.lease?.operationId, 'op-submit-restart', 'unexpired uncertain-submit lease must not be released on network failure');

  clock.value = 15000;
  const second = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    startup: true,
    executionAvailable: true,
    now: () => clock.value,
  });
  after = await repo.load();

  assert.deepEqual(second.outcomes[0].result, { kind: 'WAIT_RECOVERY', wakeAt: 40000 });
  assert.deepEqual(modes, ['VERIFY_AFTER_UNCERTAIN_SUBMIT'], 'restart before retry expiry must perform zero additional Interaction work');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 40000);
  assert.equal(after.sendArbiter.lease, null, 'startup may clear an expired lease without clearing ambiguous operation evidence');
  assert.equal(second.wakeAt, 40000);

  clock.value = 25000;
  const third = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    startup: true,
    executionAvailable: true,
    now: () => clock.value,
  });
  after = await repo.load();

  assert.deepEqual(third.outcomes[0].result, { kind: 'WAIT_RECOVERY', wakeAt: 40000 });
  assert.deepEqual(modes, ['VERIFY_AFTER_UNCERTAIN_SUBMIT'], 'repeated restart must not create a verification hot-loop');
  assert.equal(after.sessionsById.s1.operation.operationId, 'op-submit-restart');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 40000);

  offline = false;
  clock.value = 40000;
  const recovered = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    startup: true,
    executionAvailable: true,
    now: () => clock.value,
  });
  after = await repo.load();

  assert.equal(recovered.outcomes[0].result.kind, 'RECOVERED_SENT');
  assert.deepEqual(modes, ['VERIFY_AFTER_UNCERTAIN_SUBMIT', 'VERIFY_AFTER_UNCERTAIN_SUBMIT']);
  assert.equal(modes.includes('SUBMIT_EXISTING'), false, 'network recovery from ambiguous submission must never resend');
  assert.equal(after.sessionsById.s1.operation.operationId, 'op-submit-restart');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.SENT_VERIFIED);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 0);
  assert.equal(after.sessionsById.s1.tasksById.t1.lastVerifiedSendAt, 40000);
});
