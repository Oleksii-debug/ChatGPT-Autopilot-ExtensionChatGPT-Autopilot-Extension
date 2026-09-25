import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkflowDebuggerBreakpointKind,
  buildWorkflowDebuggerV1,
} from '../src/core/workflow-debugger.js';
import {
  ExactEffectEventType,
  ExactEffectPhase,
  createExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';

const CHECKPOINT_AT = '2026-09-25T02:40:00.000Z';
const EFFECT_AT = '2026-09-25T02:41:00.000Z';
const PLAN_AT = '2026-09-25T02:42:00.000Z';
const VARIANT_AT = '2026-09-25T02:45:00.000Z';
const GENERATED_AT = '2026-09-25T02:50:00.000Z';

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'PRIVATE OBJECTIVE MUST NOT BE EXPOSED',
    successCriteria: ['Complete the canonical work.'],
    nodes: [{
      nodeId: 'node-1',
      title: 'Private node title',
      objective: 'PRIVATE NODE OBJECTIVE',
      dependsOn: [],
      conflictKeys: ['workflow-debugger-test'],
      ownerId: 'agent-1',
      executionPlane: 'LOCAL',
      acceptanceCriteria: ['Pass the verifier.'],
      budget: {
        maxModelCalls: 2,
        maxRuntimeSeconds: 60,
        maxCostUsdMicros: 1000,
      },
      state: 'READY',
      evidence: 'PRIVATE EVIDENCE MUST NOT BE EXPOSED',
      updatedAt: PLAN_AT,
    }],
    createdAt: CHECKPOINT_AT,
    updatedAt: PLAN_AT,
    revision: 2,
    ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 1,
    checkpointId: 'checkpoint-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    planId: 'plan-1',
    planRevision: 1,
    internalStateRevision: 3,
    exactEffectLedgerRevision: 0,
    policyRevisionId: 'policy-1',
    snapshotArtifact: {
      schemaVersion: 1,
      artifactId: 'checkpoint-artifact-1',
      kind: 'agent-state-checkpoint',
      uri: 'artifact://private/checkpoint-1',
      mediaType: 'application/json',
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      createdAt: CHECKPOINT_AT,
      producerInvocationId: null,
      sensitive: true,
    },
    evidenceArtifactIds: ['evidence-private-1'],
    createdAt: CHECKPOINT_AT,
    checkpointDigest: 'sha256:' + 'b'.repeat(64),
    ...overrides,
  };
}

function invocation(overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: 'effect-1',
    toolId: 'github.update-file',
    providerId: 'github',
    requestedCapabilityIds: ['repo.read', 'repo.write'],
    policyDecisionId: 'policy-decision-1',
    arguments: {
      tokenLikeSecret: 'TOP-SECRET-MUST-NOT-LEAK',
      path: 'README.md',
    },
    createdAt: EFFECT_AT,
    ...overrides,
  };
}

function preparedEffect(overrides = {}) {
  return createExactEffectStateV1(invocation(overrides), { createdAt: EFFECT_AT });
}

function breakpoints() {
  return [
    {
      breakpointId: 'bp-node',
      kind: WorkflowDebuggerBreakpointKind.PLAN_NODE,
      value: 'node-1',
      enabled: true,
    },
    {
      breakpointId: 'bp-provider',
      kind: WorkflowDebuggerBreakpointKind.PROVIDER,
      value: 'github',
      enabled: true,
    },
    {
      breakpointId: 'bp-tool',
      kind: WorkflowDebuggerBreakpointKind.TOOL,
      value: 'github.update-file',
      enabled: true,
    },
    {
      breakpointId: 'bp-capability',
      kind: WorkflowDebuggerBreakpointKind.CAPABILITY,
      value: 'repo.write',
      enabled: true,
    },
    {
      breakpointId: 'bp-phase',
      kind: WorkflowDebuggerBreakpointKind.EFFECT_PHASE,
      value: ExactEffectPhase.PREPARED,
      enabled: true,
    },
  ];
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    debugSessionId: 'debug-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    generatedAt: GENERATED_AT,
    plan: plan(),
    checkpoint: checkpoint(),
    effects: [preparedEffect()],
    effectBindings: [{ effectId: 'effect-1', nodeId: 'node-1' }],
    breakpoints: breakpoints(),
    selectedNodeId: 'node-1',
    selectedEffectId: 'effect-1',
    variantRequest: {
      variantId: 'variant-1',
      checkpointId: 'checkpoint-1',
      alternateRouterId: 'router-alternate',
      targetNodeId: 'node-1',
      requestedAt: VARIANT_AT,
    },
    ...overrides,
  };
}

