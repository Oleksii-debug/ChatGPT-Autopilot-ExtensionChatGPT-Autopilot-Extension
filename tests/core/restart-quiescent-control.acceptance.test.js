import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRuntimeColdStart, runRuntimeCycle } from '../../src/core/runtime-execution.js';
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

function stateWithSubmitting(runState) {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/restart-control' });
  const session = createSession({
    id: 's1',
    name: 'restart control authority',
    tasks: [task],
    sharedPrompt: 'continue',
    retryBackoffMs: 30000,
    now: 1,
  });
  session.runState = runState;
  session.operation = {
    operationId: 'op-submit',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp-submit',
    promptText: 'continue',
    phase: OperationPhase.SUBMITTING,
    targetUrl: task.normalizedUrl,
    createdAt: 1000,
    updatedAt: 2000,
    preSendDeadline: 0,
    submitStartedAt: 2000,
    verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  state.sendArbiter.lease = {
    ownerSessionId: 's1',
    operationId: 'op-submit',
    acquiredAt: 2000,
    expiresAt: 60000,
  };
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

test('cold restart converts paused SUBMITTING evidence to AMBIGUOUS without resurrecting PAUSED', async () => {
  const repo = new Repo(stateWithSubmitting(RunState.PAUSED));
  const chromeApi = fakeChrome();
  const now = 10000;

  const result = await reconcileRuntimeColdStart({
    repository: repo,
    chromeApi,
    executionAvailable: true,
    now: () => now,
  });
  const after = await repo.load();

  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS, 'submit evidence must remain unresolved after restart');
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED, 'explicit PAUSE must remain authoritative across restart');
  assert.equal(result.wakeAt, null, 'paused unresolved work must not schedule automatic recovery until explicit resume');
  assert.equal(chromeApi.calls.some(call => call[0] === 'create'), false, 'paused restart must not arm an automatic execution wake');
});

test('startup cycle never executes a STOPPED Session merely because unresolved SUBMITTING evidence exists', async () => {
  const repo = new Repo(stateWithSubmitting(RunState.STOPPED));
  const chromeApi = fakeChrome();
  const now = 10000;
  let executorCalls = 0;
  const executor = {
    async runSessionOnce() {
      executorCalls += 1;
      return { kind: 'SHOULD_NOT_RUN' };
    },
  };

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi,
    executor,
    startup: true,
    executionAvailable: true,
    now: () => now,
  });
  const after = await repo.load();

  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS, 'restart must preserve unresolved submit evidence safely');
  assert.equal(after.sessionsById.s1.runState, RunState.STOPPED, 'explicit STOP must remain authoritative across restart');
  assert.equal(executorCalls, 0, 'STOPPED Session must never be resurrected into automatic recovery execution');
  assert.deepEqual(result.outcomes, []);
  assert.equal(result.wakeAt, null, 'STOPPED unresolved work must wait for explicit user action');
  assert.equal(chromeApi.calls.some(call => call[0] === 'create'), false, 'STOPPED restart must not arm an automatic execution wake');
});
