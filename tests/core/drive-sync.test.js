import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';
import { computeNextWake } from '../../src/core/recovery.js';
import { computeNextDriveWake, syncDueDriveSources } from '../../src/core/drive-sync.js';
import { getDriveSourceConfig, setDriveSourceConfig } from '../../src/core/drive-source.js';

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

function activeState({ checkedAt = 0, interval = 3, minChars = 1000 } = {}) {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/drive-sync' });
  const session = createSession({
    id: 's1',
    name: 'Drive sync',
    tasks: [task],
    sharedPrompt: 'old prompt '.repeat(120),
    minimumSendIntervalMs: 10 * 60_000,
    now: 1,
  });
  session.runState = RunState.RUNNING;
  session.nextAllowedSendAt = 10 * 60_000;
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  setDriveSourceConfig(state, 's1', {
    fileId: 'file-1',
    sourceUrl: 'https://drive.google.com/file/d/file-1/view',
    target: 'primary',
    autoSyncEnabled: true,
    syncIntervalMinutes: interval,
    minChars,
  });
  state.profile.driveSourceBySessionId.s1.lastCheckedAt = checkedAt;
  return state;
}

test('Drive autosync shares the canonical wake and can wake earlier than Send cooldown', () => {
  const state = activeState({ checkedAt: 60_000, interval: 3 });
  assert.equal(computeNextDriveWake(state, 100_000), 240_000);
  assert.equal(computeNextWake(state, 100_000), 240_000);
});

test('Drive autosync disabled does not alter canonical Send wake', () => {
  const state = activeState({ checkedAt: 60_000, interval: 3 });
  state.profile.driveSourceBySessionId.s1.autoSyncEnabled = false;
  assert.equal(computeNextDriveWake(state, 100_000), null);
  assert.equal(computeNextWake(state, 100_000), 600_000);
});

test('due Drive sync atomically applies a stable newer prompt and records the check', async () => {
  const state = activeState({ checkedAt: 0, minChars: 1000 });
  const repo = new Repo(state);
  const content = 'new safe prompt '.repeat(100);
  const result = await syncDueDriveSources({
    repository: repo,
    chromeApi: {},
    now: () => 100_000,
    getAccessToken: async () => 'token',
    readSnapshot: async () => ({ fileId: 'file-1', version: '7', hash: 'h7', content }),
  });
  assert.deepEqual(result, { checked: 1, accepted: 1, errors: [] });
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.sharedPrompt, content);
  const source = getDriveSourceConfig(after, 's1');
  assert.equal(source.lastAcceptedVersion, '7');
  assert.equal(source.lastCheckedAt, 100_000);
  assert.equal(source.lastSyncError, '');
});

test('unchanged Drive version is a no-op but advances visible lastCheckedAt', async () => {
  const state = activeState({ checkedAt: 0, minChars: 1000 });
  const content = 'stable prompt '.repeat(100);
  state.sessionsById.s1.sharedPrompt = content;
  state.profile.driveSourceBySessionId.s1.lastAcceptedVersion = '7';
  state.profile.driveSourceBySessionId.s1.lastAcceptedHash = 'h7';
  const repo = new Repo(state);
  const result = await syncDueDriveSources({
    repository: repo,
    chromeApi: {},
    now: () => 200_000,
    getAccessToken: async () => 'token',
    readSnapshot: async () => ({ fileId: 'file-1', version: '7', hash: 'h7', content }),
  });
  assert.equal(result.accepted, 0);
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.sharedPrompt, content);
  assert.equal(getDriveSourceConfig(after, 's1').lastCheckedAt, 200_000);
});

test('OAuth/network failure preserves last-known-good prompt and schedules by the visible interval', async () => {
  const state = activeState({ checkedAt: 0, interval: 3, minChars: 1000 });
  const beforePrompt = state.sessionsById.s1.sharedPrompt;
  const repo = new Repo(state);
  const result = await syncDueDriveSources({
    repository: repo,
    chromeApi: {},
    now: () => 300_000,
    getAccessToken: async () => {
      const error = new Error('offline');
      error.code = 'AUTH_REQUIRED';
      throw error;
    },
  });
  assert.equal(result.accepted, 0);
  assert.equal(result.errors[0].code, 'AUTH_REQUIRED');
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.sharedPrompt, beforePrompt);
  const source = getDriveSourceConfig(after, 's1');
  assert.equal(source.lastCheckedAt, 300_000);
  assert.equal(source.lastSyncError, 'AUTH_REQUIRED');
  assert.equal(computeNextDriveWake(after, 300_000), 480_000);
});

test('prompt shorter than configured minimum never replaces last-known-good', async () => {
  const state = activeState({ checkedAt: 0, minChars: 1000 });
  const beforePrompt = state.sessionsById.s1.sharedPrompt;
  const repo = new Repo(state);
  const result = await syncDueDriveSources({
    repository: repo,
    chromeApi: {},
    now: () => 400_000,
    getAccessToken: async () => 'token',
    readSnapshot: async () => ({ fileId: 'file-1', version: '8', hash: 'h8', content: 'too short' }),
  });
  assert.equal(result.accepted, 0);
  assert.equal(result.errors.length, 1);
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.sharedPrompt, beforePrompt);
  assert.equal(getDriveSourceConfig(after, 's1').lastAcceptedVersion, '');
  assert.match(getDriveSourceConfig(after, 's1').lastSyncError, /shorter than the configured minimum/);
});
