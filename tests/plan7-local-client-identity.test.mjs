import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutopilotLocalClientV1 } from '../companion/local-api/client.mjs';

const BASE = Object.freeze({
  schemaVersion: 1, requestId: 'request-1', principalId: 'owner-1',
  projectId: 'project-1', operation: 'STATUS_GET', targetId: 'agent-1',
  payloadArtifactRef: null, requestedAt: '2026-10-08T10:00:00.000Z',
});

function transportResponse(requestChanges = {}, receiptChanges = {}) {
  return {
    schemaVersion: 1, status: 'RECEIVED',
    result: {
      request: { ...BASE, ...requestChanges },
      scopeProof: {
        schemaVersion: 1, scopeRevisionId: 'scope-rev-1',
        requestId: BASE.requestId, principalId: BASE.principalId,
        projectId: BASE.projectId, operation: BASE.operation,
        targetId: BASE.targetId, payloadArtifactId: null, payloadSha256: null,
        allowed: true, verifiedAt: '2026-10-08T10:00:00.000Z',
        validThrough: '2026-10-08T10:00:03.000Z',
      },
      assessedAt: '2026-10-08T10:00:00.100Z',
      dispatchAt: '2026-10-08T10:00:00.200Z',
      completedAt: '2026-10-08T10:00:01.500Z',
      receipt: {
        schemaVersion: 1, requestId: BASE.requestId, projectId: BASE.projectId,
        operation: BASE.operation, status: 'COMPLETED',
        dispatchId: 'dispatch-1', observedAt: '2026-10-08T10:00:01.000Z',
        resultArtifactRef: null,
        ...receiptChanges,
      },
      adapterGrantsAuthority: false, executionAuthorized: false,
      schedulerAuthority: false, policyDecisionAuthorized: false,
      exactEffectAuthority: false, storeMutationAuthority: false,
    },
  };
}

async function attempt(response) {
  let invocations = 0;
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345,
    fetchImpl: async () => {
      invocations += 1;
      return { ok: true, json: async () => response };
    },
  });
  const result = await client.control(BASE);
  assert.equal(invocations, 1, 'client cannot retry ambiguous external requests');
  return result;
}

for (const [field, value] of [
  ['projectId', 'foreign-project'],
  ['principalId', 'foreign-owner'],
  ['operation', 'AGENT_STOP'],
  ['targetId', 'foreign-job'],
  ['requestedAt', '2026-10-08T11:00:00.000Z'],
]) {
  test('same requestId cannot accept a different ' + field, async () => {
    assert.equal((await attempt(transportResponse({ [field]: value }))).status,
      'UNKNOWN_NETWORK_RESULT');
  });
}

test('receipt cannot be for another project/operation or absent', async () => {
  for (const change of [{ projectId: 'foreign-project' }, { operation: 'AGENT_STOP' }]) {
    assert.equal((await attempt(transportResponse({}, change))).status,
      'UNKNOWN_NETWORK_RESULT');
  }
  const missing = transportResponse();
  delete missing.result.receipt;
  assert.equal((await attempt(missing)).status, 'UNKNOWN_NETWORK_RESULT');
});

test('reply cannot manufacture execution/policy authority', async () => {
  for (const field of ['adapterGrantsAuthority', 'executionAuthorized',
    'schedulerAuthority', 'policyDecisionAuthorized', 'exactEffectAuthority']) {
    const malicious = transportResponse();
    malicious.result[field] = true;
    assert.equal((await attempt(malicious)).status, 'UNKNOWN_NETWORK_RESULT');
  }
});

test('valid bound receipt remains transport RECEIVED, never proof of effect', async () => {
  const result = await attempt(transportResponse());
  assert.equal(result.status, 'RECEIVED');
  assert.equal(result.result.receipt.status, 'COMPLETED');
  assert.equal(result.result.executionAuthorized, false);
});

