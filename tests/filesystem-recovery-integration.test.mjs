import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { FilesystemAgentProviderV1, FILESYSTEM_PROVIDER_ID, FilesystemToolId } from '../src/core/filesystem-agent-provider.js';
import { FilesystemExactEffectExecutorV1 } from '../src/core/filesystem-exact-effect.js';
import { FilesystemWriteVerifierV1 } from '../src/core/filesystem-write-verifier.js';

const BASE_MS = Date.parse('2026-09-24T16:30:00.000Z');
function digest(text) { return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'); }
function artifactRef(text) {
  return {
    schemaVersion: 1,
    artifactId: 'artifact-recovery-1',
    kind: 'text',
    uri: 'artifact://recovery-1',
    mediaType: 'text/plain',
    sha256: digest(text),
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    createdAt: new Date(BASE_MS).toISOString(),
    producerInvocationId: null,
    sensitive: true,
  };
}
function invocation(id, desired = 'after') {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: FilesystemToolId.WRITE_EXISTING_TEXT,
    providerId: FILESYSTEM_PROVIDER_ID,
    requestedCapabilityIds: ['filesystem.writeExistingText'],
    policyDecisionId: `decision-${id}`,
    arguments: {
      rootId: 'workspace',
      relativePath: 'note.txt',
      contentArtifactRef: artifactRef(desired),
      expectedSha256: digest('before'),
    },
    createdAt: new Date(BASE_MS).toISOString(),
    parentInvocationId: null,
  };
}
function policy(id) {
  return {
    schemaVersion: 1,
    decisionId: `decision-${id}`,
    invocationId: id,
    decision: 'ALLOW',
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: new Date(BASE_MS).toISOString(),
  };
}
function durableStore({ failFirstCommit = false } = {}) {
  const rows = new Map();
  let failCommit = failFirstCommit;
  return {
    rows,
    async load(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    async save(id, state) {
      if (failCommit && state.phase === 'COMMITTED') {
        failCommit = false;
        throw new Error('simulated durable commit-save crash');
      }
      rows.set(id, structuredClone(state));
    },
  };
}
function clock() {
  let value = BASE_MS;
  return () => ++value;
}
function nativeState({ loseFirstWriteResponse = false } = {}) {
  let current = 'before';
  let writes = 0;
  let lose = loseFirstWriteResponse;
  return {
    get current() { return current; },
    get writes() { return writes; },
    client: {
      async readText() { return { rootId: 'workspace', relativePath: 'note.txt', text: current, sizeBytes: Buffer.byteLength(current, 'utf8') }; },
      async searchFiles() { return { items: [], truncated: false, visitedEntries: 0 }; },
      async writeExistingText({ text, expectedSha256 }) {
        writes += 1;
        if (digest(current) !== expectedSha256 && digest(current) !== digest(text)) {
          const error = new Error('precondition failed');
          error.code = 'PRECONDITION_FAILED';
          throw error;
        }
        current = text;
        if (lose) {
          lose = false;
          const error = new Error('native response lost after write');
          error.code = 'NATIVE_TRANSPORT_ERROR';
          throw error;
        }
        return { rootId: 'workspace', relativePath: 'note.txt', sha256: digest(text), sizeBytes: Buffer.byteLength(text, 'utf8'), alreadyApplied: false };
      },
    },
  };
}
function stack({ native, store, now, desired = 'after' }) {
  const provider = new FilesystemAgentProviderV1({
    nativeClient: native.client,
    resolveArtifactText: async ref => {
      assert.equal(ref.sha256, digest(desired));
      return desired;
    },
    grantedCapabilityIds: ['filesystem.writeExistingText'],
    now,
  });
  const verifier = new FilesystemWriteVerifierV1({ nativeClient: native.client, verifierId: 'filesystem-recovery-verifier', now });
  return new FilesystemExactEffectExecutorV1({
    provider,
    store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now,
  });
}

test('lost Native response after actual write reconciles by fresh readback and commits without replay', async () => {
  const id = 'fs-recovery-lost-response';
  const store = durableStore();
  const native = nativeState({ loseFirstWriteResponse: true });
  const now = clock();
  const executor = stack({ native, store, now });
  const inv = invocation(id);
  const decision = policy(id);

  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }), error => {
    assert.equal(error.reconcileRequired, true);
    assert.equal(error.safeToRetry, false);
    assert.equal(error.effectState.phase, 'RECONCILE');
    return true;
  });
  assert.equal(native.current, 'after');
  assert.equal(native.writes, 1);

  const reconciled = await executor.reconcile({
    invocationId: id,
    outcome: 'VERIFIED',
    reasonCode: 'READBACK_CONFIRMED',
    summary: 'Fresh independent digest readback confirms the desired effect.',
  });
  assert.equal(reconciled.phase, 'COMMITTED');
  assert.equal(reconciled.reconciliation.outcome, 'VERIFIED');
  assert.equal(native.writes, 1, 'VERIFIED reconciliation must not dispatch the mutation again');

  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }), /cannot execute from COMMITTED/);
  assert.equal(native.writes, 1, 'committed effect must never replay');
});

test('restart after VERIFIED persistence but before COMMIT resumes bookkeeping only, never filesystem I/O', async () => {
  const id = 'fs-recovery-commit-crash';
  const store = durableStore({ failFirstCommit: true });
  const native = nativeState();
  const now = clock();
  const inv = invocation(id);
  const decision = policy(id);
  const first = stack({ native, store, now });

  await assert.rejects(() => first.invoke({ invocation: inv, policyDecision: decision }), /simulated durable commit-save crash/);
  assert.equal(native.current, 'after');
  assert.equal(native.writes, 1);
  assert.equal((await store.load(id)).phase, 'VERIFIED');

  const restarted = stack({ native, store, now });
  const resumed = await restarted.invoke({ invocation: inv, policyDecision: decision });
  assert.equal(resumed.resumedCommit, true);
  assert.equal(resumed.providerResult, null);
  assert.equal(resumed.effectState.phase, 'COMMITTED');
  assert.equal(native.writes, 1, 'commit-only recovery must not dispatch filesystem mutation');
});
