import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableSubmissionCoordinator } from '../src/core/runner.js';
import { runRuntimeCycle, DEFAULT_MAX_CONCURRENT_SESSION_OPERATIONS } from '../src/core/runtime-execution.js';
import { reconcileStateForStartup } from '../src/core/recovery.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState, TabStrategy } from '../src/core/schema.js';
import { InteractionResult } from '../src/shared/protocol.js';
import { sessionSchedulingClass, SchedulingClass } from '../src/core/scheduler-fairness.js';

class MemoryRepository {
  constructor(state) {
    this.state = structuredClone(state);
    this.queue = Promise.resolve();
  }
  async load() { return structuredClone(this.state); }
  update(mutator) {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const next = await mutator(draft) || draft;
      next.revision = Number(this.state.revision || 0) + 1;
      this.state = structuredClone(next);
      return structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

function addRunningSession(state, index, { phase = null } = {}) {
  const id = `s${index}`;
  const task = createTask({ id: `t${index}`, url: 'https://chatgpt.com/' });
  const session = createSession({
    id,
    name: id,
    tasks: [task],
    sharedPrompt: `prompt ${index}`,
    minimumSendIntervalMs: 180000,
    preSendDelayMs: 0,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  if (phase) {
    session.operation = {
      operationId: `op${index}`,
      sessionId: id,
      taskId: task.id,
      promptFingerprint: `fp${index}`,
      promptText: `prompt ${index}`,
      phase,
      targetUrl: task.normalizedUrl,
      createdAt: 1,
      updatedAt: 1,
      preSendDeadline: 0,
      submitStartedAt: phase === OperationPhase.SUBMITTING ? 2 : 0,
      verificationDeadline: 0,
    };
  }
  state.sessionsById[id] = session;
  state.sessionOrder.push(id);
  return session;
}

function timedGate(target, timeoutMs = 250) {
  let entered = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const timer = setTimeout(() => release(), timeoutMs);
  return {
    async enter() {
      entered += 1;
      if (entered >= target) {
        clearTimeout(timer);
        release();
      }
      await gate;
    },
    count: () => entered,
  };
}

test('ten durable Session submits can be in flight concurrently without a profile-wide send lock', async () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 10; i += 1) addRunningSession(state, i, { phase: OperationPhase.PRE_SEND_WAIT });
  const repo = new MemoryRepository(state);
  const coordinator = new DurableSubmissionCoordinator(repo, { now: () => 1000 });
  const gate = timedGate(10);
  let inFlight = 0;
  let maxInFlight = 0;

  const results = await Promise.all(state.sessionOrder.map(async (sessionId, offset) => coordinator.submitWithDurableCheckpoint({
    sessionId,
    operationId: `op${offset + 1}`,
    submit: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.enter();
      inFlight -= 1;
      return { status: InteractionResult.SENT_VERIFIED, normalizedObservedUrl: `https://chatgpt.com/c/${offset + 1}` };
    },
  })));

  assert.equal(DEFAULT_MAX_CONCURRENT_SESSION_OPERATIONS, 10);
  assert.equal(maxInFlight, 10);
  assert.equal(gate.count(), 10);
  assert.ok(results.every(result => result.status === InteractionResult.SENT_VERIFIED));
  const after = await repo.load();
  assert.equal(after.sendArbiter.lease, null);
  assert.equal(after.sendArbiter.profileNextAllowedSendAt, 0);
  for (const id of after.sessionOrder) {
    assert.equal(after.sessionsById[id].successfulSendCount, 1);
    assert.equal(after.sessionsById[id].operation.phase, OperationPhase.SENT_VERIFIED);
  }
});

test('runtime cycle executes ten independent active Sessions concurrently instead of serially', async () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 10; i += 1) addRunningSession(state, i);
  const repo = new MemoryRepository(state);
  const gate = timedGate(10);
  let inFlight = 0;
  let maxInFlight = 0;
  const executor = {
    async runSessionOnce() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.enter();
      inFlight -= 1;
      return { kind: 'WAIT', wakeAt: 5000 };
    },
  };
  const alarmCalls = [];
  const chromeApi = {
    alarms: {
      async create(name, info) { alarmCalls.push(['create', name, info]); },
      async clear(name) { alarmCalls.push(['clear', name]); return true; },
    },
  };

  const result = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => 1000 });
  assert.equal(maxInFlight, 10);
  assert.equal(gate.count(), 10);
  assert.equal(result.outcomes.length, 10);
  assert.ok(result.outcomes.every(item => item.result.kind === 'WAIT'));
  assert.ok(alarmCalls.some(call => call[0] === 'create'));
});



