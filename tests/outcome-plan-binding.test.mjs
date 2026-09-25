import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import {
  assessAgentPlanOutcomeBindingV1,
  projectOutcomePlanningEnvelopeV1,
} from '../src/core/outcome-plan-binding.js';

const CONTRACT_AT = '2026-09-25T12:00:00.000Z';
const PLAN_AT = '2026-09-25T12:01:00.000Z';

function outcome(overrides = {}) {
  return createOutcomeContractV1({
    contractId: 'outcome-plan-1',
    projectId: 'project-1',
    desiredResult: 'Ship the capability with canonical evidence.',
    completionCriteria: [
      {
        criterionId: 'criterion-b',
        description: 'Second criterion.',
        observable: 'Second canonical observation is present.',
        requiredEvidenceKinds: ['test-report'],
      },
      {
        criterionId: 'criterion-a',
        description: 'First criterion.',
        observable: 'First canonical observation is present.',
        requiredEvidenceKinds: ['artifact'],
      },
    ],
    constraints: ['Do not create authority #2.'],
    sourceTruth: [{
      sourceId: 'source-main',
      location: 'github://owner/repo/main',
      revisionId: 'main-sha-1',
      purpose: 'Canonical implementation truth.',
    }],
    allowedAuthority: [{
      authorityId: 'authority-repo-write',
      scopeId: 'scope-repo',
      purpose: 'Existing canonical executor may mutate admitted files.',
    }],
    budgetBoundaries: {
      maxModelCalls: 50,
      maxRuntimeSeconds: 7_200,
      maxCostUsdMicros: 5_000_000,
      maxConcurrency: 2,
    },
    deliverables: [
      {
        deliverableId: 'deliverable-a',
        kind: 'code-change',
        description: 'Implementation artifact.',
        criterionIds: ['criterion-a'],
      },
      {
        deliverableId: 'deliverable-b',
        kind: 'test-report',
        description: 'Verification artifact.',
        criterionIds: ['criterion-b'],
      },
    ],
    verifierPlan: {
      planId: 'verify-plan-1',
      actorId: 'actor-1',
      verifierId: 'verifier-1',
      criterionIds: ['criterion-a', 'criterion-b'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
    },
    triggerRefs: [{ triggerId: 'trigger-manual', kind: 'manual' }],
    createdAt: CONTRACT_AT,
    ...overrides,
  });
}

function node(nodeId, acceptanceCriteria, budget = {}) {
  return {
    nodeId,
    title: nodeId,
    objective: `Execute ${nodeId}`,
    dependsOn: [],
    conflictKeys: [],
    ownerId: 'actor-1',
    executionPlane: 'BROWSER',
    acceptanceCriteria,
    budget: {
      maxModelCalls: 10,
      maxRuntimeSeconds: 60,
      maxCostUsdMicros: 200_000,
      ...budget,
    },
    state: 'PENDING',
    evidence: '',
    updatedAt: PLAN_AT,
  };
}

function plan(contract = outcome(), overrides = {}) {
  const projected = projectOutcomePlanningEnvelopeV1(contract);
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: projected.objective,
    successCriteria: projected.successCriteria,
    nodes: [
      node('node-a', [projected.successCriteria[0]]),
      node('node-b', [projected.successCriteria[1]]),
    ],
    createdAt: PLAN_AT,
    updatedAt: PLAN_AT,
    revision: 1,
    ...overrides,
  };
}

