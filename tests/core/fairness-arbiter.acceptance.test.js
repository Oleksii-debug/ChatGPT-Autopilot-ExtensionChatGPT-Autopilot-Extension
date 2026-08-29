import test from 'node:test';
import assert from 'node:assert/strict';

import { DurableSubmissionCoordinator } from '../../src/core/runner.js';
import { applyInteractionResult } from '../../src/core/execution.js';
import { computeNextWake, reconcileAlarm, ALARM_NAME } from '../../src/core/recovery.js';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
import { advanceAfterVerifiedSend, selectNextTask } from '../../src/core/scheduler.js';
import {
  createEmptyState,
  createSession,
  createTask,
  OperationPhase,
  RunState,
} from '../../src/core/schema.js';
import { beginOperation } from '../../src/core/state-machine.js';
import { InteractionResult } from '../../src/shared/protocol.js';

function makeSession(id, count = 1, {
  minimumSendIntervalMs = 120_000,
  busyCheckDelayMs = 5_000,
  retryBackoffMs = 30_000,
  now = 1,
} = {}) {
  const tasks = Array.from({ length: count }, (_, index) => createTask({
    id: `${id}-t${index + 1}`,
    url: `https://chatgpt.com/c/${id}-${index + 1}`,
  }));
  const session = createSession({
    id,
    name: id,
    tasks,
    sharedPrompt: `prompt-${id}`,
    minimumSendIntervalMs,
    preSendDelayMs: 1_000,
    busyCheckDelayMs,
    retryBackoffMs,
    now,
  });
  session.runState = RunState.RUNNING;
  return session;
}

function stateWith(...sessions) {
  const state = createEmptyState(1);
  for (const session of sessions) {
    state.sessionsById[session.id] = session;
    state.sessionOrder.push(session.id);
  }
  return state;
}

function fakeAlarms() {
  const calls = [];
  return {
    calls,
    alarms: {
      async clear(name) {
        calls.push(['clear', name]);
        return true;
      },
      async create(name, info) {
        calls.push(['create', name, info.when]);
      },
    },
  };
}

class QueuedRepo {
  constructor(state) {
    this.state = structuredClone(state);
    this.updateQueue = Promise.resolve();
    this.updateAttempts = 0;
    this.waiters = [];
  }

  async load() {
    return structuredClone(this.state);
  }

