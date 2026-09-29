import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBundledBootstrapProfile, BOOTSTRAP_META_KEY } from '../../src/core/bootstrap.js';
import { createEmptyState, RunState, RunMode, PromptMode, TabStrategy, validateState } from '../../src/core/schema.js';

class MemoryRepository {
  constructor(state = createEmptyState(1000)) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    const next = await mutator(draft) || draft;
    next.revision = this.state.revision + 1;
    validateState(next);
    this.state = structuredClone(next);
    return structuredClone(next);
  }
}

function makeChrome() {
  const values = {};
  return {
    storage: {
      local: {
        async get(key) { return { [key]: values[key] }; },
        async set(record) { Object.assign(values, structuredClone(record)); },
      },
    },
    _values: values,
  };
}

function profile(overrides = {}) {
  return {
    enabled: true,
    profileId: 'test-profile',
    revision: 1,
    autoStart: true,
    replaceManagedOnUpgrade: false,
    sessions: [{
      id: 'session-1',
      name: 'Test Session',
      promptMode: 'shared',
      sharedPrompt: 'Continue safely',
      runMode: 'continuous',
      minimumSendIntervalMs: 120000,
      preSendDelayMs: 5000,
      busyCheckDelayMs: 2000,
      retryBackoffMs: 120000,
      tabStrategy: 'worker',
      tasks: [
        { id: 'task-1', label: 'One', url: 'https://chatgpt.com/c/one' },
        { id: 'task-2', label: 'Two', url: 'https://chatgpt.com/c/two' },
      ],
    }],
    ...overrides,
  };
}

test('disabled public bootstrap profile is a no-op', async () => {
  const repository = new MemoryRepository();
  const chromeApi = makeChrome();
  const result = await applyBundledBootstrapProfile({
    repository,
    chromeApi,
    profile: { enabled: false },
    now: 2000,
  });
  assert.deepEqual(result, { applied: false, reason: 'disabled' });
  assert.equal((await repository.load()).sessionOrder.length, 0);
});

test('authorized empty-install bootstrap creates configured RUNNING session exactly once', async () => {
  const repository = new MemoryRepository();
  const chromeApi = makeChrome();
  const configured = profile();

  const first = await applyBundledBootstrapProfile({ repository, chromeApi, profile: configured, now: 2000 });
  assert.equal(first.applied, true);
  const state = await repository.load();
  assert.deepEqual(state.sessionOrder, ['session-1']);
  const session = state.sessionsById['session-1'];
  assert.equal(session.runState, RunState.RUNNING);
  assert.equal(session.promptMode, PromptMode.SHARED);
  assert.equal(session.runMode, RunMode.CONTINUOUS);
  assert.equal(session.tabStrategy, TabStrategy.ONE_WORKER_TAB_PER_SESSION);
  assert.equal(session.minimumSendIntervalMs, 120000);
  assert.equal(session.retryBackoffMs, 120000);
  assert.deepEqual(session.taskOrder, ['task-1', 'task-2']);
  assert.equal(session.sharedPrompt, 'Continue safely');
  assert.equal(chromeApi._values[BOOTSTRAP_META_KEY].profileId, 'test-profile');

  const second = await applyBundledBootstrapProfile({ repository, chromeApi, profile: configured, now: 3000 });
  assert.deepEqual(second, { applied: false, reason: 'already-applied' });
  assert.deepEqual((await repository.load()).sessionOrder, ['session-1']);
});

test('first-run bootstrap never overwrites unrelated existing user state', async () => {
  const existing = createEmptyState(1000);
  existing.sessionsById.existing = {
    id: 'existing', name: 'Existing', enabled: true, runState: 'STOPPED', promptMode: 'SHARED', sharedPrompt: 'x', runMode: 'CONTINUOUS',
    taskOrder: ['existing-task'], tasksById: { 'existing-task': { id: 'existing-task', enabled: true, label: '', url: 'https://chatgpt.com/c/existing', normalizedUrl: 'https://chatgpt.com/c/existing', promptOverride: '', status: 'IDLE', lastCheckedAt: 0, lastVerifiedSendAt: 0, lastVerifiedFingerprint: '', retryAfterAt: 0, manualReviewReason: '' } },
    currentTaskIndex: 0, minimumSendIntervalMs: 120000, preSendDelayMs: 5000, busyCheckDelayMs: 2000, retryBackoffMs: 30000,
    tabStrategy: 'KEEP_TASK_TABS_OPEN', nextAllowedSendAt: 0, operation: null, lastActionAt: 0, lastSuccessfulSendAt: 0, lastError: '', onePassCompletedTaskIds: [], createdAt: 1000, updatedAt: 1000,
  };
  existing.sessionOrder = ['existing'];
  existing.logs.existing = [];
  validateState(existing);

  const repository = new MemoryRepository(existing);
  const chromeApi = makeChrome();
  const result = await applyBundledBootstrapProfile({ repository, chromeApi, profile: profile(), now: 2000 });
  assert.deepEqual(result, { applied: false, reason: 'existing-state' });
  assert.deepEqual((await repository.load()).sessionOrder, ['existing']);
});

test('managed profile upgrade refuses to erase an active or unresolved Session', async () => {
  const repository = new MemoryRepository();
  const chromeApi = makeChrome();
  await applyBundledBootstrapProfile({ repository, chromeApi, profile: profile(), now: 2000 });

  const upgraded = profile({ revision: 2, replaceManagedOnUpgrade: true });
  const result = await applyBundledBootstrapProfile({ repository, chromeApi, profile: upgraded, now: 3000 });
  assert.deepEqual(result, { applied: false, reason: 'managed-profile-active' });
  assert.deepEqual((await repository.load()).sessionOrder, ['session-1']);
});
