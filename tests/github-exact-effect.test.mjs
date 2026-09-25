import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubExactEffectExecutorV1 } from '../src/core/github-exact-effect.js';
import { GitHubToolId } from '../src/core/github-agent-provider.js';
import {
  ExactEffectEventType,
  createExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';

const at = '2026-09-24T17:10:00.000Z';

function invocation(id = 'github-effect-1', args = {}) {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: GitHubToolId.FILE_PUT,
    providerId: 'remote/github',
    requestedCapabilityIds: ['github.file.write'],
    policyDecisionId: `decision-${id}`,
    arguments: {
      repository: 'Oleksii-debug/project',
      path: 'README.md',
      branch: 'work/test',
      content: 'hello',
      message: 'test',
      expectedSha: '0123456789abcdef0123456789abcdef01234567',
      ...args,
    },
    createdAt: at,
    parentInvocationId: null,
  };
}

function policy(id = 'github-effect-1') {
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

function storeFixture(initial = {}) {
  let root = {
    effectsById: Object.fromEntries(Object.entries(initial).map(([id, state]) => [id, { state: structuredClone(state) }])),
  };
  const writes = [];
  return {
    writes,
    store: {
      async update(mutator) {
        const before = structuredClone(root);
        const draft = structuredClone(root);
        const returned = mutator(draft);
        root = structuredClone(returned === undefined ? draft : returned);
        for (const [id, entry] of Object.entries(root.effectsById || {})) {
          const previous = before.effectsById?.[id]?.state;
          if (entry?.state && JSON.stringify(entry.state) !== JSON.stringify(previous)) {
            writes.push({ id, phase: entry.state.phase, attempt: entry.state.attempt });
          }
        }
        return structuredClone(root);
      },
    },
    snapshot(id) {
      const state = root.effectsById?.[id]?.state;
      return state ? structuredClone(state) : undefined;
    },
  };
}

function verified(inv, observation, { status = 'VERIFIED', reasonCode = 'GITHUB_STATE_MATCH', verifierId = 'github-readback-verifier' } = {}) {
  return {
    schemaVersion: 1,
    verificationId: `${inv.invocationId}:verification`,
    invocationId: inv.invocationId,
    observationId: observation.observationId,
    status,
    reasonCode,
    summary: '',
    evidenceArtifactIds: [],
    verifiedAt: at,
    verifierId,
    verificationAuthorityId: inv.policyDecisionId,
    effectId: inv.invocationId,
    executionId: `${inv.invocationId}:attempt:1`,
    attempt: 1,
  };
}

function providerFixture({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      authorize({ invocation: input, policyDecision }) {
        calls.push(['authorize', input.invocationId]);
        return { invocation: structuredClone(input), policyDecision: structuredClone(policyDecision) };
      },
      async invoke({ invocation: input }) {
        calls.push(['invoke', input.invocationId]);
        if (fail) {
          const error = new Error('connection lost after mutation dispatch');
          error.effectMayHaveOccurred = true;
          error.safeToRetry = false;
          throw error;
        }
        return {
          providerId: 'remote/github',
          invocationId: input.invocationId,
          observedAt: at,
          result: { repository: input.arguments.repository, path: input.arguments.path, sha: '1111111111111111111111111111111111111111' },
        };
      },
    },
  };
}

test('effectful GitHub mutation persists EXECUTING before provider dispatch and commits only after independent verification', async () => {
  const fx = storeFixture();
  const p = providerFixture();
  let phaseAtDispatch = null;
  const originalInvoke = p.provider.invoke;
  p.provider.invoke = async request => {
    phaseAtDispatch = fx.snapshot(request.invocation.invocationId)?.phase;
    return originalInvoke(request);
  };
  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async ({ invocation: inv, observation }) => verified(inv, observation),
  });

  const result = await executor.invoke({ invocation: invocation(), policyDecision: policy() });
  assert.equal(phaseAtDispatch, 'EXECUTING');
  assert.equal(result.effectState.phase, 'COMMITTED');
  assert.deepEqual(fx.writes.map(item => item.phase), ['EXECUTING', 'OBSERVED', 'VERIFIED', 'COMMITTED']);
  assert.equal(p.calls.filter(([name]) => name === 'invoke').length, 1);
});

