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
    writeExistingText: async payload => ({ ...payload, sha256: digest(payload.text), alreadyApplied: false }),
    ...overrides,
  };
}

test('filesystem provider registers read/search/write tools and enforces invocation-bound owner policy', async () => {
  const calls = [];
  const provider = new FilesystemAgentProviderV1({
    nativeClient: nativeClient({
      searchFiles: async payload => { calls.push(payload); return { items: ['docs/a.txt'], truncated: false }; },
    }),
    grantedCapabilityIds: ['filesystem.search'],
    now: () => Date.parse(at),
  });
  assert.equal(provider.tools().length, 3);
  assert.equal(provider.tools().find(tool => tool.toolId === FilesystemToolId.WRITE_EXISTING_TEXT).readOnly, false);
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