test('five ordinary plus five scenario-managed Sessions share one parallel batch without starvation', async () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 10; i += 1) {
    const session = addRunningSession(state, i);
    if (i > 5) {
      session.scenarioWork = {
        managed: true,
        scenarioId: 'mixed-stress',
        participantKey: `worker-${i - 5}`,
      };
    }
  }
  assert.equal(state.sessionOrder.filter(id => sessionSchedulingClass(state.sessionsById[id]) === SchedulingClass.ORDINARY).length, 5);
  assert.equal(state.sessionOrder.filter(id => sessionSchedulingClass(state.sessionsById[id]) === SchedulingClass.MANAGED).length, 5);

  const repo = new MemoryRepository(state);
  const gate = timedGate(10);
  const entered = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const executor = {
    async runSessionOnce(sessionId) {
      entered.push(sessionId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.enter();
      inFlight -= 1;
      return { kind: 'WAIT', wakeAt: 5000 };
    },
  };
  const chromeApi = {
    alarms: {
      async create() {},
      async clear() { return true; },
    },
  };

  const result = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => 1000 });
  assert.equal(maxInFlight, 10);
  assert.equal(new Set(entered).size, 10);
  assert.equal(result.outcomes.length, 10);
  assert.deepEqual(new Set(result.outcomes.map(item => sessionSchedulingClass(state.sessionsById[item.sessionId]))), new Set([SchedulingClass.ORDINARY, SchedulingClass.MANAGED]));
});

test('restart converts every concurrent SUBMITTING operation to independent AMBIGUOUS recovery and clears legacy profile barriers', () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 10; i += 1) addRunningSession(state, i, { phase: OperationPhase.SUBMITTING });
  state.sendArbiter.lease = {
    ownerSessionId: 's1', operationId: 'op1', acquiredAt: 2, expiresAt: 999999,
  };
  state.sendArbiter.profileNextAllowedSendAt = 999999;

  reconcileStateForStartup(state, 1000);

  assert.equal(state.sendArbiter.lease, null);
  assert.equal(state.sendArbiter.profileNextAllowedSendAt, 0);
  for (const id of state.sessionOrder) {
    assert.equal(state.sessionsById[id].runState, RunState.RECOVERING);
    assert.equal(state.sessionsById[id].operation.phase, OperationPhase.AMBIGUOUS);
  }
});

import { selectNextTask, advanceAfterVerifiedSend } from '../src/core/scheduler.js';
import { resolveTaskTab } from '../src/core/tabs.js';

test('ten independent three-minute Sessions each retain eighty send opportunities across four hours with no cross-session barrier', () => {
  const state = createEmptyState(0);
  for (let i = 1; i <= 10; i += 1) {
    const session = addRunningSession(state, i);
    session.minimumSendIntervalMs = 3 * 60 * 1000;
    session.nextAllowedSendAt = 3 * 60 * 1000;
  }

  const fourHours = 4 * 60 * 60 * 1000;
  const interval = 3 * 60 * 1000;
  for (let now = interval; now <= fourHours; now += interval) {
    for (const id of state.sessionOrder) {
      const session = state.sessionsById[id];
      const selected = selectNextTask(session, now);
      assert.equal(selected.kind, 'TASK');
      advanceAfterVerifiedSend(session, selected.index, now);
    }
  }

  for (const id of state.sessionOrder) {
    assert.equal(state.sessionsById[id].successfulSendCount, 80);
  }
  assert.equal(state.sendArbiter.profileNextAllowedSendAt, 0);
});

test('ten Sessions targeting the same launch surface receive ten distinct owned tabs', async () => {
  const state = createEmptyState(0);
  for (let i = 1; i <= 10; i += 1) addRunningSession(state, i);

  let nextId = 1;
  const tabs = [];
  const chromeApi = {
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async create({ url, active }) {
        const tab = { id: nextId++, url, active, status: 'complete' };
        tabs.push(tab);
        return { ...tab };
      },
      async get(id) {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error('tab not found');
        return { ...tab };
      },
      async update(id, patch) {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error('tab not found');
        Object.assign(tab, patch, { status: 'complete' });
        return { ...tab };
      },
    },
  };

  const owned = new Map();
  for (const id of state.sessionOrder) {
    const task = state.sessionsById[id].tasksById[`t${id.slice(1)}`];
    const tab = await resolveTaskTab(chromeApi, state, id, task);
    owned.set(id, tab.id);
  }

  assert.equal(new Set(owned.values()).size, 10);
  assert.equal(tabs.length, 10);
  for (const [id, tabId] of owned) {
    const taskId = `t${id.slice(1)}`;
    assert.equal(state.tabHintsByTaskId[taskId].sessionId, id);
    assert.equal(state.tabHintsByTaskId[taskId].tabId, tabId);
  }
});