test('initial GitHub verification must be independently bound to the exact durable attempt before commit', async t => {
  const cases = [
    ['missing verifier identity', value => {
      delete value.verifierId;
      return value;
    }, {}, /verification\.verifierId is invalid/],
    ['executor self-verification', value => ({ ...value, verifierId: 'github-exact-effect-executor' }), {}, /must be independent/],
    ['parent-controller self-verification', value => ({ ...value, verifierId: 'github-parent-controller' }), { parentActorId: 'github-parent-controller' }, /must be independent/],
    ['provider self-verification', value => ({ ...value, verifierId: 'remote\/github' }), {}, /must be independent/],
    ['wrong verification authority', value => ({ ...value, verificationAuthorityId: 'decision-other' }), {}, /does not match the current exact-effect attempt/],
    ['wrong effect identity', value => ({ ...value, effectId: 'github-effect-other' }), {}, /does not match the current exact-effect attempt/],
    ['wrong execution identity', value => ({ ...value, executionId: 'github-effect-other:attempt:1' }), {}, /does not match the current exact-effect attempt/],
    ['wrong attempt', value => ({ ...value, attempt: 2 }), {}, /does not match the current exact-effect attempt/],
    ['wrong invocation binding', value => ({ ...value, invocationId: 'github-effect-other' }), {}, /does not match the current exact-effect attempt/],
    ['wrong observation binding', value => ({ ...value, observationId: 'github-effect-other:observation' }), {}, /does not match the current exact-effect attempt/],
    ['verification predates observation', value => ({ ...value, verifiedAt: '2026-09-24T17:09:59.000Z' }), {}, /invalid chronology/],
    ['verification is too far in the future', value => ({ ...value, verifiedAt: '2026-09-24T17:11:01.000Z' }), {}, /invalid chronology/],
  ];

  for (const [index, [label, mutate, executorOptions, expected]] of cases.entries()) {
    await t.test(label, async () => {
      const id = `verify-binding-${index}`;
      const fx = storeFixture();
      const p = providerFixture();
      const executor = new GitHubExactEffectExecutorV1({
        provider: p.provider,
        store: fx.store,
        now: () => Date.parse(at),
        ...executorOptions,
        verify: async ({ invocation: inv, observation }) => mutate(verified(inv, observation)),
      });

      await assert.rejects(
        () => executor.invoke({ invocation: invocation(id), policyDecision: policy(id) }),
        error => {
          assert.match(error.message, expected);
          assert.equal(error.effectState.phase, 'RECONCILE');
          assert.equal(error.safeToRetry, false);
          assert.equal(error.reconcileRequired, true);
          return true;
        },
      );
      assert.equal(fx.snapshot(id).phase, 'RECONCILE');
      assert.equal(p.calls.filter(([name]) => name === 'invoke').length, 1);
      assert.equal(fx.writes.some(item => item.phase === 'COMMITTED'), false);
    });
  }
});

test('concurrent same-invocation contenders atomically admit exactly one GitHub mutation', async () => {
  const fx = storeFixture();
  const calls = [];
  let releaseDispatch;
  const gate = new Promise(resolve => { releaseDispatch = resolve; });
  const provider = {
    authorize({ invocation: input, policyDecision }) {
      calls.push(['authorize', input.invocationId]);
      return { invocation: structuredClone(input), policyDecision: structuredClone(policyDecision) };
    },
    async invoke({ invocation: input }) {
      calls.push(['invoke', input.invocationId]);
      await gate;
      return {
        providerId: 'remote/github',
        invocationId: input.invocationId,
        observedAt: at,
        result: { repository: input.arguments.repository, path: input.arguments.path, sha: '1'.repeat(40) },
      };
    },
  };
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async ({ invocation: inv, observation }) => verified(inv, observation),
  });
  const inv = invocation('github-effect-concurrent');
  const decision = policy(inv.invocationId);

  const first = executor.invoke({ invocation: inv, policyDecision: decision });
  await Promise.resolve();
  const second = executor.invoke({ invocation: structuredClone(inv), policyDecision: structuredClone(decision) });

  await assert.rejects(() => second, error => {
    assert.equal(error.code, 'GITHUB_EFFECT_NOT_EXECUTABLE');
    assert.equal(error.effectState.phase, 'EXECUTING');
    return true;
  });
  assert.equal(calls.filter(([name]) => name === 'invoke').length, 1);

  releaseDispatch();
  const result = await first;
  assert.equal(result.effectState.phase, 'COMMITTED');
  assert.equal(calls.filter(([name]) => name === 'invoke').length, 1);
});

