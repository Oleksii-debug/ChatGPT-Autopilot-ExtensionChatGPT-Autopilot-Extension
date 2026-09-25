import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeterministicWebProviderV1, normalizeDeterministicWebActionV1 } from '../src/core/deterministic-web-provider.js';

const at = '2026-09-23T15:20:00.000Z';
function fixtures(invocationId = 'inv-1') {
  const toolDescriptor = { schemaVersion: 1, toolId: 'web.action', providerId: 'deterministic-web', label: 'Web action', description: '', capabilityIds: ['web.general'], inputSchemaRef: null, outputSchemaRef: null, readOnly: false };
  const invocation = { schemaVersion: 1, invocationId, toolId: 'web.action', providerId: 'deterministic-web', requestedCapabilityIds: ['web.general'], policyDecisionId: `decision-${invocationId}`, arguments: {}, createdAt: at, parentInvocationId: null };
  const policyDecision = { schemaVersion: 1, decisionId: `decision-${invocationId}`, invocationId, decision: 'ALLOW', reasonCode: 'OWNER_POLICY', reason: '', approvalId: null, decidedAt: at };
  return { toolDescriptor, invocation, policyDecision, grantedCapabilityIds: ['web.general'] };
}

function durableStore(leaseState = { value: null }) {
  let record = { effectsById: {}, leasesByTargetId: { 'tab-1': leaseState.value } };
  let chain = Promise.resolve();
  return {
    async update(mutator) {
      const operation = chain.then(() => {
        const draft = structuredClone(record);
        const result = mutator(draft);
        record = draft;
        leaseState.value = record.leasesByTargetId['tab-1'] || null;
        return result;
      });
      chain = operation.catch(() => {});
      return operation;
    },
    snapshot() { return structuredClone(record); },
  };
}

function provider(transport, leaseState = { value: null }, store = durableStore(leaseState)) {
  return createDeterministicWebProviderV1({
    transport, store,
    now: () => at,
    leaseId: () => 'lease-1',
  });
}

test('provider refuses ephemeral/no-op lease callbacks before any browser effect', () => {
  assert.throws(() => createDeterministicWebProviderV1({ transport: { execute() {}, observe() {} } }), /atomic durable exact-effect store/);
});

test('normalizes bounded deterministic web actions and rejects unsafe URL protocols', () => {
  assert.deepEqual(normalizeDeterministicWebActionV1({ kind: 'navigate', url: 'https://example.test/path' }), { kind: 'NAVIGATE', url: 'https://example.test/path' });
  assert.throws(() => normalizeDeterministicWebActionV1({ kind: 'navigate', url: 'javascript:alert(1)' }), /protocol/);
  assert.throws(() => normalizeDeterministicWebActionV1({ kind: 'navigate', url: 'https://user:secret@example.test/' }), /credentials/);
  assert.throws(() => normalizeDeterministicWebActionV1({ kind: 'click', selector: '' }), /selector/);
  assert.throws(() => normalizeDeterministicWebActionV1({ kind: 'click', selector: '#ok', surprise: true }), /unknown field/);
  assert.throws(() => normalizeDeterministicWebActionV1({ kind: { toString: () => 'CLICK' }, selector: '#ok' }), /kind must be text/);
  assert.throws(() => normalizeDeterministicWebActionV1(Object.assign(Object.create({ kind: 'CLICK' }), { selector: '#ok' })), /plain object/);
  const symbolic = { kind: 'CLICK', selector: '#ok' };
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeDeterministicWebActionV1(symbolic), /unknown field/);
});

test('invalid actions and verification requirements cannot acquire a lease or execute', async () => {
  let effects = 0;
  const leaseState = { value: null };
  const p = provider({ execute: async () => { effects += 1; }, observe: async () => ({ data: {} }) }, leaseState);
  await assert.rejects(() => p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '' }, postcondition: { selector: '#done' } }), /selector/);
  await assert.rejects(() => p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#buy' }, postcondition: {} }), /postcondition/);
  await assert.rejects(() => p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#buy' }, postcondition: { selector: '#done', url: 'https://example.test/' } }), /exactly one/);
  assert.equal(leaseState.value, null);
  assert.equal(effects, 0);
});

