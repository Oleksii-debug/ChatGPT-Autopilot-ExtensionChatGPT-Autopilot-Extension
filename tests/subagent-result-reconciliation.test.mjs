import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentExecutionPlane,
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from '../src/core/agent-plan.js';
import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import {
  OrchestrationActivationPhase,
  OrchestrationActivationPurpose,
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  compactOrchestrationEventId,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
} from '../src/core/orchestration-hierarchy.js';
import { createSubagentResultEnvelopeV1 } from '../src/core/subagent-result-envelope.js';
import {
  SUBAGENT_TASK_ACTIVATION_BINDING_VERSION,
  SubagentResultReconciliationDecision,
  deriveSubagentTaskActivationBindingV1,
  normalizeTrustedSubagentTaskActivationBindingV1,
  prepareSubagentResultReconciliationV1,
} from '../src/core/subagent-result-reconciliation.js';
import { createSubagentTaskEnvelopeV1 } from '../src/core/subagent-task-envelope.js';
import {
  ObservationStatus,
  VerificationStatus,
} from '../src/core/universal-agent-contracts.js';

const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T10:01:00.000Z';
const T2 = '2026-09-27T10:02:00.000Z';
const T3 = '2026-09-27T10:03:00.000Z';
const T4 = '2026-09-27T10:04:00.000Z';
const T5 = '2026-09-27T10:05:00.000Z';
const T6 = '2026-09-27T10:06:00.000Z';
const EPOCH_T1 = Date.parse(T1);

function artifactRef(artifactId, {
  kind = 'ARTIFACT',
  sha256 = 'a'.repeat(64),
  createdAt = T3,
  producerInvocationId = 'invocation-child-1',
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind,
    uri: 'artifact://' + artifactId,
    mediaType: 'application/json',
    sha256,
    sizeBytes: 64,
    createdAt,
    producerInvocationId,
    sensitive: false,
  };
}

function outcomeContract({
  requiredEvidenceKinds = ['ARTIFACT'],
  requiredEvidenceArtifactCount = 1,
} = {}) {
  return createOutcomeContractV1({
    contractId: 'outcome-1',
    projectId: 'project-1',
    desiredResult: 'Return one independently verified child artifact.',
    completionCriteria: [{
      criterionId: 'criterion-1',
      description: 'Child result is complete.',
      observable: 'Immutable result evidence exists.',
      requiredEvidenceKinds,
    }],
    constraints: [],
    sourceTruth: [{
      sourceId: 'source-1',
      location: 'project://source-1',
      revisionId: 'rev-1',
      purpose: 'Canonical task source.',
    }],
    allowedAuthority: [],
    budgetBoundaries: {
      maxModelCalls: 5,
      maxRuntimeSeconds: 120,
      maxCostUsdMicros: 500,
      maxConcurrency: 1,
      enforcementAuthority: 'NONE',
    },
    deliverables: [{
      deliverableId: 'deliverable-1',
      kind: 'ARTIFACT',
      description: 'Verified child result.',
      criterionIds: ['criterion-1'],
    }],
    verifierPlan: {
      planId: 'verify-plan-1',
      actorId: 'child-1',
      verifierId: 'verifier-1',
      criterionIds: ['criterion-1'],
      requiredEvidenceArtifactCount,
      independent: true,
      verificationAuthority: 'EXTERNAL_REQUIRED',
    },
    triggerRefs: [],
    createdAt: T0,
  });
}

function taskEnvelope(contract = outcomeContract()) {
  const plan = normalizeAgentPlanV1({
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'Complete parent goal.',
    successCriteria: ['Verified child result exists'],
    nodes: [{
      nodeId: 'task-1',
      title: 'Child task',
      objective: 'Produce the verified artifact.',
      dependsOn: [],
      conflictKeys: ['artifact:result'],
      ownerId: 'child-1',
      executionPlane: AgentExecutionPlane.CLOUD,
      acceptanceCriteria: ['Result is complete'],
      budget: {
        maxModelCalls: 5,
        maxRuntimeSeconds: 120,
        maxCostUsdMicros: 500,
      },
      state: AgentPlanNodeState.READY,
      evidence: '',
      updatedAt: T1,
    }],
    createdAt: T0,
    updatedAt: T1,
    revision: 3,
  });

  return createSubagentTaskEnvelopeV1({
    envelopeId: 'envelope-1',
    projectId: 'project-1',
    parentAgentId: 'parent-1',
    childAgentId: 'child-1',
    plan,
    nodeId: 'task-1',
    inputSourceIds: ['source-1'],
    inputArtifactRefs: [artifactRef('input-1', {
      sha256: '1'.repeat(64),
      createdAt: T0,
      producerInvocationId: 'parent-input',
    })],
    outcomeContract: contract,
    createdAt: T2,
  });
}

