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
      schemaVersion: 1, readOnly: true, downstreamAuthorityRequired: false,
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
      return { ok: true, status: 200, json: async () => response };
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
      ok: true, status: 200, json: async () => {
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
      return { ok: true, status: 200, json: async () => transportResponse({ projectId: 'foreign-project' },
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
      return { ok: true, status: 200, json: async () => transportResponse() };
    },
  });
  const request = { ...BASE };
  const reply = await client.control(request);
  assert.equal(reply.status, 'RECEIVED');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], BASE);
  assert.equal(Object.hasOwn(seen[0], 'authorization'), false);
});

test('payload receipt rejects extra, symbol and accessor fields without reading untrusted values', async () => {
  const artifact = {
    schemaVersion: 1, artifactId: 'payload-a', kind: 'programmatic-control-payload',
    uri: 'artifact://payload-a', mediaType: 'application/json',
    sha256: 'a'.repeat(64), sizeBytes: 12,
    createdAt: '2026-10-08T09:00:00.000Z',
    producerInvocationId: 'producer-a', sensitive: false,
  };
  const original = { ...BASE, operation: 'OUTCOME_SUBMIT', targetId: 'outcome-a', payloadArtifactRef: artifact };
  let getterCalls = 0, networkCalls = 0;
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345,
    fetchImpl: async () => {
      networkCalls += 1;
      return { ok: true, status: 200, json: async () => {
        const reply = transportResponse({ operation: original.operation, targetId: original.targetId,
          payloadArtifactRef: { ...artifact } }, { operation: original.operation });
        Object.assign(reply.result.scopeProof, {
          operation: original.operation, targetId: original.targetId,
          payloadArtifactId: artifact.artifactId, payloadSha256: artifact.sha256,
        });
        // OUTCOME_SUBMIT is consequential; its transport acknowledgement
        // must preserve Core's non-read-only, downstream-authority contract.
        reply.result.readOnly = false;
        reply.result.downstreamAuthorityRequired = true;
        return reply;
      }};
    },
  });
  const good = await client.control(original);
  assert.equal(good.status, 'RECEIVED', 'ordinary canonical payload remains compatible');
  for (const shape of ['extra', 'symbol', 'getter', 'nonenumerable']) {
    const reply = transportResponse({ operation: original.operation, targetId: original.targetId,
      payloadArtifactRef: { ...artifact } }, { operation: original.operation });
    Object.assign(reply.result.scopeProof, {
      operation: original.operation, targetId: original.targetId,
      payloadArtifactId: artifact.artifactId, payloadSha256: artifact.sha256,
    });
    // Negative cases must differ ONLY by their hostile ArtifactRef shape.
    reply.result.readOnly = false;
    reply.result.downstreamAuthorityRequired = true;
    const ref = reply.result.request.payloadArtifactRef;
    if (shape === 'extra') ref.privateToken = 'MUST_NOT_LEAK';
    if (shape === 'symbol') ref[Symbol('secret')] = 'MUST_NOT_LEAK';
    if (shape === 'getter') Object.defineProperty(ref, 'sensitive', {
      enumerable: true, get() { getterCalls++; return false; },
    });
    if (shape === 'nonenumerable') Object.defineProperty(ref, 'unexpected', {
      enumerable: false, value: 'MUST_NOT_LEAK',
    });
    const attempt = createAutopilotLocalClientV1({
      token: 'test-only-'.repeat(5), port: 12345,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => reply }),
    });
    const result = await attempt.control(original);
    assert.equal(result.status, 'UNKNOWN_NETWORK_RESULT', shape);
    assert.equal(JSON.stringify(result).includes('MUST_NOT_LEAK'), false);
  }
  assert.equal(networkCalls, 1);
  assert.equal(getterCalls, 0);
});


test('SDK captures nested transport Proxy descriptors without executing get traps', async () => {
  let gets = 0;
  const proxy = value => new Proxy(value, { get() { gets++; throw Error('SECRET_GET_TRAP'); } });
  const envelope = transportResponse();
  envelope.result.request = proxy(envelope.result.request);
  envelope.result.scopeProof = proxy(envelope.result.scopeProof);
  envelope.result.receipt = proxy(envelope.result.receipt);
  envelope.result = proxy(envelope.result);
  // The outer JSON result is ordinary transport data. Awaiting a top-level
  // Proxy would trigger the language-level thenable probe outside this SDK;
  // nested fields must still be snapshotted with zero untrusted property gets.
  const result = await attempt(envelope);
  assert.equal(result.status, 'RECEIVED');
  assert.equal(gets, 0);
  assert.equal(Object.isFrozen(result.result.receipt), true);
  assert.equal(Object.isFrozen(result.result.request), true);
});