import { AutomaticSessionExecutor } from '../src/core/automatic-executor.js';
import { computeNextWake } from '../src/core/recovery.js';

class UpdateGuardRepository extends MemoryRepository {
  constructor(state) {
    super(state);
    this.insideUpdate = false;
  }
  update(mutator) {
    return super.update(async draft => {
      this.insideUpdate = true;
      try {
        return await mutator(draft);
      } finally {
        this.insideUpdate = false;
      }
    });
  }
}

test('rate-limit gate is account-wide but repeated parallel detections do not extend the first five-minute window', async () => {
  const state = createEmptyState(1);
  addRunningSession(state, 1);
  addRunningSession(state, 2);
  const repo = new MemoryRepository(state);
  let now = 1_000;
  const executor = new AutomaticSessionExecutor(repo, {}, { execute: async () => { throw new Error('transport must not run'); } }, { now: () => now });
  const limited = { status: InteractionResult.RATE_LIMITED, safeDiagnosticCode: 'RATE_LIMITED' };

  await executor.applyResult('s1', 't1', limited);
  let after = await repo.load();
  const firstUntil = after.profile.rateLimitUntil;
  assert.equal(firstUntil, now + 5 * 60 * 1000);
  assert.equal(after.sessionsById.s1.tasksById.t1.retryAfterAt, firstUntil);

  now += 2 * 60 * 1000;
  await executor.applyResult('s2', 't2', limited);
  after = await repo.load();
  assert.equal(after.profile.rateLimitUntil, firstUntil, 'second tab must not slide the account gate');
  assert.equal(after.sessionsById.s2.tasksById.t2.retryAfterAt, firstUntil, 'second detector joins the existing gate instead of creating a new one');
  const events = after.diagnostics.map(item => item.event);
  assert.ok(events.includes('ГЛОБАЛЬНА_ПАУЗА_ЧЕРЕЗ_RATE_LIMIT'));
  assert.ok(events.includes('RATE_LIMIT_ВЖЕ_ВРАХОВАНО'));
});

test('active profile rate-limit gate prevents new tab work and drives the next alarm to the shared deadline', async () => {
  const state = createEmptyState(1);
  addRunningSession(state, 1);
  addRunningSession(state, 2);
  state.profile.rateLimitUntil = 301_000;
  const repo = new MemoryRepository(state);
  let tabWork = 0;
  const chromeApi = { tabs: { async create() { tabWork += 1; return { id: 1, url: 'https://chatgpt.com/' }; } } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, { execute: async () => { tabWork += 1; } }, { now: () => 1_000 });

  const one = await executor.runSessionOnce('s1');
  const two = await executor.runSessionOnce('s2');
  assert.equal(one.kind, 'PROFILE_RATE_LIMIT_WAIT');
  assert.equal(two.kind, 'PROFILE_RATE_LIMIT_WAIT');
  assert.equal(one.wakeAt, 301_000);
  assert.equal(tabWork, 0);
  assert.equal(computeNextWake(await repo.load(), 1_000), 301_000);
});

test('launch surfaces never adopt an arbitrary existing root tab even when ten Sessions resolve from concurrent stale snapshots', async () => {
  const base = createEmptyState(0);
  for (let i = 1; i <= 10; i += 1) addRunningSession(base, i);
  let nextId = 1000;
  const tabs = [{ id: 999, url: 'https://chatgpt.com/', status: 'complete', active: true }];
  const chromeApi = {
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async create({ url, active }) {
        const tab = { id: nextId++, url, status: 'complete', active };
        tabs.push(tab);
        return { ...tab };
      },
      async get(id) {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error('tab not found');
        return { ...tab };
      },
      async update(id, patch) {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error('tab not found');
        Object.assign(tab, patch);
        return { ...tab };
      },
    },
  };

  const ownedIds = await Promise.all(base.sessionOrder.map(async id => {
    const snapshot = structuredClone(base);
    const task = snapshot.sessionsById[id].tasksById[`t${id.slice(1)}`];
    const tab = await resolveTaskTab(chromeApi, snapshot, id, task);
    return tab.id;
  }));

  assert.equal(new Set(ownedIds).size, 10);
  assert.ok(ownedIds.every(id => id !== 999), 'manual root launch tab must never become a shared composer lane');
  assert.equal(tabs.length, 11);
});

