import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { reconcileRuntimeColdStart, runRuntimeCycle } from '../../src/core/runtime-execution.js';
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

function runningState() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/network-test' });
  const session = createSession({
    id: 's1',
    name: 'interrupted pre-submit recovery',
    tasks: [task],
    sharedPrompt: 'continue',
    preSendDelayMs: 1000,
    retryBackoffMs: 30000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

function fakeChrome() {
  const alarmCalls = [];
  return {
    alarmCalls,
    tabs: {
      async get() { return { id: 7, url: 'https://chatgpt.com/c/network-test' }; },
      async query() { return [{ id: 7, url: 'https://chatgpt.com/c/network-test' }]; },
      async create({ url }) { return { id: 8, url }; },
    },
    alarms: {
      async clear(name) { alarmCalls.push(['clear', name]); return true; },
      async create(name, options) { alarmCalls.push(['create', name, options.when]); },
    },
  };
}

function executorFor(repo, chromeApi, clock, modes) {
  const transport = {
    async execute(_tabId, request) {
      modes.push(request.mode);
      if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY };
      if (request.mode === 'INSERT_ONLY') throw new Error('network disconnected during INSERT_ONLY');
      throw new Error(`unexpected Interaction mode: ${request.mode}`);
    },
  };
  return new AutomaticSessionExecutor(repo, chromeApi, transport, {
    now: () => clock.value,
    cryptoApi: webcrypto,
  });
}

function interruptedOperation(session, phase) {
  return {
    operationId: `op-${phase.toLowerCase()}`,
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: `fp-${phase.toLowerCase()}`,
    promptText: 'continue',
    phase,
    targetUrl: session.tasksById.t1.normalizedUrl,
    createdAt: 10000,
    updatedAt: 10000,
    preSendDeadline: 0,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
}

test('network loss during INSERT_ONLY clears only the pre-submit checkpoint and backs off', async () => {
  const repo = new Repo(runningState());
  const chromeApi = fakeChrome();
  const clock = { value: 10000 };
  const modes = [];
  const executor = executorFor(repo, chromeApi, clock, modes);

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    executionAvailable: true,
    now: () => clock.value,
  });
  const after = await repo.load();

  assert.equal(result.outcomes[0].result.kind, 'TEMPORARY_RUNTIME_ERROR');
  assert.deepEqual(modes, ['CHECK_ONLY', 'INSERT_ONLY']);
  assert.equal(after.sessionsById.s1.operation, null, 'pre-submit failure must not leave an INSERTING zombie');
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 40000);
  assert.equal(result.wakeAt, 40000, 'network recovery must use bounded backoff rather than the 500ms alarm floor');
  assert.equal(modes.includes('SUBMIT_EXISTING'), false, 'pre-submit network loss must never Send');
  assert.equal(after.sessionsById.s1.lastSuccessfulSendAt, 0, 'network loss must never fake send success');
});

for (const phase of [OperationPhase.CHECKING, OperationPhase.READY, OperationPhase.INSERTING]) {
  test(`cold restart resets interrupted ${phase} to a bounded pre-submit retry`, async () => {
    const state = runningState();
    const session = state.sessionsById.s1;
    session.operation = interruptedOperation(session, phase);
    const repo = new Repo(state);
    const chromeApi = fakeChrome();
    const now = 50000;

    const result = await reconcileRuntimeColdStart({
      repository: repo,
      chromeApi,
      executionAvailable: true,
      now: () => now,
    });
    const after = await repo.load();

    assert.equal(after.sessionsById.s1.runState, RunState.RECOVERING, 'RUNNING must recover after restart');
    assert.equal(after.sessionsById.s1.operation, null, 'strictly pre-submit checkpoint may be safely discarded');
    assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, 80000);
    assert.equal(result.wakeAt, 80000, 'restart must wait for bounded backoff, not hot-loop immediately');
    assert.equal(after.sessionsById.s1.lastSuccessfulSendAt, 0, 'restart must not invent send success');
    assert.equal(state.sendArbiter.lease, null, 'pre-submit recovery must not create a send lease');
  });
}
