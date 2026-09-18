import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveSnapshotError, readStableDriveSnapshot } from '../../src/core/drive-snapshot.js';

const hash = async text => `hash:${text}`;

function metadataReader(sequence) {
  let index = 0;
  return async () => sequence[Math.min(index++, sequence.length - 1)];
}

test('stable Drive snapshot accepts content only when both versions match', async () => {
  const result = await readStableDriveSnapshot({
    readMetadata: metadataReader([
      { id: 'file-1', version: '10' },
      { id: 'file-1', version: '10' },
    ]),
    readContent: async () => 'prompt-v10',
    hashContent: hash,
    retryDelayMs: 0,
  });
  assert.equal(result.fileId, 'file-1');
  assert.equal(result.version, '10');
  assert.equal(result.content, 'prompt-v10');
  assert.equal(result.hash, 'hash:prompt-v10');
  assert.equal(result.attempts, 1);
});

test('version race is discarded and a bounded retry can accept the next stable snapshot', async () => {
  let contentReads = 0;
  const result = await readStableDriveSnapshot({
    readMetadata: metadataReader([
      { id: 'file-1', version: '10' },
      { id: 'file-1', version: '11' },
      { id: 'file-1', version: '11' },
      { id: 'file-1', version: '11' },
    ]),
    readContent: async () => {
      contentReads += 1;
      return contentReads === 1 ? 'stale-v10' : 'prompt-v11';
    },
    hashContent: hash,
    retryDelayMs: 0,
    maxAttempts: 3,
  });
  assert.equal(result.version, '11');
  assert.equal(result.content, 'prompt-v11');
  assert.equal(result.attempts, 2);
  assert.equal(contentReads, 2);
});

test('persistent version race fails closed after bounded attempts', async () => {
  await assert.rejects(
    () => readStableDriveSnapshot({
      readMetadata: metadataReader([
        { id: 'file-1', version: '10' }, { id: 'file-1', version: '11' },
        { id: 'file-1', version: '12' }, { id: 'file-1', version: '13' },
        { id: 'file-1', version: '14' }, { id: 'file-1', version: '15' },
      ]),
      readContent: async () => 'changing',
      hashContent: hash,
      retryDelayMs: 0,
      maxAttempts: 3,
    }),
    error => error instanceof DriveSnapshotError && error.code === 'VERSION_RACE' && error.attempts === 3,
  );
});

test('retryable transient metadata failure is bounded and can recover', async () => {
  let calls = 0;
  const result = await readStableDriveSnapshot({
    readMetadata: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
      }
      return { id: 'file-2', version: '20' };
    },
    readContent: async () => 'stable',
    hashContent: hash,
    retryDelayMs: 0,
  });
  assert.equal(result.fileId, 'file-2');
  assert.equal(result.version, '20');
  assert.equal(result.content, 'stable');
  assert.equal(calls, 3);
});