test('cold-start recovery fences a still-running provider result from overwriting RECONCILE', async () => {
  const fx = storeFixture();
  let releaseDispatch;
  let dispatchStarted;
  const dispatchStartedGate = new Promise(resolve => { dispatchStarted = resolve; });
  const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
  const provider = {
    authorize({ invocation: input, policyDecision }) {
      return { invocation: structuredClone(input), policyDecision: structuredClone(policyDecision) };
    },
    async invoke({ invocation: input }) {
      dispatchStarted();
      await dispatchGate;
      return {
        providerId: 'remote/github',
        invocationId: input.invocationId,
        observedAt: at,
        result: { repository: input.arguments.repository, path: input.arguments.path, sha: '1'.repeat(40) },
      };
    },
  };
  const executor = new GitHubExactEffectExecutorV1({
    provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async () => { throw new Error('verification must not run after recovery fenced execution'); },
  });
  const running = executor.invoke({ invocation: invocation('recovery-race'), policyDecision: policy('recovery-race') });
  await dispatchStartedGate;
  assert.equal(fx.snapshot('recovery-race').phase, 'EXECUTING');

  const recovered = await executor.recoverInterrupted();
  assert.deepEqual(recovered, [{ invocationId: 'recovery-race', phase: 'RECONCILE' }]);
  releaseDispatch();

  await assert.rejects(() => running, error => {
    assert.equal(error.code, 'GITHUB_EXECUTION_FENCED');
    assert.equal(error.effectState.phase, 'RECONCILE');
    assert.equal(error.reconcileRequired, true);
    return true;
  });
  assert.equal(fx.snapshot('recovery-race').phase, 'RECONCILE');
  assert.equal(fx.snapshot('recovery-race').ambiguity.reasonCode, 'GITHUB_DISPATCH_INTERRUPTED');
});

test('cold-start recovery fences a stale independent verification result from overwriting RECONCILE', async () => {
  const fx = storeFixture();
  let verificationStarted;
  let releaseVerification;
  const verificationStartedGate = new Promise(resolve => { verificationStarted = resolve; });
  const verificationGate = new Promise(resolve => { releaseVerification = resolve; });
  const p = providerFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async ({ invocation: inv, observation }) => {
      verificationStarted();
      await verificationGate;
      return verified(inv, observation);
    },
  });
  const running = executor.invoke({ invocation: invocation('verification-race'), policyDecision: policy('verification-race') });
  await verificationStartedGate;
  assert.equal(fx.snapshot('verification-race').phase, 'OBSERVED');

  const recovered = await executor.recoverInterrupted();
  assert.deepEqual(recovered, [{ invocationId: 'verification-race', phase: 'RECONCILE' }]);
  releaseVerification();

  await assert.rejects(() => running, error => {
    assert.equal(error.code, 'GITHUB_EXECUTION_FENCED');
    assert.equal(error.effectState.phase, 'RECONCILE');
    assert.equal(error.reconcileRequired, true);
    return true;
  });
  assert.equal(fx.snapshot('verification-race').phase, 'RECONCILE');
  assert.equal(fx.snapshot('verification-race').ambiguity.reasonCode, 'GITHUB_DISPATCH_INTERRUPTED');
});

