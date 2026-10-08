import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutopilotLocalClientV1 } from '../companion/local-api/client.mjs';

const TEST_TOKEN = 'fixture-only-local-credential-'.repeat(3);
function request(requestId) {
  return {
    schemaVersion: 1,
    requestId,
    principalId: 'owner-1',
    projectId: 'project-1',
    operation: 'STATUS_GET',
    targetId: 'agent-1',
    payloadArtifactRef: null,
    requestedAt: '2026-10-08T12:00:00.000Z',
  };
}

test('concurrent identical request IDs make one transport call, never a second effect', async () => {
  let calls = 0;
  let completeFirst;
  const client = createAutopilotLocalClientV1({
    token: TEST_TOKEN,
    port: 45678,
    fetchImpl: async () => {
      calls += 1;
      return new Promise(resolve => { completeFirst = resolve; });
    },
  });
  const first = client.control(request('same-request-1'));
  const duplicate = await client.control(request('same-request-1'));
  assert.equal(calls, 1);
  assert.equal(duplicate.schemaVersion, 1);
  assert.equal(duplicate.status, 'UNKNOWN_NETWORK_RESULT');
  assert.match(duplicate.instruction, /reconcile canonical job state before retrying/iu);
  completeFirst({ ok: false, status: 503 });
  const initial = await first;
  assert.equal(initial.status, 'UNKNOWN_NETWORK_RESULT');
  assert.equal(initial.httpStatus, 503);
});

test('distinct request IDs preserve parallelism but cannot become effect authority', async () => {
  const seen = [];
  const client = createAutopilotLocalClientV1({
    token: TEST_TOKEN,
    port: 45678,
    fetchImpl: async (_url, options) => {
      const sent = JSON.parse(options.body);
      seen.push(sent.requestId);
      return { ok: false, status: 503 };
    },
  });
  const results = await Promise.all([
    client.control(request('separate-1')),
    client.control(request('separate-2')),
  ]);
  assert.deepEqual(seen.sort(), ['separate-1', 'separate-2']);
  assert.deepEqual(results.map(x => x.status), [
    'UNKNOWN_NETWORK_RESULT', 'UNKNOWN_NETWORK_RESULT',
  ]);
});

test('unknown preflight fields fail before any local network transport', async () => {
  let calls = 0;
  const client = createAutopilotLocalClientV1({
    token: TEST_TOKEN,
    port: 45678,
    fetchImpl: async () => { calls += 1; throw new Error('unreachable'); },
  });
  await assert.rejects(
    client.control({ ...request('malformed-1'), secretFromCaller: 'DO_NOT_SEND' }),
  );
  assert.equal(calls, 0);
});

// The guard is intentionally only per SDK instance. It never claims to be
// durable across browser/process restart; canonical Core owns effect dedup.
