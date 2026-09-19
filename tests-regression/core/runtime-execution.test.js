import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRuntimeColdStart, runRuntimeCycle, RuntimeExecutionConstants } from '../../src/core/runtime-execution.js';
import { computeNextWake, suspendActiveSessionsWhenExecutionUnavailable } from '../../src/core/recovery.js';
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

test('legacy PROFILE_BUSY result is tolerated but no saved profile barrier delays the next wake', async () => {
  const value = session('s1', RunState.RUNNING);
  value.operation = {
    operationId: 'op1', sessionId: 's1', taskId: 's1-t1', promptFingerprint: 'fp', promptText: 'continue',
    phase: OperationPhase.PRE_SEND_WAIT, targetUrl: 'https://chatgpt.com/c/s1', createdAt: 1, updatedAt: 1,
    preSendDeadline: 9000, submitStartedAt: 0, verificationDeadline: 0,
  };
  const state = stateWith(value);
  state.sendArbiter.profileNextAllowedSendAt = 12000;
  const repo = new Repo(state);
  const executor = { async runSessionOnce() { throw new Error('Profile send arbiter is busy'); } };

  const result = await runRuntimeCycle({ repository: repo, chromeApi: fakeChrome(), executor, executionAvailable: true, now: () => 10000 });
  assert.equal(result.outcomes[0].result.kind, 'PROFILE_BUSY');
  assert.equal((await repo.load()).sessionsById.s1.lastError, '');
  assert.equal(result.wakeAt, 10000);
});

test('PRE_SEND_WAIT next wake ignores obsolete profile lease expiry', () => {
  const value = session('s1', RunState.RUNNING);
  value.operation = {
    operationId: 'op1', sessionId: 's1', taskId: 's1-t1', promptFingerprint: 'fp', promptText: 'continue',
    phase: OperationPhase.PRE_SEND_WAIT, targetUrl: 'https://chatgpt.com/c/s1', createdAt: 1, updatedAt: 1,
    preSendDeadline: 9000, submitStartedAt: 0, verificationDeadline: 0,
  };
  const state = stateWith(value);
  state.sendArbiter.lease = { ownerSessionId: 'other', operationId: 'other-op', acquiredAt: 9000, expiresAt: 15000 };
  assert.equal(computeNextWake(state, 10000), 10000);
});

test('shared-URL navigation failure holds the whole cycle series so scheduler does not jump ahead', async () => {
  const first = createTask({ id: 'shared-t1', url: 'https://chatgpt.com/' });
  const second = createTask({ id: 'shared-t2', url: 'https://chatgpt.com/' });
  const third = createTask({ id: 'shared-t3', url: 'https://chatgpt.com/' });
  const value = createSession({
    id: 'shared', name: 'shared', tasks: [first, second, third], sharedPrompt: 'continue', retryBackoffMs: 15000, now: 1,
  });
  value.runState = RunState.RUNNING;
  value.urlMode = 'shared';
  const repo = new Repo(stateWith(value));
  const executor = { async runSessionOnce() {
    const error = new Error('Selected ChatGPT tab did not finish navigation before CHECK_ONLY');
    error.safeDiagnosticCode = 'TAB_NAVIGATION_TIMEOUT';
    error.autopilotTaskId = 'shared-t1';
    throw error;
  } };

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi: fakeChrome(),
    executor,
    executionAvailable: true,
    now: () => 10000,
  });

  const after = await repo.load();
  assert.equal(result.wakeAt, 25000);
  assert.equal(after.sessionsById.shared.currentTaskIndex, 0);
  assert.equal(after.sessionsById.shared.tasksById['shared-t1'].retryAfterAt, 25000);
  assert.equal(after.sessionsById.shared.tasksById['shared-t2'].retryAfterAt, 25000);
  assert.equal(after.sessionsById.shared.tasksById['shared-t3'].retryAfterAt, 25000);
});

test('unique-URL navigation failure keeps other independent tasks eligible', async () => {
  const first = createTask({ id: 'unique-t1', url: 'https://chatgpt.com/c/one' });
  const second = createTask({ id: 'unique-t2', url: 'https://chatgpt.com/c/two' });
  const value = createSession({
    id: 'unique', name: 'unique', tasks: [first, second], sharedPrompt: 'continue', retryBackoffMs: 15000, now: 1,
  });
  value.runState = RunState.RUNNING;
  value.urlMode = 'unique';
  const repo = new Repo(stateWith(value));
  const executor = { async runSessionOnce() {
    const error = new Error('Selected ChatGPT tab did not finish navigation before CHECK_ONLY');
    error.safeDiagnosticCode = 'TAB_NAVIGATION_TIMEOUT';
    error.autopilotTaskId = 'unique-t1';
    throw error;
  } };

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi: fakeChrome(),
    executor,
    executionAvailable: true,
    now: () => 10000,
  });

  const after = await repo.load();
  assert.equal(after.sessionsById.unique.tasksById['unique-t1'].retryAfterAt, 25000);
  assert.equal(after.sessionsById.unique.tasksById['unique-t2'].retryAfterAt, 0);
  assert.equal(result.wakeAt, 10000, 'independent task should remain immediately eligible');
});