  update(mutator) {
    const operation = this.updateQueue.then(async () => {
      this.updateAttempts += 1;
      this.#flushWaiters();
      const current = structuredClone(this.state);
      const draft = structuredClone(current);
      const next = await mutator(draft) || draft;
      next.revision = current.revision + 1;
      this.state = structuredClone(next);
      return this.load();
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }

  waitForUpdateAttempts(target) {
    if (this.updateAttempts >= target) return Promise.resolve();
    return new Promise(resolve => this.waiters.push({ target, resolve }));
  }

  #flushWaiters() {
    const pending = [];
    for (const waiter of this.waiters) {
      if (this.updateAttempts >= waiter.target) waiter.resolve();
      else pending.push(waiter);
    }
    this.waiters = pending;
  }
}

function prepareForSubmit(session, now) {
  const taskId = session.taskOrder[0];
  const task = session.tasksById[taskId];
  const operationId = `op-${session.id}`;
  beginOperation(session, {
    operationId,
    taskId,
    promptFingerprint: `fp-${session.id}`,
    targetUrl: task.normalizedUrl,
    now,
  });
  session.operation.phase = OperationPhase.PRE_SEND_WAIT;
  session.operation.preSendDeadline = now;
  session.operation.promptText = session.sharedPrompt;
  session.operation.generation = 1;
  return operationId;
}

test('one-Task continuous repeats only after the successful-Send cooldown', () => {
  const session = makeSession('single');
  const first = selectNextTask(session, 1_000);
  assert.equal(first.kind, 'TASK');
  assert.equal(first.task.id, 'single-t1');

  advanceAfterVerifiedSend(session, first.index, 1_000);
  assert.equal(session.currentTaskIndex, 0);
  assert.equal(session.nextAllowedSendAt, 121_000);
  assert.deepEqual(selectNextTask(session, 120_999), { kind: 'COOLDOWN', wakeAt: 121_000 });

  const repeated = selectNextTask(session, 121_000);
  assert.equal(repeated.kind, 'TASK');
  assert.equal(repeated.task.id, 'single-t1');
});

test('10-Task continuous round-robin stays t1→…→t10 across repeated rounds', () => {
  const session = makeSession('rr', 10);
  let now = 10_000;
  const seen = [];

  for (let step = 0; step < 20; step += 1) {
    const selected = selectNextTask(session, now);
    assert.equal(selected.kind, 'TASK');
    seen.push(selected.task.id);
    advanceAfterVerifiedSend(session, selected.index, now);
    assert.deepEqual(selectNextTask(session, session.nextAllowedSendAt - 1), {
      kind: 'COOLDOWN',
      wakeAt: session.nextAllowedSendAt,
    });
    now = session.nextAllowedSendAt;
  }

  const oneRound = Array.from({ length: 10 }, (_, index) => `rr-t${index + 1}`);
  assert.deepEqual(seen, [...oneRound, ...oneRound]);
});

test('BUSY advances immediately without Session cooldown, then all-BUSY sleeps until earliest recheck', async () => {
  const session = makeSession('busy', 3, { busyCheckDelayMs: 5_000 });
  const now = 20_000;

  for (const expectedId of ['busy-t1', 'busy-t2', 'busy-t3']) {
    const selected = selectNextTask(session, now);
    assert.equal(selected.kind, 'TASK');
    assert.equal(selected.task.id, expectedId);
    const applied = applyInteractionResult(session, selected.index, { status: InteractionResult.BUSY }, { now });
    assert.equal(applied.action, 'ADVANCE_NO_COOLDOWN');
    assert.equal(session.nextAllowedSendAt, 0);
    assert.equal(session.tasksById[expectedId].retryAfterAt, 25_000);
  }

  assert.deepEqual(selectNextTask(session, now), { kind: 'WAIT', wakeAt: 25_000 });
  const state = stateWith(session);
  assert.equal(computeNextWake(state, now), 25_000);

  const chromeApi = fakeAlarms();
  const wakeAt = await reconcileAlarm(chromeApi, state, now);
  assert.equal(wakeAt, 25_000);
  assert.deepEqual(chromeApi.calls, [
    ['create', ALARM_NAME, 25_000],
  ]);
});

test('all Tasks in retry backoff produce one future alarm at the earliest durable retry', async () => {
  const session = makeSession('backoff', 4);
  session.tasksById['backoff-t1'].retryAfterAt = 48_000;
  session.tasksById['backoff-t2'].retryAfterAt = 33_000;
  session.tasksById['backoff-t3'].retryAfterAt = 41_000;
  session.tasksById['backoff-t4'].retryAfterAt = 60_000;
  session.nextAllowedSendAt = 10_000;

  assert.deepEqual(selectNextTask(session, 30_000), { kind: 'WAIT', wakeAt: 33_000 });
  const state = stateWith(session);
  assert.equal(computeNextWake(state, 30_000), 33_000);

  const chromeApi = fakeAlarms();
  await reconcileAlarm(chromeApi, state, 30_000);
  assert.deepEqual(chromeApi.calls, [
    ['create', ALARM_NAME, 33_000],
  ]);
});

test('runtime cycle still attempts all five active Sessions when earlier Sessions hit profile-busy', async () => {
  const sessions = Array.from({ length: 5 }, (_, index) => makeSession(`s${index + 1}`));
  const repo = new QueuedRepo(stateWith(...sessions));
  const seen = [];
  const executor = {
    async runSessionOnce(id) {
      seen.push(id);
      if (id !== 's5') throw new Error('Profile send arbiter is busy');
      return { kind: 'IDLE' };
    },
  };

  const result = await runRuntimeCycle({
    repository: repo,
    chromeApi: fakeAlarms(),
    executor,
    executionAvailable: true,
    now: () => 40_000,
  });

  assert.deepEqual(seen, ['s1', 's2', 's3', 's4', 's5']);
  assert.deepEqual(result.outcomes.map(item => item.result.kind), [
    'PROFILE_BUSY',
    'PROFILE_BUSY',
    'PROFILE_BUSY',
    'PROFILE_BUSY',
    'IDLE',
  ]);
  const after = await repo.load();
  for (const session of Object.values(after.sessionsById)) assert.equal(session.lastError, '');
});

test('five Sessions cannot enter Send simultaneously and each eventually obtains the profile slot', async () => {
  let now = 50_000;
  const sessions = Array.from({ length: 5 }, (_, index) => makeSession(`p${index + 1}`));
  const operationIds = new Map();
  for (const session of sessions) operationIds.set(session.id, prepareForSubmit(session, now));

  const repo = new QueuedRepo(stateWith(...sessions));
  const coordinator = new DurableSubmissionCoordinator(repo, {
    now: () => now,
    profileGapMs: 1_000,
  });

  let releaseFirst;
  const firstBarrier = new Promise(resolve => { releaseFirst = resolve; });
  let activeEffects = 0;
  let maxConcurrentEffects = 0;
  const sentSessions = [];

  const submitEffect = (sessionId, hold = false) => async () => {
    activeEffects += 1;
    maxConcurrentEffects = Math.max(maxConcurrentEffects, activeEffects);
    sentSessions.push(sessionId);
    if (hold) await firstBarrier;
    activeEffects -= 1;
    return { status: InteractionResult.SENT_VERIFIED };
  };

  const firstWave = sessions.map((session, index) => coordinator.submitWithDurableCheckpoint({
    sessionId: session.id,
    operationId: operationIds.get(session.id),
    submit: submitEffect(session.id, index === 0),
  }));

  await repo.waitForUpdateAttempts(5);
  assert.deepEqual(sentSessions, ['p1']);
  assert.equal(activeEffects, 1);
  assert.equal(maxConcurrentEffects, 1);

  releaseFirst();
  const firstResults = await Promise.allSettled(firstWave);
  assert.equal(firstResults[0].status, 'fulfilled');
  for (const result of firstResults.slice(1)) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Profile send arbiter is busy/);
  }