test('SDK snapshots nested result ArtifactRef Proxy without property gets', async () => {
  let gets = 0;
  const envelope = transportResponse();
  envelope.result.receipt.resultArtifactRef = new Proxy({
    schemaVersion: 1, artifactId: 'result-artifact-1', kind: 'result',
    uri: 'artifact://result-artifact-1', mediaType: 'application/json',
    sha256: 'a'.repeat(64), sizeBytes: 10,
    createdAt: '2026-10-08T10:00:00.900Z',
    producerInvocationId: 'producer-1', sensitive: true,
  }, { get() { gets++; throw Error('SECRET_GET_TRAP'); } });
  const result = await attempt(envelope);
  assert.equal(result.status, 'RECEIVED');
  assert.equal(gets, 0);
  assert.equal(Object.isFrozen(result.result.receipt.resultArtifactRef), true);
});


test('SDK returns detached immutable transport receipts after successful validation', async () => {
  const wire = transportResponse();
  const accepted = await attempt(wire);
  assert.equal(accepted.status, 'RECEIVED');
  assert.equal(Object.isFrozen(accepted.result), true);
  assert.equal(Object.isFrozen(accepted.result.receipt), true);
  assert.equal(Object.isFrozen(accepted.result.scopeProof), true);
  wire.result.receipt.status = 'REJECTED';
  wire.result.scopeProof.allowed = false;
  assert.equal(accepted.result.receipt.status, 'COMPLETED');
  assert.equal(accepted.result.scopeProof.allowed, true);
});


test('SDK deadline refuses late transport completion even when fetch ignores AbortSignal', async () => {
  let calls = 0;
  let signal;
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345, timeoutMs: 100,
    fetchImpl: async (_url, options) => {
      calls += 1;
      signal = options.signal;
      return new Promise(resolve => setTimeout(
        () => resolve({ ok: true, status: 200, json: async () => transportResponse() }), 250,
      ));
    },
  });
  const reply = await client.control(BASE);
  assert.equal(reply.status, 'UNKNOWN_NETWORK_RESULT');
  assert.equal(signal.aborted, true, 'late uncooperative transport must be aborted');
  assert.equal(calls, 1, 'deadline must never resend an ambiguous request');
});

test('SDK deadline covers slow JSON body after early HTTP headers', async () => {
  let calls = 0;
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345, timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true, status: 200,
        json: () => new Promise(resolve => setTimeout(() => resolve(transportResponse()), 250)),
      };
    },
  });
  const reply = await client.control(BASE);
  assert.equal(reply.status, 'UNKNOWN_NETWORK_RESULT');
  assert.equal(calls, 1, 'response parsing must not trigger a second effect');
});

test('SDK treats throwing HTTP response metadata as ambiguous without credentials or resend', async () => {
  for (const property of ['ok', 'status']) {
    let calls = 0, reads = 0;
    const privateMessage = 'PRIVATE_HTTP_RESPONSE_DIAGNOSTIC';
    const response = { ok: false, status: 503 };
    Object.defineProperty(response, property, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(privateMessage);
      },
    });
    const client = createAutopilotLocalClientV1({
      token: 'test-only-'.repeat(5), port: 12345,
      fetchImpl: async () => {
        calls += 1;
        return response;
      },
    });
    const reply = await client.control(BASE);
    assert.equal(reply.status, 'UNKNOWN_NETWORK_RESULT', property);
    assert.equal(reply.instruction.includes('Reconcile'), true);
    assert.equal(calls, 1, property + ' must never cause blind resend');
    assert.equal(reads, 1, property + ' should be read at most once');
    assert.equal(JSON.stringify(reply).includes(privateMessage), false);
  }
});

test('SDK preserves safe HTTP error status but never treats it as zero-effect evidence', async () => {
  let calls = 0;
  const client = createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503 };
    },
  });
  const reply = await client.control(BASE);
  assert.equal(reply.status, 'UNKNOWN_NETWORK_RESULT');
  assert.equal(reply.httpStatus, 503);
  assert.equal(calls, 1);
});

