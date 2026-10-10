import test from 'node:test';
import assert from 'node:assert/strict';

import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState, TabStrategy } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class Repo {
  constructor(state) { this.state = structuredClone(state); this.queue = Promise.resolve(); }
  async load() { return structuredClone(this.state); }
  update(mutator) {
    const op = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const next = await mutator(draft) || draft;
      next.revision = Number(this.state.revision || 0) + 1;
      next.diagnostics = Array.isArray(next.diagnostics) ? next.diagnostics.slice(-20) : [];
      for (const [key, entries] of Object.entries(next.logs || {})) next.logs[key] = entries.slice(-10);
      this.state = structuredClone(next);
      return structuredClone(next);
    });
    this.queue = op.catch(() => undefined);
    return op;
  }
}

function chromeMock() {
  let id = 1;
  const tabs = [];
  return {
    _tabs: tabs,
    tabs: {
      async query() { return tabs.map(t => ({ ...t })); },
      async create({ url, active }) { const tab = { id: id++, url, active, status: 'complete' }; tabs.push(tab); return { ...tab }; },
      async get(tabId) { const tab = tabs.find(t => t.id === tabId); if (!tab) throw new Error('No tab'); return { ...tab }; },
      async update(tabId, patch) { const tab = tabs.find(t => t.id === tabId); if (!tab) throw new Error('No tab'); Object.assign(tab, patch); return { ...tab }; },
      async remove(tabId) { const i = tabs.findIndex(t => t.id === tabId); if (i >= 0) tabs.splice(i, 1); },
    },
    alarms: { async create() {}, async clear() { return true; } },
  };
}

function initialState() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
  const session = createSession({
    id: 's1', name: 'two-hour', tasks: [task], sharedPrompt: 'continue deeply',
    minimumSendIntervalMs: 120_000, preSendDelayMs: 1_000, busyCheckDelayMs: 3_000,
    retryBackoffMs: 5_000, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK, now: 1,
  });
  session.runState = RunState.RUNNING;
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

async function simulate({ ambiguousAt = 0 } = {}) {
  const repo = new Repo(initialState());
  const chromeApi = chromeMock();
  let now = 1_000;
  const endAt = now + 2 * 60 * 60 * 1000;
  let submits = 0;
  let cycles = 0;
  const transport = {
    async execute(tabId, request) {
      if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY, safeDiagnosticCode: 'READY', normalizedObservedUrl: request.expectedUrl };
      if (request.mode === 'ENSURE_HIGH_EFFORT') return { status: InteractionResult.READY, effortLevel: 'high', safeDiagnosticCode: 'EFFORT_HIGH_CONFIRMED', normalizedObservedUrl: request.expectedUrl };
      if (request.mode === 'INSERT_ONLY') return { status: InteractionResult.INSERTED_NOT_SENT, composerState: 'VISIBLE_NONEMPTY', safeDiagnosticCode: 'INSERTION_TEXT_PROVEN', normalizedObservedUrl: request.expectedUrl };
      if (request.mode === 'PREPARE_SEND') return { status: InteractionResult.READY, safeDiagnosticCode: 'PENDING_PROMPT_READY_TO_SUBMIT', normalizedObservedUrl: request.expectedUrl };
      if (request.mode === 'SUBMIT_EXISTING') {
        submits += 1;
        const generated = `https://chatgpt.com/c/two-hour-${submits}`;
        const tab = chromeApi._tabs.find(t => t.id === tabId);
        if (tab) tab.url = generated;
        if (ambiguousAt && submits === ambiguousAt) {
          return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN', normalizedObservedUrl: generated };
        }
        return { status: InteractionResult.SENT_VERIFIED, safeDiagnosticCode: 'SEND_VERIFIED_FRESH_STRUCTURAL_APPEND', normalizedObservedUrl: generated };
      }
      if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
        const tab = chromeApi._tabs.find(t => t.id === tabId);
        return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'RECOVERY_STALE_MATCH_UNPROVEN', normalizedObservedUrl: tab?.url || request.expectedUrl };
      }
      throw new Error(`Unexpected mode ${request.mode}`);
    },
  };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now });
  while (now < endAt && cycles < 2000) {
    const result = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
    cycles += 1;
    const wake = Number(result.wakeAt);
    now = Number.isFinite(wake) && wake > now ? wake + 1 : now + 1000;
  }
  return { state: await repo.load(), now, endAt, cycles, submits, liveTabs: chromeApi._tabs.length };
}

test('one Ordinary Session at a 2-minute cadence reaches about sixty sends over two virtual hours', async () => {
  const { state, now, endAt, cycles, liveTabs } = await simulate();
  const session = state.sessionsById.s1;
  assert.ok(now >= endAt);
  assert.ok(cycles < 2000);
  assert.ok(session.successfulSendCount >= 59, `expected about 60 verified sends, got ${session.successfulSendCount}`);
  assert.ok(session.successfulSendCount <= 60, `cadence must not run faster than configured, got ${session.successfulSendCount}`);
  assert.ok([RunState.RUNNING, RunState.RECOVERING].includes(session.runState));
  assert.ok(liveTabs <= 1);
});

test('a stale-match ambiguous send around the 30th cycle cannot freeze the remaining two-hour Session', async () => {
  const { state, now, endAt, cycles, liveTabs } = await simulate({ ambiguousAt: 30 });
  const session = state.sessionsById.s1;
  assert.ok(now >= endAt);
  assert.ok(cycles < 2000);
  assert.ok(session.successfulSendCount >= 58, `one ambiguous send must not collapse throughput; got ${session.successfulSendCount}`);
  if (session.operation?.phase === OperationPhase.AMBIGUOUS) {
    assert.ok(now - Number(session.operation.submitStartedAt || now) < 60_000, 'Session must not remain stuck on an old ambiguous send');
  }
  assert.ok(liveTabs <= 1);
});