function rawVerification(overrides = {}) {
  return {
    schemaVersion: 1,
    verificationId: overrides.verificationId ?? 'verification-1',
    invocationId: overrides.invocationId ?? 'invocation-child-1',
    observationId: overrides.observationId ?? 'observation-1',
    status: overrides.status ?? VerificationStatus.VERIFIED,
    reasonCode: overrides.reasonCode ?? 'PASS',
    summary: overrides.summary ?? 'Independent verifier confirmed the result.',
    evidenceArtifactIds: overrides.evidenceArtifactIds ?? ['evidence-1'],
    verifiedAt: overrides.verifiedAt ?? T4,
    verifierId: overrides.verifierId ?? 'verifier-1',
    verificationAuthorityId:
      overrides.verificationAuthorityId ?? 'verification-authority-1',
    effectId: null,
    executionId: null,
    attempt: 1,
  };
}

function resultEnvelope({
  contract = outcomeContract(),
  observationStatus = ObservationStatus.OK,
  resultProducerInvocationId = 'invocation-child-1',
  verification = rawVerification(),
  observedAt = T3,
  completedAt = T5,
} = {}) {
  return createSubagentResultEnvelopeV1({
    resultId: 'result-1',
    taskEnvelope: taskEnvelope(contract),
    observation: {
      schemaVersion: 1,
      observationId: 'observation-1',
      invocationId: 'invocation-child-1',
      status: observationStatus,
      summary: 'Child produced the bounded result artifact.',
      data: { transcript: 'must not enter reconciliation' },
      artifactRefs: [artifactRef('result-artifact-1', {
        sha256: '2'.repeat(64),
        createdAt: observedAt,
        producerInvocationId: resultProducerInvocationId,
      })],
      observedAt,
    },
    verification,
    evidenceArtifactRefs: [artifactRef('evidence-1', {
      sha256: '3'.repeat(64),
      createdAt: T4,
      producerInvocationId: 'verifier-invocation-1',
    })],
    completedAt,
  });
}

function graph() {
  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'result-reconciliation-graph',
    controlEpoch: 7,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [
      { id: 'parent-profile', role: 'PARENT', version: 1, prompt: 'parent' },
      { id: 'child-profile', role: 'CHILD', version: 1, prompt: 'child' },
    ],
    nodes: [
      {
        id: 'parent-1',
        parentId: null,
        childIds: ['child-1'],
        promptProfileId: 'parent-profile',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 1,
        barrier: {
          mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN,
          childIds: ['child-1'],
        },
      },
      {
        id: 'child-1',
        parentId: 'parent-1',
        childIds: [],
        promptProfileId: 'child-profile',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
        maxActiveChildren: 0,
        barrier: { mode: OrchestrationBarrierMode.NONE, childIds: [] },
      },
    ],
  });
}

function nestedGraph() {
  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'nested-result-reconciliation-graph',
    controlEpoch: 7,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [
      { id: 'parent-profile', role: 'PARENT', version: 1, prompt: 'parent' },
      { id: 'child-profile', role: 'CHILD', version: 1, prompt: 'child' },
      { id: 'grandchild-profile', role: 'GRANDCHILD', version: 1, prompt: 'grandchild' },
    ],
    nodes: [
      {
        id: 'parent-1',
        parentId: null,
        childIds: ['child-1'],
        promptProfileId: 'parent-profile',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 1,
        barrier: {
          mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN,
          childIds: ['child-1'],
        },
      },
      {
        id: 'child-1',
        parentId: 'parent-1',
        childIds: ['grandchild-1'],
        promptProfileId: 'child-profile',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
        maxActiveChildren: 1,
        barrier: {
          mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN,
          childIds: ['grandchild-1'],
        },
      },
      {
        id: 'grandchild-1',
        parentId: 'child-1',
        childIds: [],
        promptProfileId: 'grandchild-profile',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
        maxActiveChildren: 0,
        barrier: { mode: OrchestrationBarrierMode.NONE, childIds: [] },
      },
    ],
  });
}

function runtimeFixture({ confirmEffect = true } = {}) {
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, Date.parse(T0));
  let reduced = reduceOrchestrationHierarchyEvent(
    g,
    runtime,
    {
      type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
      eventId: 'activate-child-1',
      controlEpoch: 7,
      nodeId: 'child-1',
      generation: 1,
      activationId: 'child-activation-1',
      purpose: OrchestrationActivationPurpose.WORK,
    },
    EPOCH_T1,
  );
  runtime = reduced.runtime;

  if (confirmEffect) {
    reduced = reduceOrchestrationHierarchyEvent(
      g,
      runtime,
      {
        type: OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
        eventId: 'confirm-child-1',
        controlEpoch: 7,
        nodeId: 'child-1',
        generation: 1,
        activationId: 'child-activation-1',
        effectRef: 'effect://child-1',
      },
      EPOCH_T1 + 1,
    );
    runtime = reduced.runtime;
  }

  return { g, runtime };
}

function canonicalBindingId({
  parentAgentId = 'parent-1',
  childAgentId = 'child-1',
  taskId = 'task-1',
  taskEnvelopeId = 'envelope-1',
  planId = 'plan-1',
  planRevision = 3,
  outcomeContractId = 'outcome-1',
  outcomeContractRevision = 1,
  controlEpoch = 7,
  activationId = 'child-activation-1',
  generation = 1,
  activationPurpose = OrchestrationActivationPurpose.WORK,
  invocationId = 'invocation-child-1',
} = {}) {
  return compactOrchestrationEventId(
    'subagent-task-activation-binding',
    'project-1',
    parentAgentId,
    childAgentId,
    taskId,
    taskEnvelopeId,
    planId,
    String(planRevision),
    outcomeContractId,
    String(outcomeContractRevision),
    String(controlEpoch),
    activationId,
    String(generation),
    activationPurpose,
    invocationId,
  );
}

