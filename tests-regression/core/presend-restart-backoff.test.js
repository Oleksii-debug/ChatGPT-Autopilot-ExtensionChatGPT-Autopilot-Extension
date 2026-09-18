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

function stateWaitingToSend({ preSendDeadline = 10000, retryAfterAt = 40000 } = {}) {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/presend-backoff' });
  task.retryAfterAt = retryAfterAt;
  const session = createSession({
    id: 's1',
    name: 'pre-send restart backoff',
    tasks: [task],
    sharedPrompt: 'continue',
    preSendDelayMs: 1000,
    retryBackoffMs: 30000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  session.operation = {
    operationId: 'op-presend',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp-presend',
    promptText: 'continue',
    phase: OperationPhase.PRE_SEND_WAIT,
    targetUrl: task.normalizedUrl,
    createdAt: 1000,
    updatedAt: 1000,
    preSendDeadline,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

function fakeChrome() {
  const alarmCalls = [];
  return {
    alarmCalls,
    tabs: {
      async get() { return { id: 7, url: 'https://chatgpt.com/c/presend-backoff' }; },
      async query() { return [{ id: 7, url: 'https://chatgpt.com/c/presend-backoff' }]; },
      async create({ url }) { return { id: 8, url }; },
    },
    alarms: {
      async clear(name) { alarmCalls.push(['clear', name]); return true; },
      async create(name, options) { alarmCalls.push(['create', name, options.when]); },
    },
  };
}

function makeExecutor(repo, chromeApi, clock, modes) {
  const transport = {
    async execute(_tabId, request) {
      modes.push(request.mode);
      if (request.mode === 'PREPARE_SEND') return { status: InteractionResult.READY };
      if (request.mode === 'SUBMIT_EXISTING') return { status: InteractionResult.SENT_VERIFIED };
      throw new Error(`unexpected Interaction mode: ${request.mode}`);
    },
  };
  return new AutomaticSessionExecutor(repo, chromeApi, transport, {
    now: () => clock.value,
    cryptoApi: webcrypto,
  });
}

test('PRE_SEND_WAIT enforces task retry backoff even after pre-send delay elapsed', async () => {
  const repo = new Repo(stateWaitingToSend());
  const chromeApi = fakeChrome();
  const clock = { value: 20000 };
  const modes = [];
  const executor = makeExecutor(repo, chromeApi, clock, modes);

  const result = await executor.runSessionOnce('s1');
  const after = await repo.load();

  assert.deepEqual(result, { kind: 'WAIT_PRE_SEND', wakeAt: 40000 });
  assert.deepEqual(modes, [], 'retry barrier must block PREPARE_SEND and SUBMIT_EXISTING');
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
  assert.equal(after.sessionsById.s1.lastSuccessfulSendAt, 0);
  assert.equal(after.sendArbiter.lease, null);
});

test('repeated cold-start/runtime wakes cannot bypass PRE_SEND_WAIT retry backoff', async () => {
  const repo = new Repo(stateWaitingToSend());
  const chromeApi = fakeChrome();
  const clock = { value: 20000 };
  const modes = [];
  const executor = makeExecutor(repo, chromeApi, clock, modes);

  const cold = await reconcileRuntimeColdStart({
    repository: repo,
    chromeApi,
    executionAvailable: true,
    now: () => clock.value,
  });
  assert.equal(cold.wakeAt, 40000);

  const firstWake = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    executionAvailable: true,
    now: () => clock.value,
  });
  assert.deepEqual(firstWake.outcomes[0].result, { kind: 'WAIT_PRE_SEND', wakeAt: 40000 });

  clock.value = 30000;
  const secondWake = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    startup: true,
    executionAvailable: true,
    now: () => clock.value,
  });
  const after = await repo.load();

  assert.deepEqual(secondWake.outcomes[0].result, { kind: 'WAIT_PRE_SEND', wakeAt: 40000 });
  assert.deepEqual(modes, [], 'multiple restart/wake events before retry expiry must perform zero Interaction calls');
  assert.equal(after.sessionsById.s1.runState, RunState.RECOVERING);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.PRE_SEND_WAIT);
  assert.equal(after.sessionsById.s1.lastSuccessfulSendAt, 0);
  assert.equal(after.sendArbiter.lease, null);
});

test('PRE_SEND_WAIT uses the later of pre-send delay and retry backoff', async () => {
  const repo = new Repo(stateWaitingToSend({ preSendDeadline: 50000, retryAfterAt: 40000 }));
  const chromeApi = fakeChrome();
  const clock = { value: 45000 };
  const modes = [];
  const executor = makeExecutor(repo, chromeApi, clock, modes);

  const result = await executor.runSessionOnce('s1');

  assert.deepEqual(result, { kind: 'WAIT_PRE_SEND', wakeAt: 50000 });
  assert.deepEqual(modes, []);
});