test('tab creation runs outside the serialized repository update queue', async () => {
  const state = createEmptyState(0);
  addRunningSession(state, 1);
  const repo = new UpdateGuardRepository(state);
  let nextId = 1;
  const chromeApi = {
    tabs: {
      async create({ url, active }) {
        assert.equal(repo.insideUpdate, false, 'Chrome tab I/O must not run inside repository.update');
        return { id: nextId++, url, active, status: 'complete' };
      },
      async query() {
        assert.equal(repo.insideUpdate, false, 'Chrome tab query must not run inside repository.update');
        return [];
      },
      async get() { throw new Error('not expected'); },
    },
  };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, { execute: async () => ({ status: InteractionResult.READY }) }, { now: () => 1000 });
  const tab = await executor.bindTaskTab('s1', 't1');
  assert.equal(tab.id, 1);
  const after = await repo.load();
  assert.equal(after.tabHintsByTaskId.t1.tabId, 1);
  assert.equal(after.tabHintsByTaskId.t1.sessionId, 's1');
});

test('one slow Session does not prevent nine peers from finishing their runtime work', async () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 10; i += 1) addRunningSession(state, i);
  const repo = new MemoryRepository(state);
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  let peerFinished = 0;
  const executor = {
    async runSessionOnce(sessionId) {
      if (sessionId === 's1') await slow;
      else peerFinished += 1;
      return { kind: 'WAIT', wakeAt: 5000 };
    },
  };
  const chromeApi = { alarms: { async create() {}, async clear() { return true; } } };
  const cycle = runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => 1000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(peerFinished, 9, 'nine independent lanes finish while one lane is still blocked');
  releaseSlow();
  const result = await cycle;
  assert.equal(result.outcomes.length, 10);
});

function makeParallelChrome() {
  let nextId = 1;
  const tabs = [];
  return {
    _tabs: tabs,
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async create({ url, active }) {
        const tab = { id: nextId++, url, active, status: 'complete' };
        tabs.push(tab);
        return { ...tab };
      },
      async get(id) {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error('No tab with id');
        return { ...tab };
      },
      async update(id, patch) {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error('No tab with id');
        Object.assign(tab, patch, { status: 'complete' });
        return { ...tab };
      },
      async remove(id) {
        const index = tabs.findIndex(item => item.id === id);
        if (index >= 0) tabs.splice(index, 1);
      },
    },
    alarms: {
      async create() {},
      async clear() { return true; },
    },
  };
}

function makeHappyTransport({ failInsertOnceFor = '' } = {}) {
  const failed = new Set();
  return {
    async execute(tabId, request) {
      const sessionId = String(request.requestId || '').split(':')[0];
      if (request.mode === 'CHECK_ONLY' || request.mode === 'PREPARE_SEND') {
        return { status: InteractionResult.READY, safeDiagnosticCode: 'READY', normalizedObservedUrl: request.expectedUrl };
      }
      if (request.mode === 'INSERT_ONLY') {
        if (sessionId === failInsertOnceFor && !failed.has(sessionId)) {
          failed.add(sessionId);
          return {
            status: InteractionResult.INSERTED_NOT_SENT,
            safeDiagnosticCode: 'COMPOSER_LOST_AFTER_INSERT',
            composerState: 'EMPTY',
            normalizedObservedUrl: request.expectedUrl,
          };
        }
        return {
          status: InteractionResult.INSERTED_NOT_SENT,
          safeDiagnosticCode: 'INSERTION_TEXT_PROVEN',
          composerState: 'VISIBLE_NONEMPTY',
          normalizedObservedUrl: request.expectedUrl,
        };
      }
      if (request.mode === 'SUBMIT_EXISTING') {
        return {
          status: InteractionResult.SENT_VERIFIED,
          safeDiagnosticCode: 'SEND_VERIFIED_OPERATION_LOCAL_APPEND',
          normalizedObservedUrl: `https://chatgpt.com/c/tab-${tabId}`,
        };
      }
      if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
        return { status: InteractionResult.SENT_VERIFIED, normalizedObservedUrl: `https://chatgpt.com/c/tab-${tabId}` };
      }
      throw new Error(`unexpected mode ${request.mode}`);
    },
  };
}

function makeFivePlusFiveState() {
  const state = createEmptyState(1);
  for (let i = 1; i <= 10; i += 1) {
    const session = addRunningSession(state, i);
    session.preSendDelayMs = 0;
    session.minimumSendIntervalMs = 3 * 60 * 1000;
    if (i > 5) session.scenarioWork = { managed: true, scenarioId: 'full-pipeline', participantKey: `p${i}` };
  }
  return state;
}