function binding(overrides = {}) {
  return {
    schemaVersion: SUBAGENT_TASK_ACTIVATION_BINDING_VERSION,
    bindingId: canonicalBindingId(),
    projectId: 'project-1',
    parentAgentId: 'parent-1',
    childAgentId: 'child-1',
    taskId: 'task-1',
    taskEnvelopeId: 'envelope-1',
    planId: 'plan-1',
    planRevision: 3,
    outcomeContractId: 'outcome-1',
    outcomeContractRevision: 1,
    invocationId: 'invocation-child-1',
    controlEpoch: 7,
    activationId: 'child-activation-1',
    generation: 1,
    activationPurpose: OrchestrationActivationPurpose.WORK,
    boundAt: T2,
    ...overrides,
  };
}

function trustedRecord(contract, {
  status = VerificationStatus.VERIFIED,
  evidenceKind = 'ARTIFACT',
  verificationId = 'verification-1',
  reasonCode = status === VerificationStatus.VERIFIED ? 'PASS' : 'CHECK_FAILED',
} = {}) {
  const criterion = contract.completionCriteria[0];
  return {
    schemaVersion: 1,
    recordId: 'trusted-record-1',
    contractId: contract.contractId,
    contractRevision: contract.revision,
    verifierPlanId: contract.verifierPlan.planId,
    criterion: {
      criterionId: criterion.criterionId,
      description: criterion.description,
      observable: criterion.observable,
      requiredEvidenceKinds: [...criterion.requiredEvidenceKinds],
    },
    verifierId: 'verifier-1',
    verificationAuthorityId: 'verification-authority-1',
    verification: {
      schemaVersion: 1,
      verificationId,
      invocationId: 'invocation-child-1',
      observationId: 'observation-1',
      status,
      reasonCode,
      summary: '',
      evidenceArtifactIds: ['evidence-1'],
      verifiedAt: T4,
      verifierId: 'verifier-1',
      verificationAuthorityId: 'verification-authority-1',
    },
    evidenceArtifacts: [artifactRef('evidence-1', {
      kind: evidenceKind,
      sha256: '3'.repeat(64),
      createdAt: T4,
      producerInvocationId: 'verifier-invocation-1',
    })],
    recordedAt: T5,
    validThrough: '2026-09-27T11:00:00.000Z',
  };
}

function deps({
  contract,
  bindingValue = binding(),
  record = trustedRecord(contract),
  calls = {},
} = {}) {
  calls.binding ??= [];
  calls.contract ??= [];
  calls.verification ??= [];
  return {
    resolveTrustedTaskActivationBinding: async lookup => {
      calls.binding.push(lookup);
      return lookup.bindingId === bindingValue.bindingId ? bindingValue : null;
    },
    resolveTrustedOutcomeContract: async lookup => {
      calls.contract.push(lookup);
      return lookup.contractId === contract.contractId
        && lookup.contractRevision === contract.revision
        ? contract
        : null;
    },
    resolveTrustedVerificationRecord: async lookup => {
      calls.verification.push(lookup);
      return lookup.verificationId === record.verification.verificationId
        ? record
        : null;
    },
  };
}

function request({
  contract = outcomeContract(),
  result = resultEnvelope({ contract }),
  runtimeState = runtimeFixture(),
} = {}) {
  return {
    contract,
    result,
    runtimeState,
    input: {
      resultEnvelope: result,
      outcomeContract: contract,
      criterionVerifications: [{
        criterionId: 'criterion-1',
        verificationId: 'verification-1',
      }],
      evaluatedAt: T6,
      graph: runtimeState.g,
      runtime: runtimeState.runtime,
      taskActivationBindingId: canonicalBindingId(),
    },
  };
}

test('trusted result produces only an inert canonical terminal event and existing reducer owns parent reconciliation', async () => {
  const fixture = request();
  const value = await prepareSubagentResultReconciliationV1(
    fixture.input,
    deps({ contract: fixture.contract }),
  );

  assert.equal(
    value.decision,
    SubagentResultReconciliationDecision.ADMIT_TERMINAL,
  );
  assert.equal(value.reasonCode, 'TRUSTED_SUBAGENT_RESULT_TERMINAL_ADMITTED');
  assert.deepEqual(value.terminalEvent, {
    type: OrchestrationHierarchyEventType.NODE_TERMINAL,
    eventId: value.terminalEvent.eventId,
    controlEpoch: 7,
    nodeId: 'child-1',
    generation: 1,
    activationId: 'child-activation-1',
    status: 'COMPLETED',
  });
  assert.match(value.terminalEvent.eventId, /^subagent-result-terminal:/u);
  assert.equal(value.trustedVerification.verdict, 'VERIFIED');
  assert.equal(value.trustedVerification.completionEvidenceReady, true);
  assert.equal(value.terminalCommitAuthority, false);
  assert.equal(value.completionAuthority, false);
  assert.equal(value.executionAuthority, false);
  assert.equal(value.schedulingAuthority, false);
  assert.equal(value.policyAuthority, false);
  assert.equal(value.credentialAuthority, false);
  assert.equal(value.persistenceAuthority, false);
  assert.equal(value.requiresCanonicalOrchestrationReducer, true);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.terminalEvent), true);

  assert.equal(
    fixture.runtimeState.runtime.nodesById['child-1'].activationLedger[
      'child-activation-1'
    ].phase,
    OrchestrationActivationPhase.EFFECT_CONFIRMED,
  );

  const reduced = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    fixture.runtimeState.runtime,
    value.terminalEvent,
    Date.parse(T6) + 1,
  );
  assert.equal(
    reduced.runtime.nodesById['child-1'].activationLedger[
      'child-activation-1'
    ].phase,
    OrchestrationActivationPhase.TERMINAL,
  );
  assert.equal(reduced.actions.length, 1);
  assert.equal(
    reduced.actions[0].type,
    OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT,
  );
  assert.equal(reduced.actions[0].nodeId, 'parent-1');
  assert.equal(
    reduced.actions[0].purpose,
    OrchestrationActivationPurpose.RECONCILE,
  );
});

