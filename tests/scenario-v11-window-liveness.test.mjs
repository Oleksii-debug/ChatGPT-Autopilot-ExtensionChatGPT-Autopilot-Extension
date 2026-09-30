import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatTab, resolveTaskTab } from '../src/core/tabs.js';
import { probeAssistantConversation } from '../src/core/assistant-report-probe.js';
import { ScenarioWorkManager } from '../src/core/scenario-work-manager.js';
import { createEmptyState, createSession, createTask } from '../src/core/schema.js';

test('Scenario tabs reopen in their saved window while another window is focused', async () => {
  const created = [];
  const chrome = {
    windows: { async get(id) { assert.equal(id, 11); return { id }; } },
    tabs: {
      async query() { return [{ id: 3, windowId: 22, url: 'https://chatgpt.com/c/other' }]; },
      async create(options) { created.push(options); return { id: 4, windowId: options.windowId, ...options }; },
    },
  };
  await createChatTab(chrome, 'https://chatgpt.com/c/owner', 11);
  assert.equal(created.length, 1);
  assert.equal(created[0].windowId, 11);
});

test('parked Scenario does not adopt an unbound user conversation across windows', async () => {
  let creates = 0;
  const existing = { id: 7, windowId: 11, url: 'https://chatgpt.com/c/owner', status: 'complete' };
  const chrome = { tabs: {
    async get() { throw new Error('No saved tab'); },
    async query() { return [existing]; },
    async create(options) { creates += 1; return { id: 8, windowId: 11, ...options }; },
  } };
  const report = await probeAssistantConversation(chrome, { execute() { throw new Error('Not due yet'); } }, {
    conversationUrl: existing.url, persistentManagedTab: true, createOwnedTab: true,
    recoveryAction: 'SAME_URL_REOPEN', preferredWindowId: 11,
  });
  assert.equal(report.recoveredManagedTabId, 8);
  assert.equal(report.recoveredManagedTabOwned, true);
  assert.equal(creates, 1);
});

test('a loading or redirected owned probe tab is retained and navigated in place', async () => {
  const tab = { id: 8, windowId: 11, url: 'https://chatgpt.com/', status: 'loading' };
  let creates = 0;
  let updates = 0;
  const chrome = { tabs: {
    async get() { return { ...tab }; },
    async query() { return [tab]; },
    async create() { creates += 1; throw new Error('Duplicate probe'); },
    async update(id, changes) { assert.equal(id, 8); updates += 1; Object.assign(tab, changes); return { ...tab }; },
  } };
  const job = { conversationUrl: 'https://chatgpt.com/c/owner', persistentManagedTab: true,
    managedTabId: 8, managedTabOwned: true };
  const transport = { execute() { throw new Error('Still navigating'); } };
  const loading = await probeAssistantConversation(chrome, transport, job);
  assert.equal(loading.safeDiagnosticCode, 'ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING');
  assert.equal(updates, 0);
  tab.status = 'complete';
  const redirected = await probeAssistantConversation(chrome, transport, job);
  assert.equal(redirected.safeDiagnosticCode, 'ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING');
  assert.equal(updates, 1);
  assert.equal(tab.url, job.conversationUrl);
  assert.equal(creates, 0);
});

test('login redirect before first Send retains the same owned Scenario tab', async () => {
  const task = createTask({ id: 'task', url: 'https://chatgpt.com/' });
  const session = createSession({ id: 'session', name: 'Scenario test', tasks: [task], now: 1 });
  session.scenarioWork = { managed: true, scenarioId: 'scenario', preferredWindowId: 11 };
  const state = createEmptyState(1);
  state.sessionsById.session = session;
  state.sessionOrder.push('session');
  state.tabHintsByTaskId.task = {
    tabId: 7, sessionId: 'session', kind: 'TASK', normalizedUrl: task.normalizedUrl,
    ownedByExtension: true,
  };
  let creates = 0;
  let removes = 0;
  const chrome = { tabs: {
    async get() { return { id: 7, windowId: 11, url: 'https://chatgpt.com/auth/login' }; },
    async create() { creates += 1; throw new Error('Unexpected replacement'); },
    async remove() { removes += 1; },
  } };
  const retained = await resolveTaskTab(chrome, state, 'session', task);
  assert.equal(retained.id, 7);
  assert.equal(creates, 0);
  assert.equal(removes, 0);
});

