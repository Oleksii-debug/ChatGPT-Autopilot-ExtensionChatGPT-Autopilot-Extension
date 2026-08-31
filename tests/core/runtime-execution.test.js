import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRuntimeColdStart, runRuntimeCycle, RuntimeExecutionConstants } from '../../src/core/runtime-execution.js';
import { computeNextWake } from '../../src/core/recovery.js';
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

function session(id, runState = RunState.RUNNING) {
  const task = createTask({ id: `${id}-t1`, url: `https://chatgpt.com/c/${id}` });
  const value = createSession({
    id,
    name: id,
    tasks: [task],
    sharedPrompt: 'continue',
    retryBackoffMs: 30000,
    now: 1,
  });
  value.runState = runState;
  return value;
}

function stateWith(...sessions) {
  const state = createEmptyState(1);
  for (const value of sessions) {
    state.sessionsById[value.id] = value;
    state.sessionOrder.push(value.id);
  }
  return state;
}

function fakeChrome() {
  const calls = [];
  return {
    calls,
    alarms: {
      async clear(name) { calls.push(['clear', name]); return true; },
      async create(name, options) { calls.push(['create', name, options.when]); },
    },
  };
}

test('runtime cycle executes RUNNING/RECOVERING sessions in stable order and skips quiescent sessions', async () => {
  const repo = new Repo(stateWith(
    session('s1', RunState.RUNNING),
    session('s2', RunState.PAUSED),
    session('s3', RunState.RECOVERING),
  ));
  const seen = [];
  const executor = { async runSessionOnce(id) { seen.push(id); return { kind: 'IDLE' }; } };
  const chromeApi = fakeChrome();

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    executionAvailable: true,
    now: () => 1000,
  });

  assert.deepEqual(seen, ['s1', 's3']);
  assert.deepEqual(result.outcomes.map(item => item.sessionId), ['s1', 's3']);
  assert.equal(chromeApi.calls.length, 1);
  assert.equal(chromeApi.calls[0][0], 'create');
});

test('cold-start reconciliation repairs SUBMITTING and re-arms without running an executor', async () => {
  const value = session('s1', RunState.RUNNING);
  value.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 's1-t1',
    promptFingerprint: 'fp',
    promptText: 'continue',
    phase: OperationPhase.SUBMITTING,
    targetUrl: 'https://chatgpt.com/c/s1',
    createdAt: 1,
    updatedAt: 1,
    preSendDeadline: 0,
    submitStartedAt: 4000,
    verificationDeadline: 0,
  };
  const repo = new Repo(stateWith(value));
  const chromeApi = fakeChrome();

  const result = await reconcileRuntimeColdStart({
    repository: repo,
    chromeApi,
    executionAvailable: true,
    now: () => 5000,
  });

  const after = await repo.load();
  assert.equal(after.sessionsById.s1.runState, RunState.RECOVERING);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(result.wakeAt, 5000);
  assert.deepEqual(chromeApi.calls, [
    ['create', 'autopilot-core-wake', 5500],
  ]);
});

test('startup converts persisted RUNNING to RECOVERING before executor sees it', async () => {
  const repo = new Repo(stateWith(session('s1', RunState.RUNNING)));
  let observed;
  const executor = { async runSessionOnce(id) {
    observed = (await repo.load()).sessionsById[id].runState;
    return { kind: 'IDLE' };
  } };

  await runRuntimeCycle({
    repository: repo,
    chromeApi: fakeChrome(),
    executor,
    startup: true,
    executionAvailable: true,
    now: () => 2000,
  });

  assert.equal(observed, RunState.RECOVERING);
  assert.equal((await repo.load()).sessionsById.s1.runState, RunState.RECOVERING);
});

test('Chrome startup preserves a configured retry deadline and automatically re-arms the active Session', async () => {
  const value = session('s1', RunState.RUNNING);
  value.retryBackoffMs = 5 * 60 * 1000;
  value.tasksById['s1-t1'].status = 'RATE_LIMITED';
  value.tasksById['s1-t1'].retryAfterAt = 301000;
  const repo = new Repo(stateWith(value));
  const chromeApi = fakeChrome();
  const seen = [];
  const executor = { async runSessionOnce(id) {
    const live = (await repo.load()).sessionsById[id];
    seen.push([id, live.runState, live.tasksById['s1-t1'].retryAfterAt]);
    return { kind: 'WAIT', wakeAt: live.tasksById['s1-t1'].retryAfterAt };
  } };

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    startup: true,
    executionAvailable: true,
    now: () => 1000,
  });

  assert.deepEqual(seen, [['s1', RunState.RECOVERING, 301000]]);
  assert.equal(result.wakeAt, 301000);
  assert.deepEqual(chromeApi.calls, [['create', 'autopilot-core-wake', 301000]]);
});

