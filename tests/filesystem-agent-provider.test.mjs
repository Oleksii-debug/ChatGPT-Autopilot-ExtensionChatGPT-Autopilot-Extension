import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  FILESYSTEM_PROVIDER_ID,
  FilesystemAgentProviderV1,
  FilesystemToolId,
} from '../src/core/filesystem-agent-provider.js';

const at = '2026-09-24T16:00:00.000Z';
function digest(value) { return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex'); }
function artifactRef(text = 'x') {
  return {
    schemaVersion: 1,
    artifactId: 'artifact-write-1',
    kind: 'text',
    uri: 'artifact://write-1',
    mediaType: 'text/plain',
    sha256: digest(text),
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    createdAt: at,
    producerInvocationId: null,
    sensitive: false,
  };
}
function invocation(toolId, capabilityId, args = {}, id = 'fs-inv-1') {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId,
    providerId: FILESYSTEM_PROVIDER_ID,
    requestedCapabilityIds: [capabilityId],
    policyDecisionId: `decision-${id}`,
    arguments: args,
    createdAt: at,
    parentInvocationId: null,
  };
}
function allow(id = 'fs-inv-1') {
  return {
    schemaVersion: 1,
    decisionId: `decision-${id}`,
    invocationId: id,
    decision: 'ALLOW',
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: at,
  };
}

function nativeClient(overrides = {}) {
  return {
    readText: async payload => ({ ...payload, text: 'hello' }),
    searchFiles: async payload => ({ ...payload, items: ['docs/a.txt'], truncated: false }),
    listFiles: async payload => ({ ...payload, items: [], visitedEntries: 0, truncated: false }),
    statPath: async payload => ({ ...payload, kind: 'FILE', sizeBytes: 1, modifiedAt: at, hashed: false, sha256: '' }),
    writeExistingText: async payload => ({ ...payload, sha256: digest(payload.text), alreadyApplied: false }),
    ...overrides,
  };
}

test('filesystem provider advertises only executable read/search/list/stat tools while retaining hidden write recovery contract', async () => {
  const calls = [];
  const client = nativeClient({
    searchFiles: async payload => { calls.push(payload); return { items: ['docs/a.txt'], truncated: false }; },
  });
  delete client.writeExistingText;
  const provider = new FilesystemAgentProviderV1({
    nativeClient: client,
    grantedCapabilityIds: ['filesystem.search'],
    now: () => Date.parse(at),
  });
  assert.equal(provider.tools().length, 4);
  assert.deepEqual(provider.tools().map(tool => tool.toolId), [
    FilesystemToolId.READ_TEXT,
    FilesystemToolId.SEARCH,
    FilesystemToolId.LIST,
    FilesystemToolId.STAT,
  ]);
  assert.equal(provider.tools().some(tool => tool.toolId === FilesystemToolId.WRITE_EXISTING_TEXT), false);
  const inv = invocation(FilesystemToolId.SEARCH, 'filesystem.search', { rootId: 'workspace', query: 'a' });
  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: { ...allow(), decision: 'DENY' } }), /not authorized/);
  const result = await provider.invoke({ invocation: inv, policyDecision: allow() });
  assert.equal(result.providerId, FILESYSTEM_PROVIDER_ID);
  assert.deepEqual(calls, [{ rootId: 'workspace', query: 'a' }]);
});

test('write invocation persists only ArtifactRef identity while resolver supplies transient content', async () => {
  const calls = [];
  const ref = artifactRef('x');
  const provider = new FilesystemAgentProviderV1({
    nativeClient: nativeClient({ writeExistingText: async payload => { calls.push(structuredClone(payload)); return { sha256: digest(payload.text), alreadyApplied: false }; } }),
    resolveArtifactText: async resolvedRef => {
      assert.equal(resolvedRef.artifactId, ref.artifactId);
      return 'x';
    },
    grantedCapabilityIds: ['filesystem.writeExistingText'],
  });
  const inv = invocation(FilesystemToolId.WRITE_EXISTING_TEXT, 'filesystem.writeExistingText', {
    rootId: 'workspace', relativePath: 'a.txt', contentArtifactRef: ref, expectedSha256: 'b'.repeat(64),
  });
  const result = await provider.invoke({ invocation: inv, policyDecision: allow() });
  assert.equal(result.result.sha256, digest('x'));
  assert.deepEqual(calls, [{ rootId: 'workspace', relativePath: 'a.txt', text: 'x', expectedSha256: 'b'.repeat(64) }]);
  assert.equal(JSON.stringify(inv).includes('"text":"x"'), false);
});

