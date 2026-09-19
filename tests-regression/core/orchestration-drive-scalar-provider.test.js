import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRIVE_SCALAR_PROVIDER_V1,
  DriveScalarProviderError,
  DriveScalarProviderV1,
  compareDriveProviderRevisions,
  createGoogleDriveScalarReader,
  extractGoogleDriveScalarSourceId,
  normalizeDriveProviderRevision,
  parseDriveScalarContent,
} from '../../src/core/orchestration-drive-scalar-provider.js';

test('L2-A parses exactly one bounded scalar and rejects prose or multiple values', () => {
  assert.equal(parseDriveScalarContent('0\n', 5), 0);
  assert.equal(parseDriveScalarContent('5', 5), 5);
  assert.throws(() => parseDriveScalarContent('6', 5), error => error.code === 'OUT_OF_RANGE');
  assert.throws(() => parseDriveScalarContent('workers=3', 5), error => error.code === 'INVALID_SCALAR');
  assert.throws(() => parseDriveScalarContent('3\n4', 5), error => error.code === 'INVALID_SCALAR');
  assert.throws(() => parseDriveScalarContent('03', 5), error => error.code === 'INVALID_SCALAR');
  assert.throws(() => parseDriveScalarContent('-1', 5), error => error.code === 'INVALID_SCALAR');
});

test('L2-A canonical Drive revisions compare without Number precision loss', () => {
  assert.equal(normalizeDriveProviderRevision('00042'), '42');
  assert.equal(compareDriveProviderRevisions('41', '42'), -1);
  assert.equal(compareDriveProviderRevisions('42', '42'), 0);
  assert.equal(compareDriveProviderRevisions('99999999999999999999', '100000000000000000000'), -1);
  assert.throws(() => normalizeDriveProviderRevision('v42'), error => error.code === 'INVALID_VERSION');
});

test('L2-A stable read accepts one revision and returns only deterministic scalar envelope', async () => {
  const metadata = [
    { id: 'file_abcdef', version: '41', mimeType: 'text/plain' },
    { id: 'file_abcdef', version: '41', mimeType: 'text/plain' },
  ];
  let index = 0;
  const provider = new DriveScalarProviderV1({
    readMetadata: async () => metadata[index++],
    readContent: async () => '  5\n',
    sleepFn: async () => {},
  });
  assert.deepEqual(await provider.read({
    groupNodeId: 'manager:data',
    maxWorkers: 5,
    sourceId: 'file_abcdef',
  }), {
    providerId: DRIVE_SCALAR_PROVIDER_V1,
    groupNodeId: 'manager:data',
    sourceId: 'file_abcdef',
    providerRevision: '41',
    requestedSlotCount: 5,
    attempts: 1,
  });
});

test('L2-A unstable version retries and same scalar on a newer revision remains a new request identity', async () => {
  const reads = [
    { id: 'file_abcdef', version: '41', mimeType: 'text/plain' },
    { id: 'file_abcdef', version: '42', mimeType: 'text/plain' },
    { id: 'file_abcdef', version: '42', mimeType: 'text/plain' },
    { id: 'file_abcdef', version: '42', mimeType: 'text/plain' },
  ];
  let metadataIndex = 0;
  let sleeps = 0;
  const provider = new DriveScalarProviderV1({
    readMetadata: async () => reads[metadataIndex++],
    readContent: async () => '5',
    maxAttempts: 3,
    retryDelayMs: 1,
    sleepFn: async () => { sleeps += 1; },
  });
  const result = await provider.read({
    groupNodeId: 'manager:data',
    maxWorkers: 5,
    sourceId: 'file_abcdef',
  });
  assert.equal(result.providerRevision, '42');
  assert.equal(result.requestedSlotCount, 5);
  assert.equal(result.attempts, 2);
  assert.equal(sleeps, 1);
});

