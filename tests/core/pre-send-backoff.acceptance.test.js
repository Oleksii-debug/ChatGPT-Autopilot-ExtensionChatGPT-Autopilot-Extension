import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { computeNextWake } from '../../src/core/recovery.js';
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

function stateInExpiredPreSendWait(now) {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/example' });
  const session = createSession({
    id: 's1',
    name: 'S',
    tasks: [task],
    sharedPrompt: 'hello',
    preSendDelayMs: 1000,
    retryBackoffMs: 30000,
    minimumSendIntervalMs: 5000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp',
    promptText: 'hello',
    phase: OperationPhase.PRE_SEND_WAIT,
    targetUrl: task.normalizedUrl,
    createdAt: 1,
    updatedAt: 2,
    preSendDeadline: now - 1,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

test('temporary PREPARE_SEND failure must honor retry backoff instead of immediate wake spin', async () => {
  const now = 100000;
  const repo = new Repo(stateInExpiredPreSendWait(now));
  const transport = { async execute(_tabId, request) {
    assert.equal(request.mode, 'PREPARE_SEND');
    return { status: InteractionResult.TEMPORARY_ERROR, safeDiagnosticCode: 'NETWORK_TEMPORARY' };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, {
    now: () => now,
    cryptoApi: webcrypto,
  });

  const result = await executor.runSessionOnce('s1');
  assert.equal(result.kind, 'PREPARE_HELD');

  const after = await repo.load();
  const session = after.sessionsById.s1;
  const retryAt = session.tasksById.t1.retryAfterAt;
  assert.equal(retryAt, now + session.retryBackoffMs);

  const nextWake = computeNextWake(after, now);
  assert.ok(
    nextWake >= retryAt,
    `expected next wake >= retryAt (${retryAt}), got ${nextWake}; PRE_SEND_WAIT must not bypass task backoff`,
  );
});

test('rate-limited PREPARE_SEND must honor at least the one-minute backoff', async () => {
  const now = 200000;
  const repo = new Repo(stateInExpiredPreSendWait(now));
  const transport = { async execute(_tabId, request) {
    assert.equal(request.mode, 'PREPARE_SEND');
    return { status: InteractionResult.RATE_LIMITED, safeDiagnosticCode: 'RATE_LIMITED' };
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, {
    now: () => now,
    cryptoApi: webcrypto,
  });

  const result = await executor.runSessionOnce('s1');
  assert.equal(result.kind, 'PREPARE_HELD');

  const after = await repo.load();
  const session = after.sessionsById.s1;
  const retryAt = session.tasksById.t1.retryAfterAt;
  assert.equal(retryAt, now + Math.max(session.retryBackoffMs, 60000));

  const nextWake = computeNextWake(after, now);
  assert.ok(
    nextWake >= retryAt,
    `expected rate-limit wake >= retryAt (${retryAt}), got ${nextWake}; PRE_SEND_WAIT must not create a hot loop`,
  );
});
