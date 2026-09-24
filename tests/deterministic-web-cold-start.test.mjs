import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeterministicWebProviderV1 } from '../src/core/deterministic-web-provider.js';

const at = '2026-09-24T16:20:00.000Z';

function fixtures(invocationId = 'cold-start-invocation') {
  return {
    toolDescriptor: {
      schemaVersion: 1,
      toolId: 'web.action',
      providerId: 'deterministic-web',
      label: 'Web action',
      description: '',
      capabilityIds: ['web.general'],
      inputSchemaRef: null,
      outputSchemaRef: null,
      readOnly: false,
    },
    invocation: {
      schemaVersion: 1,
      invocationId,
      toolId: 'web.action',
      providerId: 'deterministic-web',
      requestedCapabilityIds: ['web.general'],
      policyDecisionId: `decision-${invocationId}`,
      arguments: {},
      createdAt: at,
      parentInvocationId: null,
    },
    policyDecision: {
      schemaVersion: 1,
      decisionId: `decision-${invocationId}`,
      invocationId,
      decision: 'ALLOW',
      reasonCode: 'OWNER_POLICY',
      reason: '',
      approvalId: null,
      decidedAt: at,
    },
    grantedCapabilityIds: ['web.general'],
  };
}

function durableStore() {
  let record = { effectsById: {}, leasesByTargetId: {} };
  let chain = Promise.resolve();
  return {
    update(mutator) {
      const operation = chain.then(async () => {
        const draft = structuredClone(record);
        await mutator(draft);
        record = draft;
        return structuredClone(record);
      });
      chain = operation.catch(() => undefined);
      return operation;
    },
    snapshot() { return structuredClone(record); },
  };
}

function makeProvider({ store, transport, reconcileVerify }) {
  return createDeterministicWebProviderV1({
    store,
    transport,
    reconcileVerify,
    now: () => at,
    leaseId: () => 'cold-start-lease',
  });
}

test('cold-start recovery moves durable EXECUTING to RECONCILE without replay and retains target ownership', async () => {
  const store = durableStore();
  let dispatches = 0;
  let releaseDispatch;
  let signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const gate = new Promise(resolve => { releaseDispatch = resolve; });
  const transport = {
    async execute() {
      dispatches += 1;
      signalEntered();
      await gate;
    },
    async observe() {
      return { data: { visibleSelectors: ['#done'] }, artifactRefs: [] };
    },
  };
  const request = {
    ...fixtures(),
    targetId: 'tab:7',
    action: { kind: 'CLICK', selector: '#go' },
    postcondition: { selector: '#done' },
  };

  const first = makeProvider({ store, transport });
  const inFlight = first.invoke(request);
  await entered;
  assert.equal(store.snapshot().effectsById['cold-start-invocation'].state.phase, 'EXECUTING');

  const restarted = makeProvider({ store, transport });
  const recovered = await restarted.recoverInterrupted();
  assert.deepEqual(recovered, [{ invocationId: 'cold-start-invocation', targetId: 'tab:7', phase: 'RECONCILE' }]);
  assert.equal(store.snapshot().effectsById['cold-start-invocation'].state.phase, 'RECONCILE');
  assert.equal(store.snapshot().leasesByTargetId['tab:7'].ownerInvocationId, 'cold-start-invocation');

  const blocked = await restarted.invoke(request);
  assert.equal(blocked.status, 'RECONCILE_REQUIRED');
  assert.equal(dispatches, 1);

  releaseDispatch();
  const staleWorker = await inFlight;
  assert.equal(staleWorker.status, 'AMBIGUOUS');
  assert.equal(dispatches, 1);
});

test('reconciliation verifier receives the exact durable target, action, postcondition and execution attempt', async () => {
  const store = durableStore();
  const transport = {
    async execute() { throw new Error('connection lost after effect'); },
    async observe() { return { data: {}, artifactRefs: [] }; },
  };
  const request = {
    ...fixtures('reconcile-context'),
    targetId: 'tab:9',
    action: { kind: 'CLICK', selector: '#buy' },
    postcondition: { selector: '#receipt' },
  };
  const initial = makeProvider({ store, transport });
  assert.equal((await initial.invoke(request)).status, 'AMBIGUOUS');

  let context;
  const verifier = makeProvider({
    store,
    transport,
    reconcileVerify: async input => {
      context = structuredClone(input);
      return {
        verifierId: 'independent-chrome-readback',
        targetId: input.targetId,
        observation: {
          schemaVersion: 1,
          observationId: 'reconcile-context-observation',
          invocationId: input.invocation.invocationId,
          status: 'OK',
          summary: '',
          data: { quiescent: true },
          artifactRefs: [],
          observedAt: at,
        },
        verification: {
          schemaVersion: 1,
          verificationId: 'reconcile-context-verification',
          invocationId: input.invocation.invocationId,
          observationId: 'reconcile-context-observation',
          status: 'AMBIGUOUS',
          reasonCode: 'EFFECT_UNRESOLVED',
          summary: '',
          evidenceArtifactIds: [],
          verifiedAt: at,
          verifierId: 'independent-chrome-readback',
          verificationAuthorityId: input.invocation.policyDecisionId,
          effectId: input.invocation.invocationId,
          executionId: input.executionId,
          attempt: input.attempt,
        },
      };
    },
  });
  const settled = await verifier.reconcile({ invocationId: 'reconcile-context', outcome: 'MANUAL_REVIEW' });
  assert.equal(settled.phase, 'MANUAL_REVIEW');
  assert.equal(context.targetId, 'tab:9');
  assert.deepEqual(context.action, { kind: 'CLICK', selector: '#buy' });
  assert.deepEqual(context.postcondition, { selector: '#receipt' });
  assert.equal(context.attempt, 1);
  assert.equal(context.ambiguity.reasonCode, 'WEB_DISPATCH_UNCERTAIN');
  assert.equal(store.snapshot().leasesByTargetId['tab:9'], undefined);
});