test('stopped Session retirePending ownership remains alarm-driven and retries independently of provider rate limit', async () => {
  const value = session('retire-stopped', RunState.STOPPED);
  const state = stateWith(value);
  state.profile.rateLimitUntil = 9_999_999;
  state.tabHintsByTaskId['retire-stopped-t1'] = {
    tabId: 77,
    sessionId: 'retire-stopped',
    normalizedUrl: 'https://chatgpt.com/c/retire-stopped',
    kind: 'TASK',
    ownedByExtension: true,
    retirePending: true,
    retireAttempts: 1,
    retireRetryAt: 11_000,
    boundAt: 1,
  };
  const repo = new Repo(state);
  const tabs = new Map([[77, { id: 77, url: 'https://chatgpt.com/c/retire-stopped' }]]);
  const alarmCalls = [];
  const chromeApi = {
    tabs: {
      async remove(id) { if (!tabs.has(id)) throw new Error('No tab with id'); tabs.delete(id); },
      async get(id) { if (!tabs.has(id)) throw new Error('No tab with id'); return { ...tabs.get(id) }; },
    },
    alarms: {
      async clear(name) { alarmCalls.push(['clear', name]); return true; },
      async create(name, options) { alarmCalls.push(['create', name, options.when]); },
    },
  };
  const executor = { async runSessionOnce() { throw new Error('stopped Session must never execute'); } };

  assert.equal(computeNextWake(state, 10_000), 11_000,
    'physical cleanup wake must not be delayed by ChatGPT provider rate-limit');

  const beforeDue = await runRuntimeCycle({
    repository: repo, chromeApi, executor, executionAvailable: true, now: () => 10_000,
  });
  assert.equal(beforeDue.wakeAt, 11_000);
  assert.equal(tabs.has(77), true);

  const due = await runRuntimeCycle({
    repository: repo, chromeApi, executor, executionAvailable: true, now: () => 11_000,
  });
  assert.equal(tabs.has(77), false);
  assert.equal((await repo.load()).tabHintsByTaskId['retire-stopped-t1'], undefined);
  assert.equal(due.wakeAt, null);
  assert.ok(alarmCalls.some(call => call[0] === 'create' && call[2] >= 11_000));
});


test('post-submit ambiguous transport failure preserves the exact evidence tab instead of churning ownership', async () => {
  const value = session('evidence', RunState.RECOVERING);
  value.tabStrategy = 'OPEN_CLOSE_PER_TASK';
  value.operation = {
    operationId: 'op-evidence', sessionId: 'evidence', taskId: 'evidence-t1', promptFingerprint: 'fp', promptText: 'continue',
    phase: OperationPhase.AMBIGUOUS, targetUrl: 'https://chatgpt.com/c/evidence', launchUrl: 'https://chatgpt.com/',
    createdAt: 1, updatedAt: 1, preSendDeadline: 0, submitStartedAt: 9000, verificationDeadline: 40000,
  };
  const state = stateWith(value);
  state.tabHintsByTaskId['evidence-t1'] = {
    tabId: 77, sessionId: 'evidence', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK', ownedByExtension: true, retirePending: false, boundAt: 1,
  };
  const repo = new Repo(state);
  let removes = 0;
  const chromeApi = {
    tabs: {
      async remove() { removes += 1; },
      async get(id) { return { id, url: 'https://chatgpt.com/c/evidence', status: 'complete' }; },
    },
    alarms: {
      async clear() { return true; },
      async create() {},
    },
  };
  const executor = { async runSessionOnce() {
    const error = new Error('Safe receiver restoration failed after the receiving end was missing');
    error.safeDiagnosticCode = 'INTERACTION_RECEIVER_RESTORE_FAILED';
    error.autopilotTaskId = 'evidence-t1';
    throw error;
  } };

  await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => 10000 });
  const after = await repo.load();
  assert.equal(removes, 0);
  assert.equal(after.tabHintsByTaskId['evidence-t1'].tabId, 77);
  assert.equal(after.tabHintsByTaskId['evidence-t1'].retirePending, false);
  assert.ok(after.diagnostics.some(item => item.event === 'ДОКАЗОВУ_ВКЛАДКУ_ПІСЛЯ_SEND_ЗБЕРЕЖЕНО'));
});


test('execution-unavailable suspension preserves Drive prompt bindings without throwing', () => {
  const value = session('drive-gated', RunState.RUNNING);
  value.drivePromptSources = {
    schemaVersion: 1,
    bindings: [{
      target: 'PRIMARY',
      enabled: true,
      fileId: 'file_abcdef',
      pollIntervalMs: 180000,
      minChars: 1000,
      lastAcceptedVersion: '7',
      lastAcceptedHash: 'a'.repeat(64),
      lastCheckedAt: 1000,
      nextCheckAt: 181000,
      lastErrorCode: '',
    }],
  };
  const state = stateWith(value);

  assert.doesNotThrow(() => suspendActiveSessionsWhenExecutionUnavailable(state, 5000));
  assert.equal(state.sessionsById['drive-gated'].runState, RunState.PAUSED);
  assert.equal(state.sessionsById['drive-gated'].pausedByRuntimeGate, true);
  assert.equal(state.sessionsById['drive-gated'].drivePromptSources.bindings[0].fileId, 'file_abcdef');
  assert.equal(state.sessionsById['drive-gated'].drivePromptSources.bindings[0].lastAcceptedVersion, '7');
  assert.equal(state.sessionsById['drive-gated'].drivePromptSources.bindings[0].nextCheckAt, 181000);
});