test('nested subagent reconciles upward only after its canonical RECONCILE activation is terminalized', async () => {
  const contract = outcomeContract();
  const task = taskEnvelope(contract);
  const g = nestedGraph();
  let runtime = createOrchestrationHierarchyRuntime(g, Date.parse(T0));

  runtime = reduceOrchestrationHierarchyEvent(
    g,
    runtime,
    {
      type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
      eventId: 'activate-grandchild',
      controlEpoch: 7,
      nodeId: 'grandchild-1',
      generation: 1,
      activationId: 'grandchild-activation-1',
      purpose: OrchestrationActivationPurpose.WORK,
    },
    EPOCH_T1,
  ).runtime;
  runtime = reduceOrchestrationHierarchyEvent(
    g,
    runtime,
    {
      type: OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      eventId: 'confirm-grandchild',
      controlEpoch: 7,
      nodeId: 'grandchild-1',
      generation: 1,
      activationId: 'grandchild-activation-1',
      effectRef: 'effect://grandchild',
    },
    EPOCH_T1 + 1,
  ).runtime;
  const grandchildTerminal = reduceOrchestrationHierarchyEvent(
    g,
    runtime,
    {
      type: OrchestrationHierarchyEventType.NODE_TERMINAL,
      eventId: 'terminal-grandchild',
      controlEpoch: 7,
      nodeId: 'grandchild-1',
      generation: 1,
      activationId: 'grandchild-activation-1',
      status: 'COMPLETED',
    },
    EPOCH_T1 + 2,
  );
  runtime = grandchildTerminal.runtime;

  assert.equal(grandchildTerminal.actions.length, 1);
  const childReconcileAction = grandchildTerminal.actions[0];
  assert.equal(
    childReconcileAction.type,
    OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT,
  );
  assert.equal(childReconcileAction.nodeId, 'child-1');
  assert.equal(
    childReconcileAction.purpose,
    OrchestrationActivationPurpose.RECONCILE,
  );

  runtime = reduceOrchestrationHierarchyEvent(
    g,
    runtime,
    {
      type: OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      eventId: 'confirm-child-reconcile',
      controlEpoch: 7,
      nodeId: 'child-1',
      generation: 1,
      activationId: childReconcileAction.activationId,
      effectRef: 'effect://child-reconcile',
    },
    EPOCH_T1 + 3,
  ).runtime;

  const derivedBinding = deriveSubagentTaskActivationBindingV1({
    taskEnvelope: task,
    graph: g,
    runtime,
    activationAction: childReconcileAction,
    invocationId: 'invocation-child-1',
    boundAt: T2,
  });
  assert.equal(
    derivedBinding.activationPurpose,
    OrchestrationActivationPurpose.RECONCILE,
  );

  const result = resultEnvelope({ contract });
  const input = {
    resultEnvelope: result,
    outcomeContract: contract,
    criterionVerifications: [{
      criterionId: 'criterion-1',
      verificationId: 'verification-1',
    }],
    evaluatedAt: T6,
    graph: g,
    runtime,
    taskActivationBindingId: derivedBinding.bindingId,
  };
  const value = await prepareSubagentResultReconciliationV1(
    input,
    deps({ contract, bindingValue: derivedBinding }),
  );

  assert.equal(
    value.decision,
    SubagentResultReconciliationDecision.ADMIT_TERMINAL,
  );
  assert.equal(value.terminalEvent.status, 'COMPLETED');

  const reduced = reduceOrchestrationHierarchyEvent(
    g,
    runtime,
    value.terminalEvent,
    Date.parse(T6) + 1,
  );
  assert.equal(reduced.actions.length, 1);
  assert.equal(
    reduced.actions[0].type,
    OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT,
  );
  assert.equal(reduced.actions[0].nodeId, 'parent-1');
});

