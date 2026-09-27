import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentExecutionPlane,
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from '../src/core/agent-plan.js';
import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import {
  OrchestrationHierarchyActionType,
  OrchestrationNodeLifecycle,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from '../src/core/orchestration-hierarchy.js';
import {
  deriveSubagentTaskActivationBindingV1,
} from '../src/core/subagent-result-reconciliation.js';
import {
  createSubagentTaskActivationBindingRegistryV1,
  putSubagentTaskActivationBindingV1,
  resolveSubagentTaskActivationBindingV1,
} from '../src/core/subagent-task-activation-binding-registry.js';
import {
  SubagentSpawnTaskBindingDecision,
  bindSubagentSpawnTaskAuthorityV1,
} from '../src/core/subagent-spawn-task-binding.js';
import { SubagentSpawnInitiator } from '../src/core/subagent-structure-policy.js';

const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T10:01:00.000Z';
const T2 = '2026-09-27T10:02:00.000Z';
const T3 = '2026-09-27T10:03:00.000Z';

function node(id, parentId = null, childIds = []) {
  return {
    id,
    parentId,
    childIds,
    promptProfileId: 'worker',
    recoveryPromptProfileId: 'recovery',
    chatMode: 'NEW_CHAT_PER_ACTIVATION',
    maxActiveChildren: childIds.length,
    barrier: childIds.length
      ? { mode: 'ALL_DIRECT_CHILDREN', childIds }
      : { mode: 'NONE', childIds: [] },
    providerBinding: null,
  };
}

function graph() {
  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'spawn-task-binding-graph',
    controlEpoch: 4,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [
      { id: 'worker', role: 'worker', version: 1, prompt: 'work' },
      { id: 'recovery', role: 'recovery', version: 1, prompt: 'recover' },
    ],
    nodes: [node('root')],
  });
}

function runtimeFor(canonicalGraph) {
  const runtime = createOrchestrationHierarchyRuntime(canonicalGraph, 100);
  runtime.nodesById.root.lifecycle = OrchestrationNodeLifecycle.ACTIVE;
  runtime.nodesById.root.scopeState = 'RUNNING';
  return validateOrchestrationHierarchyRuntimeV1(canonicalGraph, runtime);
}

function tool(toolId = 'tool.read') {
  return {
    schemaVersion: 1,
    toolId,
    providerId: 'provider.main',
    label: toolId,
    description: '',
    capabilityIds: ['cap.read'],
    inputSchemaRef: null,
    outputSchemaRef: null,
    readOnly: true,
  };
}

function artifactRef(artifactId = 'artifact.input') {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'ARTIFACT',
    uri: 'artifact://' + artifactId,
    mediaType: 'application/json',
    sha256: 'a'.repeat(64),
    sizeBytes: 64,
    createdAt: T0,
    producerInvocationId: 'parent-input',
    sensitive: false,
  };
}

