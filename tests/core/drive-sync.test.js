import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';
import { SessionFunctionId, setSessionFunctionEnabled } from '../../src/core/session-functions.js';
import { getDriveSourceConfig, setDriveSourceConfig } from '../../src/core/drive-source.js';
import { syncDueDriveSources } from '../../src/core/drive-sync.js';
import { computeNextWake } from '../../src/core/recovery.js';

class MemoryRepo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    const next = await mutator(draft) || draft;
    next.revision = this.state.revision + 1;
    this.state = structuredClone(next);
    return this.load();
  }
}

function makeState() {
  const state = createEmptyState(0);
  const session = createSession({
    id: 's1',
    name: 'Drive auto sync',
    tasks: [createTask({ id: 't1', url: 'https://chatgpt.com/c/one' })],
    sharedPrompt: 'last-known-good',
    now: 0,
  });
  session.runState = RunState.RUNNING;
  session.activeFunctions = setSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.ORDINARY_SEND, false);
  session.activeFunctions = setSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.DRIVE_SOURCE, true);
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  state.logs.s1 = [];
  setDriveSourceConfig(state, 's1', {
    fileId: 'file-1',
    sourceUrl: 'https://drive.google.com/file/d/file-1/view',
    target: 'primary',
    autoSync: true,
    syncIntervalMs: 120_000,
    minimumCharacters: 4,
  });
  return state;
}

test('Drive auto-sync uses the canonical wake deadline and advances it after a stable snapshot', async () => {
  const repo = new MemoryRepo(makeState());
  assert.equal(computeNextWake(await repo.load(), 1_000), 1_000);

  let reads = 0;
  const result = await syncDueDriveSources({
    repository: repo,
    chromeApi: {},
    now: () => 1_000,
    getAccessToken: async (_chrome, details) => {
      assert.deepEqual(details, { interactive: false });
      return 'token';
    },
    readSnapshot: async ({ fileId, accessToken }) => {
      reads += 1;
      assert.equal(fileId, 'file-1');
      assert.equal(accessToken, 'token');
      return { fileId, version: '2', hash: 'h2', content: 'fresh prompt' };
    },
  });

  assert.equal(reads, 1);
  assert.deepEqual(result, [{ sessionId: 's1', ok: true, accepted: true, reason: '', version: '2' }]);
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.sharedPrompt, 'fresh prompt');
  const source = getDriveSourceConfig(after, 's1');
  assert.equal(source.lastAcceptedVersion, '2');
  assert.equal(source.lastCheckedAt, 1_000);
  assert.equal(source.nextSyncAt, 121_000);
  assert.equal(source.lastSyncError, '');
  assert.equal(computeNextWake(after, 2_000), 121_000);

  await syncDueDriveSources({
    repository: repo,
    chromeApi: {},
    now: () => 60_000,
    getAccessToken: async () => { throw new Error('should not authenticate before due time'); },
    readSnapshot: async () => { throw new Error('should not read before due time'); },
  });
  assert.equal(reads, 1);
});

test('Drive auto-sync failure preserves last-known-good prompt and schedules the next visible interval', async () => {
  const repo = new MemoryRepo(makeState());
  const result = await syncDueDriveSources({
    repository: repo,
    chromeApi: {},
    now: () => 5_000,
    getAccessToken: async () => {
      const error = new Error('offline');
      error.code = 'NETWORK';
      throw error;
    },
    readSnapshot: async () => { throw new Error('must not read without token'); },
  });

  assert.deepEqual(result, [{ sessionId: 's1', ok: false, diagnosticCode: 'NETWORK' }]);
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.sharedPrompt, 'last-known-good');
  const source = getDriveSourceConfig(after, 's1');
  assert.equal(source.lastAcceptedVersion, '');
  assert.equal(source.lastSyncError, 'NETWORK');
  assert.equal(source.lastCheckedAt, 5_000);
  assert.equal(source.nextSyncAt, 125_000);
  assert.equal(after.sessionsById.s1.runState, RunState.RUNNING);
  assert.equal(computeNextWake(after, 6_000), 125_000);
});
