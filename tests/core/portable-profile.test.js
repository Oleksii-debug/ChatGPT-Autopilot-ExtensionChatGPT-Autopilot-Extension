import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, RunState } from '../../src/core/schema.js';
import { applyPortableProfile, exportPortableProfile, previewPortableProfile } from '../../src/core/portable-profile.js';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';

function profile(overrides = {}) {
  return {
    format: 'chatgpt-autopilot-profile',
    version: 1,
    profileName: 'Test',
    autoStart: false,
    sessions: [{
      id: 'session-1',
      name: 'Session 1',
      autoStart: false,
      promptMode: 'shared',
      sharedPrompt: 'continue',
      runMode: 'continuous',
      minimumSendIntervalMinutes: 2,
      preSendDelaySeconds: 5,
      busyCheckDelaySeconds: 2,
      retryBackoffSeconds: 30,
      tabStrategy: 'worker',
      tasks: [{ id: 'task-1', enabled: true, label: 'A', url: 'https://chatgpt.com/c/a', promptOverride: '' }],
    }],
    ...overrides,
  };
}

test('portable profile preview validates format and reports counts without state mutation', () => {
  const input = profile();
  const preview = previewPortableProfile(input, 100);
  assert.equal(preview.profileName, 'Test');
  assert.equal(preview.sessionCount, 1);
  assert.equal(preview.taskCount, 1);
  assert.equal(preview.autoStartSessionCount, 0);
  assert.throws(() => previewPortableProfile({ ...input, version: 2 }, 100), /Unsupported profile version/);
});

test('portable profile import upserts only named sessions and stays stopped without explicit start confirmation', () => {
  const state = createEmptyState(0);
  state.sessionsById.keep = {
    id: 'keep', name: 'Keep', enabled: true, runState: RunState.STOPPED, promptMode: 'SHARED', sharedPrompt: 'x', runMode: 'CONTINUOUS',
    taskOrder: ['keep-task'], tasksById: { 'keep-task': { id:'keep-task', enabled:true, label:'', url:'https://chatgpt.com/c/keep', normalizedUrl:'https://chatgpt.com/c/keep', promptOverride:'', status:'IDLE', lastCheckedAt:0, lastVerifiedSendAt:0, lastVerifiedFingerprint:'', retryAfterAt:0, manualReviewReason:'' } },
    currentTaskIndex:0, minimumSendIntervalMs:120000, preSendDelayMs:5000, busyCheckDelayMs:2000, retryBackoffMs:30000, tabStrategy:'ONE_WORKER_TAB_PER_SESSION', nextAllowedSendAt:0, operation:null, lastActionAt:0, lastSuccessfulSendAt:0, lastError:'', onePassCompletedTaskIds:[], createdAt:0, updatedAt:0,
  };
  state.sessionOrder.push('keep');
  const result = applyPortableProfile(state, profile({ autoStart: true }), { now: 100, confirmAutoStart: false });
  assert.deepEqual(result.importedSessionIds, ['session-1']);
  assert.deepEqual(result.startedSessionIds, []);
  assert.equal(state.sessionsById['session-1'].runState, RunState.STOPPED);
  assert.equal(state.sessionsById.keep.name, 'Keep');
});

test('portable profile starts only after explicit confirmation and rejects active URL collisions atomically', () => {
  const state = createEmptyState(0);
  const input = profile({ autoStart: true });
  const result = applyPortableProfile(state, input, { now: 100, confirmAutoStart: true, executionAvailable: true });
  assert.deepEqual(result.startedSessionIds, ['session-1']);
  assert.equal(state.sessionsById['session-1'].runState, RunState.RUNNING);

  const second = profile({
    profileName: 'Second',
    autoStart: true,
    sessions: [{ ...input.sessions[0], id: 'session-2', name: 'Session 2', tasks: [{ ...input.sessions[0].tasks[0], id: 'task-2' }] }],
  });
  const before = structuredClone(state);
  assert.throws(() => applyPortableProfile(state, second, { now: 200, confirmAutoStart: true, executionAvailable: true }), /already owned/);
  assert.deepEqual(state, before);
});

test('portable profile export contains configuration only and defaults autoStart to false', () => {
  const state = createEmptyState(0);
  applyPortableProfile(state, profile(), { now: 100 });
  const exported = exportPortableProfile(state, { profileName: 'Round trip' });
  assert.equal(exported.format, 'chatgpt-autopilot-profile');
  assert.equal(exported.autoStart, false);
  assert.equal(exported.sessions[0].autoStart, false);
  assert.equal(exported.sessions[0].tasks[0].url, 'https://chatgpt.com/c/a');
  assert.equal(exported.sessions[0].sharedPrompt, 'continue');
  assert.equal(exported.sessions[0].runState, undefined);
  assert.equal(exported.sessions[0].operation, undefined);
});

test('Core dispatcher previews imports and exports portable profile through canonical storage', async () => {
  let db = {};
  const chrome = { storage: { local: { get: async key => ({ [key]: db[key] }), set: async record => Object.assign(db, record) } } };
  const core = new CoreCommandDispatcher(new StorageRepository(chrome), () => 1000, { executionAvailable: true });
  const input = profile();
  const preview = await core.execute(CoreCommand.PREVIEW_PORTABLE_PROFILE, { profile: input });
  assert.equal(preview.preview.taskCount, 1);
  const imported = await core.execute(CoreCommand.IMPORT_PORTABLE_PROFILE, { profile: input, confirmAutoStart: false });
  assert.deepEqual(imported.summary.importedSessionIds, ['session-1']);
  const exported = await core.execute(CoreCommand.EXPORT_PORTABLE_PROFILE, { profileName: 'Export' });
  assert.equal(exported.profile.sessions[0].id, 'session-1');
});