test('payload reference needs exact size, sensitivity, provenance, and digest', async () => {
  const artifact = {
    schemaVersion: 1, artifactId: 'artifact-1', kind: 'programmatic-control-payload',
    uri: 'artifact://artifact-1', mediaType: 'application/json', sha256: 'a'.repeat(64),
    sizeBytes: 10, createdAt: '2026-10-08T09:00:00.000Z',
    producerInvocationId: 'invocation-1', sensitive: true,
  };
  const request = { ...BASE, operation: 'OUTCOME_SUBMIT', payloadArtifactRef: artifact };
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345,
    fetchImpl: async () => ({
      ok: true, json: async () => {
        const malicious = transportResponse({
          operation: request.operation, payloadArtifactRef: { ...artifact, sensitive: false },
        }, { operation: request.operation });
        return malicious;
      },
    }),
  });
  assert.equal((await client.control(request)).status, 'UNKNOWN_NETWORK_RESULT');
});


test('response identity is bound to serialized wire bytes despite caller TOCTOU mutation', async () => {
  const request = { ...BASE };
  let sentProject = null, invocations = 0;
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345,
    fetchImpl: async (_, options) => {
      invocations += 1;
      sentProject = JSON.parse(options.body).projectId;
      request.projectId = 'foreign-project';
      return { ok: true, json: async () => transportResponse({ projectId: 'foreign-project' },
        { projectId: 'foreign-project' }) };
    },
  });
  const result = await client.control(request);
  assert.equal(sentProject, BASE.projectId);
  assert.equal(result.status, 'UNKNOWN_NETWORK_RESULT');
  assert.equal(invocations, 1, 'uncertain effect must not be sent twice');
});

test('transport receipt cannot assert store mutation authority', async () => {
  for (const forged of [true, 'false', 1, null]) {
    const reply = transportResponse();
    reply.result.storeMutationAuthority = forged;
    assert.equal((await attempt(reply)).status, 'UNKNOWN_NETWORK_RESULT');
  }
  const missing = transportResponse();
  delete missing.result.storeMutationAuthority;
  assert.equal((await attempt(missing)).status, 'UNKNOWN_NETWORK_RESULT');
  const valid = await attempt(transportResponse());
  assert.equal(valid.status, 'RECEIVED');
  assert.equal(valid.result.storeMutationAuthority, false);
});

test('receipt must retain dispatch identity and causal UTC chronology', async () => {
  for (const corruption of [
    { dispatchId: null },
    { dispatchId: 1 },
    { dispatchId: '' },
    { dispatchId: 'bad dispatch id' },
    { dispatchId: 'X'.repeat(181) },
    { observedAt: null },
    { observedAt: '2026-10-08T10:00:01' },
    { observedAt: '2026-10-08T10:00:01+00:00' },
    { observedAt: '2026-10-08T09:59:59.999Z' },
    { observedAt: '2026-02-30T10:00:01.000Z' },
  ]) {
    assert.equal((await attempt(transportResponse({}, corruption))).status,
      'UNKNOWN_NETWORK_RESULT', 'invalid dispatch receipt cannot prove transport success');
  }
  const missingId = transportResponse();
  delete missingId.result.receipt.dispatchId;
  assert.equal((await attempt(missingId)).status, 'UNKNOWN_NETWORK_RESULT');
  const missingObservedAt = transportResponse();
  delete missingObservedAt.result.receipt.observedAt;
  assert.equal((await attempt(missingObservedAt)).status, 'UNKNOWN_NETWORK_RESULT');
  assert.equal((await attempt(transportResponse())).status, 'RECEIVED');
});


test('transport cannot promote a denied, foreign or missing Core scope proof', async () => {
  const variants = [
    { allowed: false }, { allowed: 'true' }, { principalId: 'other-owner' },
    { projectId: 'other-project' }, { requestId: 'other-request' },
    { operation: 'AGENT_STOP' }, { targetId: 'other-target' },
    { payloadArtifactId: 'other-artifact' }, { payloadSha256: 'a'.repeat(64) },
    { scopeRevisionId: 'invalid revision with spaces' },
  ];
  for (const variant of variants) {
    const forged = transportResponse();
    Object.assign(forged.result.scopeProof, variant);
    assert.equal((await attempt(forged)).status, 'UNKNOWN_NETWORK_RESULT');
  }
  const missing = transportResponse();
  delete missing.result.scopeProof;
  assert.equal((await attempt(missing)).status, 'UNKNOWN_NETWORK_RESULT');
  assert.equal((await attempt(transportResponse())).status, 'RECEIVED');
});

