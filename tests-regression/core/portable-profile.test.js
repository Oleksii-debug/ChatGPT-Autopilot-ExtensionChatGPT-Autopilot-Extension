import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState } from '../../src/core/schema.js';
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
  assert.equal(previewPortableProfile(profile({ autoStart: true }), 100).autoStartSessionCount, 1);
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

test('portable profile does not impose an arbitrary prompt character cap', () => {
  const hugePrompt = 'Ж'.repeat(300000);
  const input = profile();
  input.sessions[0].sharedPrompt = hugePrompt;
  input.sessions[0].tasks[0].promptOverride = hugePrompt;
  input.sessions[0].defaultUniquePrompt = hugePrompt;
  const preview = previewPortableProfile(input, 100);
  assert.equal(preview.taskCount, 1);
  const state = createEmptyState(0);
  applyPortableProfile(state, input, { now: 100 });
  assert.equal(state.sessionsById['session-1'].sharedPrompt.length, hugePrompt.length);
});

test('portable export remains re-importable when the user has more than five Sessions', () => {
  const state = createEmptyState(0);
  for (let index = 1; index <= 20; index += 1) {
    const task = createTask({ id: `task-${index}`, url: `https://chatgpt.com/c/session-${index}` });
    const session = createSession({ id: `session-${index}`, name: `Session ${index}`, tasks: [task], sharedPrompt: `prompt ${index}`, now: 0 });
    state.sessionsById[session.id] = session;
    state.sessionOrder.push(session.id);
  }

  const exported = exportPortableProfile(state, { profileName: '20-session round trip' });
  assert.equal(exported.sessions.length, 20);
  const preview = previewPortableProfile(exported, 1);
  assert.equal(preview.sessionCount, 20);
  assert.equal(preview.taskCount, 20);

  const restored = createEmptyState(1);
  const result = applyPortableProfile(restored, exported, { now: 2 });
  assert.equal(result.importedSessionIds.length, 20);
  assert.deepEqual(restored.sessionOrder, state.sessionOrder);
  for (const id of state.sessionOrder) {
    assert.equal(restored.sessionsById[id].sharedPrompt, state.sessionsById[id].sharedPrompt);
    assert.equal(restored.sessionsById[id].tasksById[state.sessionsById[id].taskOrder[0]].url, state.sessionsById[id].tasksById[state.sessionsById[id].taskOrder[0]].url);
  }
});

test('portable auto-start allows parallel Sessions on the same launch surface but not the same concrete conversation', () => {
  const launchProfile = {
    format: 'chatgpt-autopilot-profile', version: 1, profileName: 'parallel launch', autoStart: true,
    sessions: [1, 2].map(index => ({
      id: `launch-${index}`, name: `Launch ${index}`, autoStart: true, promptMode: 'shared', urlMode: 'shared', sharedPrompt: `p${index}`,
      runMode: 'one-pass', minimumSendIntervalMinutes: 1, preSendDelaySeconds: 10, busyCheckDelaySeconds: 10,
      retryBackoffSeconds: 15, retryPolicy: 'safe', tabStrategy: 'open-close',
      tasks: [{ id: `t${index}`, enabled: true, label: '', url: 'https://chatgpt.com/', promptOverride: '' }],
    })),
  };
  const state = createEmptyState(0);
  const result = applyPortableProfile(state, launchProfile, { now: 1, confirmAutoStart: true, executionAvailable: true });
  assert.deepEqual(result.startedSessionIds, ['launch-1', 'launch-2']);
  assert.equal(state.sessionsById['launch-1'].runState, RunState.RUNNING);
  assert.equal(state.sessionsById['launch-2'].runState, RunState.RUNNING);

  const conversationProfile = structuredClone(launchProfile);
  conversationProfile.profileName = 'collision';
  conversationProfile.sessions[0].id = 'conversation-1';
  conversationProfile.sessions[0].tasks[0].id = 'ct1';
  conversationProfile.sessions[0].tasks[0].url = 'https://chatgpt.com/c/exact-shared';
  conversationProfile.sessions[1].id = 'conversation-2';
  conversationProfile.sessions[1].tasks[0].id = 'ct2';
  conversationProfile.sessions[1].tasks[0].url = 'https://chatgpt.com/c/exact-shared';
  const collisionState = createEmptyState(0);
  assert.throws(
    () => applyPortableProfile(collisionState, conversationProfile, { now: 1, confirmAutoStart: true, executionAvailable: true }),
    /already owned/,
  );
});


test('portable profile round-trips cadence and Drive config but strips Drive runtime evidence', () => {
  const state = createEmptyState(0);
  applyPortableProfile(state, profile(), { now: 100 });
  const session = state.sessionsById['session-1'];
  session.promptCadence = {
    schemaVersion: 1,
    prompt2: { enabled: true, prompt: 'Prompt two', everyN: 7 },
    prompt3: { enabled: true, prompt: 'Prompt three', everyN: 13 },
  };
  session.drivePromptSources = {
    schemaVersion: 1,
    bindings: [{
      target: 'PROMPT_2',
      enabled: true,
      fileId: 'file_abcdef',
      pollIntervalMs: 180000,
      minChars: 1200,
      lastAcceptedVersion: '55',
      lastAcceptedHash: 'a'.repeat(64),
      lastCheckedAt: 123456,
      nextCheckAt: 456789,
      lastErrorCode: 'NETWORK',
    }],
  };

  const exported = exportPortableProfile(state, { profileName: 'Cadence + Drive' });
  const portable = exported.sessions[0];
  assert.deepEqual(portable.promptCadence, session.promptCadence);
  assert.deepEqual(portable.drivePromptSources, {
    schemaVersion: 1,
    bindings: [{
      target: 'PROMPT_2',
      enabled: true,
      fileId: 'file_abcdef',
      pollIntervalMs: 180000,
      minChars: 1200,
    }],
  });
  assert.equal(JSON.stringify(portable).includes('lastAcceptedVersion'), false);
  assert.equal(JSON.stringify(portable).includes('lastAcceptedHash'), false);
  assert.equal(JSON.stringify(portable).includes('NETWORK'), false);

  const restored = createEmptyState(0);
  applyPortableProfile(restored, exported, { now: 200 });
  const imported = restored.sessionsById['session-1'];
  assert.deepEqual(imported.promptCadence, session.promptCadence);
  assert.deepEqual(imported.drivePromptSources, {
    schemaVersion: 1,
    bindings: [{
      target: 'PROMPT_2',
      enabled: true,
      fileId: 'file_abcdef',
      pollIntervalMs: 180000,
      minChars: 1200,
      lastAcceptedVersion: '',
      lastAcceptedHash: '',
      lastCheckedAt: 0,
      nextCheckAt: 0,
      lastErrorCode: '',
    }],
  });
});

test('portable profile remains backward compatible when cadence and Drive config are absent', () => {
  const input = profile();
  delete input.sessions[0].promptCadence;
  delete input.sessions[0].drivePromptSources;
  const state = createEmptyState(0);
  assert.doesNotThrow(() => applyPortableProfile(state, input, { now: 100 }));
  const session = state.sessionsById['session-1'];
  assert.equal(session.promptCadence.prompt2.enabled, false);
  assert.equal(session.promptCadence.prompt3.enabled, false);
  assert.deepEqual(session.drivePromptSources, { schemaVersion: 1, bindings: [] });
});
