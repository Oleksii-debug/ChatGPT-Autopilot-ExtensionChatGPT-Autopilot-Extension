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
      next.diagnostics = Array.isArray(next.diagnostics) ? next.diagnostics.slice(-80) : [];
      for (const [key, entries] of Object.entries(next.logs || {})) next.logs[key] = entries.slice(-20);
      this.state = structuredClone(next);
      return structuredClone(next);
    });
    this.queue = op.catch(() => undefined);
    return op;
  }
}

function chromeMock() {
  let nextId = 1;
  const tabs = [];
  let maxTabs = 0;
  let removeAttempts = 0;
  const failedRemoveIds = new Set();
  return {
    _tabs: tabs,
    stats: () => ({ maxTabs, removeAttempts }),
    tabs: {
      async query() { return tabs.map(t => ({ ...t })); },
      async create({ url, active }) {
        const tab = { id: nextId++, url, active, status: 'complete' };
        tabs.push(tab); maxTabs = Math.max(maxTabs, tabs.length); return { ...tab };
      },
      async get(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('No tab with id'); return { ...tab }; },
      async update(id, patch) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('No tab with id'); Object.assign(tab, patch, { status: 'complete' }); return { ...tab }; },
      async remove(id) {
        removeAttempts += 1;
        if (removeAttempts % 47 === 0 && !failedRemoveIds.has(id)) {
          failedRemoveIds.add(id);
          throw new Error('synthetic tabs.remove transient failure');
        }
        const index = tabs.findIndex(t => t.id === id);
        if (index >= 0) tabs.splice(index, 1);
      },
    },
    alarms: { async create() {}, async clear() { return true; } },
  };
}

function stateFixture() {
  const state = createEmptyState(1);
  const task = createTask({ id: 'diag-t1', url: 'https://chatgpt.com/' });
  const session = createSession({
    id: 'diag-s1', name: 'diagnostic-derived-single-session', tasks: [task], sharedPrompt: 'continue deeply',
    minimumSendIntervalMs: 1_000, preSendDelayMs: 1_000, busyCheckDelayMs: 3_000,
    retryBackoffMs: 5_000, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK, now: 1,
  });
  session.runState = RunState.RUNNING;
  state.sessionsById[session.id] = session;
  state.sessionOrder.push(session.id);
  return state;
}

function runtimeError(code, message = code) {
  const error = new Error(message);
  error.safeDiagnosticCode = code;
  return error;
}