test('ambiguous GitHub transport outcome becomes durable RECONCILE and blind retry is blocked', async () => {
  const fx = storeFixture();
  const p = providerFixture({ fail: true });
  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async () => { throw new Error('must not verify'); },
  });

  await assert.rejects(() => executor.invoke({ invocation: invocation(), policyDecision: policy() }), error => {
    assert.equal(error.reconcileRequired, true);
    assert.equal(error.safeToRetry, false);
    assert.equal(error.effectState.phase, 'RECONCILE');
    return true;
  });
  assert.equal(fx.snapshot('github-effect-1').phase, 'RECONCILE');

  await assert.rejects(() => executor.invoke({ invocation: invocation(), policyDecision: policy() }), /requires reconciliation/);
  assert.equal(p.calls.filter(([name]) => name === 'invoke').length, 1, 'same mutation must not dispatch twice');
});

test('restart recovery converts a durable EXECUTING mutation to RECONCILE before any provider replay', async () => {
  const inv = invocation('interrupted');
  let state = createExactEffectStateV1(inv, { createdAt: at });
  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: 'interrupted:begin',
    type: ExactEffectEventType.BEGIN_EXECUTION,
    effectId: 'interrupted',
    at,
  }).state;
  const fx = storeFixture({ interrupted: state });
  const p = providerFixture();
  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async () => { throw new Error('must not verify'); },
  });

  const recovered = await executor.recoverInterrupted();
  assert.deepEqual(recovered, [{ invocationId: 'interrupted', phase: 'RECONCILE' }]);
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy('interrupted') }), /requires reconciliation/);
  assert.equal(fx.snapshot('interrupted').phase, 'RECONCILE');
  assert.equal(fx.snapshot('interrupted').ambiguity.reasonCode, 'GITHUB_DISPATCH_INTERRUPTED');
  assert.equal(p.calls.filter(([name]) => name === 'invoke').length, 0);
});

test('same invocation id cannot be rebound to a different GitHub mutation after uncertainty', async () => {
  const fx = storeFixture();
  const p = providerFixture({ fail: true });
  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async () => { throw new Error('must not verify'); },
  });
  await assert.rejects(() => executor.invoke({ invocation: invocation(), policyDecision: policy() }));

  await assert.rejects(() => executor.invoke({
    invocation: invocation('github-effect-1', { path: 'OTHER.md' }),
    policyDecision: policy(),
  }), /binding changed/);
  assert.equal(p.calls.filter(([name]) => name === 'invoke').length, 1);
});

test('durable GitHub exact-effect identities reject JavaScript coercion aliases', async () => {
  const fx = storeFixture();
  const p = providerFixture();

  for (const actorId of [1, true, { toString: () => 'actor' }]) {
    assert.throws(() => new GitHubExactEffectExecutorV1({
      provider: p.provider,
      store: fx.store,
      actorId,
      now: () => Date.parse(at),
      verify: async ({ invocation: inv, observation }) => verified(inv, observation),
    }), /actorId is invalid/);
  }

  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async ({ invocation: inv, observation }) => verified(inv, observation),
  });
  for (const invocationId of [1, true, { toString: () => 'github-effect-1' }]) {
    await assert.rejects(
      () => executor.reconcile({ invocationId, outcome: 'MANUAL_REVIEW' }),
      /invocationId is invalid/,
    );
  }
});

test('GitHub reconciliation request rejects inherited, accessor, symbol and coerced authority before proof or transition', async t => {
  const fx = storeFixture();
  const p = providerFixture({ fail: true });
  let proofCalls = 0;
  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async () => { throw new Error('must not verify'); },
    reconcileVerify: async () => {
      proofCalls += 1;
      throw new Error('invalid request must not reach proof acquisition');
    },
  });
  const inv = invocation('github-reconcile-request-boundary');
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }));
  assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');

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
    ['inherited authority', inherited, /plain object/],
    ['symbol authority', symbolAuthority, /unknown field/],
    ['non-enumerable identity', nonEnumerable, /enumerable data property/],
    ['coerced outcome', { invocationId: inv.invocationId, outcome: true, reasonCode: 'OWNER_REVIEW_REQUIRED' }, /outcome is invalid/],
    ['coerced summary', { invocationId: inv.invocationId, outcome: 'MANUAL_REVIEW', reasonCode: 'OWNER_REVIEW_REQUIRED', summary: 7 }, /summary must be text/],
  ];

  for (const [label, request, expected] of cases) {
    await t.test(label, async () => {
      const before = JSON.stringify(fx.snapshot(inv.invocationId));
      await assert.rejects(() => executor.reconcile(request), expected);
      assert.equal(JSON.stringify(fx.snapshot(inv.invocationId)), before);
      assert.equal(proofCalls, 0);
    });
  }
});