test('full 5+5 browser pipeline creates ten isolated tabs, inserts in parallel, then verifies ten independent sends', async () => {
  const state = makeFivePlusFiveState();
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  let now = 1_000;
  const executor = new AutomaticSessionExecutor(repo, chromeApi, makeHappyTransport(), { now: () => now });

  const insertionCycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(insertionCycle.outcomes.length, 10);
  assert.ok(insertionCycle.outcomes.every(item => item.result.kind === 'WAIT_PRE_SEND'));
  assert.equal(chromeApi._tabs.length, 10);
  assert.equal(new Set(chromeApi._tabs.map(tab => tab.id)).size, 10);

  let after = await repo.load();
  assert.ok(after.sessionOrder.every(id => after.sessionsById[id].operation?.phase === OperationPhase.PRE_SEND_WAIT));
  assert.equal(new Set(after.sessionOrder.map(id => after.tabHintsByTaskId[`t${id.slice(1)}`]?.tabId)).size, 10);

  now = 2_000;
  const sendCycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(sendCycle.outcomes.length, 10);
  assert.ok(sendCycle.outcomes.every(item => item.result.kind === 'SENT'));
  after = await repo.load();
  assert.ok(after.sessionOrder.every(id => after.sessionsById[id].successfulSendCount === 1));
  assert.equal(after.sendArbiter.profileNextAllowedSendAt, 0);
});

test('one COMPOSER_LOST_AFTER_INSERT lane fails safe while the other nine 5+5 lanes still reach verified Send', async () => {
  const state = makeFivePlusFiveState();
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  let now = 1_000;
  const executor = new AutomaticSessionExecutor(repo, chromeApi, makeHappyTransport({ failInsertOnceFor: 's1' }), { now: () => now });

  const insertionCycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  const s1 = insertionCycle.outcomes.find(item => item.sessionId === 's1');
  assert.equal(s1.result.kind, 'INSERTION_RETRY');
  assert.equal(insertionCycle.outcomes.filter(item => item.result.kind === 'WAIT_PRE_SEND').length, 9);

  now = 2_000;
  const sendCycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(sendCycle.outcomes.filter(item => item.result.kind === 'SENT').length, 9);
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.successfulSendCount, 0);
  for (let i = 2; i <= 10; i += 1) assert.equal(after.sessionsById[`s${i}`].successfulSendCount, 1);
});

test('one TAB_NAVIGATION_TIMEOUT lane cannot poison the other nine ordinary/scenario lanes', async () => {
  const state = makeFivePlusFiveState();
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  let now = 1_000;
  const healthy = makeHappyTransport();
  const transport = {
    async execute(tabId, request) {
      const sessionId = String(request.requestId || '').split(':')[0];
      if (sessionId === 's1' && request.mode === 'CHECK_ONLY') {
        const error = new Error('simulated tab navigation timeout');
        error.safeDiagnosticCode = 'TAB_NAVIGATION_TIMEOUT';
        throw error;
      }
      return healthy.execute(tabId, request);
    },
  };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now });

  const cycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  const failed = cycle.outcomes.find(item => item.sessionId === 's1');
  assert.equal(failed.result.kind, 'TEMPORARY_RUNTIME_ERROR');
  assert.equal(failed.result.diagnosticCode, 'TAB_NAVIGATION_TIMEOUT');
  assert.equal(cycle.outcomes.filter(item => item.result.kind === 'WAIT_PRE_SEND').length, 9);

  const after = await repo.load();
  assert.equal(after.sessionsById.s1.tasksById.t1.status, 'RETRY_WAIT');
  for (let i = 2; i <= 10; i += 1) {
    assert.equal(after.sessionsById[`s${i}`].operation?.phase, OperationPhase.PRE_SEND_WAIT);
  }
});

test('all ten lanes resume together after the fixed profile rate-limit deadline expires', async () => {
  const state = makeFivePlusFiveState();
  state.profile.rateLimitUntil = 301_000;
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  let now = 100_000;
  const executor = new AutomaticSessionExecutor(repo, chromeApi, makeHappyTransport(), { now: () => now });

  const held = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(held.outcomes.filter(item => item.result.kind === 'PROFILE_RATE_LIMIT_WAIT').length, 10);
  assert.equal(chromeApi._tabs.length, 0);

  now = 301_001;
  const resumed = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(resumed.outcomes.filter(item => item.result.kind === 'WAIT_PRE_SEND').length, 10);
  assert.equal(chromeApi._tabs.length, 10);
});



