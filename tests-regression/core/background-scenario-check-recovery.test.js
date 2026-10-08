import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';

function scenarioFixture(count) {
  const state = createEmptyState(0);
  let activeId = 1;
  const updates = [];
  const tasks = Array.from({ length: count }, (_, i) => {
    const id = `t${i + 1}`;
    const sessionId = `s${i + 1}`;
    const tabId = i + 2;
    const task = createTask({ id, url: 'https://chatgpt.com/' });
    const session = createSession({ id: sessionId, name: sessionId, tasks: [task], now: 0 });
    session.runState = RunState.RUNNING;
    session.scenarioWork = { managed: true, preferredWindowId: 42, windowBindingRequired: true };
    state.sessionsById[sessionId] = session;
    state.sessionOrder.push(sessionId);
    state.tabHintsByTaskId[id] = { tabId, sessionId, kind: 'TASK', ownedByExtension: true };
    return { id, sessionId, tabId, task };
  });
  const repo = { load: async () => state, update: async mutate => mutate(state) };
  const chromeApi = { tabs: {
    get: async id => ({ id, windowId: 42, active: activeId === id, url: 'https://chatgpt.com/' }),
    query: async ({active,windowId}) => active && windowId === 42 ? [{ id: activeId, windowId: 42 }] : [],
    update: async (id, change) => {
      assert.equal(change.active, true);
      activeId = id;
      updates.push(id);
      return { id, windowId: 42, active: true };
    },
  } };
  const executor = new AutomaticSessionExecutor(repo, chromeApi, {}, { forceHighEffort: false });
  executor.executeInteraction = async (_sessionId, _session, _task, tabId, mode) => {
    assert.equal(mode, 'CHECK_ONLY');
    assert.equal(activeId, tabId);
    return { status: 'READY', safeDiagnosticCode: 'READY' };
  };
  return { state, tasks, executor, updates, activeId: () => activeId };
}

test('ten concurrently hidden scenario tabs recover composer with read-only checks and restore Pilot tab', async () => {
  const { tasks, executor, updates, activeId } = scenarioFixture(10);
  const results = await Promise.all(tasks.map(t => executor.retryHiddenScenarioCheck(
    t.sessionId, t.task, t.tabId, `check-${t.tabId}`,
    {status:'TEMPORARY_ERROR', safeDiagnosticCode:'COMPOSER_NOT_READY'}
  )));
  assert.equal(results.length, 10);
  assert.ok(results.every(result => result.status === 'READY'));
  assert.equal(activeId(), 1);
  assert.equal(updates.length, 20);
  for (let i=0; i < updates.length; i+=2) {
    assert.ok(updates[i] >= 2);
    assert.equal(updates[i+1], 1);
  }
});

test('a background tab not positively owned by the scenario is never activated', async () => {
  const { state, tasks, executor, updates } = scenarioFixture(1);
  state.tabHintsByTaskId.t1.ownedByExtension = false;
  const result = await executor.retryHiddenScenarioCheck(tasks[0].sessionId, tasks[0].task, 2, 'check',
    {status:'TEMPORARY_ERROR',safeDiagnosticCode:'COMPOSER_NOT_READY'});
  assert.equal(result.status, 'TEMPORARY_ERROR');
  assert.equal(updates.length, 0);
});