test('exact retry produces the same event identity and canonical reducer deduplicates it', async () => {
  const fixture = request();
  const dependencies = deps({ contract: fixture.contract });
  const first = await prepareSubagentResultReconciliationV1(
    fixture.input,
    dependencies,
  );
  const second = await prepareSubagentResultReconciliationV1(
    fixture.input,
    dependencies,
  );
  assert.equal(first.terminalEvent.eventId, second.terminalEvent.eventId);

  const once = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    fixture.runtimeState.runtime,
    first.terminalEvent,
    Date.parse(T6) + 1,
  );
  const twice = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    once.runtime,
    second.terminalEvent,
    Date.parse(T6) + 2,
  );
  assert.equal(twice.deduplicated, true);
  assert.deepEqual(twice.actions, []);
});

test('result artifacts must be produced by the exact child invocation before trusted completion is even queried', async () => {
  const contract = outcomeContract();
  const result = resultEnvelope({
    contract,
    resultProducerInvocationId: 'invocation-old-child',
  });
  const fixture = request({ contract, result });
  const calls = {};
  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      fixture.input,
      deps({ contract, calls }),
    ),
    /producerInvocationId is not bound to the exact result invocation/u,
  );
  assert.equal(calls.binding.length, 0);
  assert.equal(calls.contract.length, 0);
  assert.equal(calls.verification.length, 0);
});

test('task activation binding is exact trusted owner state, not caller identity aliases', async () => {
  const fixture = request();
  const mismatches = [
    ['childAgentId', 'child-other'],
    ['parentAgentId', 'parent-other'],
    ['taskId', 'task-other'],
    ['taskEnvelopeId', 'envelope-other'],
    ['planRevision', 4],
    ['outcomeContractRevision', 2],
    ['invocationId', 'invocation-other'],
    ['activationId', 'child-activation-other'],
    ['generation', 2],
    ['controlEpoch', 8],
  ];

  for (const [key, value] of mismatches) {
    await assert.rejects(
      prepareSubagentResultReconciliationV1(
        fixture.input,
        deps({
          contract: fixture.contract,
          bindingValue: binding({ [key]: value }),
        }),
      ),
      /binding|controlEpoch|activationId|generation|mismatch|stale/iu,
      key,
    );
  }
});

test('stale pre-recovery binding cannot terminalize the current recovered activation', async () => {
  const fixture = request();
  let runtime = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    fixture.runtimeState.runtime,
    {
      type: OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
      eventId: 'recover-child-1',
      controlEpoch: 7,
      nodeId: 'child-1',
      generation: 1,
      newGeneration: 2,
      activationId: 'child-recovery-2',
    },
    Date.parse(T5) + 1,
  ).runtime;
  runtime = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    runtime,
    {
      type: OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      eventId: 'confirm-recovery-child-1',
      controlEpoch: 7,
      nodeId: 'child-1',
      generation: 2,
      activationId: 'child-recovery-2',
    },
    Date.parse(T5) + 2,
  ).runtime;

  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      { ...fixture.input, runtime },
      deps({ contract: fixture.contract, bindingValue: binding() }),
    ),
    /activationId is not current|generation is stale/u,
  );
});

test('paused scope and unconfirmed effect produce no terminal event', async () => {
  const unconfirmed = request({ runtimeState: runtimeFixture({ confirmEffect: false }) });
  const waiting = await prepareSubagentResultReconciliationV1(
    unconfirmed.input,
    deps({ contract: unconfirmed.contract }),
  );
  assert.equal(waiting.decision, SubagentResultReconciliationDecision.WAIT);
  assert.equal(waiting.reasonCode, 'RESULT_CHILD_EFFECT_NOT_CONFIRMED');
  assert.equal(waiting.terminalEvent, null);

  const fixture = request();
  const pausedRuntime = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    fixture.runtimeState.runtime,
    {
      type: OrchestrationHierarchyEventType.PAUSE_SCOPE,
      eventId: 'pause-parent',
      controlEpoch: 7,
      nodeId: 'parent-1',
    },
    Date.parse(T5) + 1,
  ).runtime;
  const paused = await prepareSubagentResultReconciliationV1(
    { ...fixture.input, runtime: pausedRuntime },
    deps({ contract: fixture.contract }),
  );
  assert.equal(paused.decision, SubagentResultReconciliationDecision.WAIT);
  assert.equal(paused.reasonCode, 'RESULT_CHILD_SCOPE_PAUSED');
  assert.equal(paused.terminalEvent, null);
});

test('stopped scope permanently denies late result admission instead of waiting for resume', async () => {
  const fixture = request();
  const stoppedRuntime = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    fixture.runtimeState.runtime,
    {
      type: OrchestrationHierarchyEventType.STOP_SCOPE,
      eventId: 'stop-parent',
      controlEpoch: 7,
      nodeId: 'parent-1',
    },
    Date.parse(T5) + 1,
  ).runtime;

  const stopped = await prepareSubagentResultReconciliationV1(
    { ...fixture.input, runtime: stoppedRuntime },
    deps({ contract: fixture.contract }),
  );
  assert.equal(stopped.decision, SubagentResultReconciliationDecision.DENY);
  assert.equal(stopped.reasonCode, 'RESULT_CHILD_SCOPE_STOPPED');
  assert.equal(stopped.terminalEvent, null);
  assert.equal(stopped.requiresCanonicalOrchestrationReducer, false);
});