test('GitHub reconciliation proof rejects exotic or non-data authority without changing durable RECONCILE state', async t => {
  const fx = storeFixture();
  const p = providerFixture({ fail: true });
  let mutateProof = raw => raw;
  const inv = invocation('github-reconcile-proof-boundary');
  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async () => { throw new Error('must not verify'); },
    reconcileVerify: async input => {
      const observation = {
        schemaVersion: 1,
        observationId: `${input.effectId}:reconcile-observation`,
        invocationId: input.effectId,
        status: 'OK',
        summary: '',
        data: { committed: true },
        artifactRefs: [],
        observedAt: at,
      };
      const verification = {
        ...verified(inv, observation, { verifierId: 'independent-github-readback' }),
        executionId: input.executionId,
        attempt: input.attempt,
      };
      return mutateProof({
        verifierId: 'independent-github-readback',
        verificationAuthorityId: input.policyDecisionId,
        effectId: input.effectId,
        executionId: input.executionId,
        attempt: input.attempt,
        observation,
        verification,
      });
    },
  });
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }));
  assert.equal(fx.snapshot(inv.invocationId).phase, 'RECONCILE');

  const cases = [
    ['string attempt', raw => ({ ...raw, attempt: '1' }), /current exact-effect attempt/],
    ['symbol authority', raw => { raw[Symbol('authority')] = true; return raw; }, /unknown field/],
    ['exotic prototype', raw => Object.assign(Object.create({ admin: true }), raw), /plain object/],
    ['accessor effectId', raw => {
      const value = raw.effectId;
      Object.defineProperty(raw, 'effectId', { get: () => value, enumerable: true, configurable: true });
      return raw;
    }, /enumerable data property/],
  ];

  for (const [label, mutate, expected] of cases) {
    await t.test(label, async () => {
      mutateProof = mutate;
      const before = JSON.stringify(fx.snapshot(inv.invocationId));
      await assert.rejects(() => executor.reconcile({
        invocationId: inv.invocationId,
        outcome: 'VERIFIED',
        reasonCode: 'READBACK_CONFIRMED',
      }), expected);
      assert.equal(JSON.stringify(fx.snapshot(inv.invocationId)), before);
    });
  }
});

test('fresh independently bound reconciliation can verify and commit without replaying the GitHub mutation', async () => {
  const fx = storeFixture();
  const p = providerFixture({ fail: true });
  const executor = new GitHubExactEffectExecutorV1({
    provider: p.provider,
    store: fx.store,
    now: () => Date.parse(at),
    verify: async () => { throw new Error('must not verify'); },
    reconcileVerify: async ({ invocation: inv, effectId, executionId, attempt, policyDecisionId }) => {
      const observation = {
        schemaVersion: 1,
        observationId: `${effectId}:reconcile-observation`,
        invocationId: effectId,
        status: 'OK',
        summary: '',
        data: { repository: inv.arguments.repository, path: inv.arguments.path, committed: true },
        artifactRefs: [],
        observedAt: at,
      };
      return {
        verifierId: 'independent-github-readback',
        verificationAuthorityId: policyDecisionId,
        effectId,
        executionId,
        attempt,
        observation,
        verification: {
          ...verified(inv, observation, { verifierId: 'independent-github-readback' }),
          executionId,
          attempt,
        },
      };
    },
  });
  await assert.rejects(() => executor.invoke({ invocation: invocation(), policyDecision: policy() }));
  const reconciled = await executor.reconcile({ invocationId: 'github-effect-1', outcome: 'VERIFIED' });
  assert.equal(reconciled.phase, 'COMMITTED');
  assert.equal(p.calls.filter(([name]) => name === 'invoke').length, 1, 'reconciliation is readback-only and must not replay mutation');
});