test('effectful filesystem transport uncertainty is not retry-safe while known pre-effect rejection is retry-safe', async () => {
  const transport = Object.assign(new Error('native port closed'), { code: 'NATIVE_TRANSPORT_ERROR' });
  const common = {
    nativeClient: nativeClient({ writeExistingText: async () => { throw transport; } }),
    resolveArtifactText: async () => 'x',
    grantedCapabilityIds: ['filesystem.writeExistingText'],
  };
  const uncertain = new FilesystemAgentProviderV1(common);
  const inv = invocation(FilesystemToolId.WRITE_EXISTING_TEXT, 'filesystem.writeExistingText', {
    rootId: 'workspace', relativePath: 'a.txt', contentArtifactRef: artifactRef('x'), expectedSha256: 'b'.repeat(64),
  });
  await assert.rejects(() => uncertain.invoke({ invocation: inv, policyDecision: allow() }), error => {
    assert.equal(error.effectMayHaveOccurred, true);
    assert.equal(error.safeToRetry, false);
    return true;
  });

  const denied = Object.assign(new Error('root is read only'), { code: 'ROOT_NOT_WRITABLE' });
  const preEffect = new FilesystemAgentProviderV1({
    ...common,
    nativeClient: nativeClient({ writeExistingText: async () => { throw denied; } }),
  });
  await assert.rejects(() => preEffect.invoke({ invocation: inv, policyDecision: allow() }), error => {
    assert.equal(error.effectMayHaveOccurred, false);
    assert.equal(error.safeToRetry, true);
    assert.equal(error.code, 'ROOT_NOT_WRITABLE');
    return true;
  });
});

test('artifact resolver mismatch fails before Native Companion mutation', async () => {
  let calls = 0;
  const provider = new FilesystemAgentProviderV1({
    nativeClient: nativeClient({ writeExistingText: async () => { calls += 1; return {}; } }),
    resolveArtifactText: async () => 'tampered',
    grantedCapabilityIds: ['filesystem.writeExistingText'],
  });
  const inv = invocation(FilesystemToolId.WRITE_EXISTING_TEXT, 'filesystem.writeExistingText', {
    rootId: 'workspace', relativePath: 'a.txt', contentArtifactRef: artifactRef('x'), expectedSha256: 'b'.repeat(64),
  });
  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: allow() }), error => {
    assert.equal(error.code, 'ARTIFACT_CONTENT_INVALID');
    assert.equal(error.effectMayHaveOccurred, false);
    return true;
  });
  assert.equal(calls, 0);
});


test('unavailable atomic filesystem publication is classified as a pre-effect failure', async () => {
  let calls = 0;
  const unavailable = Object.assign(new Error('parent-bound publication unavailable'), { code: 'ATOMIC_WRITE_UNAVAILABLE' });
  const provider = new FilesystemAgentProviderV1({
    nativeClient: nativeClient({
      writeExistingText: async () => { calls += 1; throw unavailable; },
    }),
    resolveArtifactText: async () => 'x',
    grantedCapabilityIds: ['filesystem.writeExistingText'],
  });
  const inv = invocation(FilesystemToolId.WRITE_EXISTING_TEXT, 'filesystem.writeExistingText', {
    rootId: 'workspace',
    relativePath: 'a.txt',
    contentArtifactRef: artifactRef('x'),
    expectedSha256: 'b'.repeat(64),
  });

  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: allow() }), error => {
    assert.equal(error.code, 'ATOMIC_WRITE_UNAVAILABLE');
    assert.equal(error.effectMayHaveOccurred, false);
    assert.equal(error.safeToRetry, true);
    return true;
  });
  assert.equal(calls, 1);
});

test('read-only filesystem list/stat dispatch through canonical policy authorization', async () => {
  const calls = [];
  const provider = new FilesystemAgentProviderV1({
    nativeClient: nativeClient({
      listFiles: async payload => {
        calls.push(['list', structuredClone(payload)]);
        return { rootId: payload.rootId, relativePath: payload.relativePath, items: [], visitedEntries: 0, truncated: false };
      },
      statPath: async payload => {
        calls.push(['stat', structuredClone(payload)]);
        return { rootId: payload.rootId, relativePath: payload.relativePath, kind: 'FILE', sizeBytes: 3, modifiedAt: at, hashed: true, sha256: digest('abc') };
      },
    }),
    grantedCapabilityIds: ['filesystem.list', 'filesystem.stat'],
    now: () => Date.parse(at),
  });
  const listInvocation = invocation(
    FilesystemToolId.LIST,
    'filesystem.list',
    { rootId: 'workspace', relativePath: '.', maxEntries: 10 },
    'fs-list-1',
  );
  const statInvocation = invocation(
    FilesystemToolId.STAT,
    'filesystem.stat',
    { rootId: 'workspace', relativePath: 'a.txt', hash: true, maxHashBytes: 1024 },
    'fs-stat-1',
  );
  const listed = await provider.invoke({ invocation: listInvocation, policyDecision: allow('fs-list-1') });
  const stated = await provider.invoke({ invocation: statInvocation, policyDecision: allow('fs-stat-1') });
  assert.equal(listed.result.truncated, false);
  assert.equal(stated.result.sha256, digest('abc'));
  assert.deepEqual(calls, [
    ['list', { rootId: 'workspace', relativePath: '.', maxEntries: 10 }],
    ['stat', { rootId: 'workspace', relativePath: 'a.txt', hash: true, maxHashBytes: 1024 }],
  ]);
  await assert.rejects(
    () => provider.invoke({
      invocation: listInvocation,
      policyDecision: { ...allow('fs-list-1'), decision: 'DENY' },
    }),
    /not authorized/u,
  );
});
