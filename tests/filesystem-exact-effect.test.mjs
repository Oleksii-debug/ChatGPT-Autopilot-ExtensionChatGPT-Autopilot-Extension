import test from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemExactEffectExecutorV1 } from '../src/core/filesystem-exact-effect.js';
import { FILESYSTEM_PROVIDER_ID, FilesystemToolId } from '../src/core/filesystem-agent-provider.js';
import { ExactEffectPhase } from '../src/core/universal-agent-exact-effect.js';

const baseMs = Date.parse('2026-09-24T16:00:00.000Z');
function invocation(id = 'fs-effect-1') {
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
      contentArtifactRef: {
        schemaVersion: 1,
        artifactId: 'artifact-effect-1',
        kind: 'text',
        uri: 'artifact://effect-1',
        mediaType: 'text/plain',
        sha256: 'a'.repeat(64),
        sizeBytes: 5,
        createdAt: new Date(baseMs).toISOString(),
        producerInvocationId: null,
        sensitive: true,
      },
      expectedSha256: 'b'.repeat(64),
    },
    createdAt: new Date(baseMs).toISOString(),
    parentInvocationId: null,
  };
}
function policy(id = 'fs-effect-1') {
  return {
    schemaVersion: 1,
    decisionId: `decision-${id}`,
    invocationId: id,
    decision: 'ALLOW',
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: new Date(baseMs).toISOString(),
  };
}
function memoryStore(onSave = null) {
  const values = new Map();
  return {
    async load(id) { return values.has(id) ? structuredClone(values.get(id)) : null; },
    async save(id, state) {
      values.set(id, structuredClone(state));
      onSave?.(structuredClone(state));
    },
  };
}
function verified({ invocation: inv, observation, effectId, executionId, attempt, policyDecisionId, requestedAt }) {
  return {
    schemaVersion: 1,
    verificationId: `${inv.invocationId}:verification`,
    invocationId: inv.invocationId,
    observationId: observation.observationId,
    status: 'VERIFIED',
    reasonCode: 'POSTCONDITION_MATCHED',
    summary: 'Independent readback matched the expected filesystem digest.',
    evidenceArtifactIds: ['artifact-effect-1'],
    verifiedAt: new Date(Date.parse(requestedAt) + 1).toISOString(),
    verifierId: 'filesystem-independent-verifier',
    verificationAuthorityId: policyDecisionId,
    effectId,
    executionId,
    attempt,
  };
}
function successfulProvider(counter) {
  return {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async ({ invocation: inv }) => {
      counter.calls += 1;
      return {
        providerId: FILESYSTEM_PROVIDER_ID,
        invocationId: inv.invocationId,
        observedAt: new Date(baseMs + 1000).toISOString(),
        result: { rootId: 'workspace', relativePath: 'note.txt', sha256: 'a'.repeat(64), alreadyApplied: false },
      };
    },
  };
}

test('filesystem write persists EXECUTING before dispatch, verifies, commits, and never replays a committed effect', async () => {
  const savedPhases = [];
  const persisted = [];
  const store = memoryStore(state => { savedPhases.push(state.phase); persisted.push(JSON.stringify(state)); });
  const counter = { calls: 0 };
  const provider = successfulProvider(counter);
  let nowMs = baseMs;
  const executor = new FilesystemExactEffectExecutorV1({ provider, store, verify: verified, now: () => { nowMs += 1000; return nowMs; } });
  const inv = invocation();
  const result = await executor.invoke({ invocation: inv, policyDecision: policy() });
  assert.equal(result.effectState.phase, ExactEffectPhase.COMMITTED);
  assert.equal(counter.calls, 1);
  assert.ok(savedPhases.indexOf(ExactEffectPhase.EXECUTING) < savedPhases.indexOf(ExactEffectPhase.OBSERVED));
  assert.equal(persisted.some(serialized => serialized.includes('"text":"after"')), false);
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy() }), /cannot execute from COMMITTED/);
  assert.equal(counter.calls, 1);
});

