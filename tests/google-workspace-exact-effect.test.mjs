import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleWorkspaceExactEffectExecutorV1 } from '../src/core/google-workspace-exact-effect.js';
import { GOOGLE_WORKSPACE_PROVIDER_ID, GoogleWorkspaceCapabilityId, GoogleWorkspaceToolId } from '../src/core/google-workspace-agent-provider.js';
import { ExactEffectPhase } from '../src/core/universal-agent-exact-effect.js';

const baseMs = Date.parse('2026-09-25T07:00:00.000Z');
function invocation(id = 'gmail-draft-effect-1') {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: GoogleWorkspaceToolId.GMAIL_DRAFT_CREATE,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    requestedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_DRAFT_CREATE],
    policyDecisionId: `decision-${id}`,
    arguments: { userId: 'owner@example.com', rawMessageBase64Url: 'QUJD' },
    createdAt: new Date(baseMs).toISOString(),
    parentInvocationId: null,
  };
}
function policy(id = 'gmail-draft-effect-1') {
  return { schemaVersion: 1, decisionId: `decision-${id}`, invocationId: id, decision: 'ALLOW', reasonCode: 'OWNER_POLICY', reason: '', approvalId: null, decidedAt: new Date(baseMs).toISOString() };
}
function memoryStore(onSave = null) {
  let root = { effectsById: {} };
  return {
    async update(mutator) {
      const draft = structuredClone(root);
      const returned = mutator(draft);
      root = structuredClone(returned === undefined ? draft : returned);
      if (onSave) for (const entry of Object.values(root.effectsById || {})) if (entry?.state) onSave(structuredClone(entry.state));
      return structuredClone(root);
    },
    async load(id) { return structuredClone(root.effectsById?.[id]?.state || null); },
  };
}
function verification({ invocation: inv, observation, effectId, executionId, attempt, policyDecisionId, requestedAt }) {
  return {
    schemaVersion: 1,
    verificationId: `${inv.invocationId}:verification`,
    invocationId: inv.invocationId,
    observationId: observation.observationId,
    status: 'VERIFIED',
    reasonCode: 'GMAIL_DRAFT_CONTENT_MATCHED',
    summary: 'Independent Gmail readback matched the intended draft.',
    evidenceArtifactIds: [],
    verifiedAt: new Date(Date.parse(requestedAt) + 1).toISOString(),
    verifierId: 'gmail-draft-independent-verifier',
    verificationAuthorityId: policyDecisionId,
    effectId,
    executionId,
    attempt,
  };
}
function provider(counter, { fail = null } = {}) {
  return {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async ({ invocation: inv }) => {
      counter.calls += 1;
      if (fail) throw fail();
      return { providerId: GOOGLE_WORKSPACE_PROVIDER_ID, invocationId: inv.invocationId, observedAt: new Date(baseMs + 1000).toISOString(), result: { userId: 'owner@example.com', draftId: 'draft_1', messageId: 'msg_1', threadId: 'thread_1', labelIds: ['DRAFT'] } };
    },
  };
}

test('Gmail draft exact effect persists execution, independently verifies, commits, and never replays committed create', async () => {
  const phases = [];
  const store = memoryStore(state => phases.push(state.phase));
  const counter = { calls: 0 };
  let now = baseMs;
  const executor = new GoogleWorkspaceExactEffectExecutorV1({ provider: provider(counter), store, verify: verification, now: () => { now += 1000; return now; } });
  const inv = invocation();
  const result = await executor.invoke({ invocation: inv, policyDecision: policy() });
  assert.equal(result.effectState.phase, ExactEffectPhase.COMMITTED);
  assert.equal(counter.calls, 1);
  assert.ok(phases.indexOf(ExactEffectPhase.EXECUTING) < phases.indexOf(ExactEffectPhase.OBSERVED));
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy() }), /cannot execute from COMMITTED/);
  assert.equal(counter.calls, 1);
});