function plan(childId, taskId = 'task.one') {
  return normalizeAgentPlanV1({
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'Complete parent goal.',
    successCriteria: ['Verified child result exists'],
    nodes: [{
      nodeId: taskId,
      title: 'Child task',
      objective: 'Produce the verified artifact.',
      dependsOn: [],
      conflictKeys: ['artifact:result'],
      ownerId: childId,
      executionPlane: AgentExecutionPlane.CLOUD,
      acceptanceCriteria: ['Child result is complete.'],
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
}

function outcome(childId, sourceIds = ['source.repo']) {
  return createOutcomeContractV1({
    contractId: 'outcome-1',
    projectId: 'project.alpha',
    desiredResult: 'Return one independently verified child artifact.',
    completionCriteria: [{
      criterionId: 'criterion-1',
      description: 'Child result is complete.',
      observable: 'Immutable result evidence exists.',
      requiredEvidenceKinds: ['ARTIFACT'],
    }],
    constraints: [],
    sourceTruth: sourceIds.map(sourceId => ({
      sourceId,
      location: 'project://' + sourceId,
      revisionId: 'rev-1',
      purpose: 'Canonical task source.',
    })),
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
      actorId: childId,
      verifierId: 'verifier-1',
      criterionIds: ['criterion-1'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
      verificationAuthority: 'EXTERNAL_REQUIRED',
    },
    triggerRefs: [],
    createdAt: T0,
  });
}

function spawnAuthorityRequest(overrides = {}) {
  const canonicalGraph = overrides.graph || graph();
  return {
    topologyRequest: {
      graph: canonicalGraph,
      runtime: overrides.runtime || runtimeFor(canonicalGraph),
      policy: {
        schemaVersion: 1,
        allowAgentCreatedChildren: true,
        maxDepth: 2,
        maxChildrenPerAgent: 4,
      },
      initiator: SubagentSpawnInitiator.AGENT,
      parentNodeId: 'root',
      requestedChildren: 1,
      resourceBudget: { maxChildAgents: 8 },
      spawnId: 'spawn-bind',
      nowMs: overrides.nowMs ?? 250,
    },
    projectId: 'project.alpha',
    parentProviderIds: ['provider.main'],
    ownerAllowedProviderIds: ['provider.main'],
    providerCapabilities: [{
      providerId: 'provider.main',
      capabilityIds: ['cap.read'],
    }],
    parentCapabilityIds: ['cap.read'],
    ownerAllowedCapabilityIds: ['cap.read'],
    parentSourceIds: ['source.repo', 'source.drive'],
    ownerAllowedSourceIds: ['source.repo', 'source.drive'],
    parentArtifactIds: ['artifact.input', 'artifact.other'],
    ownerAllowedArtifactIds: ['artifact.input', 'artifact.other'],
    parentToolIds: ['tool.read'],
    ownerAllowedToolIds: ['tool.read'],
    parentToolDescriptors: [tool()],
    childTasks: [{
      taskId: 'task.one',
      providerId: 'provider.main',
      taskRequestedCapabilityIds: ['cap.read'],
      taskSourceIds: ['source.repo'],
      taskArtifactIds: ['artifact.input'],
      requestedToolIds: ['tool.read'],
    }],
    ...(overrides.priorTaskBindings ? { priorTaskBindings: overrides.priorTaskBindings } : {}),
  };
}

function taskSpec(childId = 'subagent:spawn-bind:1', overrides = {}) {
  return {
    taskId: 'task.one',
    envelopeId: 'envelope-1',
    plan: plan(childId),
    nodeId: 'task.one',
    inputSourceIds: ['source.repo'],
    inputArtifactRefs: [artifactRef()],
    outcomeContract: outcome(childId),
    createdAt: T2,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    spawnAuthorityRequest: spawnAuthorityRequest(overrides.spawn || {}),
    taskEnvelopeSpecs: overrides.taskEnvelopeSpecs || [taskSpec()],
  };
}

test('composes canonical spawned child identity, least authority and immutable task envelope', () => {
  const result = bindSubagentSpawnTaskAuthorityV1(request());

  assert.equal(result.decision, SubagentSpawnTaskBindingDecision.ALLOW);
  assert.equal(result.reasonCode, 'SUBAGENT_SPAWN_TASK_AUTHORITY_BOUND');
  assert.deepEqual(result.createdNodeIds, ['subagent:spawn-bind:1']);
  assert.equal(result.taskEnvelopes.length, 1);
  const envelope = result.taskEnvelopes[0];
  assert.equal(envelope.projectId, 'project.alpha');
  assert.equal(envelope.parentAgentId, 'root');
  assert.equal(envelope.childAgentId, 'subagent:spawn-bind:1');
  assert.equal(envelope.taskId, 'task.one');
  assert.deepEqual(envelope.inputSourceRefs.map(ref => ref.sourceId), ['source.repo']);
  assert.deepEqual(envelope.inputArtifactRefs.map(ref => ref.artifactId), ['artifact.input']);
  assert.equal(envelope.executionAuthority, false);
  assert.equal(envelope.completionAuthority, false);
  assert.equal(result.activationAuthority, false);
  assert.equal(result.persistenceAuthority, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(envelope), true);
});

test('task spec cannot inject parent or child identity authority aliases', () => {
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(request({
      taskEnvelopeSpecs: [{ ...taskSpec(), childAgentId: 'attacker' }],
    })),
    /unknown field: childAgentId/u,
  );
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(request({
      taskEnvelopeSpecs: [{ ...taskSpec(), parentAgentId: 'attacker' }],
    })),
    /unknown field: parentAgentId/u,
  );
});

test('AgentPlan owner and OutcomeContract actor must be the exact canonical spawned child', () => {
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(request({
      taskEnvelopeSpecs: [taskSpec('attacker-child')],
    })),
    /exact AgentPlan node owner binding|actor must be the exact child Agent/u,
  );
});

test('task input sources cannot drift from the already-derived child authority envelope', () => {
  const result = bindSubagentSpawnTaskAuthorityV1(request({
    taskEnvelopeSpecs: [taskSpec('subagent:spawn-bind:1', {
      inputSourceIds: ['source.drive'],
      outcomeContract: outcome('subagent:spawn-bind:1', ['source.repo', 'source.drive']),
    })],
  }));
  assert.equal(result.decision, SubagentSpawnTaskBindingDecision.DENY);
  assert.equal(result.reasonCode, 'TASK_SOURCE_AUTHORITY_MISMATCH');
  assert.deepEqual(result.taskEnvelopes, []);
});

test('task input artifacts cannot drift from the already-derived child authority envelope', () => {
  const result = bindSubagentSpawnTaskAuthorityV1(request({
    taskEnvelopeSpecs: [taskSpec('subagent:spawn-bind:1', {
      inputArtifactRefs: [artifactRef('artifact.other')],
    })],
  }));
  assert.equal(result.decision, SubagentSpawnTaskBindingDecision.DENY);
  assert.equal(result.reasonCode, 'TASK_ARTIFACT_AUTHORITY_MISMATCH');
  assert.deepEqual(result.taskEnvelopes, []);
});

test('exact topology replay preserves child↔task identity only with prior durable task-binding evidence', () => {
  const first = bindSubagentSpawnTaskAuthorityV1(request());
  assert.equal(first.decision, SubagentSpawnTaskBindingDecision.ALLOW);

  const replay = bindSubagentSpawnTaskAuthorityV1({
    spawnAuthorityRequest: spawnAuthorityRequest({
      graph: first.graph,
      runtime: first.runtime,
      nowMs: 300,
      priorTaskBindings: first.taskBindings,
    }),
    taskEnvelopeSpecs: [taskSpec()],
  });
  assert.equal(replay.decision, SubagentSpawnTaskBindingDecision.ALLOW);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.createdNodeIds, first.createdNodeIds);
  assert.equal(replay.taskEnvelopes[0].childAgentId, first.taskEnvelopes[0].childAgentId);
});

