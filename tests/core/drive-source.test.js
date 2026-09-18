import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptDriveSnapshot, getDriveSourceConfig, setDriveSourceConfig } from '../../src/core/drive-source.js';

function state() {
  return {
    profile: { masterPaused: false, createdAt: 0 },
    sessionsById: {
      s1: {
        id: 's1',
        promptMode: 'SHARED',
        sharedPrompt: 'primary-v1',
        defaultUniquePrompt: '',
      },
    },
  };
}

test('Drive source config is durable and source replacement clears accepted identity', () => {
  const s = state();
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://drive.google.com/file/d/file-1/view', target: 'primary', minChars: 1 });
  assert.deepEqual(getDriveSourceConfig(s, 's1'), {
    fileId: 'file-1',
    sourceUrl: 'https://drive.google.com/file/d/file-1/view',
    target: 'primary',
    lastAcceptedVersion: '',
    lastAcceptedHash: '',
    lastSyncedAt: 0,
    lastCheckedAt: 0,
    lastSyncError: '',
    autoSyncEnabled: false,
    syncIntervalMinutes: 3,
    minChars: 1000,
  });
  s.profile.driveSourceBySessionId.s1.lastAcceptedVersion = '12';
  s.profile.driveSourceBySessionId.s1.lastAcceptedHash = 'h12';
  setDriveSourceConfig(s, 's1', { fileId: 'file-2', sourceUrl: 'https://drive.google.com/file/d/file-2/view', target: 'primary', minChars: 1 });
  assert.equal(getDriveSourceConfig(s, 's1').lastAcceptedVersion, '');
});

test('legacy secondary target normalizes to prompt2 without resetting source identity', () => {
  const s = state();
  s.profile.driveSourceBySessionId = {
    s1: {
      fileId: 'file-1',
      sourceUrl: 'https://drive.google.com/file/d/file-1/view',
      target: 'secondary',
      lastAcceptedVersion: '4',
      lastAcceptedHash: 'h4',
      lastSyncedAt: 40,
    },
  };
  assert.equal(getDriveSourceConfig(s, 's1').target, 'prompt2');
  setDriveSourceConfig(s, 's1', {
    fileId: 'file-1',
    sourceUrl: 'https://drive.google.com/file/d/file-1/view',
    target: 'prompt2',
  });
  assert.equal(getDriveSourceConfig(s, 's1').lastAcceptedVersion, '4');
});

test('stable newer Drive snapshot atomically replaces the primary prompt', () => {
  const s = state();
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://drive.google.com/file/d/file-1/view', target: 'primary', minChars: 1 });
  const first = acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'h10', content: 'primary-v10' }, { now: 100 });
  assert.equal(first.accepted, true);
  assert.equal(s.sessionsById.s1.sharedPrompt, 'primary-v10');
  assert.equal(getDriveSourceConfig(s, 's1').lastAcceptedVersion, '10');
  const noop = acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'h10', content: 'primary-v10' }, { now: 200 });
  assert.equal(noop.accepted, false);
  assert.equal(getDriveSourceConfig(s, 's1').lastSyncedAt, 100);
  acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '11', hash: 'h11', content: 'primary-v11' }, { now: 300 });
  assert.equal(s.sessionsById.s1.sharedPrompt, 'primary-v11');
  assert.equal(getDriveSourceConfig(s, 's1').lastAcceptedVersion, '11');
});

test('older or same-version divergent content fails closed without mutation', () => {
  const s = state();
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://drive.google.com/file/d/file-1/view', target: 'primary', minChars: 1 });
  acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'h10', content: 'primary-v10' }, { now: 100 });
  const before = structuredClone(s);
  assert.throws(() => acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '9', hash: 'h9', content: 'older' }), /older/);
  assert.deepEqual(s, before);
  assert.throws(() => acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'different', content: 'changed' }), /different content identity/);
  assert.deepEqual(s, before);
});

test('prompt2 Drive target updates only prompt 2 and preserves cadence settings', () => {
  const s = state();
  s.profile.promptCadenceBySessionId = {
    s1: {
      prompts: [
        { enabled: false, prompt: '', everyN: 10 },
        { enabled: true, prompt: 'old-2', everyN: 5 },
        { enabled: true, prompt: 'old-3', everyN: 7 },
      ],
      chatFlow: { enabled: false, mode: 'same-chat' },
    },
  };
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://docs.google.com/document/d/file-1/edit', target: 'prompt2', minChars: 1 });
  acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '20', hash: 'h20', content: 'new-prompt-2' });
  assert.equal(s.sessionsById.s1.sharedPrompt, 'primary-v1');
  const config = s.profile.promptCadenceBySessionId.s1;
  assert.equal(config.prompts[1].prompt, 'new-prompt-2');
  assert.equal(config.prompts[1].everyN, 5);
  assert.equal(config.prompts[1].enabled, true);
  assert.equal(config.prompts[2].prompt, 'old-3');
});

test('prompt3 Drive target updates only prompt 3 and preserves prompt 2', () => {
  const s = state();
  s.profile.promptCadenceBySessionId = {
    s1: {
      prompts: [
        { enabled: false, prompt: '', everyN: 10 },
        { enabled: true, prompt: 'prompt-2', everyN: 3 },
        { enabled: true, prompt: 'prompt-3-old', everyN: 4 },
      ],
    },
  };
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://drive.google.com/file/d/file-1/view', target: 'prompt3', minChars: 1 });
  acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '21', hash: 'h21', content: 'prompt-3-new' });
  const config = s.profile.promptCadenceBySessionId.s1;
  assert.equal(config.prompts[1].prompt, 'prompt-2');
  assert.equal(config.prompts[2].prompt, 'prompt-3-new');
  assert.equal(config.prompts[2].everyN, 4);
});


test('Drive primary target fails closed in unique prompt mode instead of pretending to update tasks', () => {
  const s = state();
  s.sessionsById.s1.promptMode = 'UNIQUE';
  s.sessionsById.s1.tasksById = { t1: { id: 't1', promptOverride: 'task-specific' } };
  setDriveSourceConfig(s, 's1', {
    fileId: 'file-1',
    sourceUrl: 'https://drive.google.com/file/d/file-1/view',
    target: 'primary',
    minChars: 1,
  });
  assert.throws(
    () => acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '1', hash: 'h1', content: 'new text' }),
    /requires shared prompt mode/,
  );
  assert.equal(s.sessionsById.s1.tasksById.t1.promptOverride, 'task-specific');
});


test('Drive source write rejects fractional or out-of-range visible settings', () => {
  const s = state();
  assert.throws(
    () => setDriveSourceConfig(s, 's1', {
      fileId: 'file-1',
      sourceUrl: 'https://drive.google.com/file/d/file-1/view',
      target: 'primary',
      syncIntervalMinutes: 2.5,
      minChars: 1000,
    }),
    /Drive sync interval must be an integer/,
  );
  assert.throws(
    () => setDriveSourceConfig(s, 's1', {
      fileId: 'file-1',
      sourceUrl: 'https://drive.google.com/file/d/file-1/view',
      target: 'primary',
      syncIntervalMinutes: 3,
      minChars: 0,
    }),
    /Drive minimum prompt length must be an integer/,
  );
});