test('ordinary lanes get bounded starts with no send history even when managed queue is much larger than concurrency', async () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 30; i += 1) {
    const session = addRunningSession(state, i);
    if (i <= 28) session.scenarioWork = { managed: true, scenarioId: 'no-history-fairness', participantKey: `managed-${i}` };
  }

  const repo = new MemoryRepository(state);
  let releaseManaged;
  const managedGate = new Promise(resolve => { releaseManaged = resolve; });
  const entered = [];
  let ordinaryFinished = 0;
  const executor = {
    async runSessionOnce(sessionId) {
      entered.push(sessionId);
      if (sessionId === 's29' || sessionId === 's30') {
        ordinaryFinished += 1;
        return { kind: 'WAIT', wakeAt: 5_000 };
      }
      await managedGate;
      return { kind: 'WAIT', wakeAt: 5_000 };
    },
  };
  const chromeApi = { alarms: { async create() {}, async clear() { return true; } } };

  const cycle = runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => 1_000 });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(ordinaryFinished, 2, 'ordinary lanes must enter the first mixed batch even without last-sender history');
  assert.ok(entered.indexOf('s29') < 10, 'first ordinary lane starts within the concurrency window');
  assert.ok(entered.indexOf('s30') < 10, 'second ordinary lane starts within the concurrency window');

  releaseManaged();
  const result = await cycle;
  assert.equal(result.outcomes.length, 30);
});
test('two ordinary Sessions make bounded progress even when twenty-eight managed lanes are queued and managed peers stall', async () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 30; i += 1) {
    const session = addRunningSession(state, i);
    if (i <= 28) {
      session.scenarioWork = {
        managed: true,
        scenarioId: 'diagnostic-starvation-reproduction',
        participantKey: `managed-${i}`,
      };
    }
  }
  // Reproduce the important diagnostic condition: Scenario traffic was the last verified sender,
  // while ordinary Sessions have already waited behind a large managed queue.
  state.sendArbiter.lastSentSessionId = 's28';
  state.sendArbiter.lastSentSchedulingClass = SchedulingClass.MANAGED;

  const repo = new MemoryRepository(state);
  let releaseManaged;
  const managedGate = new Promise(resolve => { releaseManaged = resolve; });
  const entered = [];
  let ordinaryFinished = 0;
  let managedEntered = 0;
  const executor = {
    async runSessionOnce(sessionId) {
      entered.push(sessionId);
      if (sessionId === 's29' || sessionId === 's30') {
        ordinaryFinished += 1;
        return { kind: 'WAIT', wakeAt: 5_000 };
      }
      managedEntered += 1;
      // Deliberately stall managed work. Ordinary lanes must not sit behind these waits.
      await managedGate;
      return { kind: 'WAIT', wakeAt: 5_000 };
    },
  };
  const chromeApi = { alarms: { async create() {}, async clear() { return true; } } };

  const cycle = runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => 1_000 });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(ordinaryFinished, 2, 'both ordinary lanes must complete a runtime attempt before stalled managed work is released');
  assert.ok(entered.indexOf('s29') < 4, 'first ordinary lane starts immediately after a managed verified Send');
  assert.ok(entered.indexOf('s30') < 4, 'second ordinary lane starts within the first two mixed scheduling pairs');
  assert.ok(managedEntered > 0, 'managed work remains concurrent instead of being globally paused');

  releaseManaged();
  const result = await cycle;
  assert.equal(result.outcomes.length, 30);
  assert.ok(result.outcomes.some(item => item.sessionId === 's29'));
  assert.ok(result.outcomes.some(item => item.sessionId === 's30'));
});

test('scenario ambiguous Send is verification-only while nine mixed-load peers keep their verified progress', async () => {
  const state = makeFivePlusFiveState();
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  let now = 1_000;
  const healthy = makeHappyTransport();
  const modesForScenario = [];
  let submitReturnedUncertain = false;
  const transport = {
    async execute(tabId, request) {
      if (request.taskId === 't6') {
        modesForScenario.push(request.mode);
        if (request.mode === 'SUBMIT_EXISTING' && !submitReturnedUncertain) {
          submitReturnedUncertain = true;
          return {
            status: InteractionResult.SUBMISSION_UNCERTAIN,
            safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN',
            normalizedObservedUrl: `https://chatgpt.com/c/tab-${tabId}`,
          };
        }
        if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
          return {
            status: InteractionResult.SUBMISSION_UNCERTAIN,
            safeDiagnosticCode: 'RECOVERY_UNCERTAIN',
            normalizedObservedUrl: `https://chatgpt.com/c/tab-${tabId}`,
          };
        }
      }
      return healthy.execute(tabId, request);
    },
  };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now });

  const insertionCycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(insertionCycle.outcomes.filter(item => item.result.kind === 'WAIT_PRE_SEND').length, 10);

  now = 2_000;
  const sendCycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(sendCycle.outcomes.filter(item => item.result.kind === 'SENT').length, 9);
  let after = await repo.load();
  assert.equal(after.sessionsById.s6.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s6.successfulSendCount, 0);
  for (let i = 1; i <= 10; i += 1) {
    if (i === 6) continue;
    assert.equal(after.sessionsById[`s${i}`].successfulSendCount, 1);
  }

  now = Number(after.sessionsById.s6.operation.verificationDeadline || 0) + 1;
  const verifyCycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  const held = verifyCycle.outcomes.find(item => item.sessionId === 's6');
  assert.equal(held.result.kind, 'UNCERTAIN_VERIFY_HOLD');
  after = await repo.load();
  assert.equal(after.sessionsById.s6.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s6.successfulSendCount, 0);
  assert.equal(modesForScenario.filter(mode => mode === 'SUBMIT_EXISTING').length, 1, 'scenario Send must never be replayed after uncertainty');
  assert.ok(modesForScenario.includes('VERIFY_AFTER_UNCERTAIN_SUBMIT'));
});


