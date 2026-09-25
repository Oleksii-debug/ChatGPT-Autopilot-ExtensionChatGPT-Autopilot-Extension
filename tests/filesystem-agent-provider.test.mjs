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

test('filesystem provider advertises only executable read/search tools and enforces invocation-bound owner policy', async () => {
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
  assert.equal(provider.tools().length, 2);
  assert.deepEqual(provider.tools().map(tool => tool.toolId), [
    FilesystemToolId.READ_TEXT,
    FilesystemToolId.SEARCH,
  ]);
  assert.equal(provider.tools().some(tool => tool.toolId === FilesystemToolId.WRITE_EXISTING_TEXT), false);
  const inv = invocation(FilesystemToolId.SEARCH, 'filesystem.search', { rootId: 'workspace', query: 'a' });
  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: { ...allow(), decision: 'DENY' } }), /not authorized/);
  const result = await provider.invoke({ invocation: inv, policyDecision: allow() });
  assert.equal(result.providerId, FILESYSTEM_PROVIDER_ID);
  assert.deepEqual(calls, [{ rootId: 'workspace', query: 'a' }]);
});

test('unavailable filesystem write is not registered and cannot reach resolver or Native Companion', async () => {
  let resolverCalls = 0;
  let nativeCalls = 0;
  const provider = new FilesystemAgentProviderV1({
    nativeClient: nativeClient({
      writeExistingText: async () => { nativeCalls += 1; return {}; },
    }),
    resolveArtifactText: async () => { resolverCalls += 1; return 'x'; },
    grantedCapabilityIds: ['filesystem.writeExistingText'],
  });
  const inv = invocation(FilesystemToolId.WRITE_EXISTING_TEXT, 'filesystem.writeExistingText', {
    rootId: 'workspace',
    relativePath: 'a.txt',
    contentArtifactRef: artifactRef('x'),
    expectedSha256: 'b'.repeat(64),
  });
  await assert.rejects(
    () => provider.invoke({ invocation: inv, policyDecision: allow() }),
    /Filesystem tool is not registered/,
  );
  assert.equal(resolverCalls, 0);
  assert.equal(nativeCalls, 0);
});

