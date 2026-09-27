import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentExecutionPlane,
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from '../src/core/agent-plan.js';
import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import {
  SUBAGENT_TASK_ENVELOPE_VERSION,
  createSubagentTaskEnvelopeV1,
  normalizeSubagentTaskEnvelopeV1,
} from '../src/core/subagent-task-envelope.js';

const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T10:01:00.000Z';
const T2 = '2026-09-27T10:02:00.000Z';

function plan(overrides = {}) {
  const node = {
    nodeId: 'task-1',
    title: 'Produce verified report',
    objective: 'Produce the child report from the admitted source.',
    dependsOn: [],
    conflictKeys: ['artifact:report'],
    ownerId: 'child-1',
    executionPlane: AgentExecutionPlane.CLOUD,
    acceptanceCriteria: ['Report artifact is complete'],
    budget: {
      maxModelCalls: 10,
      maxRuntimeSeconds: 300,
      maxCostUsdMicros: 1_000,
    },
    state: AgentPlanNodeState.READY,
    evidence: '',
    updatedAt: T1,
    ...(overrides.node || {}),
  };
  return normalizeAgentPlanV1({
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'Complete the parent goal.',
    successCriteria: ['Child result verified'],
    nodes: [node],
    createdAt: T0,
    updatedAt: T1,
    revision: 7,
    ...(overrides.plan || {}),
  });
}

function outcome(overrides = {}) {
  const criterionDescription = overrides.criterionDescription || 'Report artifact is complete';
  return createOutcomeContractV1({
    contractId: 'outcome-1',
    projectId: overrides.projectId ?? 'project-1',
    desiredResult: 'A verified report artifact.',
    completionCriteria: [{
      criterionId: 'criterion-1',
      description: criterionDescription,
      observable: 'The immutable report artifact is present and reviewable.',
      requiredEvidenceKinds: ['artifact'],
    }],
    constraints: [],
    sourceTruth: [{
      sourceId: 'source-1',
      location: 'project://source-1',
      revisionId: 'rev-1',
      purpose: 'Authoritative child input.',
    }],
    allowedAuthority: [],
    budgetBoundaries: {
      maxModelCalls: overrides.maxModelCalls ?? 5,
      maxRuntimeSeconds: overrides.maxRuntimeSeconds ?? 120,
      maxCostUsdMicros: overrides.maxCostUsdMicros ?? 500,
      maxConcurrency: 1,
      enforcementAuthority: 'NONE',
    },
    deliverables: [{
      deliverableId: 'deliverable-report',
      kind: 'artifact',
      description: 'Final report artifact.',
      criterionIds: ['criterion-1'],
    }],
    verifierPlan: {
      planId: 'verify-1',
      actorId: overrides.actorId ?? 'child-1',
      verifierId: overrides.verifierId ?? 'verifier-1',
      criterionIds: ['criterion-1'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
      verificationAuthority: 'EXTERNAL_REQUIRED',
    },
    triggerRefs: [],
    createdAt: overrides.createdAt ?? T0,
  });
}

function request(overrides = {}) {
  return {
    envelopeId: 'envelope-1',
    projectId: 'project-1',
    parentAgentId: 'parent-1',
    childAgentId: 'child-1',
    plan: plan(),
    nodeId: 'task-1',
    inputSourceIds: ['source-1'],
    inputArtifactIds: ['artifact-input-2', 'artifact-input-1'],
    outcomeContract: outcome(),
    createdAt: T2,
    ...overrides,
  };
}

test('binds exact child task, immutable input refs, budget, conflicts and outcome contract without authority', () => {
  const value = createSubagentTaskEnvelopeV1(request());

  assert.equal(value.schemaVersion, SUBAGENT_TASK_ENVELOPE_VERSION);
  assert.equal(value.envelopeId, 'envelope-1');
  assert.equal(value.projectId, 'project-1');
  assert.equal(value.parentAgentId, 'parent-1');
  assert.equal(value.childAgentId, 'child-1');
  assert.equal(value.taskId, 'task-1');
  assert.equal(value.planId, 'plan-1');
  assert.equal(value.planRevision, 7);
  assert.equal(value.objective, 'Produce the child report from the admitted source.');
  assert.deepEqual(value.conflictKeys, ['artifact:report']);
  assert.deepEqual(value.budget, {
    maxModelCalls: 10,
    maxRuntimeSeconds: 300,
    maxCostUsdMicros: 1_000,
  });
  assert.deepEqual(value.inputSourceIds, ['source-1']);
  assert.deepEqual(value.inputArtifactIds, ['artifact-input-1', 'artifact-input-2']);
  assert.deepEqual(value.outcome, {
    contractId: 'outcome-1',
    contractRevision: 1,
    desiredResult: 'A verified report artifact.',
    criterionIds: ['criterion-1'],
    deliverableIds: ['deliverable-report'],
    verifierId: 'verifier-1',
    requiredEvidenceArtifactCount: 1,
  });
  assert.equal(value.executionAuthority, false);
  assert.equal(value.schedulingAuthority, false);
  assert.equal(value.policyAuthority, false);
  assert.equal(value.credentialAuthority, false);
  assert.equal(value.completionAuthority, false);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.budget), true);
  assert.equal(Object.isFrozen(value.outcome), true);
});