test('SDK rejects noncanonical bearer characters at construction before any transport', () => {
  let networkCalls = 0;
  const attemptedFetch = async () => { networkCalls += 1; throw new Error('unexpected network'); };
  const invalidTokens = [
    'abc def'.repeat(7),
    'x'.repeat(32) + '\r',
    'x'.repeat(32) + '\n',
    '\t' + 'x'.repeat(40),
    'x'.repeat(32) + '\u0000',
    'x'.repeat(32) + 'é',
    'x'.repeat(32) + '\u2028',
    'x'.repeat(32) + '\u007f',
  ];
  for (const token of invalidTokens) {
    assert.throws(
      () => createAutopilotLocalClientV1({ token, port: 12345, fetchImpl: attemptedFetch }),
      /token/u,
      'SDK and Companion must enforce one exact bearer alphabet',
    );
  }
  assert.equal(networkCalls, 0, 'invalid credentials must not reach fetch or Core');
  assert.doesNotThrow(() => createAutopilotLocalClientV1({
    token: 'test-only-'.repeat(5), port: 12345, fetchImpl: attemptedFetch,
  }), 'existing valid Companion tokens remain compatible');
});

test('owner-managed SDK bearer rotates per call without caching stale credentials', async () => {
  let current = 'first-owner-token-'.repeat(3);
  let resolutions = 0;
  const sent = [];
  const client = createAutopilotLocalClientV1({
    tokenProvider: async () => { resolutions += 1; return current; },
    port: 12345,
    fetchImpl: async (_, options) => {
      sent.push(options.headers.Authorization);
      return { ok: true, status: 200, json: async () => transportResponse() };
    },
  });
  assert.equal((await client.control(BASE)).status, 'RECEIVED');
  current = 'rotated-owner-token-'.repeat(3);
  assert.equal((await client.control(BASE)).status, 'RECEIVED');
  assert.equal(resolutions, 2);
  assert.deepEqual(sent, [
    'Bearer ' + 'first-owner-token-'.repeat(3),
    'Bearer ' + 'rotated-owner-token-'.repeat(3),
  ]);
});

test('owner-token resolver fails closed before networking and recovers on next call', async () => {
  let value = null;
  let sent = 0;
  const client = createAutopilotLocalClientV1({
    tokenProvider: async () => value,
    port: 12345,
    fetchImpl: async () => {
      sent += 1;
      return { ok: true, status: 200, json: async () => transportResponse() };
    },
  });
  await assert.rejects(client.control(BASE), /owner token unavailable before transmission/u);
  assert.equal(sent, 0);
  value = 'new-owner-secret-'.repeat(3);
  assert.equal((await client.control(BASE)).status, 'RECEIVED');
  assert.equal(sent, 1);
  assert.throws(() => createAutopilotLocalClientV1({
    token: value, tokenProvider: () => value, port: 12345,
  }), /never both/u);
  assert.throws(() => createAutopilotLocalClientV1({
    tokenProvider: 'not-a-provider', port: 12345,
  }), /never both/u);
});

test('hung SDK owner-token lookup is bounded and cannot dispatch or become sticky', async () => {
  let hanging = true;
  let sent = 0;
  const client = createAutopilotLocalClientV1({
    tokenProvider: () => hanging
      ? new Promise(() => {}) : 'restored-owner-secret-'.repeat(3),
    port: 12345,
    timeoutMs: 100,
    fetchImpl: async () => {
      sent += 1;
      return { ok: true, status: 200, json: async () => transportResponse() };
    },
  });
  await assert.rejects(client.control(BASE), /owner token unavailable before transmission/u);
  assert.equal(sent, 0);
  hanging = false;
  assert.equal((await client.control(BASE)).status, 'RECEIVED');
  assert.equal(sent, 1);
});

test('SDK one total deadline includes owner-token lookup and retains safe recovery', async () => {
  const token = 'test-only-'.repeat(5);
  let slow = true;
  let calls = 0;
  let lastSignal;
  const client = createAutopilotLocalClientV1({
    tokenProvider: async () => {
      if (slow) await new Promise(resolve => setTimeout(resolve, 100));
      return token;
    },
    port: 12345,
    timeoutMs: 250,
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      lastSignal = signal;
      if (slow) await new Promise(resolve => setTimeout(resolve, 190));
      return { ok: true, status: 200, json: async () => transportResponse() };
    },
  });
  const late = await client.control(BASE);
  assert.equal(late.status, 'UNKNOWN_NETWORK_RESULT',
    'owner lookup must consume the same budget as network and receipt parsing');
  assert.equal(lastSignal.aborted, true,
    'late uncooperative transport must be aborted even after owner lookup');
  assert.equal(calls, 1, 'uncertain operation may never be retried automatically');
  slow = false;
  const recovered = await client.control(BASE);
  assert.equal(recovered.status, 'RECEIVED', 'fresh request after timeout recovers');
  assert.equal(recovered.result.receipt.status, 'COMPLETED');
  assert.equal(calls, 2);
});