test('projects the complete Outcome Contract planning envelope without granting authority', () => {
  const contract = outcome();
  const projected = projectOutcomePlanningEnvelopeV1(contract);

  assert.equal(projected.contractId, contract.contractId);
  assert.equal(projected.contractRevision, contract.revision);
  assert.equal(projected.objective, contract.desiredResult);
  assert.deepEqual(projected.successCriteria, [
    'criterion-a: First canonical observation is present.',
    'criterion-b: Second canonical observation is present.',
  ]);
  assert.deepEqual(projected.resourceEnvelope, {
    maxModelCalls: 50,
    maxRuntimeSeconds: 7_200,
    maxCostUsdMicros: 5_000_000,
  });
  assert.equal(projected.maxConcurrency, 2);
  assert.equal(projected.sourceTruth[0].revisionId, 'main-sha-1');
  assert.equal(projected.authorityRequirements[0].authorityEffect, 'REQUIREMENT_ONLY');
  assert.equal(projected.verifierPlan.verificationAuthority, 'EXTERNAL_REQUIRED');
  assert.equal(projected.triggerRefs[0].schedulingAuthority, 'REFERENCE_ONLY');
  assert.equal(projected.advisoryOnly, true);
  assert.equal(projected.planningAuthorized, false);
  assert.equal(projected.policyDecisionGranted, false);
  assert.equal(projected.executionAuthorized, false);
  assert.equal(projected.completionAuthorized, false);
  assert.equal(projected.requiresCanonicalBudgetEnforcement, true);
  assert.equal(projected.requiresCanonicalConcurrencyEnforcement, true);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.resourceEnvelope), true);
});

test('binds an exact compatible AgentPlan and reports criterion coverage plus aggregate budget', () => {
  const contract = outcome();
  const result = assessAgentPlanOutcomeBindingV1(contract, plan(contract));

  assert.equal(result.bindingStatus, 'STRUCTURALLY_BOUND');
  assert.deepEqual(result.criterionCoverage, [
    {
      criterionId: 'criterion-a',
      planningCriterion: 'criterion-a: First canonical observation is present.',
      nodeIds: ['node-a'],
    },
    {
      criterionId: 'criterion-b',
      planningCriterion: 'criterion-b: Second canonical observation is present.',
      nodeIds: ['node-b'],
    },
  ]);
  assert.deepEqual(result.aggregateBudget, {
    maxModelCalls: 20,
    maxRuntimeSeconds: 120,
    maxCostUsdMicros: 400_000,
  });
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.requiresCanonicalVerifier, true);
});

test('rejects objective or success-criterion drift from the exact Outcome Contract', () => {
  const contract = outcome();
  assert.throws(
    () => assessAgentPlanOutcomeBindingV1(contract, plan(contract, { objective: 'Different objective' })),
    /objective does not match/u,
  );

  const projected = projectOutcomePlanningEnvelopeV1(contract);
  assert.throws(
    () => assessAgentPlanOutcomeBindingV1(contract, plan(contract, {
      successCriteria: [...projected.successCriteria].reverse(),
    })),
    /successCriteria do not match/u,
  );
});

test('requires every Outcome criterion to be covered by at least one AgentPlan node', () => {
  const contract = outcome();
  const projected = projectOutcomePlanningEnvelopeV1(contract);
  assert.throws(
    () => assessAgentPlanOutcomeBindingV1(contract, plan(contract, {
      nodes: [node('node-a', [projected.successCriteria[0]])],
    })),
    /criterion-b/u,
  );
});

test('rejects AgentPlan aggregate budget that exceeds the Outcome resource boundary', () => {
  const contract = outcome();
  const projected = projectOutcomePlanningEnvelopeV1(contract);
  assert.throws(
    () => assessAgentPlanOutcomeBindingV1(contract, plan(contract, {
      nodes: [
        node('node-a', [projected.successCriteria[0]], { maxModelCalls: 50 }),
        node('node-b', [projected.successCriteria[1]], { maxModelCalls: 1 }),
      ],
    })),
    /maxModelCalls/u,
  );
});

test('rejects an AgentPlan created before its Outcome Contract', () => {
  const contract = outcome();
  assert.throws(
    () => assessAgentPlanOutcomeBindingV1(contract, plan(contract, {
      createdAt: '2026-09-25T11:59:59.000Z',
      updatedAt: '2026-09-25T11:59:59.000Z',
      nodes: plan(contract).nodes.map(item => ({
        ...item,
        updatedAt: '2026-09-25T11:59:59.000Z',
      })),
    })),
    /cannot predate/u,
  );
});
