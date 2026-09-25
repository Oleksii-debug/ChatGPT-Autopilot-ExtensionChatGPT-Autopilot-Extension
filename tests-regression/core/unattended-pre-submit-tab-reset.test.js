import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { createEmptyState, createSession, createTask, RunState, TabStrategy } from '../../src/core/schema.js';
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

function stateFor(policy = 'safe') {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
  const session = createSession({
    id: 's1', name: 'S', tasks: [task], sharedPrompt: 'hello',
    retryBackoffMs: 15000, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK, now: 1,
  });
  session.retryPolicy = policy;
  session.runState = RunState.RUNNING;
  session.urlMode = 'shared';
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  state.tabHintsByTaskId.t1 = {
    tabId: 7, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK', boundAt: 1,
  };
  return state;
}

function chromeRecorder() {
  const removed = [];
  return {
    removed,
    api: { tabs: { async remove(id) { removed.push(id); } } },
  };
}

for (const status of [
  InteractionResult.AUTH_REQUIRED,
  InteractionResult.UNKNOWN_UI,
  InteractionResult.MANUAL_REVIEW_REQUIRED,
]) {
  test(`safe unattended pre-submit ${status} resets open-close tab before retry`, async () => {
    const repo = new Repo(stateFor('safe'));
    const chrome = chromeRecorder();
    const executor = new AutomaticSessionExecutor(repo, chrome.api, { execute: async () => ({}) }, {
      now: () => 1000, cryptoApi: webcrypto,
    });

    await executor.applyResult('s1', 't1', {
      status,
      safeDiagnosticCode: `TEST_${status}`,
      safeDiagnosticMessage: 'temporary pre-submit obstruction',
    });
    const closed = await executor.closeOpenCloseTabAfterTerminalResult('s1', 't1', { status });
    const after = await repo.load();

    assert.equal(closed, true);
    assert.deepEqual(chrome.removed, [7]);
    assert.equal(after.tabHintsByTaskId.t1, undefined);
    assert.equal(after.sessionsById.s1.runState, RunState.RUNNING);
    assert.equal(after.sessionsById.s1.tasksById.t1.status, 'RETRY_WAIT');
    assert.equal(after.sessionsById.s1.tasksById.t1.manualReviewReason, '');
  });
}

test('manual pre-submit obstruction preserves open-close tab for deliberate inspection', async () => {
  const repo = new Repo(stateFor('manual'));
  const chrome = chromeRecorder();
  const executor = new AutomaticSessionExecutor(repo, chrome.api, { execute: async () => ({}) }, {
    now: () => 1000, cryptoApi: webcrypto,
  });
  const result = { status: InteractionResult.MANUAL_REVIEW_REQUIRED, safeDiagnosticCode: 'MANUAL_TEST' };
  await executor.applyResult('s1', 't1', result);
  const closed = await executor.closeOpenCloseTabAfterTerminalResult('s1', 't1', result);
  const after = await repo.load();

  assert.equal(closed, false);
  assert.deepEqual(chrome.removed, []);
  assert.equal(after.tabHintsByTaskId.t1.tabId, 7);
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
});