test('L2-A never accepts a continuously changing Drive revision', async () => {
  let version = 40;
  const provider = new DriveScalarProviderV1({
    readMetadata: async () => ({ id: 'file_abcdef', version: String(++version), mimeType: 'text/plain' }),
    readContent: async () => '3',
    maxAttempts: 2,
    retryDelayMs: 0,
    sleepFn: async () => {},
  });
  await assert.rejects(
    () => provider.read({ groupNodeId: 'manager:data', maxWorkers: 5, sourceId: 'file_abcdef' }),
    error => error instanceof DriveScalarProviderError && error.code === 'VERSION_RACE',
  );
});

test('L2-A Drive source identity changing mid-read fails closed', async () => {
  let call = 0;
  const provider = new DriveScalarProviderV1({
    readMetadata: async () => call++ === 0
      ? { id: 'file_abcdef', version: '7', mimeType: 'text/plain' }
      : { id: 'file_other', version: '7', mimeType: 'text/plain' },
    readContent: async () => '2',
  });
  await assert.rejects(
    () => provider.read({ groupNodeId: 'manager:data', maxWorkers: 5, sourceId: 'file_abcdef' }),
    error => error.code === 'FILE_ID_CHANGED',
  );
});

test('L2-A extracts only explicit Google Docs/Drive source ids', () => {
  assert.equal(extractGoogleDriveScalarSourceId('file_abcdef'), 'file_abcdef');
  assert.equal(
    extractGoogleDriveScalarSourceId('https://docs.google.com/document/d/file_abcdef/edit'),
    'file_abcdef',
  );
  assert.equal(
    extractGoogleDriveScalarSourceId('https://drive.google.com/file/d/file_abcdef/view'),
    'file_abcdef',
  );
  assert.throws(
    () => extractGoogleDriveScalarSourceId('https://example.com/file_abcdef'),
    error => error.code === 'INVALID_SOURCE',
  );
});

function response({ status = 200, json = null, text = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(json); },
    async text() { return text; },
  };
}

test('L2-A Google Drive reader uses bearer only at the execution boundary and supports Docs export', async () => {
  const calls = [];
  let tokenCalls = 0;
  const reader = createGoogleDriveScalarReader({
    fileId: 'https://docs.google.com/document/d/file_abcdef/edit',
    getAccessToken: async () => { tokenCalls += 1; return 'secret-token-not-stored'; },
    fetchFn: async (url, options) => {
      calls.push({ url, authorization: options?.headers?.Authorization });
      if (url.includes('/export?')) return response({ text: '4' });
      return response({ json: { id: 'file_abcdef', version: '9', mimeType: 'application/vnd.google-apps.document' } });
    },
  });

  const provider = new DriveScalarProviderV1({
    readMetadata: reader.readMetadata,
    readContent: reader.readContent,
  });
  const result = await provider.read({
    groupNodeId: 'manager:data',
    maxWorkers: 5,
    sourceId: reader.sourceId,
  });

  assert.equal(result.providerRevision, '9');
  assert.equal(result.requestedSlotCount, 4);
  assert.equal(tokenCalls, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls.every(call => call.authorization === 'Bearer secret-token-not-stored'), true);
  assert.equal(JSON.stringify(result).includes('secret-token-not-stored'), false);
});

test('L2-A Google Drive reader fails closed on auth and unsupported MIME', async () => {
  const noAuthReader = createGoogleDriveScalarReader({
    fileId: 'file_abcdef',
    getAccessToken: async () => '',
    fetchFn: async () => { throw new Error('must not fetch'); },
  });
  await assert.rejects(() => noAuthReader.readMetadata(), error => error.code === 'AUTH_REQUIRED');

  const unsupported = createGoogleDriveScalarReader({
    fileId: 'file_abcdef',
    getAccessToken: async () => 'token',
    fetchFn: async () => response({ json: { id: 'file_abcdef', version: '1', mimeType: 'application/pdf' } }),
  });
  const meta = await unsupported.readMetadata();
  await assert.rejects(
    () => unsupported.readContent({ metadata: meta }),
    error => error.code === 'UNSUPPORTED_MIME',
  );
});
