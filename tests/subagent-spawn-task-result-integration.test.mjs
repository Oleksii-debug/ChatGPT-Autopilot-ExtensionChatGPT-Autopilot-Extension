import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentExecutionPlane,
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from '../src/core/agent-plan.js';
import {
  OrchestrationNodeLifecycle,
  createOrchestrationHierarchyRuntime,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from '../src/core/orchestration-hierarchy.js';
import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import { createSubagentResultEnvelopeV1 } from '../src/core/subagent-result-envelope.js';
import { bindSubagentSpawnTaskAuthorityV1 } from '../src/core/subagent-spawn-task-binding.js';
import { SubagentSpawnInitiator } from '../src/core/subagent-structure-policy.js';
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
const CHILD_ID = 'subagent:e2e-spawn:1';

function node(id) {
  return {
    id,
    parentId: null,
    childIds: [],
    promptProfileId: 'worker',
    recoveryPromptProfileId: 'recovery',
    chatMode: 'NEW_CHAT_PER_ACTIVATION',
    maxActiveChildren: 0,
    barrier: { mode: 'NONE', childIds: [] },
    providerBinding: null,
  };
}

function canonicalGraph() {
  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'e2e-subagent-graph',
    controlEpoch: 9,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [
      { id: 'worker', role: 'worker', version: 1, prompt: 'work' },
      { id: 'recovery', role: 'recovery', version: 1, prompt: 'recover' },
    ],
    nodes: [node('root')],
  });
}

function topologyRequest() {
  const graph = canonicalGraph();
  const runtime = createOrchestrationHierarchyRuntime(graph, 100);
  runtime.nodesById.root.lifecycle = OrchestrationNodeLifecycle.ACTIVE;
  runtime.nodesById.root.scopeState = 'RUNNING';
  return {
    graph,
    runtime: validateOrchestrationHierarchyRuntimeV1(graph, runtime),
    policy: {
      schemaVersion: 1,
      allowAgentCreatedChildren: true,
      maxDepth: 2,
      maxChildrenPerAgent: 2,
    },
    initiator: SubagentSpawnInitiator.AGENT,
    parentNodeId: 'root',
    requestedChildren: 1,
    resourceBudget: { maxChildAgents: 4 },
    spawnId: 'e2e-spawn',
    nowMs: 250,
  };
}

function tool() {
  return {
    schemaVersion: 1,
    toolId: 'tool.read',
    providerId: 'provider.main',
    label: 'Read',
    description: '',
    capabilityIds: ['cap.read'],
    inputSchemaRef: null,
    outputSchemaRef: null,
    readOnly: true,
  };
}

function plan() {
  return normalizeAgentPlanV1({
    schemaVersion: 1,
    planId: 'plan.e2e',
    jobId: 'job.e2e',
    objective: 'Complete parent goal.',
    successCriteria: ['Child result is independently verified'],
    nodes: [{
      nodeId: 'task.e2e',
      title: 'Child task',
      objective: 'Produce the bounded child artifact.',
      dependsOn: [],
      conflictKeys: ['artifact:result'],
      ownerId: CHILD_ID,
      executionPlane: AgentExecutionPlane.CLOUD,
      acceptanceCriteria: ['Result artifact is complete'],
      budget: {
        maxModelCalls: 8,
        maxRuntimeSeconds: 180,
        maxCostUsdMicros: 800,
      },
      state: AgentPlanNodeState.READY,
      evidence: '',
      updatedAt: T1,
    }],
    createdAt: T0,
    updatedAt: T1,
    revision: 5,
  });
}

function outcome() {
  return createOutcomeContractV1({
    contractId: 'outcome.e2e',
    projectId: 'project.e2e',
    desiredResult: 'A verified result artifact.',
    completionCriteria: [{
      criterionId: 'criterion.complete',
      description: 'Result artifact is complete',
      observable: 'The immutable result artifact exists.',
      requiredEvidenceKinds: ['artifact'],
    }],
    constraints: [],
    sourceTruth: [{
      sourceId: 'source.repo',
      location: 'project://source.repo',
      revisionId: 'rev-1',
      purpose: 'Canonical child input.',
    }],
    allowedAuthority: [],
    budgetBoundaries: {
      maxModelCalls: 4,
      maxRuntimeSeconds: 90,
      maxCostUsdMicros: 400,
      maxConcurrency: 1,
      enforcementAuthority: 'NONE',
    },
    deliverables: [{
      deliverableId: 'deliverable.result',
      kind: 'artifact',
      description: 'Result artifact.',
      criterionIds: ['criterion.complete'],
    }],
    verifierPlan: {
      planId: 'verify.e2e',
      actorId: CHILD_ID,
      verifierId: 'verifier.e2e',
      criterionIds: ['criterion.complete'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
      verificationAuthority: 'EXTERNAL_REQUIRED',
    },
    triggerRefs: [],
    createdAt: T0,
  });
}

function artifactRef(artifactId, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'document',
    uri: 'artifact://' + artifactId,
    mediaType: 'text/plain',
    sha256: overrides.sha256 || 'a'.repeat(64),
    sizeBytes: 12,
    createdAt: overrides.createdAt || T0,
    producerInvocationId: overrides.producerInvocationId || 'invocation.e2e',
    sensitive: false,
  };
}