test('canonical activation action derives and persists exact task↔activation↔invocation binding', () => {
  const composed = bindSubagentSpawnTaskAuthorityV1(request());
  const activationRequest = composed.activationRequests[0];
  assert.ok(activationRequest);

  const activated = reduceOrchestrationHierarchyEvent(
    composed.graph,
    composed.runtime,
    activationRequest,
    251,
  );
  const action = activated.actions.find(
    item => item.type === OrchestrationHierarchyActionType.ACTIVATE_NODE,
  );
  assert.ok(action);

  const binding = deriveSubagentTaskActivationBindingV1({
    taskEnvelope: composed.taskEnvelopes[0],
    graph: composed.graph,
    runtime: activated.runtime,
    activationAction: action,
    invocationId: 'invocation-child-1',
    boundAt: T3,
  });
  assert.equal(binding.childAgentId, 'subagent:spawn-bind:1');
  assert.equal(binding.taskId, 'task.one');
  assert.equal(binding.activationId, action.activationId);
  assert.equal(binding.invocationId, 'invocation-child-1');

  const registry = putSubagentTaskActivationBindingV1(
    createSubagentTaskActivationBindingRegistryV1(),
    { binding, registeredAt: T3 },
  );
  assert.deepEqual(
    resolveSubagentTaskActivationBindingV1(registry, { bindingId: binding.bindingId }),
    binding,
  );
});