test('raw negative observation cannot override canonical trusted outcome completion', async () => {
  const contract = outcomeContract();
  const result = resultEnvelope({
    contract,
    observationStatus: ObservationStatus.PARTIAL,
  });
  const fixture = request({ contract, result });
  const value = await prepareSubagentResultReconciliationV1(
    fixture.input,
    deps({ contract }),
  );
  assert.equal(
    value.decision,
    SubagentResultReconciliationDecision.ADMIT_TERMINAL,
  );
  assert.equal(value.reasonCode, 'TRUSTED_SUBAGENT_RESULT_TERMINAL_ADMITTED');
  assert.equal(value.trustedVerification.verdict, 'VERIFIED');
  assert.equal(value.terminalEvent.status, 'COMPLETED');
  assert.equal(value.completionAuthority, false);
});

test('canonical evidence-policy REOPEN terminalizes the failed attempt so existing parent reconciliation can replan', async () => {
  const contract = outcomeContract({ requiredEvidenceKinds: ['TEST'] });
  const result = resultEnvelope({ contract });
  const fixture = request({ contract, result });
  const record = trustedRecord(contract, { evidenceKind: 'ARTIFACT' });
  const value = await prepareSubagentResultReconciliationV1(
    fixture.input,
    deps({ contract, record }),
  );

  assert.equal(value.decision, SubagentResultReconciliationDecision.REOPEN);
  assert.equal(value.reasonCode, 'TRUSTED_OUTCOME_REOPEN_TERMINAL_ADMITTED');
  assert.equal(value.trustedVerification.verdict, 'REOPEN');
  assert.deepEqual(value.trustedVerification.reopenCriterionIds, ['criterion-1']);
  assert.equal(value.terminalEvent.status, 'FAILED');
  assert.equal(value.completionAuthority, false);
  assert.equal(value.requiresCanonicalOrchestrationReducer, true);

  const reduced = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    fixture.runtimeState.runtime,
    value.terminalEvent,
    Date.parse(T6) + 1,
  );
  assert.equal(
    reduced.runtime.nodesById['child-1'].activationLedger[
      'child-activation-1'
    ].terminalStatus,
    'FAILED',
  );
  assert.equal(reduced.actions.length, 1);
  assert.equal(
    reduced.actions[0].type,
    OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT,
  );
  assert.equal(reduced.actions[0].nodeId, 'parent-1');
});

test('raw result verification must participate in the exact trusted outcome adjudication', async () => {
  const contract = outcomeContract();
  const fixture = request({ contract });
  const other = trustedRecord(contract, { verificationId: 'verification-other' });
  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      {
        ...fixture.input,
        criterionVerifications: [{
          criterionId: 'criterion-1',
          verificationId: 'verification-other',
        }],
      },
      deps({ contract, record: other }),
    ),
    /verificationId does not participate in trusted outcome adjudication/u,
  );
});

test('trusted verification must bind the exact result invocation and observation identities', async () => {
  const contract = outcomeContract();
  const fixture = request({ contract });
  const record = trustedRecord(contract);
  record.verification.invocationId = 'invocation-other';
  record.verification.observationId = 'observation-other';

  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      fixture.input,
      deps({ contract, record }),
    ),
    /verification identity does not match its trusted canonical verification record/u,
  );
});

test('successful terminal admission requires exact trusted verification provenance', async () => {
  const contract = outcomeContract();

  for (const [name, mutate] of [
    ['authority', result => { result.verificationAuthorityId = 'verification-authority-other'; }],
    ['reason', result => { result.verificationReasonCode = 'RAW_ONLY_REASON'; }],
    ['time', result => { result.verifiedAt = '2026-09-27T10:04:30.000Z'; }],
  ]) {
    const result = structuredClone(resultEnvelope({ contract }));
    mutate(result);
    const fixture = request({ contract, result });

    await assert.rejects(
      prepareSubagentResultReconciliationV1(
        fixture.input,
        deps({ contract }),
      ),
      /Trusted completion verification provenance does not exactly match/u,
      name,
    );
  }
});

test('successful terminal admission requires exact trusted evidence IDs and ArtifactRef fingerprints', async () => {
  const contract = outcomeContract();

  const wrongId = structuredClone(resultEnvelope({ contract }));
  wrongId.evidenceArtifactRefs[0].artifactId = 'evidence-other';
  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      request({ contract, result: wrongId }).input,
      deps({ contract }),
    ),
    /Trusted completion evidence artifact IDs do not exactly match/u,
  );

  const wrongHash = structuredClone(resultEnvelope({ contract }));
  wrongHash.evidenceArtifactRefs[0].sha256 = '4'.repeat(64);
  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      request({ contract, result: wrongHash }).input,
      deps({ contract }),
    ),
    /Trusted completion evidence artifact reference does not exactly match/u,
  );
});

test('canonical trusted FAILED overrides a raw VERIFIED child claim and reconciles the failed attempt', async () => {
  const contract = outcomeContract();
  const fixture = request({ contract });
  const record = trustedRecord(contract, {
    status: VerificationStatus.FAILED,
    reasonCode: 'CHECK_FAILED',
  });

  const value = await prepareSubagentResultReconciliationV1(
    fixture.input,
    deps({ contract, record }),
  );
  assert.equal(value.decision, SubagentResultReconciliationDecision.REOPEN);
  assert.equal(value.trustedVerification.verdict, 'REOPEN');
  assert.equal(value.trustedVerification.criteria[0].verificationStatus, 'FAILED');
  assert.equal(value.trustedVerification.criteria[0].trustedReasonCode, 'CHECK_FAILED');
  assert.equal(value.terminalEvent.status, 'FAILED');
  assert.equal(value.completionAuthority, false);
});