test('concurrent Gmail draft contenders atomically admit exactly one POST', async () => {
  const store = memoryStore();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const p = {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async ({ invocation: inv }) => {
      calls += 1;
      await gate;
      return { providerId: GOOGLE_WORKSPACE_PROVIDER_ID, invocationId: inv.invocationId, result: { draftId: 'draft_1' } };
    },
  };
  let now = baseMs;
  const executor = new GoogleWorkspaceExactEffectExecutorV1({ provider: p, store, verify: verification, now: () => { now += 1000; return now; } });
  const inv = invocation('gmail-draft-concurrent');
  const first = executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) });
  await Promise.resolve();
  const second = executor.invoke({ invocation: structuredClone(inv), policyDecision: policy(inv.invocationId) });
  await assert.rejects(() => second, error => error.code === 'GOOGLE_WORKSPACE_EFFECT_NOT_EXECUTABLE' && error.effectState.phase === ExactEffectPhase.EXECUTING);
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(calls, 1);
});

test('uncertain Gmail POST becomes RECONCILE and cannot blind replay', async () => {
  const store = memoryStore();
  const counter = { calls: 0 };
  let now = baseMs;
  const executor = new GoogleWorkspaceExactEffectExecutorV1({
    provider: provider(counter, { fail: () => Object.assign(new Error('lost POST response'), { effectMayHaveOccurred: true, safeToRetry: false }) }),
    store,
    verify: verification,
    now: () => { now += 1000; return now; },
  });
  const inv = invocation('gmail-draft-ambiguous');
  const decision = policy(inv.invocationId);
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }), error => {
    assert.equal(error.effectState.phase, ExactEffectPhase.RECONCILE);
    assert.equal(error.reconcileRequired, true);
    assert.equal(error.safeToRetry, false);
    return true;
  });
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }), /requires reconciliation before retry/);
  assert.equal(counter.calls, 1);
});

test('Gmail verifier identity, policy, effect, execution and attempt bindings are mandatory', async () => {
  const store = memoryStore();
  const counter = { calls: 0 };
  let now = baseMs;
  const executor = new GoogleWorkspaceExactEffectExecutorV1({
    provider: provider(counter),
    store,
    verify(input) {
      const out = verification(input);
      out.verifierId = GOOGLE_WORKSPACE_PROVIDER_ID;
      return out;
    },
    now: () => { now += 1000; return now; },
  });
  const inv = invocation('gmail-draft-bad-verifier');
  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: policy(inv.invocationId) }), error => {
    assert.match(error.message, /verifier must be independent/i);
    assert.equal(error.effectState.phase, ExactEffectPhase.RECONCILE);
    return true;
  });
  assert.equal(counter.calls, 1);
});

test('reconciliation rejects whitespace aliases for durable invocation identity without changing stored effect state', async () => {
  const store = memoryStore();
  const counter = { calls: 0 };
  let now = baseMs;
  const executor = new GoogleWorkspaceExactEffectExecutorV1({
    provider: provider(counter, {
      fail: () => Object.assign(new Error('lost POST response'), {
        effectMayHaveOccurred: true,
        safeToRetry: false,
      }),
    }),
    store,
    verify: verification,
    now: () => { now += 1000; return now; },
  });
  const inv = invocation('gmail-draft-exact-id');
  const decision = policy(inv.invocationId);

  await assert.rejects(() => executor.invoke({ invocation: inv, policyDecision: decision }));
  const before = await store.load(inv.invocationId);
  assert.equal(before.phase, ExactEffectPhase.RECONCILE);

  for (const alias of [` ${inv.invocationId}`, `${inv.invocationId} `]) {
    await assert.rejects(
      () => executor.reconcile({
        invocationId: alias,
        outcome: 'MANUAL_REVIEW',
        reasonCode: 'OWNER_REVIEW_REQUIRED',
        summary: 'Alias must fail before durable effect lookup or transition.',
      }),
      /invocationId is invalid/,
    );
    assert.deepEqual(await store.load(inv.invocationId), before);
  }
  assert.equal(counter.calls, 1, 'invalid reconciliation aliases must never replay Gmail mutation');
});