test('a pre-Send deadline does not replace the member or draft tab', async () => {
  let now = 1000;
  const data = {};
  const chrome = { storage: { local: {
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(value) { Object.assign(data, structuredClone(value)); },
  } }, alarms: { async create() {}, async clear() {} } };
  const core = { state: createEmptyState(0), async load() { return structuredClone(this.state); },
    async update(mutator) { this.state = await mutator(structuredClone(this.state)) || this.state; return this.load(); } };
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome,
    now: () => now, createId: () => 'same-tab',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  await manager.create({ config: { steps: [{ prompt: 'ONE' }], responseTimeoutMinutes: 1 } });
  await manager.start('same-tab');
  const sessionId = core.state.sessionOrder[0];
  const taskId = core.state.sessionsById[sessionId].taskOrder[0];
  now += 61_000;
  await manager.cycleOne('same-tab');
  const live = (await manager.get('same-tab')).scenario.runtime;
  assert.equal(live.chat.sessionId, sessionId);
  assert.equal(live.totalLaunches, 1);
  assert.equal(core.state.sessionsById[sessionId].tasksById[taskId].lastVerifiedSendAt, 0);
  assert.ok(live.chat.deadlineAt > now);
});

test('parking persists the owner window for the next scheduled probe', async () => {
  let now = 1000;
  const data = {};
  const jobs = [];
  const removed = [];
  const tabs = new Map([[7, { id: 7, windowId: 11, url: 'https://chatgpt.com/c/owner' }]]);
  const created = [];
  const chrome = { storage: { local: {
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(value) { Object.assign(data, structuredClone(value)); },
  } }, alarms: { async create() {}, async clear() {} }, tabs: {
    async get(id) { if (!tabs.has(id)) throw Error('No tab'); return structuredClone(tabs.get(id)); },
    async query() { return [...tabs.values()]; },
    async create(options) { const tab = { id: 8, windowId: options.windowId, ...options }; created.push(tab); tabs.set(8, tab); return tab; },
    async update(id, patch) { Object.assign(tabs.get(id), patch); return structuredClone(tabs.get(id)); },
    async remove(id) { removed.push(id); tabs.delete(id); },
  } };
  const core = { state: createEmptyState(0), async load() { return structuredClone(this.state); },
    async update(mutator) { this.state = await mutator(structuredClone(this.state)) || this.state; return this.load(); } };
  const manager = new ScenarioWorkManager({ coreRepository: core, chromeApi: chrome,
    now: () => now, createId: () => 'parked', collectAssistantReport: async job => {
      jobs.push(job);
      return job.recoveryAction === 'SAME_URL_REOPEN'
        ? { status: 'TEMPORARY_ERROR', recoveredManagedTabId: 8, recoveredManagedTabOwned: true }
        : { status: 'TEMPORARY_ERROR', safeDiagnosticCode: 'ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING', tabRecoveryPending: true };
    } });
  await manager.create({ config: { steps: [{ prompt: 'ONE' }], closeTabsBetweenChecks: true } });
  await manager.start('parked');
  const sessionId = core.state.sessionOrder[0];
  const taskId = core.state.sessionsById[sessionId].taskOrder[0];
  core.state.sessionsById[sessionId].operation = { phase: 'SENT_VERIFIED', taskId };
  core.state.sessionsById[sessionId].tasksById[taskId].lastVerifiedSendAt = 1001;
  core.state.sessionsById[sessionId].tasksById[taskId].lastConversationUrl = 'https://chatgpt.com/c/owner';
  core.state.tabHintsByTaskId[taskId] = {
    tabId: 7, sessionId, kind: 'TASK', normalizedUrl: 'https://chatgpt.com/c/owner',
    ownedByExtension: true,
  };
  now = 2000;
  await manager.cycleOne('parked');
  const parked = (await manager.get('parked')).scenario.runtime;
  assert.equal(parked.preferredWindowId, 11);
  assert.deepEqual(removed, [7]);
  assert.equal(jobs.length, 0);
  now = parked.chat.nextProbeAt + 1;
  await manager.cycleOne('parked');
  assert.equal(jobs.length, 0, 'creation is recorded without a separate probe-side create');
  assert.equal(created.length, 1);
  assert.equal(created[0].windowId, 11);
  assert.equal(core.state.tabHintsByTaskId[taskId].tabId, 8);
  now += 15_001;
  await manager.cycleOne('parked');
  assert.deepEqual(removed, [7], 'the loading report tab stays open for the next observation');
  assert.equal(core.state.tabHintsByTaskId[taskId].tabId, 8);
});