test('terminal event identity changes when trusted adjudication changes terminal outcome', async () => {
  const contract = outcomeContract();
  const fixture = request({ contract });

  const completed = await prepareSubagentResultReconciliationV1(
    fixture.input,
    deps({ contract }),
  );
  const failed = await prepareSubagentResultReconciliationV1(
    fixture.input,
    deps({
      contract,
      record: trustedRecord(contract, {
        status: VerificationStatus.FAILED,
        reasonCode: 'CHECK_FAILED',
      }),
    }),
  );

  assert.equal(completed.terminalEvent.status, 'COMPLETED');
  assert.equal(failed.terminalEvent.status, 'FAILED');
  assert.notEqual(completed.terminalEvent.eventId, failed.terminalEvent.eventId);
});

test('result observation and completion cannot predate the trusted activation binding', async () => {
  const contract = outcomeContract();
  const fixture = request({ contract });
  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      fixture.input,
      deps({
        contract,
        bindingValue: binding({ boundAt: '2026-09-27T10:03:30.000Z' }),
      }),
    ),
    /observation predates its trusted task activation binding/u,
  );
});

test('already-terminal current activation produces no second terminal proposal', async () => {
  const fixture = request();
  const first = await prepareSubagentResultReconciliationV1(
    fixture.input,
    deps({ contract: fixture.contract }),
  );
  const terminalRuntime = reduceOrchestrationHierarchyEvent(
    fixture.runtimeState.g,
    fixture.runtimeState.runtime,
    first.terminalEvent,
    Date.parse(T6) + 1,
  ).runtime;

  const replay = await prepareSubagentResultReconciliationV1(
    { ...fixture.input, runtime: terminalRuntime },
    deps({ contract: fixture.contract }),
  );
  assert.equal(
    replay.decision,
    SubagentResultReconciliationDecision.ALREADY_TERMINAL,
  );
  assert.equal(replay.reasonCode, 'RESULT_CHILD_ACTIVATION_ALREADY_TERMINAL');
  assert.equal(replay.terminalEvent, null);
  assert.equal(replay.requiresCanonicalOrchestrationReducer, false);
});

test('task activation binding identity changes with exact task, plan and outcome semantics', () => {
  const baseline = canonicalBindingId();
  for (const variant of [
    { parentAgentId: 'parent-other' },
    { childAgentId: 'child-other' },
    { taskId: 'task-other' },
    { taskEnvelopeId: 'envelope-other' },
    { planId: 'plan-other' },
    { planRevision: 4 },
    { outcomeContractId: 'outcome-other' },
    { outcomeContractRevision: 2 },
    { activationPurpose: OrchestrationActivationPurpose.RECOVERY },
    { invocationId: 'invocation-other' },
  ]) {
    assert.notEqual(canonicalBindingId(variant), baseline);
  }

  assert.throws(
    () => normalizeTrustedSubagentTaskActivationBindingV1({
      ...binding(),
      planRevision: 4,
    }),
    /bindingId is not canonical/u,
  );

  const revised = normalizeTrustedSubagentTaskActivationBindingV1({
    ...binding(),
    planRevision: 4,
    bindingId: canonicalBindingId({ planRevision: 4 }),
  });
  assert.equal(revised.planRevision, 4);
});

test('task activation binding identity is scoped to the exact owner control epoch', () => {
  assert.notEqual(canonicalBindingId({ controlEpoch: 7 }), canonicalBindingId({ controlEpoch: 8 }));

  assert.throws(
    () => normalizeTrustedSubagentTaskActivationBindingV1({
      ...binding(),
      controlEpoch: 8,
    }),
    /bindingId is not canonical/u,
  );

  const epochEight = normalizeTrustedSubagentTaskActivationBindingV1({
    ...binding(),
    controlEpoch: 8,
    bindingId: canonicalBindingId({ controlEpoch: 8 }),
  });
  assert.equal(epochEight.controlEpoch, 8);
  assert.equal(epochEight.bindingId, canonicalBindingId({ controlEpoch: 8 }));
});

test('trusted activation binding boundary rejects authority-bearing extras and accessors without getter execution', () => {
  assert.throws(
    () => normalizeTrustedSubagentTaskActivationBindingV1({
      ...binding(),
      bindingId: 'caller-chosen-binding-id',
    }),
    /bindingId is not canonical/u,
  );

  assert.throws(
    () => normalizeTrustedSubagentTaskActivationBindingV1({
      ...binding(),
      completionAuthority: true,
    }),
    /contains unknown field: completionAuthority/u,
  );

  let reads = 0;
  const hostile = binding();
  Object.defineProperty(hostile, 'activationId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'child-activation-1';
    },
  });
  assert.throws(
    () => normalizeTrustedSubagentTaskActivationBindingV1(hostile),
    /activationId must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);
});

