import test from 'node:test';
import assert from 'node:assert/strict';

import { buildThreeLevelHierarchyTemplate } from '../../src/core/orchestration-role-prompts.js';

import {
  DRIVE_FILE_SCOPE,
  DRIVE_SCALAR_PROVIDER_V1,
  DriveScalarProviderError,
  DriveScalarProviderV1,
  compareDriveProviderRevisions,
  createGoogleDriveScalarReader,
  extractGoogleDriveScalarSourceId,
  getChromeDriveAccessToken,
  inspectChromeDriveOAuth,
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


test('L2-A Chrome OAuth boundary fails closed until a real drive.file client is deployed', async () => {
  assert.deepEqual(inspectChromeDriveOAuth({}), {
    configured: false,
    clientIdPresent: false,
    driveFileScopePresent: false,
  });

  let authCalls = 0;
  const chromeApi = {
    runtime: { getManifest: () => ({ manifest_version: 3 }) },
    identity: { async getAuthToken() { authCalls += 1; return { token: 'must-not-be-called' }; } },
  };
  await assert.rejects(
    () => getChromeDriveAccessToken(chromeApi, { interactive: true }),
    error => error.code === 'OAUTH_NOT_CONFIGURED',
  );
  assert.equal(authCalls, 0, 'missing OAuth deployment must fail before Chrome auth is invoked');

  const configured = {
    runtime: {
      getManifest: () => ({
        oauth2: { client_id: 'real-client-id.apps.googleusercontent.com', scopes: [DRIVE_FILE_SCOPE] },
      }),
    },
    identity: {
      async getAuthToken(options) {
        authCalls += 1;
        assert.equal(options.interactive, false);
        return { token: 'transient-token' };
      },
    },
  };
  assert.equal(inspectChromeDriveOAuth(configured.runtime.getManifest()).configured, true);
  assert.equal(await getChromeDriveAccessToken(configured, { interactive: false }), 'transient-token');
  assert.equal(authCalls, 1);
});

test('L2-A owner template binds Drive only to the exact configured Manager and local slot maximum', () => {
  const graph = buildThreeLevelHierarchyTemplate({
    graphId: 'drive-template',
    projectId: 'project',
    targetRepository: 'owner/repo',
    domains: [
      { id: 'runtime', scope: 'Runtime.' },
      { id: 'science', scope: 'Science.' },
    ],
    workersPerManager: 4,
    driveScalarSources: {
      runtime: 'https://docs.google.com/document/d/file_abcdef/edit',
    },
    driveScalarPollIntervalMs: 120000,
  });

  const runtimeManager = graph.nodesById['manager:runtime'];
  const scienceManager = graph.nodesById['manager:science'];
  assert.deepEqual(runtimeManager.providerBinding, {
    providerId: DRIVE_SCALAR_PROVIDER_V1,
    groupNodeId: 'manager:runtime',
    maxSlots: 4,
    sourceId: 'file_abcdef',
    pollIntervalMs: 120000,
  });
  assert.equal(scienceManager.providerBinding, null);
  assert.equal(graph.nodesById['worker:runtime:01'].providerBinding, null);

  assert.throws(
    () => buildThreeLevelHierarchyTemplate({
      graphId: 'foreign-drive-template',
      projectId: 'project',
      targetRepository: 'owner/repo',
      domains: [{ id: 'runtime', scope: 'Runtime.' }],
      workersPerManager: 2,
      driveScalarSources: { science: 'file_abcdef' },
    }),
    /unknown domain science/,
  );
});


test('L2-A provider-bound Manager and recovery prompts carry the strict scalar publication contract', () => {
  const graph = buildThreeLevelHierarchyTemplate({
    graphId: 'drive-prompt-contract',
    projectId: 'project',
    targetRepository: 'owner/repo',
    domains: [{ id: 'runtime', scope: 'Runtime.' }],
    workersPerManager: 3,
    driveScalarSources: { runtime: 'file_abcdef' },
  });
  const manager = graph.nodesById['manager:runtime'];
  const primary = graph.promptProfiles.find(profile => profile.id === manager.promptProfileId)?.prompt || '';
  const recovery = graph.promptProfiles.find(profile => profile.id === manager.recoveryPromptProfileId)?.prompt || '';

  for (const prompt of [primary, recovery]) {
    assert.match(prompt, /DETERMINISTIC CHILD-SLOT PROVIDER/);
    assert.match(prompt, /PROVIDER_ID=drive-scalar-v1/);
    assert.match(prompt, /PROVIDER_SOURCE_ID=file_abcdef/);
    assert.match(prompt, /MAX_CHILD_SLOTS=3/);
    assert.match(prompt, /entire file content MUST be exactly one decimal integer/);
    assert.match(prompt, /Every new Drive file revision\/version is a distinct activation request/);
    assert.match(prompt, /Use 0 when this round needs no child activation/);
    assert.match(prompt, /cannot change hierarchy, child identities, parent ownership, maximum slots/);
  }

  const worker = graph.nodesById['worker:runtime:01'];
  const workerPrompt = graph.promptProfiles.find(profile => profile.id === worker.promptProfileId)?.prompt || '';
  assert.doesNotMatch(workerPrompt, /DETERMINISTIC CHILD-SLOT PROVIDER/);
  assert.doesNotMatch(workerPrompt, /PROVIDER_SOURCE_ID=/);
});