test('one ordinary fresh-chat Session survives diagnostic-derived submit, receiver, navigation, composer and rate-limit faults beyond 200 sends', async () => {
  const repo = new Repo(stateFixture());
  const chromeApi = chromeMock();
  let now = 1_000;
  let runtimeCycles = 0;
  let checkCalls = 0;
  let insertCalls = 0;
  let submitCalls = 0;
  let rateLimitInjected = false;
  const physicalSubmitOperationIds = new Set();
  const uncertainOperationIds = new Set();
  const verifyCallsByOperation = new Map();
  const injected = new Set();

  const transport = {
    async execute(tabId, request) {
      if (request.mode === 'CHECK_ONLY') {
        checkCalls += 1;
        if (checkCalls % 29 === 0) {
          throw runtimeError('TAB_NAVIGATION_TIMEOUT', 'Selected ChatGPT tab did not finish navigation before CHECK_ONLY');
        }
        if (!rateLimitInjected && checkCalls >= 137) {
          rateLimitInjected = true;
          return { status: InteractionResult.RATE_LIMITED, safeDiagnosticCode: 'RATE_LIMIT_DIALOG_ACKNOWLEDGED_BUT_STILL_VISIBLE', normalizedObservedUrl: request.expectedUrl };
        }
        return { status: InteractionResult.READY, safeDiagnosticCode: 'READY', normalizedObservedUrl: request.expectedUrl };
      }
      if (request.mode === 'INSERT_ONLY') {
        insertCalls += 1;
        if (insertCalls % 41 === 0) {
          return { status: InteractionResult.INSERTED_NOT_SENT, composerState: 'VISIBLE_EMPTY', safeDiagnosticCode: 'COMPOSER_LOST_AFTER_INSERT', normalizedObservedUrl: request.expectedUrl };
        }
        return { status: InteractionResult.INSERTED_NOT_SENT, composerState: 'VISIBLE_NONEMPTY', safeDiagnosticCode: 'INSERTION_TEXT_PROVEN', normalizedObservedUrl: request.expectedUrl };
      }
      if (request.mode === 'PREPARE_SEND') {
        return { status: InteractionResult.READY, safeDiagnosticCode: 'PENDING_PROMPT_READY_TO_SUBMIT', normalizedObservedUrl: request.expectedUrl };
      }
      if (request.mode === 'SUBMIT_EXISTING') {
        submitCalls += 1;
        assert.ok(!physicalSubmitOperationIds.has(request.requestId), `operation ${request.requestId} must never be physically submitted twice`);
        physicalSubmitOperationIds.add(request.requestId);
        const generated = `https://chatgpt.com/c/diag-${submitCalls}`;
        const tab = chromeApi._tabs.find(t => t.id === tabId);
        if (tab) tab.url = generated;
        if (submitCalls % 17 === 0) {
          uncertainOperationIds.add(request.requestId);
          return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN', normalizedObservedUrl: generated };
        }
        return { status: InteractionResult.SENT_VERIFIED, safeDiagnosticCode: 'SEND_VERIFIED_FRESH_GENERATION_STARTED', normalizedObservedUrl: generated };
      }
      if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
        const count = (verifyCallsByOperation.get(request.requestId) || 0) + 1;
        verifyCallsByOperation.set(request.requestId, count);
        const tab = chromeApi._tabs.find(t => t.id === tabId);
        const ordinal = Number(String(tab?.url || '').match(/diag-(\d+)/)?.[1] || 0);
        if (ordinal % 51 === 0) {
          injected.add('INTERACTION_RECEIVER_RESTORE_FAILED');
          throw runtimeError('INTERACTION_RECEIVER_RESTORE_FAILED', 'Safe receiver restoration failed after the receiving end was missing');
        }
        if (ordinal % 34 === 0) {
          injected.add('TAB_NAVIGATION_URL_MISMATCH');
          throw runtimeError('TAB_NAVIGATION_URL_MISMATCH', 'Selected ChatGPT tab completed at a different URL before CHECK_ONLY');
        }
        injected.add('RECOVERY_TEXT_ACK_PENDING');
        return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'RECOVERY_TEXT_ACK_PENDING', normalizedObservedUrl: tab?.url || request.expectedUrl };
      }
      throw new Error(`unexpected mode ${request.mode}`);
    },
  };

  const executor = new AutomaticSessionExecutor(repo, chromeApi, transport, { now: () => now });
  while (runtimeCycles < 8000) {
    const state = await repo.load();
    if (state.sessionsById['diag-s1'].successfulSendCount >= 230) break;
    const cycle = await runRuntimeCycle({ repository: repo, chromeApi, executor, executionAvailable: true, now: () => now });
    runtimeCycles += 1;
    const wake = Number(cycle.wakeAt);
    now = Number.isFinite(wake) && wake > now ? wake + 1 : now + 1_000;
  }

  const after = await repo.load();
  const session = after.sessionsById['diag-s1'];
  assert.ok(session.successfulSendCount >= 230, `Session must keep progressing well beyond 200 verified sends; got ${session.successfulSendCount}`);
  assert.ok(runtimeCycles < 8000, 'fault recovery must stay bounded');
  assert.ok(submitCalls > 230, 'stress must include ambiguous no-resend settlements in addition to verified sends');
  assert.ok(uncertainOperationIds.size >= 10, 'stress must repeatedly exercise SEND_CLICK_UNCERTAIN');
  assert.ok(injected.has('RECOVERY_TEXT_ACK_PENDING'));
  assert.ok(injected.has('TAB_NAVIGATION_URL_MISMATCH'));
  assert.ok(injected.has('INTERACTION_RECEIVER_RESTORE_FAILED'));
  assert.equal(physicalSubmitOperationIds.size, submitCalls, 'at-most-once physical Send identity must hold');
  assert.equal(rateLimitInjected, true, 'stress must exercise a real account-level pause');
  assert.ok([RunState.RUNNING, RunState.RECOVERING].includes(session.runState));
  if (session.operation?.phase === OperationPhase.AMBIGUOUS) {
    assert.ok(now - Number(session.operation.submitStartedAt || now) < 60_000, 'no ancient ambiguous operation may survive');
  }
  assert.ok(chromeApi.stats().maxTabs <= 1, `single open-close Session must not accumulate tabs; max=${chromeApi.stats().maxTabs}`);
});
