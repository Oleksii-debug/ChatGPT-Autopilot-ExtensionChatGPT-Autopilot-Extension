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
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://drive.google.com/file/d/file-1/view', target: 'primary' });
  assert.deepEqual(getDriveSourceConfig(s, 's1'), {
    fileId: 'file-1',
    sourceUrl: 'https://drive.google.com/file/d/file-1/view',
    target: 'primary',
    lastAcceptedVersion: '',
    lastAcceptedHash: '',
    lastSyncedAt: 0,
  });
  s.profile.driveSourceBySessionId.s1.lastAcceptedVersion = '12';
  s.profile.driveSourceBySessionId.s1.lastAcceptedHash = 'h12';
  setDriveSourceConfig(s, 's1', { fileId: 'file-2', sourceUrl: 'https://drive.google.com/file/d/file-2/view', target: 'primary' });
  assert.equal(getDriveSourceConfig(s, 's1').lastAcceptedVersion, '');
});

test('stable newer Drive snapshot atomically replaces the primary prompt', () => {
  const s = state();
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://drive.google.com/file/d/file-1/view', target: 'primary' });
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
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://drive.google.com/file/d/file-1/view', target: 'primary' });
  acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'h10', content: 'primary-v10' }, { now: 100 });
  const before = structuredClone(s);
  assert.throws(() => acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '9', hash: 'h9', content: 'older' }), /older/);
  assert.deepEqual(s, before);
  assert.throws(() => acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '10', hash: 'different', content: 'changed' }), /different content identity/);
  assert.deepEqual(s, before);
});

test('secondary target updates cadence source without disturbing cadence counter or primary prompt', () => {
  const s = state();
  s.profile.promptCadenceBySessionId = { s1: { enabled: true, secondaryPrompt: 'old', everyN: 5 } };
  setDriveSourceConfig(s, 's1', { fileId: 'file-1', sourceUrl: 'https://docs.google.com/document/d/file-1/edit', target: 'secondary' });
  acceptDriveSnapshot(s, 's1', { fileId: 'file-1', version: '20', hash: 'h20', content: 'new-secondary' });
  assert.equal(s.sessionsById.s1.sharedPrompt, 'primary-v1');
  assert.deepEqual(s.profile.promptCadenceBySessionId.s1, { enabled: true, secondaryPrompt: 'new-secondary', everyN: 5 });
});
