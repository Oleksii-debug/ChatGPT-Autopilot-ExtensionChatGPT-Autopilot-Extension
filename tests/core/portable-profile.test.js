import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, RunState } from '../../src/core/schema.js';
import { applyPortableProfile, exportPortableProfile, previewPortableProfile } from '../../src/core/portable-profile.js';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';
import { getPromptCadenceConfig } from '../../src/core/prompt-cadence.js';
import { getDriveSourceConfig } from '../../src/core/drive-source.js';

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


test('portable profile imports prompt2, prompt3 and Drive binding without runtime identity', () => {
  const state = createEmptyState(0);
  const input = profile();
  input.sessions[0].promptCadence = {
    prompt2: { enabled: true, prompt: 'audit', everyN: 30 },
    prompt3: { enabled: true, prompt: 'strategy', everyN: 40 },
    chatFlow: {
      enabled: false,
      mode: 'same-chat',
      newChatEveryN: 10,
      continuePrompt: 'продовжуй',
      continueCount: 10,
      stage2Prompt: '',
      stage2Count: 10,
    },
  };
  input.sessions[0].driveSource = {
    sourceUrl: 'https://drive.google.com/file/d/file-123/view',
    target: 'prompt3',
    autoSyncEnabled: true,
    syncIntervalMinutes: 3,
    minChars: 1000,
  };

  applyPortableProfile(state, input, { now: 100 });

  const cadence = getPromptCadenceConfig(state, 'session-1');
  assert.equal(cadence.prompts[1].prompt, 'audit');
  assert.equal(cadence.prompts[1].everyN, 30);
  assert.equal(cadence.prompts[2].prompt, 'strategy');
  assert.equal(cadence.prompts[2].everyN, 40);
  const drive = getDriveSourceConfig(state, 'session-1');
  assert.equal(drive.fileId, 'file-123');
  assert.equal(drive.target, 'prompt3');
  assert.equal(drive.autoSyncEnabled, true);
  assert.equal(drive.syncIntervalMinutes, 3);
  assert.equal(drive.minChars, 1000);
  assert.equal(drive.lastAcceptedVersion, '');
  assert.equal(drive.lastAcceptedHash, '');
});

test('portable profile export round-trips cadence and Drive configuration but omits Drive runtime state', () => {
  const state = createEmptyState(0);
  const input = profile();
  input.sessions[0].promptCadence = {
    prompt2: { enabled: true, prompt: 'p2', everyN: 3 },
    prompt3: { enabled: true, prompt: 'p3', everyN: 4 },
    chatFlow: {
      enabled: true,
      mode: 'new-chat-after',
      newChatEveryN: 12,
      continuePrompt: 'продовжуй',
      continueCount: 5,
      stage2Prompt: '',
      stage2Count: 6,
    },
  };
  input.sessions[0].driveSource = {
    sourceUrl: 'https://docs.google.com/document/d/doc-123/edit',
    target: 'prompt2',
    autoSyncEnabled: true,
    syncIntervalMinutes: 5,
    minChars: 1200,
  };
  applyPortableProfile(state, input, { now: 100 });
  state.profile.driveSourceBySessionId['session-1'].lastAcceptedVersion = '99';
  state.profile.driveSourceBySessionId['session-1'].lastAcceptedHash = 'secretish-runtime-hash';
  state.profile.driveSourceBySessionId['session-1'].lastSyncedAt = 1234;

  const exported = exportPortableProfile(state, { profileName: 'Round trip extras' });
  const session = exported.sessions[0];
  assert.deepEqual(session.promptCadence.prompt2, { enabled: true, prompt: 'p2', everyN: 3 });
  assert.deepEqual(session.promptCadence.prompt3, { enabled: true, prompt: 'p3', everyN: 4 });
  assert.equal(session.promptCadence.chatFlow.newChatEveryN, 12);
  assert.deepEqual(session.driveSource, {
    sourceUrl: 'https://docs.google.com/document/d/doc-123/edit',
    target: 'prompt2',
    autoSyncEnabled: true,
    syncIntervalMinutes: 5,
    minChars: 1200,
  });
  assert.equal(JSON.stringify(exported).includes('lastAcceptedVersion'), false);
  assert.equal(JSON.stringify(exported).includes('secretish-runtime-hash'), false);
});

test('portable profile preview rejects malformed Drive URL before any state mutation', () => {
  const input = profile();
  input.sessions[0].driveSource = { sourceUrl: 'https://example.com/not-drive', target: 'primary' };
  assert.throws(() => previewPortableProfile(input, 100), /Google Docs|Google Drive/);
});

test('legacy portable profiles without cadence or Drive fields remain valid', () => {
  const state = createEmptyState(0);
  const input = profile();
  assert.equal(input.sessions[0].promptCadence, undefined);
  assert.equal(input.sessions[0].driveSource, undefined);
  applyPortableProfile(state, input, { now: 100 });
  assert.equal(state.sessionsById['session-1'].sharedPrompt, 'continue');
});