function reconciliationEffect() {
  let state = preparedEffect();
  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: 'event-begin',
    type: ExactEffectEventType.BEGIN_EXECUTION,
    effectId: 'effect-1',
    at: '2026-09-25T02:43:00.000Z',
    executionId: '',
  }).state;
  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: 'event-ambiguous',
    type: ExactEffectEventType.DECLARE_AMBIGUITY,
    effectId: 'effect-1',
    at: '2026-09-25T02:44:00.000Z',
    executionId: state.executionId,
    reasonCode: 'TRANSPORT_AMBIGUOUS',
    summary: 'Outcome requires reconciliation.',
  }).state;
  return state;
}

test('WorkflowDebuggerV1 exposes bounded structural state without private payloads', () => {
  const result = buildWorkflowDebuggerV1(request());

  assert.equal(result.readOnly, true);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.checkpointRestoreAuthorized, false);
  assert.equal(result.externalEffectReplayAuthorized, false);
  assert.equal(result.hiddenReasoningExposed, false);

  assert.equal(result.plan.nodes[0].nodeId, 'node-1');
  assert.equal(Object.hasOwn(result.plan.nodes[0], 'objective'), false);
  assert.equal(Object.hasOwn(result.plan.nodes[0], 'evidence'), false);
  assert.equal(Object.hasOwn(result.plan.nodes[0], 'title'), false);

  assert.equal(result.effects[0].effectId, 'effect-1');
  assert.equal(result.effects[0].toolId, 'github.update-file');
  assert.equal(result.effects[0].providerId, 'github');
  assert.equal(Object.hasOwn(result.effects[0], 'invocation'), false);
  assert.equal(Object.hasOwn(result.effects[0], 'observation'), false);
  assert.equal(Object.hasOwn(result.effects[0], 'verification'), false);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('TOP-SECRET-MUST-NOT-LEAK'), false);
  assert.equal(serialized.includes('PRIVATE OBJECTIVE'), false);
  assert.equal(serialized.includes('PRIVATE NODE OBJECTIVE'), false);
  assert.equal(serialized.includes('PRIVATE EVIDENCE'), false);
  assert.equal(serialized.includes('artifact://private/'), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.effects[0]), true);
});

test('breakpoints deterministically match plan nodes, provider, tool, capability and effect phase', () => {
  const result = buildWorkflowDebuggerV1(request());
  assert.deepEqual(
    result.breakpointHits.map(hit => [hit.breakpointId, hit.subjectKind, hit.subjectId]),
    [
      ['bp-capability', 'EXACT_EFFECT', 'effect-1'],
      ['bp-node', 'PLAN_NODE', 'node-1'],
      ['bp-phase', 'EXACT_EFFECT', 'effect-1'],
      ['bp-provider', 'EXACT_EFFECT', 'effect-1'],
      ['bp-tool', 'EXACT_EFFECT', 'effect-1'],
    ],
  );
  assert.deepEqual(
    result.effects[0].requestedCapabilityIds,
    ['repo.read', 'repo.write'],
  );
});

test('internal variant is proposal-only even when no external effect progressed after checkpoint', () => {
  const result = buildWorkflowDebuggerV1(request());
  assert.equal(result.variantProposal.proposalEligible, true);
  assert.equal(result.variantProposal.reasonCode, 'INTERNAL_VARIANT_REQUIRES_FRESH_GATES');
  assert.equal(result.variantProposal.internalPlanningReplayRequested, true);
  assert.equal(result.variantProposal.internalPlanningReplayAuthorized, false);
  assert.equal(result.variantProposal.externalEffectReplayAuthorized, false);
  assert.equal(result.variantProposal.checkpointRestoreAuthorized, false);
  assert.equal(result.variantProposal.requiresCanonicalCheckpointVerification, true);
  assert.equal(result.variantProposal.requiresCanonicalCheckpointRewindAssessment, true);
  assert.equal(result.variantProposal.requiresFreshPolicyEvaluation, true);
  assert.equal(result.variantProposal.requiresFreshWorldState, true);
  assert.equal(result.variantProposal.requiresFreshReconciliation, true);
});

test('post-checkpoint ambiguous external effect blocks internal variant proposal eligibility', () => {
  const effect = reconciliationEffect();
  const result = buildWorkflowDebuggerV1(request({
    effects: [effect],
  }));
  assert.equal(result.effects[0].phase, ExactEffectPhase.RECONCILE);
  assert.equal(result.effects[0].ambiguityReasonCode, 'TRANSPORT_AMBIGUOUS');
  assert.equal(result.variantProposal.proposalEligible, false);
  assert.equal(result.variantProposal.reasonCode, 'EXTERNAL_EFFECT_STATE_AFTER_CHECKPOINT');
  assert.deepEqual(result.variantProposal.blockingEffectIds, ['effect-1']);
  assert.equal(result.variantProposal.externalEffectReplayAuthorized, false);
});