test('uncertain write becomes RECONCILE and blind replay is blocked', async () => {
  const store = memoryStore();
  let calls = 0;
  const provider = {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async () => {
      calls += 1;
      const error = new Error('native response was lost');
      error.code = 'NATIVE_TRANSPORT_ERROR';
      error.effectMayHaveOccurred = true;
      error.safeToRetry = false;
      throw error;
    },
  };
  let nowMs = baseMs;
  const executor = new FilesystemExactEffectExecutorV1({ provider, store, verify: verified, now: () => { nowMs += 1000; return nowMs; } });
  const inv = invocation('fs-effect-ambiguous');
  const decision = policy('fs-effect-ambiguous');
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }), error => {
    assert.equal(error.reconcileRequired, true);
    assert.equal(error.safeToRetry, false);
    assert.equal(error.effectState.phase, ExactEffectPhase.RECONCILE);
    return true;
  });
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }), /requires reconciliation before retry/);
  assert.equal(calls, 1);

  const resolved = await executor.reconcile({
    invocationId: inv.invocationId,
    outcome: 'MANUAL_REVIEW',
    reasonCode: 'OWNER_REVIEW_REQUIRED',
    summary: 'No independent readback was available.',
  });
  assert.equal(resolved.phase, ExactEffectPhase.MANUAL_REVIEW);
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }), /cannot execute from MANUAL_REVIEW/);
  assert.equal(calls, 1);
});

test('initial verification must be independently identity-bound to policy, effect, execution, attempt and observation', async t => {
  const cases = [
    ['missing verifier identity', raw => { delete raw.verifierId; }, /verifierId is invalid/],
    ['effect provider posing as verifier', raw => { raw.verifierId = FILESYSTEM_PROVIDER_ID; }, /verifier must be independent/],
    ['actor posing as verifier', raw => { raw.verifierId = 'filesystem-exact-effect-executor'; }, /verifier must be independent/],
    ['wrong policy authority', raw => { raw.verificationAuthorityId = 'decision-other'; }, /authority must bind/],
    ['wrong effect id', raw => { raw.effectId = 'effect-other'; }, /current exact-effect attempt/],
    ['wrong execution id', raw => { raw.executionId = 'execution-other'; }, /current exact-effect attempt/],
    ['wrong attempt', raw => { raw.attempt += 1; }, /current exact-effect attempt/],
    ['wrong invocation id', raw => { raw.invocationId = 'invocation-other'; }, /invocation and observation/],
    ['wrong observation id', raw => { raw.observationId = 'observation-other'; }, /invocation and observation/],
  ];

  for (const [label, mutate, expected] of cases) {
    await t.test(label, async () => {
      const counter = { calls: 0 };
      const store = memoryStore();
      let nowMs = baseMs;
      const verify = input => {
        const raw = structuredClone(verified(input));
        mutate(raw);
        return raw;
      };
      const executor = new FilesystemExactEffectExecutorV1({
        provider: successfulProvider(counter),
        store,
        verify,
        now: () => { nowMs += 1000; return nowMs; },
      });
      const inv = invocation(`fs-binding-${label.replaceAll(' ', '-')}`);
      await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }), error => {
        assert.match(error.message, expected);
        assert.equal(error.effectState.phase, ExactEffectPhase.RECONCILE);
        assert.equal(error.reconcileRequired, true);
        return true;
      });
      assert.equal(counter.calls, 1, 'failed verification binding must not replay filesystem I/O');
    });
  }
});

test('initial verification rejects stale, pre-observation, and implausibly future evidence', async t => {
  const cases = [
    ['pre-observation', ({ raw, observation }) => { raw.verifiedAt = new Date(Date.parse(observation.observedAt) - 1).toISOString(); }],
    ['stale', ({ raw, requestedAt }) => { raw.verifiedAt = new Date(Date.parse(requestedAt) - 10 * 60 * 1000).toISOString(); }],
    ['future', ({ raw, requestedAt }) => { raw.verifiedAt = new Date(Date.parse(requestedAt) + 10 * 60 * 1000).toISOString(); }],
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const counter = { calls: 0 };
      const store = memoryStore();
      let nowMs = baseMs;
      const verify = input => {
        const raw = structuredClone(verified(input));
        mutate({ raw, ...input });
        return raw;
      };
      const executor = new FilesystemExactEffectExecutorV1({
        provider: successfulProvider(counter),
        store,
        verify,
        maxReconciliationEvidenceAgeMs: 5 * 60 * 1000,
        now: () => { nowMs += 1000; return nowMs; },
      });
      const inv = invocation(`fs-freshness-${label}`);
      await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }), error => {
        assert.match(error.message, /stale or has an invalid chronology/);
        assert.equal(error.effectState.phase, ExactEffectPhase.RECONCILE);
        assert.equal(error.reconcileRequired, true);
        return true;
      });
      assert.equal(counter.calls, 1);
    });
  }
});