test('ordinary ambiguous Send is verification-only, preserves observed conversation identity, and cannot poison mixed-load peers', async () => {
  const state = makeFivePlusFiveState();
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  let now = 1_000;
  const healthy = makeHappyTransport();
  const modesForOrdinary = [];
  let uncertainOnce = false;
  const transport = {
    async execute(tabId, request) {
      if (request.taskId === 't1') {
        modesForOrdinary.push(request.mode);
        if (request.mode === 'SUBMIT_EXISTING' && !uncertainOnce) {
          uncertainOnce = true;
          return {
            status: InteractionResult.SUBMISSION_UNCERTAIN,
            safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN',
            normalizedObservedUrl: `https://chatgpt.com/c/ordinary-${tabId}`,
          };
        }
        if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
          return {
            status: InteractionResult.SUBMISSION_UNCERTAIN,
            safeDiagnosticCode: 'RECOVERY_UNCERTAIN',
            normalizedObservedUrl: `https://chatgpt.com/c/ordinary-${tabId}`,
          };
        }
      }
      return healthy.execute(tabId, request);
    },
  };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now });

  const insertion = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(insertion.outcomes.filter(item => item.result.kind === 'WAIT_PRE_SEND').length, 10);

  now = 2_000;
  const send = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(send.outcomes.filter(item => item.result.kind === 'SENT').length, 9);
  let after = await repo.load();
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(after.sessionsById.s1.tasksById.t1.normalizedUrl, 'https://chatgpt.com/c/ordinary-1');
  assert.equal(after.sessionsById.s1.operation.targetUrl, 'https://chatgpt.com/c/ordinary-1');
  for (let i = 2; i <= 10; i += 1) assert.equal(after.sessionsById[`s${i}`].successfulSendCount, 1);

  now = Number(after.sessionsById.s1.operation.verificationDeadline || 0) + 1;
  const verify = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  const settled = verify.outcomes.find(item => item.sessionId === 's1');
  assert.equal(settled.result.kind, 'UNCERTAIN_SETTLED_NO_RESEND');
  after = await repo.load();
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.FAILED_SAFE);
  assert.equal(after.sessionsById.s1.runState, RunState.RUNNING);
  assert.equal(after.sessionsById.s1.successfulSendCount, 0);
  assert.equal(after.sessionsById.s1.tasksById.t1.normalizedUrl, 'https://chatgpt.com/', 'recurring fresh-launch Session must return to its launch surface after bounded uncertainty');
  assert.equal(modesForOrdinary.filter(mode => mode === 'SUBMIT_EXISTING').length, 1, 'ordinary ambiguous Send must never be replayed blindly');
  assert.equal(
    modesForOrdinary.includes('VERIFY_AFTER_UNCERTAIN_SUBMIT'),
    false,
    'once the bounded verification deadline is already expired, liveness must not depend on another browser verification round trip',
  );

  now = Number(after.sessionsById.s1.tasksById.t1.retryAfterAt || 0) + 1;
  const nextCycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  const restarted = nextCycle.outcomes.find(item => item.sessionId === 's1');
  assert.equal(restarted.result.kind, 'WAIT_PRE_SEND');
  after = await repo.load();
  assert.notEqual(after.sessionsById.s1.operation.operationId, 's1:1', 'a new cycle must own a new durable operation');
  assert.equal(modesForOrdinary.filter(mode => mode === 'SUBMIT_EXISTING').length, 1, 'starting the next cycle must not replay the old ambiguous Send');
});