test('transport receipt chronology cannot outrun or predate canonical Core stages', async () => {
  const variants = [
    ['scopeProof', 'verifiedAt', '2026-10-08T10:00:00.500Z'],
    ['scopeProof', 'validThrough', '2026-10-08T10:00:00.199Z'],
    ['result', 'dispatchAt', '2026-10-08T09:59:59.000Z'],
    ['result', 'completedAt', '2026-10-08T10:00:00.999Z'],
    ['result', 'assessedAt', '2026-10-08T10:00:01.000Z'],
    ['result', 'completedAt', '2026-10-08T10:00:01+00:00'],
  ];
  for (const [part, field, value] of variants) {
    const forged = transportResponse();
    if (part === 'scopeProof') forged.result.scopeProof[field] = value;
    else forged.result[field] = value;
    assert.equal((await attempt(forged)).status, 'UNKNOWN_NETWORK_RESULT');
  }
});

test('result artifact requires exact canonical Core provenance before RECEIVED', async () => {
  const ref = {
    schemaVersion: 1, artifactId: 'result-artifact-1', kind: 'result',
    uri: 'artifact://result-artifact-1', mediaType: 'application/json',
    sha256: 'a'.repeat(64), sizeBytes: 12,
    createdAt: '2026-10-08T10:00:00.900Z',
    producerInvocationId: 'invocation-1', sensitive: true,
  };
  const good = transportResponse({}, { resultArtifactRef: ref });
  assert.equal((await attempt(good)).status, 'RECEIVED');
  for (const corrupted of [
    { ...ref, sha256: 'NOT_A_DIGEST' },
    { ...ref, sensitive: 'true' },
    { ...ref, createdAt: '2026-10-08T10:00:01.500Z' },
    { ...ref, sizeBytes: -1 },
    { ...ref, privateSecret: 'DO_NOT_DISCLOSE' },
    Object.fromEntries(Object.entries(ref).filter(([key]) => key !== 'artifactId')),
  ]) {
    assert.equal((await attempt(transportResponse({}, { resultArtifactRef: corrupted }))).status,
      'UNKNOWN_NETWORK_RESULT', 'forged result artifact must not be trusted');
  }
  const omitted = transportResponse();
  delete omitted.result.receipt.resultArtifactRef;
  assert.equal((await attempt(omitted)).status, 'UNKNOWN_NETWORK_RESULT');
});

test('SDK validates canonical Core request before opening transport, without executing getters', async () => {
  let getterCalls = 0, networkCalls = 0;
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345,
    fetchImpl: async () => { networkCalls++; throw new Error('unreachable transport'); },
  });
  const malformed = [
    { ...BASE, operation: 'FORGED_EFFECT' },
    { ...BASE, requestedAt: '2026-10-08T10:00:00+00:00' },
    { ...BASE, targetId: 'agent 1' },
    { ...BASE, credential: 'SHOULD_NOT_LEAVE_PROCESS' },
    { ...BASE, payloadArtifactRef: { secret: 'SHOULD_NOT_LEAVE_PROCESS' } },
    { ...BASE, projectId: null },
  ];
  const getterRequest = { ...BASE };
  Object.defineProperty(getterRequest, 'principalId', {
    enumerable: true, get() { getterCalls++; return BASE.principalId; },
  });
  malformed.push(getterRequest);
  const symbolRequest = { ...BASE };
  symbolRequest[Symbol('hiddenCredential')] = 'SHOULD_NOT_LEAVE_PROCESS';
  malformed.push(symbolRequest);
  for (const input of malformed) {
    await assert.rejects(() => client.control(input));
  }
  assert.equal(getterCalls, 0, 'SDK must not execute hostile request accessors');
  assert.equal(networkCalls, 0, 'invalid request must never enter transport');
});

test('SDK serializes only canonical request fields and preserves wire-bound identity', async () => {
  const seen = [];
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345,
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body));
      return { ok: true, json: async () => transportResponse() };
    },
  });
  const request = { ...BASE };
  const reply = await client.control(request);
  assert.equal(reply.status, 'RECEIVED');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], BASE);
  assert.equal(Object.hasOwn(seen[0], 'authorization'), false);
});