test('effect bindings are exact and cannot alias unknown nodes, unknown effects or duplicates', () => {
  assert.throws(
    () => buildWorkflowDebuggerV1(request({
      effectBindings: [{ effectId: 'effect-1', nodeId: 'missing-node' }],
    })),
    /unknown nodeId/,
  );
  assert.throws(
    () => buildWorkflowDebuggerV1(request({
      effectBindings: [{ effectId: 'missing-effect', nodeId: 'node-1' }],
    })),
    /unknown effectId/,
  );
  assert.throws(
    () => buildWorkflowDebuggerV1(request({
      effectBindings: [
        { effectId: 'effect-1', nodeId: 'node-1' },
        { effectId: 'effect-1', nodeId: 'node-1' },
      ],
    })),
    /duplicate effectId|exactly bind every effect/,
  );
});

test('selection, checkpoint and variant identities fail closed when mismatched', () => {
  assert.throws(
    () => buildWorkflowDebuggerV1(request({ selectedNodeId: 'missing-node' })),
    /selectedNodeId does not exist/,
  );
  assert.throws(
    () => buildWorkflowDebuggerV1(request({ selectedEffectId: 'missing-effect' })),
    /selectedEffectId does not exist/,
  );
  assert.throws(
    () => buildWorkflowDebuggerV1(request({
      checkpoint: checkpoint({ agentId: 'other-agent' }),
    })),
    /checkpoint agentId mismatch/,
  );
  assert.throws(
    () => buildWorkflowDebuggerV1(request({
      variantRequest: {
        ...request().variantRequest,
        checkpointId: 'other-checkpoint',
      },
    })),
    /checkpointId does not match/,
  );
});

test('future state and non-canonical debugger timestamps reject', () => {
  assert.throws(
    () => buildWorkflowDebuggerV1(request({
      generatedAt: '2026-09-25T02:50:00Z',
    })),
    /canonical ISO-8601 UTC/,
  );
  assert.throws(
    () => buildWorkflowDebuggerV1(request({
      generatedAt: '2026-09-25T02:41:30.000Z',
    })),
    /AgentPlan is from the future/,
  );
  assert.throws(
    () => buildWorkflowDebuggerV1(request({
      variantRequest: {
        ...request().variantRequest,
        requestedAt: '2026-09-25T02:51:00.000Z',
      },
    })),
    /cannot be after debugger generation/,
  );
});

test('top-level accessors and non-canonical effect arrays fail without ordinary getter reads', () => {
  let topReads = 0;
  const accessor = request();
  Object.defineProperty(accessor, 'projectId', {
    enumerable: true,
    get() {
      topReads += 1;
      return 'project-1';
    },
  });
  assert.throws(
    () => buildWorkflowDebuggerV1(accessor),
    /enumerable own data property/,
  );
  assert.equal(topReads, 0);

  let arrayReads = 0;
  const proxiedEffects = new Proxy([preparedEffect()], {
    get(target, key, receiver) {
      if (key === 'length' || key === '0') arrayReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const result = buildWorkflowDebuggerV1(request({ effects: proxiedEffects }));
  assert.equal(result.effects.length, 1);
  assert.equal(arrayReads, 0);

  const sparse = new Array(1);
  assert.throws(
    () => buildWorkflowDebuggerV1(request({ effects: sparse })),
    /must be dense/,
  );
});

test('unknown hidden-reasoning or authority fields are rejected rather than projected', () => {
  assert.throws(
    () => buildWorkflowDebuggerV1({
      ...request(),
      chainOfThought: 'hidden reasoning',
    }),
    /unknown field/,
  );
  assert.throws(
    () => buildWorkflowDebuggerV1({
      ...request(),
      replayAuthorized: true,
    }),
    /unknown field/,
  );

  const invalidBreakpoint = breakpoints();
  invalidBreakpoint[0] = {
    ...invalidBreakpoint[0],
    executeNow: true,
  };
  assert.throws(
    () => buildWorkflowDebuggerV1(request({ breakpoints: invalidBreakpoint })),
    /unknown field/,
  );
});

test('disabled breakpoints do not hit and output ordering is stable', () => {
  const reversed = breakpoints().reverse().map((item, index) =>
    index === 0 ? { ...item, enabled: false } : item);
  const first = buildWorkflowDebuggerV1(request({ breakpoints: reversed }));
  const second = buildWorkflowDebuggerV1(request({ breakpoints: reversed }));

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.breakpoints.map(item => item.breakpointId),
    ['bp-capability', 'bp-node', 'bp-phase', 'bp-provider', 'bp-tool'],
  );
  assert.equal(
    first.breakpointHits.some(hit => hit.breakpointId === reversed[0].breakpointId),
    false,
  );
});