test('two active Sessions targeting the same exact conversation cannot share ownership even when binding starts concurrently', async () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 2; i += 1) {
    const id = `same${i}`;
    const task = createTask({ id: `same-task-${i}`, url: 'https://chatgpt.com/c/shared-conversation' });
    const session = createSession({ id, name: id, tasks: [task], sharedPrompt: `same ${i}`, preSendDelayMs: 0, now: 1 });
    session.runState = RunState.RUNNING;
    state.sessionsById[id] = session;
    state.sessionOrder.push(id);
  }
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  chromeApi._tabs.push({ id: 900, url: 'https://chatgpt.com/c/shared-conversation', active: false, status: 'complete' });
  const executor = new AutomaticSessionExecutor(repo, chromeApi, makeHappyTransport(), { now: () => 1_000 });

  const settled = await Promise.allSettled([
    executor.bindTaskTab('same1', 'same-task-1'),
    executor.bindTaskTab('same2', 'same-task-2'),
  ]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
  const rejection = settled.find(item => item.status === 'rejected');
  assert.equal(rejection.reason.safeDiagnosticCode, 'TAB_CONVERSATION_OWNERSHIP_CONFLICT');
  const after = await repo.load();
  const hints = Object.values(after.tabHintsByTaskId).filter(hint => hint?.tabId === 900);
  assert.equal(hints.length, 1, 'the exact conversation tab has one active owner only');
});

test('OPEN_CLOSE ordinary Session discards and closes its owned tab after TAB_NAVIGATION_TIMEOUT so retries get a fresh tab', async () => {
  const state = createEmptyState(1);
  const session = addRunningSession(state, 1);
  session.tabStrategy = TabStrategy.OPEN_CLOSE_PER_TASK;
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  let now = 1_000;
  let timedOut = false;
  const healthy = makeHappyTransport();
  const transport = {
    async execute(tabId, request) {
      if (!timedOut && request.mode === 'CHECK_ONLY') {
        timedOut = true;
        const error = new Error('simulated navigation timeout on owned tab');
        error.safeDiagnosticCode = 'TAB_NAVIGATION_TIMEOUT';
        throw error;
      }
      return healthy.execute(tabId, request);
    },
  };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now });

  const first = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(first.outcomes[0].result.kind, 'TEMPORARY_RUNTIME_ERROR');
  assert.equal(first.outcomes[0].result.diagnosticCode, 'TAB_NAVIGATION_TIMEOUT');
  let after = await repo.load();
  assert.equal(after.tabHintsByTaskId.t1, undefined, 'dead owned tab hint must be removed');
  assert.equal(chromeApi._tabs.length, 0, 'dead extension-owned tab must be closed');

  now = Number(after.sessionsById.s1.tasksById.t1.retryAfterAt || 0) + 1;
  const retry = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(retry.outcomes[0].result.kind, 'WAIT_PRE_SEND');
  after = await repo.load();
  assert.ok(after.tabHintsByTaskId.t1?.tabId, 'retry must bind a fresh tab');
  assert.equal(chromeApi._tabs.length, 1);
});

test('KEEP_OPEN ordinary Session retires an extension-created dead tab after TAB_NAVIGATION_TIMEOUT', async () => {
  const state = createEmptyState(1);
  const session = addRunningSession(state, 1);
  session.tabStrategy = TabStrategy.KEEP_TASK_TABS_OPEN;
  const repo = new MemoryRepository(state);
  const chromeApi = makeParallelChrome();
  let now = 1_000;
  let timedOut = false;
  const healthy = makeHappyTransport();
  const transport = {
    async execute(tabId, request) {
      if (!timedOut && request.mode === 'CHECK_ONLY') {
        timedOut = true;
        const error = new Error('simulated keep-open navigation timeout');
        error.safeDiagnosticCode = 'TAB_NAVIGATION_TIMEOUT';
        throw error;
      }
      return healthy.execute(tabId, request);
    },
  };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now });

  const first = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(first.outcomes[0].result.kind, 'TEMPORARY_RUNTIME_ERROR');
  assert.equal(first.outcomes[0].result.diagnosticCode, 'TAB_NAVIGATION_TIMEOUT');
  let after = await repo.load();
  assert.equal(after.tabHintsByTaskId.t1, undefined, 'dead extension-owned keep-open hint must be removed');
  assert.equal(chromeApi._tabs.length, 0, 'dead extension-owned keep-open tab must be physically closed');

  now = Number(after.sessionsById.s1.tasksById.t1.retryAfterAt || 0) + 1;
  const retry = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
  assert.equal(retry.outcomes[0].result.kind, 'WAIT_PRE_SEND');
  after = await repo.load();
  assert.ok(after.tabHintsByTaskId.t1?.tabId, 'retry must bind a fresh keep-open tab');
  assert.equal(chromeApi._tabs.length, 1);
});
