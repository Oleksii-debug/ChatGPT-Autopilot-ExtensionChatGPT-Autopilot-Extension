import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, createEmptyState, createSession, createTask } from '../../src/core/schema.js';
import { StorageRepository, migrateState } from '../../src/core/storage.js';
import { resolveTaskTab } from '../../src/core/tabs.js';

function fakeStorageChrome(seed) {
  let data = structuredClone(seed ?? {});
  return {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(data[key]) }; },
      async set(record) { data = { ...data, ...structuredClone(record) }; }
    }},
    read() { return structuredClone(data); }
  };
}

test('empty storage bootstraps a versioned state without losing validation invariants', async () => {
  const chromeApi = fakeStorageChrome();
  const repo = new StorageRepository(chromeApi);
  const state = await repo.load();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.sessionOrder, []);
});

test('storage update increments revision exactly once and persists complete envelope', async () => {
  const initial = createEmptyState(1_000);
  const chromeApi = fakeStorageChrome({ [STORAGE_KEY]: initial });
  const repo = new StorageRepository(chromeApi);
  const saved = await repo.update((draft) => { draft.profile.masterPaused = true; });
  assert.equal(saved.revision, 1);
  assert.equal(saved.profile.masterPaused, true);
  assert.equal(chromeApi.read()[STORAGE_KEY].revision, 1);
});

test('future schema version fails closed rather than silently resetting sessions', () => {
  assert.throws(() => migrateState({ schemaVersion: 999, revision: 0 }), /newer extension version/i);
});

test('missing migration path fails closed', () => {
  assert.throws(() => migrateState({ schemaVersion: 0, revision: 0 }), /No migration path/);
});

test('valid existing task tab is reused without creating a duplicate', async () => {
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/abc' });
  const state = createEmptyState();
  state.tabHintsByTaskId.t1 = { tabId: 7, sessionId: 's1', normalizedUrl: task.normalizedUrl };
  let created = 0;
  const chromeApi = { tabs: {
    async get(id) { assert.equal(id, 7); return { id: 7, url: 'https://chatgpt.com/c/abc' }; },
    async query() { throw new Error('query should not run for valid hint'); },
    async create() { created++; return { id: 8, url: task.normalizedUrl }; }
  }};
  const tab = await resolveTaskTab(chromeApi, state, 's1', task);
  assert.equal(tab.id, 7);
  assert.equal(created, 0);
});

test('stale tab hint is discarded and an already-open matching tab is reused', async () => {
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/abc' });
  const state = createEmptyState();
  state.tabHintsByTaskId.t1 = { tabId: 7, sessionId: 's1', normalizedUrl: task.normalizedUrl };
  let created = 0;
  const chromeApi = { tabs: {
    async get() { throw new Error('No tab'); },
    async query() { return [{ id: 9, url: 'https://chatgpt.com/c/abc/' }]; },
    async create() { created++; return { id: 10, url: task.normalizedUrl }; }
  }};
  const tab = await resolveTaskTab(chromeApi, state, 's1', task);
  assert.equal(tab.id, 9);
  assert.equal(created, 0);
  assert.equal(state.tabHintsByTaskId.t1.tabId, 9);
});

test('missing task tab is created at most once per resolution and remembered', async () => {
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/abc' });
  const state = createEmptyState();
  let created = 0;
  const chromeApi = { tabs: {
    async get() { throw new Error('No tab'); },
    async query() { return []; },
    async create({ url, active }) { created++; assert.equal(active, false); return { id: 11, url }; }
  }};
  const tab = await resolveTaskTab(chromeApi, state, 's1', task);
  assert.equal(tab.id, 11);
  assert.equal(created, 1);
  assert.equal(state.tabHintsByTaskId.t1.tabId, 11);
});