test('executes only authorized invocation and independently verifies URL postcondition', async () => {
  const calls = [];
  const leaseState = { value: null };
  const p = provider({
    execute: async payload => calls.push(['execute', payload]),
    observe: async payload => { calls.push(['observe', payload]); return { data: { url: 'https://example.test/done' }, artifactRefs: [] }; },
  }, leaseState);
  const result = await p.invoke({ ...fixtures(), targetId: 'tab-7', action: { kind: 'NAVIGATE', url: 'https://example.test/done' }, postcondition: { url: 'https://example.test/done' } });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.verification.reasonCode, 'URL_MATCH');
  assert.equal(result.verification.verifierId, 'deterministic-web-postcondition-verifier');
  assert.equal(result.verification.verificationAuthorityId, 'decision-inv-1');
  assert.equal(result.verification.effectId, 'inv-1');
  assert.equal(result.verification.executionId, 'inv-1:attempt:1');
  assert.equal(result.verification.attempt, 1);
  assert.deepEqual(calls.map(([name]) => name), ['execute', 'observe']);
  assert.equal(leaseState.value, null, 'target lease is released after verification');
});

test('fails closed before transport when policy is not ALLOW', async () => {
  let called = false;
  const p = provider({ execute: async () => { called = true; }, observe: async () => ({ data: {} }) });
  const fx = fixtures();
  fx.policyDecision = { ...fx.policyDecision, decision: 'DENY' };
  await assert.rejects(() => p.invoke({ ...fx, targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } }), /not authorized/);
  assert.equal(called, false);
});

test('does not mutate a target with a live lease owned by another invocation', async () => {
  let called = false;
  const leaseState = { value: { schemaVersion: 1, targetId: 'tab-1', ownerInvocationId: 'other', leaseId: 'other-lease', acquiredAt: '2026-09-23T15:19:59.000Z', expiresAt: '2026-09-23T15:21:00.000Z' } };
  const p = provider({ execute: async () => { called = true; }, observe: async () => ({ data: {} }) }, leaseState);
  const result = await p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } });
  assert.equal(result.status, 'TARGET_CONFLICT');
  assert.equal(called, false);
});

test('post-effect observation failure is AMBIGUOUS and retains lease for reconciliation', async () => {
  const leaseState = { value: null };
  const p = provider({ execute: async () => {}, observe: async () => { throw new Error('browser disconnected with private page text'); } }, leaseState);
  const result = await p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#buy' }, postcondition: { selector: '#receipt' } });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.reconcileRequired, true);
  assert.equal(result.error, 'WEB_DISPATCH_UNCERTAIN');
  assert.ok(!JSON.stringify(result).includes('private page text'));
  assert.equal(leaseState.value.ownerInvocationId, 'inv-1');
});