test('normalization is restart-stable and rejects any attempt to mint authority', () => {
  const value = createSubagentTaskEnvelopeV1(request());
  assert.deepEqual(normalizeSubagentTaskEnvelopeV1(structuredClone(value)), value);

  for (const key of [
    'executionAuthority',
    'schedulingAuthority',
    'policyAuthority',
    'credentialAuthority',
    'completionAuthority',
  ]) {
    const forged = structuredClone(value);
    forged[key] = true;
    assert.throws(
      () => normalizeSubagentTaskEnvelopeV1(forged),
      new RegExp('cannot grant ' + key),
    );
  }

  const unknown = structuredClone(value);
  unknown.schedulerId = 'scheduler-2';
  assert.throws(
    () => normalizeSubagentTaskEnvelopeV1(unknown),
    /contains unknown field: schedulerId/,
  );
});

test('exact project, child actor and existing AgentPlan owner are binding', () => {
  assert.throws(
    () => createSubagentTaskEnvelopeV1(request({
      outcomeContract: outcome({ projectId: 'project-other' }),
    })),
    /OutcomeContract project mismatch/,
  );
  assert.throws(
    () => createSubagentTaskEnvelopeV1(request({
      outcomeContract: outcome({ actorId: 'other-agent' }),
    })),
    /actor must be the exact child Agent/,
  );
  assert.throws(
    () => createSubagentTaskEnvelopeV1(request({
      plan: plan({ node: { ownerId: 'other-agent' } }),
    })),
    /child identity does not match AgentPlan node owner/,
  );
  assert.throws(
    () => createSubagentTaskEnvelopeV1(request({ childAgentId: 'parent-1' })),
    /child identity must differ from parent/,
  );
});

test('child task cannot amplify the AgentPlan node budget through its OutcomeContract', () => {
  for (const [field, patch] of [
    ['maxModelCalls', { maxModelCalls: 11 }],
    ['maxRuntimeSeconds', { maxRuntimeSeconds: 301 }],
    ['maxCostUsdMicros', { maxCostUsdMicros: 1_001 }],
  ]) {
    assert.throws(
      () => createSubagentTaskEnvelopeV1(request({
        outcomeContract: outcome(patch),
      })),
      new RegExp('budget exceeds child task budget: ' + field),
    );
  }
});

test('OutcomeContract must cover existing AgentPlan acceptance criteria', () => {
  assert.throws(
    () => createSubagentTaskEnvelopeV1(request({
      outcomeContract: outcome({ criterionDescription: 'A different success claim' }),
    })),
    /does not cover AgentPlan acceptance criterion/,
  );
});

test('input source refs must be declared by OutcomeContract source truth while artifact refs stay opaque', () => {
  assert.throws(
    () => createSubagentTaskEnvelopeV1(request({
      inputSourceIds: ['source-unknown'],
    })),
    /input source is not bound to OutcomeContract sourceTruth/,
  );

  const value = createSubagentTaskEnvelopeV1(request({
    inputArtifactIds: ['artifact:opaque:1'],
  }));
  assert.deepEqual(value.inputArtifactIds, ['artifact:opaque:1']);
});

test('envelope chronology cannot predate either exact AgentPlan revision or OutcomeContract', () => {
  assert.throws(
    () => createSubagentTaskEnvelopeV1(request({ createdAt: T0 })),
    /cannot predate AgentPlan revision/,
  );

  assert.throws(
    () => createSubagentTaskEnvelopeV1(request({
      outcomeContract: outcome({ createdAt: T2 }),
      createdAt: T1,
    })),
    /cannot predate OutcomeContract/,
  );
});

test('only READY or RUNNING canonical plan work can be bound to a child task', () => {
  for (const state of [
    AgentPlanNodeState.PENDING,
    AgentPlanNodeState.BLOCKED,
    AgentPlanNodeState.VERIFIED,
    AgentPlanNodeState.FAILED,
    AgentPlanNodeState.CANCELLED,
  ]) {
    assert.throws(
      () => createSubagentTaskEnvelopeV1(request({
        plan: plan({ node: { state } }),
      })),
      /must be READY or RUNNING/,
    );
  }

  assert.doesNotThrow(() => createSubagentTaskEnvelopeV1(request({
    plan: plan({ node: { state: AgentPlanNodeState.RUNNING } }),
  })));
});

test('request and nested ref boundaries reject accessors, sparse arrays, symbols and hidden authority', () => {
  let getterReads = 0;
  const getterRequest = request();
  Object.defineProperty(getterRequest, 'childAgentId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'child-1';
    },
  });
  assert.throws(
    () => createSubagentTaskEnvelopeV1(getterRequest),
    /must be an enumerable own data property/,
  );
  assert.equal(getterReads, 0);

  const sparse = request();
  sparse.inputArtifactIds = new Array(2);
  sparse.inputArtifactIds[0] = 'artifact-1';
  assert.throws(
    () => createSubagentTaskEnvelopeV1(sparse),
    /dense data-only array/,
  );

  const symbolRequest = request();
  symbolRequest[Symbol('authority')] = true;
  assert.throws(
    () => createSubagentTaskEnvelopeV1(symbolRequest),
    /contains symbol field/,
  );

  const hidden = request();
  Object.defineProperty(hidden, 'schedulerId', {
    value: 'scheduler-2',
    enumerable: false,
  });
  assert.throws(
    () => createSubagentTaskEnvelopeV1(hidden),
    /contains unknown field: schedulerId/,
  );
});

test('caller-owned arrays and canonical inputs cannot mutate the frozen derived envelope', () => {
  const raw = request();
  const value = createSubagentTaskEnvelopeV1(raw);

  raw.inputArtifactIds.push('artifact-late');
  raw.inputSourceIds[0] = 'source-late';
  assert.deepEqual(value.inputArtifactIds, ['artifact-input-1', 'artifact-input-2']);
  assert.deepEqual(value.inputSourceIds, ['source-1']);
});
