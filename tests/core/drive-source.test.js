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

function bind(s, overrides = {}) {
  return setDriveSourceConfig(s, 's1', {
    fileId: 'file-1',
    sourceUrl: 'https://drive.google.com/file/d/file-1/view',
    target: 'primary',
    minimumCharacters: 1,
    ...overrides,
  });
}

test('Drive source config is durable and source replacement clears accepted identity', () => {
  const s = state();
  bind(s);
  assert.deepEqual(getDriveSourceConfig(s, 's1'), {
    fileId: 'file-1',
    sourceUrl: 'https://drive.google.com/file/d/file-1/view',
    target: 'primary',
    lastAcceptedVersion: '',
    lastAcceptedHash: '',
    lastSyncedAt: 0,
    autoSync: false,
    syncIntervalMs: 180000,
    minimumCharacters: 1,
    nextSyncAt: 0,
    lastCheckedAt: 0,
    lastSyncError: '',
  });
  s.profile.driveSourceBySessionId.s1.lastAcceptedVersion = '12';
  s.profile.driveSourceBySessionId.s1.lastAcceptedHash = 'h12';
  bind(s, { fileId: 'file-2', sourceUrl: 'https://drive.google.com/file/d/file-2/view' });
  assert.equal(getDriveSourceConfig(s, 's1').lastAcceptedVersion, '');
});

test('Drive source uses visible production-safe defaults when optional sync settings are omitted', () => {
  const s = state();
  setDriveSourceConfig(s, 's1', {
    fileId: 'file-defaults',
    sourceUrl: 'https://drive.google.com/file/d/file-defaults/view',
    target: 'primary',
  });
  const source = getDriveSourceConfig(s, 's1');
  assert.equal(source.autoSync, false);
  assert.equal(source.syncIntervalMs, 180000);
  assert.equal(source.minimumCharacters, 1000);
});

test('stable newer Drive snapshot atomically replaces the primary prompt', () => {
  const s = state();
  bind(s);
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
  bind(s);
  acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'h10', content: 'primary-v10' }, { now: 100 });
  const before = structuredClone(s);
  assert.throws(() => acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '9', hash: 'h9', content: 'older' }), /older/);
  assert.deepEqual(s, before);
  assert.throws(() => acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'different', content: 'changed' }), /different content identity/);
  assert.deepEqual(s, before);
});

test('content below the configured minimum fails closed without replacing last-known-good prompt', () => {
  const s = state();
  bind(s, { minimumCharacters: 1000 });
  const before = structuredClone(s);
  assert.throws(
    () => acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'h10', content: 'too short' }),
    /minimum is 1000/,
  );
  assert.deepEqual(s, before);
});

test('legacy secondary target updates the canonical second cadence slot', () => {
  const s = state();
  s.profile.promptCadenceBySessionId = { s1: { enabled: true, secondaryPrompt: 'old', everyN: 5 } };
  bind(s, {
    sourceUrl: 'https://docs.google.com/document/d/file-1/edit',
    target: 'secondary',
  });
  acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '20', hash: 'h20', content: 'new-secondary' });
  assert.equal(s.sessionsById.s1.sharedPrompt, 'primary-v1');
  assert.equal(s.profile.promptCadenceBySessionId.s1.secondaryPrompt, 'new-secondary');
  assert.equal(s.profile.promptCadenceBySessionId.s1.prompts[1].prompt, 'new-secondary');
  assert.equal(s.profile.promptCadenceBySessionId.s1.prompts[1].enabled, true);
  assert.equal(s.profile.promptCadenceBySessionId.s1.prompts[1].everyN, 5);
});

test('Drive prompt3 target updates the modern third cadence slot without changing the primary prompt', () => {
  const s = state();
  s.profile.promptCadenceBySessionId = {
    s1: {
      prompts: [
        { enabled: false, prompt: '', everyN: 10 },
        { enabled: true, prompt: 'second', everyN: 30 },
        { enabled: true, prompt: 'old-third', everyN: 40 },
      ],
    },
  };
  bind(s, {
    fileId: 'file-3',
    sourceUrl: 'https://drive.google.com/file/d/file-3/view',
    target: 'prompt3',
  });
  acceptDriveSnapshot(s, 's1', { fileId: 'file-3', version: '21', hash: 'h21', content: 'new-third' });
  assert.equal(s.sessionsById.s1.sharedPrompt, 'primary-v1');
  assert.equal(s.profile.promptCadenceBySessionId.s1.prompts[1].prompt, 'second');
  assert.equal(s.profile.promptCadenceBySessionId.s1.prompts[2].prompt, 'new-third');
  assert.equal(s.profile.promptCadenceBySessionId.s1.prompts[2].enabled, true);
  assert.equal(s.profile.promptCadenceBySessionId.s1.prompts[2].everyN, 40);
});