test('request boundary rejects unknown completion aliases and sparse criterion rows before trusted resolvers run', async () => {
  const fixture = request();
  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      { ...fixture.input, completionAuthorized: true },
      deps({ contract: fixture.contract }),
    ),
    /contains unknown field: completionAuthorized/u,
  );

  const sparse = new Array(2);
  sparse[0] = {
    criterionId: 'criterion-1',
    verificationId: 'verification-1',
  };
  const calls = {};
  await assert.rejects(
    prepareSubagentResultReconciliationV1(
      { ...fixture.input, criterionVerifications: sparse },
      deps({ contract: fixture.contract, calls }),
    ),
    /criterionVerifications must be a dense data-only array/u,
  );
  assert.equal(calls.contract.length, 0);
  assert.equal(calls.verification.length, 0);
});


test('derives task activation binding only from canonical task, reducer action and current runtime', () => {
  const contract = outcomeContract();
  const task = taskEnvelope(contract);
  const g = graph();
  let runtime = createOrchestrationHierarchyRuntime(g, Date.parse(T0));
  const prepared = reduceOrchestrationHierarchyEvent(
    g,
    runtime,
    {
      type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
      eventId: 'derive-activate-child',
      controlEpoch: 7,
      nodeId: 'child-1',
      generation: 1,
      activationId: 'child-activation-1',
      purpose: OrchestrationActivationPurpose.WORK,
    },
    EPOCH_T1,
  );
  runtime = prepared.runtime;

  const value = deriveSubagentTaskActivationBindingV1({
    taskEnvelope: task,
    graph: g,
    runtime,
    activationAction: prepared.actions[0],
    invocationId: 'invocation-child-1',
    boundAt: T2,
  });

  assert.deepEqual(value, binding());
  assert.equal(Object.isFrozen(value), true);
});

test('binding derivation rejects forged or stale activation actions and never accepts delegation as result completion', () => {
  const contract = outcomeContract();
  const task = taskEnvelope(contract);
  const g = graph();
  const initial = createOrchestrationHierarchyRuntime(g, Date.parse(T0));
  const prepared = reduceOrchestrationHierarchyEvent(
    g,
    initial,
    {
      type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
      eventId: 'derive-activate-child-2',
      controlEpoch: 7,
      nodeId: 'child-1',
      generation: 1,
      activationId: 'child-activation-1',
      purpose: OrchestrationActivationPurpose.WORK,
    },
    EPOCH_T1,
  );
  const baseInput = {
    taskEnvelope: task,
    graph: g,
    runtime: prepared.runtime,
    activationAction: prepared.actions[0],
    invocationId: 'invocation-child-1',
    boundAt: T2,
  };

  assert.throws(
    () => deriveSubagentTaskActivationBindingV1({
      ...baseInput,
      activationAction: {
        ...prepared.actions[0],
        activationId: 'forged-activation',
      },
    }),
    /not the current canonical activation/u,
  );

  assert.throws(
    () => deriveSubagentTaskActivationBindingV1({
      ...baseInput,
      activationAction: {
        ...prepared.actions[0],
        authority: 'CALLER_ASSERTED',
      },
    }),
    /not from the canonical Core session\/task path/u,
  );

  assert.throws(
    () => deriveSubagentTaskActivationBindingV1({
      ...baseInput,
      activationAction: {
        ...prepared.actions[0],
        purpose: OrchestrationActivationPurpose.DELEGATE,
      },
    }),
    /purpose cannot terminalize a result/u,
  );
});

test('binding derivation rejects ambiguous/terminal activation state and pre-activation chronology', () => {
  const contract = outcomeContract();
  const task = taskEnvelope(contract);
  const g = graph();
  const initial = createOrchestrationHierarchyRuntime(g, Date.parse(T0));
  const prepared = reduceOrchestrationHierarchyEvent(
    g,
    initial,
    {
      type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
      eventId: 'derive-activate-child-3',
      controlEpoch: 7,
      nodeId: 'child-1',
      generation: 1,
      activationId: 'child-activation-1',
      purpose: OrchestrationActivationPurpose.WORK,
    },
    EPOCH_T1,
  );
  const baseInput = {
    taskEnvelope: task,
    graph: g,
    activationAction: prepared.actions[0],
    invocationId: 'invocation-child-1',
    boundAt: T2,
  };

  assert.throws(
    () => deriveSubagentTaskActivationBindingV1({
      ...baseInput,
      runtime: prepared.runtime,
      boundAt: T0,
    }),
    /predates canonical activation preparation|predates the task envelope/u,
  );

  const ambiguous = reduceOrchestrationHierarchyEvent(
    g,
    prepared.runtime,
    {
      type: OrchestrationHierarchyEventType.NODE_EFFECT_AMBIGUOUS,
      eventId: 'derive-ambiguous',
      controlEpoch: 7,
      nodeId: 'child-1',
      generation: 1,
      activationId: 'child-activation-1',
    },
    EPOCH_T1 + 1,
  ).runtime;
  assert.throws(
    () => deriveSubagentTaskActivationBindingV1({
      ...baseInput,
      runtime: ambiguous,
    }),
    /cannot be derived from a terminal, ambiguous, or superseded activation/u,
  );
});