function spawnTask() {
  return bindSubagentSpawnTaskAuthorityV1({
    authorityRequest: {
      topologyRequest: topologyRequest(),
      projectId: 'project.e2e',
      parentProviderIds: ['provider.main'],
      ownerAllowedProviderIds: ['provider.main'],
      providerCapabilities: [{
        providerId: 'provider.main',
        capabilityIds: ['cap.read'],
      }],
      parentCapabilityIds: ['cap.read'],
      ownerAllowedCapabilityIds: ['cap.read'],
      parentSourceIds: ['source.repo'],
      ownerAllowedSourceIds: ['source.repo'],
      parentArtifactIds: ['artifact.input'],
      ownerAllowedArtifactIds: ['artifact.input'],
      parentToolIds: ['tool.read'],
      ownerAllowedToolIds: ['tool.read'],
      parentToolDescriptors: [tool()],
      childTasks: [{
        taskId: 'task.e2e',
        providerId: 'provider.main',
        taskRequestedCapabilityIds: ['cap.read'],
        taskSourceIds: ['source.repo'],
        taskArtifactIds: ['artifact.input'],
        requestedToolIds: ['tool.read'],
      }],
    },
    plan: plan(),
    taskEnvelopes: [{
      taskId: 'task.e2e',
      envelopeId: 'envelope.e2e',
      inputSourceIds: ['source.repo'],
      inputArtifactRefs: [
        artifactRef('artifact.input', { sha256: '1'.repeat(64) }),
      ],
      outcomeContract: outcome(),
      createdAt: T2,
    }],
  });
}

test('canonical spawn/task output is directly consumable by immutable result handback contract', () => {
  const spawn = spawnTask();
  assert.equal(spawn.decision, 'ALLOW');
  const taskEnvelope = spawn.taskBindings[0].taskEnvelope;

  const result = createSubagentResultEnvelopeV1({
    resultId: 'result.e2e',
    taskEnvelope,
    observation: {
      schemaVersion: 1,
      observationId: 'observation.e2e',
      invocationId: 'invocation.e2e',
      status: ObservationStatus.OK,
      summary: 'Child produced result artifact.',
      data: {
        transcript: 'must not cross the immutable handback boundary',
        internalState: 'private',
      },
      artifactRefs: [
        artifactRef('artifact.result', {
          sha256: '2'.repeat(64),
          createdAt: T3,
        }),
      ],
      observedAt: T3,
    },
    verification: {
      schemaVersion: 1,
      verificationId: 'verification.e2e',
      invocationId: 'invocation.e2e',
      observationId: 'observation.e2e',
      status: VerificationStatus.VERIFIED,
      reasonCode: 'INDEPENDENT_CHECK_PASS',
      summary: 'Verifier confirmed exact child observation.',
      evidenceArtifactIds: ['artifact.evidence'],
      verifiedAt: T4,
      verifierId: 'verifier.e2e',
      verificationAuthorityId: 'authority.verify.e2e',
      effectId: null,
      executionId: null,
      attempt: 1,
    },
    evidenceArtifactRefs: [
      artifactRef('artifact.evidence', {
        sha256: '3'.repeat(64),
        createdAt: T4,
        producerInvocationId: 'invocation.verifier.e2e',
      }),
    ],
    completedAt: T5,
  });

  assert.equal(result.projectId, 'project.e2e');
  assert.equal(result.parentAgentId, 'root');
  assert.equal(result.childAgentId, CHILD_ID);
  assert.equal(result.taskId, 'task.e2e');
  assert.equal(result.envelopeId, 'envelope.e2e');
  assert.equal(result.outcomeContractId, 'outcome.e2e');
  assert.equal(result.verifierId, 'verifier.e2e');
  assert.equal(result.verificationProvenance, 'UNVERIFIED_INPUT');
  assert.equal(result.trustedVerificationRequired, true);
  assert.deepEqual(result.resultArtifactRefs.map(item => item.artifactId), ['artifact.result']);
  assert.deepEqual(result.evidenceArtifactRefs.map(item => item.artifactId), ['artifact.evidence']);
  assert.equal(JSON.stringify(result).includes('must not cross'), false);
  assert.equal(result.executionAuthority, false);
  assert.equal(result.schedulingAuthority, false);
  assert.equal(result.policyAuthority, false);
  assert.equal(result.credentialAuthority, false);
  assert.equal(result.completionAuthority, false);
  assert.equal(Object.isFrozen(result), true);
});

