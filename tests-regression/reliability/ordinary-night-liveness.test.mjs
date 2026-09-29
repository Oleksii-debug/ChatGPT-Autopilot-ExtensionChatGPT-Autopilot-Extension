import test from 'node:test';
import assert from 'node:assert/strict';

import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState, TabStrategy } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class CompactMemoryRepository {
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
      // Diagnostics/log volume is intentionally bounded only in this virtual-time
      // stress harness. Runtime/session state is untouched. This prevents test I/O
      // history from dominating the cost of simulating hundreds of real cycles.
      next.diagnostics = Array.isArray(next.diagnostics) ? next.diagnostics.slice(-24) : [];
      for (const [key, entries] of Object.entries(next.logs || {})) {
        next.logs[key] = Array.isArray(entries) ? entries.slice(-12) : entries;
      }
      this.state = structuredClone(next);
      return structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

function makeChrome() {
  let nextId = 1;
  const tabs = [];
  let created = 0;
  let removed = 0;
  let removeAttempts = 0;
  let removeFailures = 0;
  const failedOnce = new Set();
  return {
    _tabs: tabs,
    stats: () => ({ created, removed, removeAttempts, removeFailures }),
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async create({ url, active }) {
        created += 1;
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
        removeAttempts += 1;
        if (removeAttempts % 37 === 0 && !failedOnce.has(id)) {
          failedOnce.add(id);
          removeFailures += 1;
          throw new Error('synthetic tabs.remove failure');
        }
        const index = tabs.findIndex(item => item.id === id);
        if (index >= 0) {
          tabs.splice(index, 1);
          removed += 1;
        }
      },
    },
    alarms: {
      async create() {},
      async clear() { return true; },
    },
  };
}

function addSession(state, index) {
  const id = `s${index}`;
  const task = createTask({ id: `t${index}`, url: 'https://chatgpt.com/' });
  const session = createSession({
    id,
    name: `ordinary-night-${index}`,
    tasks: [task],
    sharedPrompt: `night prompt ${index}`,
    minimumSendIntervalMs: 2 * 60 * 1000,
    preSendDelayMs: 1_000,
    retryBackoffMs: 5_000,
    tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  state.sessionsById[id] = session;
  state.sessionOrder.push(id);
}

test('six ordinary open-close Sessions retain hundreds of cycles over eight virtual hours despite ambiguous sends and dead-tab timeouts', async () => {
  const state = createEmptyState(1);
  for (let i = 1; i <= 6; i += 1) addSession(state, i);

  const repo = new CompactMemoryRepository(state);
  const chromeApi = makeChrome();
  let now = 1_000;
  const endAt = now + 8 * 60 * 60 * 1000;
  let maxTabs = 0;
  let runtimeCycles = 0;
  const checkCount = new Map();
  const submitCount = new Map();
  const uncertainKeys = new Set();
  const timeoutKeys = new Set();

  const transport = {
    async execute(tabId, request) {
      const sessionId = String(request.requestId || '').split(':')[0];
      if (request.mode === 'CHECK_ONLY') {
        const count = (checkCount.get(sessionId) || 0) + 1;
        checkCount.set(sessionId, count);
        const key = `${sessionId}:${count}`;
        if (count % 29 === 0 && !timeoutKeys.has(key)) {
          timeoutKeys.add(key);
          const error = new Error('virtual night navigation timeout');
          error.safeDiagnosticCode = 'TAB_NAVIGATION_TIMEOUT';
          throw error;
        }
        return { status: InteractionResult.READY, safeDiagnosticCode: 'READY', normalizedObservedUrl: request.expectedUrl };
      }
      if (request.mode === 'INSERT_ONLY') {
        return {
          status: InteractionResult.INSERTED_NOT_SENT,
          safeDiagnosticCode: 'INSERTION_TEXT_PROVEN',
          composerState: 'VISIBLE_NONEMPTY',
          normalizedObservedUrl: request.expectedUrl,
        };
      }
      if (request.mode === 'PREPARE_SEND') {
        return { status: InteractionResult.READY, safeDiagnosticCode: 'PENDING_PROMPT_READY_TO_SUBMIT', normalizedObservedUrl: request.expectedUrl };
      }
      if (request.mode === 'SUBMIT_EXISTING') {
        const count = (submitCount.get(sessionId) || 0) + 1;
        submitCount.set(sessionId, count);
        const generated = `https://chatgpt.com/c/${sessionId}-night-${count}`;
        const tab = chromeApi._tabs.find(item => item.id === tabId);
        if (tab) tab.url = generated;
        const key = `${sessionId}:${count}`;
        if (count % 17 === 0 && !uncertainKeys.has(key)) {
          uncertainKeys.add(key);
          return {
            status: InteractionResult.SUBMISSION_UNCERTAIN,
            safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN',
            normalizedObservedUrl: generated,
          };
        }
        return {
          status: InteractionResult.SENT_VERIFIED,
          safeDiagnosticCode: 'SEND_VERIFIED_FRESH_STRUCTURAL_APPEND',
          normalizedObservedUrl: generated,
        };
      }
      if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
        const tab = chromeApi._tabs.find(item => item.id === tabId);
        return {
          status: InteractionResult.SUBMISSION_UNCERTAIN,
          safeDiagnosticCode: 'RECOVERY_STALE_MATCH_UNPROVEN',
          normalizedObservedUrl: tab?.url || request.expectedUrl,
        };
      }
      throw new Error(`unexpected mode ${request.mode}`);
    },
  };

  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now });
  while (now < endAt && runtimeCycles < 5000) {
    const cycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
    runtimeCycles += 1;
    maxTabs = Math.max(maxTabs, chromeApi._tabs.length);
    const wakeAt = Number(cycle.wakeAt);
    now = Number.isFinite(wakeAt) && wakeAt > now ? wakeAt + 1 : now + 1_000;
  }

  assert.ok(runtimeCycles < 5000, 'virtual night must progress through scheduled wakeups');
  assert.ok(now >= endAt, 'virtual clock must cover the full eight-hour night');
  assert.ok(maxTabs <= 6, `owned tab count must remain bounded by active Session count, observed ${maxTabs}`);
  assert.ok(timeoutKeys.size > 0, 'stress must inject navigation timeouts');
  assert.ok(uncertainKeys.size > 0, 'stress must inject ambiguous sends');

  const after = await repo.load();
  const counts = after.sessionOrder.map(id => after.sessionsById[id].successfulSendCount);
  for (const id of after.sessionOrder) {
    const session = after.sessionsById[id];
    assert.ok([RunState.RUNNING, RunState.RECOVERING].includes(session.runState));
    assert.ok(session.successfulSendCount >= 210, `${id} must retain hundreds of verified sends; got ${session.successfulSendCount}`);
    if (session.operation?.phase === OperationPhase.AMBIGUOUS) {
      assert.ok(now - Number(session.operation.submitStartedAt || now) < 60_000, `${id} must not remain stuck in one ambiguous operation`);
    }
  }
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 2, `Sessions must not diverge catastrophically: ${counts.join(', ')}`);

  const { created, removed, removeFailures } = chromeApi.stats();
  assert.ok(created > 1000, `stress must actually exercise repeated fresh tabs, created=${created}`);
  assert.ok(removed > 1000, `open-close cleanup must remove repeated owned tabs, removed=${removed}`);
  assert.ok(removeFailures > 0, 'stress must inject tabs.remove failures and recover without orphan growth');
});
