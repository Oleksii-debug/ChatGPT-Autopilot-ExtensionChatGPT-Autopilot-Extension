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
  let root = { effectsById: {} };
  return {
    async update(mutator) {
      const before = JSON.stringify(root);
      const draft = structuredClone(root);
      const returned = mutator(draft);
      root = structuredClone(returned === undefined ? draft : returned);
      if (JSON.stringify(root) !== before && onSave) {
        for (const entry of Object.values(root.effectsById || {})) {
          if (entry?.state) onSave(structuredClone(entry.state));
        }
      }
      return structuredClone(root);
    },
    async load(id) {
      const state = root.effectsById?.[id]?.state;
      return state ? structuredClone(state) : null;
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

test('concurrent same-invocation contenders share one atomic admission and dispatch exactly once', async () => {
  const store = memoryStore();
  let releaseDispatch;
  const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
  const counter = { calls: 0 };
  const provider = {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async ({ invocation: inv }) => {
      counter.calls += 1;
      await dispatchGate;
      return {
        providerId: FILESYSTEM_PROVIDER_ID,
        invocationId: inv.invocationId,
        observedAt: new Date(baseMs + 1000).toISOString(),
        result: { rootId: 'workspace', relativePath: 'note.txt', sha256: 'a'.repeat(64), alreadyApplied: false },
      };
    },
  };
  let nowMs = baseMs;
  const executor = new FilesystemExactEffectExecutorV1({
    provider,
    store,
    verify: verified,
    now: () => { nowMs += 1000; return nowMs; },
  });
  const inv = invocation('fs-effect-concurrent');
  const decision = policy(inv.invocationId);

  const first = executor.invoke({ invocation: inv, policyDecision: decision });
  await Promise.resolve();
  const second = executor.invoke({ invocation: structuredClone(inv), policyDecision: structuredClone(decision) });

  await assert.rejects(() => second, error => {
    assert.equal(error.code, 'FILESYSTEM_EFFECT_NOT_EXECUTABLE');
    assert.equal(error.effectState.phase, ExactEffectPhase.EXECUTING);
    return true;
  });
  assert.equal(counter.calls, 1, 'only the atomically admitted contender may dispatch');

  releaseDispatch();
  const result = await first;
  assert.equal(result.effectState.phase, ExactEffectPhase.COMMITTED);
  assert.equal(counter.calls, 1);
  assert.equal((await store.load(inv.invocationId)).phase, ExactEffectPhase.COMMITTED);
});

test('same invocation id cannot be rebound to different filesystem arguments before dispatch', async () => {
  const store = memoryStore();
  const counter = { calls: 0 };
  let releaseDispatch;
  const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
  const provider = {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async ({ invocation: inv }) => {
      counter.calls += 1;
      await dispatchGate;
      return {
        providerId: FILESYSTEM_PROVIDER_ID,
        invocationId: inv.invocationId,
        observedAt: new Date(baseMs + 1000).toISOString(),
        result: { rootId: 'workspace', relativePath: 'note.txt', sha256: 'a'.repeat(64), alreadyApplied: false },
      };
    },
  };
  let nowMs = baseMs;
  const executor = new FilesystemExactEffectExecutorV1({ provider, store, verify: verified, now: () => { nowMs += 1000; return nowMs; } });
  const original = invocation('fs-effect-binding-race');
  const first = executor.invoke({ invocation: original, policyDecision: policy(original.invocationId) });
  await Promise.resolve();

  const changed = structuredClone(original);
  changed.arguments.relativePath = 'other.txt';
  await assert.rejects(
    () => executor.invoke({ invocation: changed, policyDecision: policy(changed.invocationId) }),
    /invocation binding changed/,
  );
  assert.equal(counter.calls, 1);

  releaseDispatch();
  await first;
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


test('filesystem reconciliation request rejects coerced, inherited and non-data authority before any state transition', async t => {
  const store = memoryStore();
  let providerCalls = 0;
  let proofCalls = 0;
  const provider = {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async () => {
      providerCalls += 1;
      throw new Error('simulated uncertain native effect');
    },
  };
  let nowMs = baseMs;
  const executor = new FilesystemExactEffectExecutorV1({
    provider,
    store,
    verify: verified,
    reconcileVerify: async () => {
      proofCalls += 1;
      throw new Error('proof verifier must not run for invalid manual-review requests');
    },
    now: () => { nowMs += 1000; return nowMs; },
  });
  const inv = invocation('fs-reconcile-request-boundary');
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }));
  assert.equal((await store.load(inv.invocationId)).phase, ExactEffectPhase.RECONCILE);
  assert.equal(providerCalls, 1);

  const inherited = Object.create({
    invocationId: inv.invocationId,
    outcome: 'MANUAL_REVIEW',
    reasonCode: 'OWNER_REVIEW_REQUIRED',
  });
  const symbolAuthority = {
    invocationId: inv.invocationId,
    outcome: 'MANUAL_REVIEW',
    reasonCode: 'OWNER_REVIEW_REQUIRED',
  };
  symbolAuthority[Symbol('authority')] = true;
  const nonEnumerable = {
    outcome: 'MANUAL_REVIEW',
    reasonCode: 'OWNER_REVIEW_REQUIRED',
  };
  Object.defineProperty(nonEnumerable, 'invocationId', {
    value: inv.invocationId,
    enumerable: false,
    configurable: true,
  });

  const cases = [
    ['numeric invocationId', { invocationId: 123, outcome: 'MANUAL_REVIEW', reasonCode: 'OWNER_REVIEW_REQUIRED' }, /invocationId must be text/],
    ['boolean outcome', { invocationId: inv.invocationId, outcome: true, reasonCode: 'OWNER_REVIEW_REQUIRED' }, /Reconciliation outcome must be text/],
    ['numeric reasonCode', { invocationId: inv.invocationId, outcome: 'MANUAL_REVIEW', reasonCode: 7 }, /reasonCode must be text/],
    ['inherited request authority', inherited, /plain object/],
    ['symbol request authority', symbolAuthority, /unknown field/],
    ['non-enumerable request authority', nonEnumerable, /enumerable data property/],
  ];

  for (const [label, request, expected] of cases) {
    await t.test(label, async () => {
      const before = JSON.stringify(await store.load(inv.invocationId));
      await assert.rejects(() => executor.reconcile(request), expected);
      assert.equal(JSON.stringify(await store.load(inv.invocationId)), before);
      assert.equal(providerCalls, 1, 'invalid reconciliation request must never replay filesystem I/O');
      assert.equal(proofCalls, 0, 'invalid manual-review request must be rejected before proof acquisition');
    });
  }
});

test('filesystem reconciliation proof rejects coerced and exotic authority without changing durable state', async t => {
  const store = memoryStore();
  let providerCalls = 0;
  let proofCalls = 0;
  let mutateProof = raw => raw;
  const provider = {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async () => {
      providerCalls += 1;
      throw new Error('simulated uncertain native effect');
    },
  };
  let nowMs = baseMs;
  const executor = new FilesystemExactEffectExecutorV1({
    provider,
    store,
    verify: verified,
    reconcileVerify: async input => {
      proofCalls += 1;
      const observedAt = new Date(Date.parse(input.requestedAt) + 1).toISOString();
      const observation = {
        schemaVersion: 1,
        observationId: `${input.effectId}:reconcile-observation`,
        invocationId: input.effectId,
        status: 'OK',
        summary: 'Fresh independent filesystem readback.',
        data: { committed: true },
        artifactRefs: [],
        observedAt,
      };
      const verification = {
        schemaVersion: 1,
        verificationId: `${input.effectId}:reconcile-verification`,
        invocationId: input.effectId,
        observationId: observation.observationId,
        status: 'VERIFIED',
        reasonCode: 'POSTCONDITION_MATCHED',
        summary: 'Fresh readback matched the desired digest.',
        evidenceArtifactIds: [],
        verifiedAt: observedAt,
        verifierId: 'filesystem-independent-reconciler',
        verificationAuthorityId: input.policyDecisionId,
        effectId: input.effectId,
        executionId: input.executionId,
        attempt: input.attempt,
      };
      return mutateProof({
        verifierId: verification.verifierId,
        verificationAuthorityId: input.policyDecisionId,
        effectId: input.effectId,
        executionId: input.executionId,
        attempt: input.attempt,
        observation,
        verification,
      });
    },
    now: () => { nowMs += 1000; return nowMs; },
  });
  const inv = invocation('fs-reconcile-proof-boundary');
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }));
  assert.equal((await store.load(inv.invocationId)).phase, ExactEffectPhase.RECONCILE);
  assert.equal(providerCalls, 1);

  const cases = [
    ['numeric verifierId', raw => ({ ...raw, verifierId: 7 }), /verifierId must be text/],
    ['boolean effectId', raw => ({ ...raw, effectId: true }), /proof\.effectId must be text/],
    ['string attempt', raw => ({ ...raw, attempt: '1' }), /attempt is invalid/],
    ['symbol proof authority', raw => { raw[Symbol('authority')] = true; return raw; }, /unknown field/],
    ['exotic proof prototype', raw => Object.assign(Object.create({ admin: true }), raw), /plain object/],
    ['non-enumerable proof authority', raw => {
      Object.defineProperty(raw, 'executionId', {
        value: raw.executionId,
        enumerable: false,
        configurable: true,
      });
      return raw;
    }, /enumerable data property/],
    ['accessor proof authority', raw => {
      const value = raw.effectId;
      Object.defineProperty(raw, 'effectId', {
        get: () => value,
        enumerable: true,
        configurable: true,
      });
      return raw;
    }, /enumerable data property/],
  ];

  for (const [label, mutate, expected] of cases) {
    await t.test(label, async () => {
      mutateProof = mutate;
      const before = JSON.stringify(await store.load(inv.invocationId));
      const callsBefore = proofCalls;
      await assert.rejects(() => executor.reconcile({
        invocationId: inv.invocationId,
        outcome: 'VERIFIED',
        reasonCode: 'READBACK_CONFIRMED',
      }), expected);
      assert.equal(JSON.stringify(await store.load(inv.invocationId)), before);
      assert.equal(providerCalls, 1, 'malformed proof must never replay filesystem I/O');
      assert.equal(proofCalls, callsBefore + 1);
    });
  }
});
