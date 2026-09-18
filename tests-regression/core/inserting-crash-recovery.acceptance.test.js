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

function setupRunning() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/network-test' });
  const session = createSession({
    id: 's1',
    name: 'network crash recovery',
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
      throw new Error(`unexpected Interaction mode after insertion transport loss: ${request.mode}`);
    },
  };
  return new AutomaticSessionExecutor(repo, chromeApi, transport, {
    now: () => clock.value,
    cryptoApi: webcrypto,
  });
}

test('network loss during INSERT_ONLY cannot become an active INSERTING retry zombie', async () => {
  const repo = new Repo(setupRunning());
  const chromeApi = fakeChrome();
  const clock = { value: 10000 };
  const modes = [];
  const executor = executorFor(repo, chromeApi, clock, modes);

  const first = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    executionAvailable: true,
    now: () => clock.value,
  });

  const afterFailure = await repo.load();
  assert.equal(first.outcomes[0].result.kind, 'TEMPORARY_RUNTIME_ERROR');
  assert.deepEqual(modes, ['CHECK_ONLY', 'INSERT_ONLY']);
  assert.equal(afterFailure.sessionsById.s1.operation.phase, OperationPhase.INSERTING);
  assert.equal(afterFailure.sessionsById.s1.tasksById.t1.retryAfterAt, 40000);
  assert.equal(first.wakeAt, 40000);

  clock.value = 40000;
  const second = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    executionAvailable: true,
    now: () => clock.value,
  });
  const afterRetry = await repo.load();

  assert.notEqual(
    second.outcomes[0].result.kind,
    'OPERATION_IN_PROGRESS',
    'expired backoff must not strand an active Session forever in INSERTING',
  );
  assert.notEqual(
    afterRetry.sessionsById.s1.operation?.phase,
    OperationPhase.INSERTING,
    'recovery must move INSERTING to a retryable or fail-closed durable state',
  );
  assert.notEqual(
    second.wakeAt,
    clock.value,
    'recovery must not create an immediate alarm hot-loop after INSERTING backoff expires',
  );
  assert.equal(modes.includes('SUBMIT_EXISTING'), false, 'network loss before insertion proof must never Send');
  assert.notEqual(afterRetry.sessionsById.s1.operation?.phase, OperationPhase.SENT_VERIFIED, 'network loss must never fake success');
});

test('restart with an expired persisted INSERTING operation must not preserve the zombie phase', async () => {
  const state = setupRunning();
  const session = state.sessionsById.s1;
  session.tasksById.t1.retryAfterAt = 20000;
  session.operation = {
    operationId: 'op-inserting',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp-inserting',
    promptText: 'continue',
    phase: OperationPhase.INSERTING,
    targetUrl: session.tasksById.t1.normalizedUrl,
    createdAt: 10000,
    updatedAt: 10000,
    preSendDeadline: 0,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };

  const repo = new Repo(state);
  const chromeApi = fakeChrome();
  const clock = { value: 50000 };
  const modes = [];
  const executor = executorFor(repo, chromeApi, clock, modes);

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    startup: true,
    executionAvailable: true,
    now: () => clock.value,
  });
  const after = await repo.load();

  assert.equal(after.sessionsById.s1.runState, RunState.RECOVERING);
  assert.notEqual(
    result.outcomes[0].result.kind,
    'OPERATION_IN_PROGRESS',
    'cold start must reconcile an interrupted pre-submit insertion phase instead of wedging it',
  );
  assert.notEqual(after.sessionsById.s1.operation?.phase, OperationPhase.INSERTING);
  assert.notEqual(result.wakeAt, clock.value, 'restart recovery must not immediately spin the canonical alarm');
  assert.equal(modes.includes('SUBMIT_EXISTING'), false, 'restart recovery from INSERTING must never infer permission to Send');
  assert.notEqual(after.sessionsById.s1.operation?.phase, OperationPhase.SENT_VERIFIED, 'restart must never invent submission success');
});