test('result handback cannot rebind a canonical child task to a different verifier', () => {
  const spawn = spawnTask();
  const taskEnvelope = spawn.taskBindings[0].taskEnvelope;

  assert.throws(
    () => createSubagentResultEnvelopeV1({
      resultId: 'result.bad-verifier',
      taskEnvelope,
      observation: {
        schemaVersion: 1,
        observationId: 'observation.bad-verifier',
        invocationId: 'invocation.bad-verifier',
        status: ObservationStatus.OK,
        summary: 'Child produced result artifact.',
        data: {},
        artifactRefs: [
          artifactRef('artifact.result', {
            sha256: '2'.repeat(64),
            createdAt: T3,
            producerInvocationId: 'invocation.bad-verifier',
          }),
        ],
        observedAt: T3,
      },
      verification: {
        schemaVersion: 1,
        verificationId: 'verification.bad-verifier',
        invocationId: 'invocation.bad-verifier',
        observationId: 'observation.bad-verifier',
        status: VerificationStatus.VERIFIED,
        reasonCode: 'INDEPENDENT_CHECK_PASS',
        summary: 'Wrong verifier attempted handback.',
        evidenceArtifactIds: ['artifact.evidence'],
        verifiedAt: T4,
        verifierId: 'verifier.other',
        verificationAuthorityId: 'authority.verify.other',
        effectId: null,
        executionId: null,
        attempt: 1,
      },
      evidenceArtifactRefs: [
        artifactRef('artifact.evidence', {
          sha256: '3'.repeat(64),
          createdAt: T4,
          producerInvocationId: 'invocation.verifier.other',
        }),
      ],
      completedAt: T5,
    }),
    /verifier does not match task outcome verifier/u,
  );
});


test('canonical handback rejects a result artifact produced by a different invocation', () => {
  const spawn = spawnTask();
  assert.equal(spawn.decision, 'ALLOW');
  const taskEnvelope = spawn.taskBindings[0].taskEnvelope;

  assert.throws(
    () => createSubagentResultEnvelopeV1({
      resultId: 'result.foreign-producer',
      taskEnvelope,
      observation: {
        schemaVersion: 1,
        observationId: 'observation.foreign-producer',
        invocationId: 'invocation.e2e',
        status: ObservationStatus.OK,
        summary: 'Child observation with a foreign-produced artifact.',
        data: {},
        artifactRefs: [
          artifactRef('artifact.foreign-result', {
            sha256: '4'.repeat(64),
            createdAt: T3,
            producerInvocationId: 'invocation.other',
          }),
        ],
        observedAt: T3,
      },
      verification: {
        schemaVersion: 1,
        verificationId: 'verification.foreign-producer',
        invocationId: 'invocation.e2e',
        observationId: 'observation.foreign-producer',
        status: VerificationStatus.VERIFIED,
        reasonCode: 'INDEPENDENT_CHECK_PASS',
        summary: 'Verifier input cannot repair foreign result provenance.',
        evidenceArtifactIds: ['artifact.foreign-evidence'],
        verifiedAt: T4,
        verifierId: 'verifier.e2e',
        verificationAuthorityId: 'authority.verify.e2e',
        effectId: null,
        executionId: null,
        attempt: 1,
      },
      evidenceArtifactRefs: [
        artifactRef('artifact.foreign-evidence', {
          sha256: '5'.repeat(64),
          createdAt: T4,
          producerInvocationId: 'invocation.verifier.e2e',
        }),
      ],
      completedAt: T5,
    }),
    /producerInvocationId must match child invocation/u,
  );
});