test('effectful dispatch rejection is AMBIGUOUS and fences a competing invocation', async () => {
  const leaseState = { value: null };
  const p = provider({ execute: async () => { throw new Error('connection lost after dispatch'); }, observe: async () => ({ data: {} }) }, leaseState);
  const result = await p.invoke({ ...fixtures('inv-1'), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#buy' }, postcondition: { selector: '#receipt' } });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.reconcileRequired, true);
  assert.equal(leaseState.value.ownerInvocationId, 'inv-1');

  let competingExecuted = false;
  const competitor = provider({ execute: async () => { competingExecuted = true; }, observe: async () => ({ data: { visibleSelectors: ['#receipt'] }, artifactRefs: [] }) }, leaseState);
  const blocked = await competitor.invoke({ ...fixtures('inv-2'), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#buy' }, postcondition: { selector: '#receipt' } });
  assert.equal(blocked.status, 'TARGET_CONFLICT');
  assert.equal(competingExecuted, false);
});

test('an expired lease does not erase unresolved target ownership after a restart', async () => {
  let executed = false;
  const leaseState = { value: {
    schemaVersion: 1, targetId: 'tab-1', ownerInvocationId: 'inv-1', leaseId: 'old-lease',
    acquiredAt: '2026-09-23T15:18:00.000Z', expiresAt: '2026-09-23T15:19:00.000Z',
  } };
  const restarted = provider({ execute: async () => { executed = true; }, observe: async () => ({ data: {} }) }, leaseState);
  const result = await restarted.invoke({ ...fixtures('inv-2'), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#buy' }, postcondition: { selector: '#receipt' } });
  assert.equal(result.status, 'TARGET_CONFLICT');
  assert.equal(leaseState.value.ownerInvocationId, 'inv-1');
  assert.equal(executed, false);
  const sameOwner = await restarted.invoke({ ...fixtures('inv-1'), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#buy' }, postcondition: { selector: '#receipt' } });
  assert.equal(sameOwner.status, 'TARGET_CONFLICT');
  assert.equal(executed, false);
});

test('failed postcondition is AMBIGUOUS and retains its target until reconciliation', async () => {
  const leaseState = { value: null };
  const p = provider({ execute: async () => {}, observe: async () => ({ data: { visibleSelectors: ['#other'] }, artifactRefs: [] }) }, leaseState);
  const result = await p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.reconcileRequired, true);
  assert.equal(result.verification.reasonCode, 'SELECTOR_NOT_VISIBLE');
  assert.equal(result.effectState.phase, 'RECONCILE');
  assert.equal(leaseState.value.ownerInvocationId, 'inv-1');
});

test('a restarted provider does not replay a durable EXECUTING effect; manual reconciliation frees its target', async () => {
  const leaseState = { value: null };
  const store = durableStore(leaseState);
  let finishDispatch;
  let dispatches = 0;
  const transport = {
    execute: async () => { dispatches += 1; await new Promise(resolve => { finishDispatch = resolve; }); },
    observe: async () => ({ data: { visibleSelectors: ['#done'] } }),
  };
  const first = provider(transport, leaseState, store);
  const request = { ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } };
  const pending = first.invoke(request);
  while (!finishDispatch) await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.snapshot().effectsById['inv-1'].state.phase, 'EXECUTING');
  const restarted = provider(transport, leaseState, store);
  const blocked = await restarted.invoke(request);
  assert.equal(blocked.status, 'RECONCILE_REQUIRED');
  assert.equal(blocked.effectState.phase, 'RECONCILE');
  assert.equal(dispatches, 1);
  finishDispatch();
  assert.equal((await pending).status, 'AMBIGUOUS');
  await assert.rejects(() => restarted.reconcile({ invocationId: 'inv-1', outcome: 'MANUAL_REVIEW' }), /independent web reconciliation verifier/);
  const withQuiescenceProof = createDeterministicWebProviderV1({ transport, store, now: () => at, reconcileVerify: async ({ invocation, executionId, targetId }) => ({
    verifierId: 'independent-verifier',
    targetId,
    observation: { schemaVersion: 1, observationId: 'quiescent-observation', invocationId: invocation.invocationId, status: 'OK', summary: '', data: { quiescent: true }, artifactRefs: [], observedAt: at },
    verification: { schemaVersion: 1, verificationId: 'quiescent-verification', invocationId: invocation.invocationId, observationId: 'quiescent-observation', status: 'AMBIGUOUS', reasonCode: 'EFFECT_UNRESOLVED', summary: '', evidenceArtifactIds: [], verifiedAt: at, verifierId: 'independent-verifier', verificationAuthorityId: invocation.policyDecisionId, effectId: invocation.invocationId, executionId, attempt: 1 },
  }) });
  const settled = await withQuiescenceProof.reconcile({ invocationId: 'inv-1', outcome: 'MANUAL_REVIEW' });
  assert.equal(settled.phase, 'MANUAL_REVIEW');
  assert.equal(leaseState.value, null);
  assert.equal((await restarted.invoke(request)).status, 'MANUAL_REVIEW');
  assert.equal(dispatches, 1);
});

test('atomic admission fences concurrent invocations of the same target across provider instances', async () => {
  const leaseState = { value: null };
  const store = durableStore(leaseState);
  let finishDispatch;
  let dispatches = 0;
  const transport = {
    execute: async () => { dispatches += 1; await new Promise(resolve => { finishDispatch = resolve; }); },
    observe: async () => ({ data: { visibleSelectors: ['#done'] } }),
  };
  const first = provider(transport, leaseState, store);
  const second = provider(transport, leaseState, store);
  const args = id => ({ ...fixtures(id), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } });
  const pending = first.invoke(args('inv-1'));
  const competitor = await second.invoke(args('inv-2'));
  assert.equal(competitor.status, 'TARGET_CONFLICT');
  assert.equal(dispatches, 1);
  finishDispatch();
  assert.equal((await pending).status, 'VERIFIED');
  assert.equal(store.snapshot().effectsById['inv-1'].state.phase, 'COMMITTED');
});

test('safe retry needs fresh independently bound no-effect evidence', async () => {
  const leaseState = { value: null };
  const store = durableStore(leaseState);
  let dispatches = 0;
  const transport = {
    execute: async () => { dispatches += 1; if (dispatches === 1) throw new Error('lost after dispatch'); },
    observe: async () => ({ data: { visibleSelectors: ['#done'] } }),
  };
  const initial = provider(transport, leaseState, store);
  const request = { ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } };
  assert.equal((await initial.invoke(request)).status, 'AMBIGUOUS');

  const beforeAliasAttempt = store.snapshot();
  const beforeAliasLease = structuredClone(leaseState.value);
  let aliasVerifierCalls = 0;
  const aliasGuard = createDeterministicWebProviderV1({
    transport,
    store,
    now: () => at,
    reconcileVerify: async () => {
      aliasVerifierCalls += 1;
      throw new Error('reconciliation verifier must not run for a noncanonical invocation identity');
    },
  });
  for (const invocationId of [' inv-1', 'inv-1 ']) {
    await assert.rejects(
      () => aliasGuard.reconcile({ invocationId, outcome: 'SAFE_RETRY' }),
      /reconciliation invocationId is invalid/,
    );
  }
  assert.equal(aliasVerifierCalls, 0);
  assert.deepEqual(store.snapshot(), beforeAliasAttempt);
  assert.deepEqual(leaseState.value, beforeAliasLease);

  await assert.rejects(() => initial.reconcile({ invocationId: 'inv-1', outcome: 'SAFE_RETRY' }), /independent web reconciliation verifier/);
  const bad = createDeterministicWebProviderV1({ transport, store, now: () => at, reconcileVerify: async ({ invocation, executionId, targetId }) => ({
    verifierId: 'independent-verifier',
    targetId,
    observation: { schemaVersion: 1, observationId: 'reconcile-obs', invocationId: invocation.invocationId, status: 'OK', summary: '', data: { committed: true }, artifactRefs: [], observedAt: at },
    verification: { schemaVersion: 1, verificationId: 'reconcile-check', invocationId: invocation.invocationId, observationId: 'reconcile-obs', status: 'FAILED', reasonCode: 'NO_COMMITTED_EFFECT', summary: '', evidenceArtifactIds: [], verifiedAt: at, verifierId: 'independent-verifier', verificationAuthorityId: invocation.policyDecisionId, effectId: invocation.invocationId, executionId, attempt: 1 },
  }) });
  await assert.rejects(() => bad.reconcile({ invocationId: 'inv-1', outcome: 'SAFE_RETRY' }), /proof of no committed effect/);
  assert.equal(store.snapshot().effectsById['inv-1'].state.phase, 'RECONCILE');
  const safe = createDeterministicWebProviderV1({ transport, store, now: () => at, reconcileVerify: async ({ invocation, executionId, targetId }) => ({
    verifierId: 'independent-verifier',
    targetId,
    observation: { schemaVersion: 1, observationId: 'reconcile-obs', invocationId: invocation.invocationId, status: 'OK', summary: '', data: { committed: false }, artifactRefs: [], observedAt: at },
    verification: { schemaVersion: 1, verificationId: 'reconcile-check', invocationId: invocation.invocationId, observationId: 'reconcile-obs', status: 'FAILED', reasonCode: 'NO_COMMITTED_EFFECT', summary: '', evidenceArtifactIds: [], verifiedAt: at, verifierId: 'independent-verifier', verificationAuthorityId: invocation.policyDecisionId, effectId: invocation.invocationId, executionId, attempt: 1 },
  }) });
  assert.equal((await safe.reconcile({ invocationId: 'inv-1', outcome: 'SAFE_RETRY' })).phase, 'SAFE_RETRY');
  assert.equal((await safe.invoke(request)).status, 'VERIFIED');
  assert.equal(dispatches, 2);
});


test('provider rejects malformed canonical durable maps before browser dispatch', async t => {
  const malformedRoots = [
    { effectsById: null, leasesByTargetId: {} },
    { effectsById: {}, leasesByTargetId: null },
    { effectsById: [], leasesByTargetId: {} },
    { effectsById: {}, leasesByTargetId: [] },
  ];

  for (const [index, root] of malformedRoots.entries()) {
    await t.test(`malformed durable maps ${index + 1}`, async () => {
      let effects = 0;
      const store = {
        async update(mutator) {
          const draft = structuredClone(root);
          return mutator(draft);
        },
      };
      const p = createDeterministicWebProviderV1({
        transport: {
          execute: async () => { effects += 1; },
          observe: async () => ({ data: { visibleSelectors: ['#done'] }, artifactRefs: [] }),
        },
        store,
        now: () => at,
        leaseId: () => 'must-not-be-used',
      });
      await assert.rejects(() => p.invoke({
        ...fixtures(`malformed-store-${index + 1}`),
        targetId: 'tab-1',
        action: { kind: 'CLICK', selector: '#go' },
        postcondition: { selector: '#done' },
      }), /effectsById|leasesByTargetId/);
      assert.equal(effects, 0);
    });
  }
});

test('prototype-named invocation ids are treated only as own durable entries', async () => {
  const leaseState = { value: null };
  const store = durableStore(leaseState);
  let effects = 0;
  const p = createDeterministicWebProviderV1({
    transport: {
      execute: async () => { effects += 1; },
      observe: async () => ({ data: { visibleSelectors: ['#done'] }, artifactRefs: [] }),
    },
    store,
    now: () => at,
    leaseId: () => 'constructor-lease',
  });
  const result = await p.invoke({
    ...fixtures('constructor'),
    targetId: 'tab-1',
    action: { kind: 'CLICK', selector: '#go' },
    postcondition: { selector: '#done' },
  });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(effects, 1);
  assert.equal(store.snapshot().effectsById.constructor.state.phase, 'COMMITTED');
});


test('malformed reconciliation request authority is rejected before durable state access', async t => {
  let storeUpdates = 0;
  const store = {
    async update() {
      storeUpdates += 1;
      throw new Error('store must not be reached');
    },
  };
  const p = createDeterministicWebProviderV1({
    transport: { execute: async () => {}, observe: async () => ({ data: {} }) },
    store,
    now: () => at,
  });

  const inherited = Object.create({ invocationId: 'inv-1', outcome: 'VERIFIED' });
  const symbolic = { invocationId: 'inv-1', outcome: 'VERIFIED' };
  symbolic[Symbol('authority')] = true;
  const cases = [
    [{ invocationId: 7, outcome: 'VERIFIED' }, /invocationId must be text/],
    [{ invocationId: 'inv-1', outcome: { toString: () => 'VERIFIED' } }, /outcome must be text/],
    [{ invocationId: 'inv-1', outcome: 'VERIFIED', reasonCode: true }, /reasonCode must be text/],
    [inherited, /plain object/],
    [symbolic, /unknown field/],
  ];

  for (const [request, expected] of cases) {
    await t.test(expected.source, async () => {
      await assert.rejects(() => p.reconcile(request), expected);
      assert.equal(storeUpdates, 0);
    });
  }
});

test('exotic postcondition authority is rejected before target lease or browser effect', async () => {
  let effects = 0;
  const leaseState = { value: null };
  const p = provider({
    execute: async () => { effects += 1; },
    observe: async () => ({ data: {} }),
  }, leaseState);
  const inherited = Object.create({ selector: '#done' });
  await assert.rejects(() => p.invoke({
    ...fixtures('exotic-postcondition'),
    targetId: 'tab-1',
    action: { kind: 'CLICK', selector: '#go' },
    postcondition: inherited,
  }), /plain object/);
  assert.equal(effects, 0);
  assert.equal(leaseState.value, null);
});