test('execution-disabled startup remains fail closed and never calls executor', async () => {
  const repo = new Repo(stateWith(session('s1', RunState.RUNNING)));
  let calls = 0;
  const executor = { async runSessionOnce() { calls += 1; } };

  await runRuntimeCycle({
    repository: repo,
    chromeApi: fakeChrome(),
    executor,
    startup: true,
    executionAvailable: false,
    now: () => 3000,
  });

  const after = await repo.load();
  assert.equal(calls, 0);
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.equal(after.sessionsById.s1.pausedByRuntimeGate, true);
});

test('temporary runtime failure persists bounded retry instead of hot-looping', async () => {
  const value = session('s1', RunState.RUNNING);
  value.retryBackoffMs = 3 * 60 * 1000;
  const repo = new Repo(stateWith(value));
  const executor = { async runSessionOnce() {
    const error = new Error('Selected ChatGPT tab did not finish navigation before CHECK_ONLY');
    error.safeDiagnosticCode = 'TAB_NAVIGATION_TIMEOUT';
    error.autopilotTaskId = 's1-t1';
    throw error;
  } };
  const chromeApi = fakeChrome();

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    executionAvailable: true,
    now: () => 10000,
  });

  const after = await repo.load();
  assert.equal(result.outcomes[0].result.kind, 'TEMPORARY_RUNTIME_ERROR');
  assert.equal(result.outcomes[0].result.diagnosticCode, 'TAB_NAVIGATION_TIMEOUT');
  assert.equal(after.sessionsById.s1.nextAllowedSendAt, 0, 'runtime failure must not manufacture a Send cooldown');
  assert.equal(after.sessionsById.s1.tasksById['s1-t1'].status, 'RETRY_WAIT');
  assert.equal(after.sessionsById.s1.tasksById['s1-t1'].retryAfterAt, 190000);
  assert.equal(
    after.sessionsById.s1.lastError,
    `${RuntimeExecutionConstants.RUNTIME_RETRY_MESSAGE} Diagnostic: TAB_NAVIGATION_TIMEOUT.`,
  );
  assert.equal(after.logs.s1.at(-1).message, 'Runtime retry scheduled [TAB_NAVIGATION_TIMEOUT]');
  assert.equal(result.wakeAt, 190000);
});

test('profile arbiter busy is treated as a scheduling condition, not a runtime failure', async () => {
  const value = session('s1', RunState.RUNNING);
  value.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 's1-t1',
    promptFingerprint: 'fp',
    promptText: 'continue',
    phase: OperationPhase.PRE_SEND_WAIT,
    targetUrl: 'https://chatgpt.com/c/s1',
    createdAt: 1,
    updatedAt: 1,
    preSendDeadline: 9000,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
  const state = stateWith(value);
  state.sendArbiter.profileNextAllowedSendAt = 12000;
  const repo = new Repo(state);
  const executor = { async runSessionOnce() { throw new Error('Profile send arbiter is busy'); } };

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi: fakeChrome(),
    executor,
    executionAvailable: true,
    now: () => 10000,
  });

  assert.equal(result.outcomes[0].result.kind, 'PROFILE_BUSY');
  assert.equal((await repo.load()).sessionsById.s1.lastError, '');
  assert.equal(result.wakeAt, 12000);
});

test('PRE_SEND_WAIT next wake respects active profile lease expiry', () => {
  const value = session('s1', RunState.RUNNING);
  value.operation = {
    operationId: 'op1', sessionId: 's1', taskId: 's1-t1', promptFingerprint: 'fp', promptText: 'continue',
    phase: OperationPhase.PRE_SEND_WAIT, targetUrl: 'https://chatgpt.com/c/s1', createdAt: 1, updatedAt: 1,
    preSendDeadline: 9000, submitStartedAt: 0, verificationDeadline: 0,
  };
  const state = stateWith(value);
  state.sendArbiter.lease = { ownerSessionId: 'other', operationId: 'other-op', acquiredAt: 9000, expiresAt: 15000 };
  assert.equal(computeNextWake(state, 10000), 15000);
});
