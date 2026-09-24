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
  const states = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  const writes = [];
  return {
    writes,
    store: {
      async load(id) { return states.has(id) ? structuredClone(states.get(id)) : null; },
      async save(id, state) {
        states.set(id, structuredClone(state));
        writes.push({ id, phase: state.phase, attempt: state.attempt });
      },
    },
    snapshot(id) { return structuredClone(states.get(id)); },
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
  assert.deepEqual(fx.writes.map(item => item.phase), ['PREPARED', 'EXECUTING', 'OBSERVED', 'VERIFIED', 'COMMITTED']);
  assert.equal(p.calls.filter(([name]) => name === 'invoke').length, 1);
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