  let blockedEffectRan = false;
  now = 50_999;
  await assert.rejects(
    () => coordinator.submitWithDurableCheckpoint({
      sessionId: 'p2',
      operationId: operationIds.get('p2'),
      submit: async () => {
        blockedEffectRan = true;
        return { status: InteractionResult.SENT_VERIFIED };
      },
    }),
    /Profile send arbiter is busy/,
  );
  assert.equal(blockedEffectRan, false);

  for (let index = 1; index < sessions.length; index += 1) {
    now = 50_000 + index * 1_000;
    const session = sessions[index];
    const result = await coordinator.submitWithDurableCheckpoint({
      sessionId: session.id,
      operationId: operationIds.get(session.id),
      submit: submitEffect(session.id),
    });
    assert.equal(result.status, InteractionResult.SENT_VERIFIED);
  }

  assert.deepEqual(sentSessions, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(maxConcurrentEffects, 1);
  assert.equal(activeEffects, 0);

  const finalState = await repo.load();
  for (let index = 0; index < sessions.length; index += 1) {
    const id = `p${index + 1}`;
    const sentAt = 50_000 + index * 1_000;
    const session = finalState.sessionsById[id];
    assert.equal(session.lastSuccessfulSendAt, sentAt);
    assert.equal(session.nextAllowedSendAt, sentAt + session.minimumSendIntervalMs);
    assert.equal(session.operation.phase, OperationPhase.SENT_VERIFIED);
  }
  assert.equal(finalState.sendArbiter.lease, null);
  assert.equal(finalState.sendArbiter.profileNextAllowedSendAt, 55_000);
});
