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
import { SubagentSpawnInitiator } from '../src/core/subagent-structure-policy.js';
import {
  SubagentSpawnTaskBindingDecision,
  bindSubagentSpawnTaskAuthorityV1,
} from '../src/core/subagent-spawn-task-binding.js';

const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T10:01:00.000Z';
const T2 = '2026-09-27T10:02:00.000Z';
const CHILD_ID = 'subagent:spawn-task:1';

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

function graph(nodes = [node('root')]) {
  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'spawn-task-graph',
    controlEpoch: 4,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [
      { id: 'worker', role: 'worker', version: 1, prompt: 'work' },
      { id: 'recovery', role: 'recovery', version: 1, prompt: 'recover' },
    ],
    nodes,
  });
}

function runtimeFor(canonicalGraph) {
  const runtime = createOrchestrationHierarchyRuntime(canonicalGraph, 100);
  runtime.nodesById.root.lifecycle = OrchestrationNodeLifecycle.ACTIVE;
  runtime.nodesById.root.scopeState = 'RUNNING';
  return validateOrchestrationHierarchyRuntimeV1(canonicalGraph, runtime);
}

function topologyRequest(overrides = {}) {
  const canonicalGraph = overrides.graph || graph();
  return {
    graph: canonicalGraph,
    runtime: overrides.runtime || runtimeFor(canonicalGraph),
    policy: overrides.policy || {
      schemaVersion: 1,
      allowAgentCreatedChildren: true,
      maxDepth: 2,
      maxChildrenPerAgent: 4,
    },
    initiator: overrides.initiator || SubagentSpawnInitiator.AGENT,
    parentNodeId: overrides.parentNodeId || 'root',
    requestedChildren: overrides.requestedChildren || 1,
    resourceBudget: overrides.resourceBudget || { maxChildAgents: 8 },
    spawnId: overrides.spawnId || 'spawn-task',
    nowMs: overrides.nowMs ?? 250,
  };
}

function tool(toolId) {
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

function authorityRequest(overrides = {}) {
  return {
    topologyRequest: topologyRequest(),
    projectId: 'project.alpha',
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
    parentToolDescriptors: [tool('tool.read')],
    childTasks: [{
      taskId: 'task.one',
      providerId: 'provider.main',
      taskRequestedCapabilityIds: ['cap.read'],
      taskSourceIds: ['source.repo'],
      taskArtifactIds: ['artifact.input'],
      requestedToolIds: ['tool.read'],
    }],
    ...overrides,
  };
}

function plan(overrides = {}) {
  return normalizeAgentPlanV1({
    schemaVersion: 1,
    planId: 'plan.spawn-task',
    jobId: 'job.spawn-task',
    objective: 'Complete delegated child work.',
    successCriteria: ['Verified child artifact'],
    nodes: [{
      nodeId: 'task.one',
      title: 'Produce verified artifact',
      objective: 'Produce the verified child artifact.',
      dependsOn: [],
      conflictKeys: ['artifact:report'],
      ownerId: CHILD_ID,
      executionPlane: AgentExecutionPlane.CLOUD,
      acceptanceCriteria: ['Artifact is complete'],
      budget: {
        maxModelCalls: 10,
        maxRuntimeSeconds: 300,
        maxCostUsdMicros: 1000,
      },
      state: AgentPlanNodeState.READY,
      evidence: '',
      updatedAt: T1,
      ...(overrides.node || {}),
    }],
    createdAt: T0,
    updatedAt: T1,
    revision: 3,
    ...(overrides.plan || {}),
  });
}

function outcome(overrides = {}) {
  return createOutcomeContractV1({
    contractId: overrides.contractId || 'outcome.spawn-task',
    projectId: 'project.alpha',
    desiredResult: overrides.desiredResult || 'A verified child artifact.',
    completionCriteria: [{
      criterionId: 'criterion.complete',
      description: 'Artifact is complete',
      observable: 'The immutable artifact exists.',
      requiredEvidenceKinds: ['artifact'],
    }],
    constraints: [],
    sourceTruth: [{
      sourceId: overrides.sourceId || 'source.repo',
      location: 'project://source.repo',
      revisionId: 'rev-1',
      purpose: 'Canonical child source.',
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
      deliverableId: 'deliverable.child',
      kind: 'artifact',
      description: 'Child artifact.',
      criterionIds: ['criterion.complete'],
    }],
    verifierPlan: {
      planId: 'verify.spawn-task',
      actorId: overrides.actorId || CHILD_ID,
      verifierId: 'verifier.main',
      criterionIds: ['criterion.complete'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
      verificationAuthority: 'EXTERNAL_REQUIRED',
    },
    triggerRefs: [],
    createdAt: T0,
  });
}

function artifactRef(artifactId = 'artifact.input') {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'document',
    uri: 'artifact://' + artifactId,
    mediaType: 'text/plain',
    sha256: 'a'.repeat(64),
    sizeBytes: 12,
    createdAt: T0,
    producerInvocationId: 'invocation-1',
    sensitive: false,
  };
}

function taskEnvelopeSpec(overrides = {}) {
  return {
    taskId: 'task.one',
    envelopeId: 'envelope.task.one',
    inputSourceIds: ['source.repo'],
    inputArtifactRefs: [artifactRef()],
    outcomeContract: outcome(),
    createdAt: T2,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    authorityRequest: authorityRequest(),
    plan: plan(),
    taskEnvelopes: [taskEnvelopeSpec()],
    ...overrides,
  };
}

test('atomically binds canonical spawn identity, least authority and concrete child task contract', () => {
  const result = bindSubagentSpawnTaskAuthorityV1(request());

  assert.equal(result.decision, SubagentSpawnTaskBindingDecision.ALLOW);
  assert.equal(result.reasonCode, 'SUBAGENT_SPAWN_TASK_AUTHORITY_BOUND');
  assert.equal(result.parentNodeId, 'root');
  assert.deepEqual(result.createdNodeIds, [CHILD_ID]);
  assert.equal(result.taskBindings.length, 1);
  assert.deepEqual(
    result.authorityTaskBindings,
    [{
      childNodeId: CHILD_ID,
      projectId: 'project.alpha',
      taskId: 'task.one',
      providerId: 'provider.main',
      taskRequestedCapabilityIds: ['cap.read'],
      taskSourceIds: ['source.repo'],
      taskArtifactIds: ['artifact.input'],
      requestedToolIds: ['tool.read'],
    }],
  );
  assert.equal(result.taskEnvelopeBindings.length, 1);
  assert.equal(result.taskEnvelopeBindings[0].childNodeId, CHILD_ID);
  assert.equal(result.taskEnvelopeBindings[0].taskId, 'task.one');
  assert.equal(
    result.taskEnvelopeBindings[0].taskEnvelope,
    result.taskBindings[0].taskEnvelope,
  );
  assert.equal(
    result.taskEnvelopeBindings[0].taskEnvelope.outcome.contractId,
    'outcome.spawn-task',
  );
  assert.equal(
    result.taskEnvelopeBindings[0].taskEnvelope.planRevision,
    3,
  );
  assert.equal(Object.isFrozen(result.authorityTaskBindings), true);
  assert.equal(Object.isFrozen(result.taskEnvelopeBindings), true);
  assert.equal(Object.isFrozen(result.taskEnvelopeBindings[0]), true);
  assert.equal(Object.isFrozen(result.taskEnvelopeBindings[0].taskEnvelope), true);
  const binding = result.taskBindings[0];
  assert.equal(binding.childNodeId, CHILD_ID);
  assert.equal(binding.taskId, 'task.one');
  assert.equal(binding.authorityEnvelope.parentAgentId, 'root');
  assert.equal(binding.authorityEnvelope.childAgentId, CHILD_ID);
  assert.equal(binding.taskEnvelope.parentAgentId, 'root');
  assert.equal(binding.taskEnvelope.childAgentId, CHILD_ID);
  assert.equal(binding.taskEnvelope.taskId, 'task.one');
  assert.deepEqual(binding.taskEnvelope.inputSourceRefs.map(item => item.sourceId), ['source.repo']);
  assert.deepEqual(binding.taskEnvelope.inputArtifactRefs.map(item => item.artifactId), ['artifact.input']);
  assert.equal(result.activationAuthority, false);
  assert.equal(result.executionAuthority, false);
  assert.equal(result.credentialAuthority, false);
  assert.equal(result.policyAuthority, false);
  assert.equal(result.persistenceAuthority, false);
  assert.equal(result.schedulingAuthority, false);
  assert.equal(result.completionAuthority, false);
  assert.equal(result.verificationAuthority, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(binding.taskEnvelope), true);
});

test('task envelope specs cannot inject parent or child identity aliases', () => {
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(request({
      taskEnvelopes: [{
        ...taskEnvelopeSpec(),
        childAgentId: 'attacker',
      }],
    })),
    /contains unknown field: childAgentId/u,
  );

  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1({
      ...request(),
      parentAgentId: 'attacker',
    }),
    /contains unknown field: parentAgentId/u,
  );
});

test('canonical AgentPlan owner and OutcomeContract actor must match the child created by topology', () => {
  const wrongOwner = bindSubagentSpawnTaskAuthorityV1(request({
    plan: plan({ node: { ownerId: 'other-child' } }),
  }));
  assert.equal(wrongOwner.decision, 'DENY');
  assert.equal(wrongOwner.reasonCode, 'TASK_ENVELOPE_REJECTED');
  assert.deepEqual(wrongOwner.createdNodeIds, []);
  assert.equal(Object.hasOwn(wrongOwner, 'graph'), false);

  const wrongActor = bindSubagentSpawnTaskAuthorityV1(request({
    taskEnvelopes: [taskEnvelopeSpec({
      outcomeContract: outcome({ actorId: 'other-child' }),
    })],
  }));
  assert.equal(wrongActor.reasonCode, 'TASK_ENVELOPE_REJECTED');
  assert.equal(Object.hasOwn(wrongActor, 'runtime'), false);
});

test('task sources and artifacts cannot escape the already-derived child authority envelope', () => {
  const sourceDrift = bindSubagentSpawnTaskAuthorityV1(request({
    taskEnvelopes: [taskEnvelopeSpec({
      inputSourceIds: ['source.secret'],
      outcomeContract: outcome({ sourceId: 'source.secret' }),
    })],
  }));
  assert.equal(sourceDrift.decision, 'DENY');
  assert.equal(sourceDrift.reasonCode, 'TASK_INPUT_AUTHORITY_DRIFT');
  assert.deepEqual(sourceDrift.taskBindings, []);
  assert.equal(Object.hasOwn(sourceDrift, 'graph'), false);

  const artifactDrift = bindSubagentSpawnTaskAuthorityV1(request({
    taskEnvelopes: [taskEnvelopeSpec({
      inputArtifactRefs: [artifactRef('artifact.secret')],
    })],
  }));
  assert.equal(artifactDrift.reasonCode, 'TASK_INPUT_AUTHORITY_DRIFT');
  assert.equal(Object.hasOwn(artifactDrift, 'activationRequests'), true);
  assert.deepEqual(artifactDrift.activationRequests, []);
});

test('task cardinality and task identity must exactly cover canonical authority bindings', () => {
  const none = bindSubagentSpawnTaskAuthorityV1(request({ taskEnvelopes: [] }));
  assert.equal(none.reasonCode, 'TASK_ENVELOPE_COUNT_MISMATCH');
  assert.equal(none.expectedTaskEnvelopeCount, 1);
  assert.equal(none.actualTaskEnvelopeCount, 0);

  const missing = bindSubagentSpawnTaskAuthorityV1(request({
    taskEnvelopes: [{
      ...taskEnvelopeSpec(),
      taskId: 'task.other',
    }],
  }));
  assert.equal(missing.reasonCode, 'TASK_ENVELOPE_MISSING');
  assert.equal(missing.deniedTaskId, 'task.one');

  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(request({
      taskEnvelopes: [taskEnvelopeSpec(), taskEnvelopeSpec({
        envelopeId: 'envelope.duplicate',
      })],
    })),
    /duplicate taskId/u,
  );
});

test('upstream spawn/authority denial exposes no topology or task contract proposal', () => {
  const result = bindSubagentSpawnTaskAuthorityV1(request({
    authorityRequest: authorityRequest({
      ownerAllowedCapabilityIds: [],
    }),
  }));

  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'SPAWN_AUTHORITY_DENIED');
  assert.equal(result.authorityReasonCode, 'CHILD_AUTHORITY_DENIED');
  assert.deepEqual(result.createdNodeIds, []);
  assert.deepEqual(result.authorityBindings, []);
  assert.deepEqual(result.taskBindings, []);
  assert.deepEqual(result.activationRequests, []);
  assert.equal(Object.hasOwn(result, 'graph'), false);
  assert.equal(Object.hasOwn(result, 'runtime'), false);
});

test('exact spawn replay round-trips canonical authority and task-envelope evidence', () => {
  const first = bindSubagentSpawnTaskAuthorityV1(request());
  assert.equal(first.decision, 'ALLOW');

  const replayAuthority = authorityRequest({
    topologyRequest: topologyRequest({
      graph: first.graph,
      runtime: first.runtime,
      nowMs: 300,
    }),
    priorTaskBindings: first.authorityTaskBindings,
  });
  const replay = bindSubagentSpawnTaskAuthorityV1(request({
    authorityRequest: replayAuthority,
    priorTaskEnvelopeBindings: first.taskEnvelopeBindings,
  }));

  assert.equal(replay.decision, 'ALLOW');
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.createdNodeIds, [CHILD_ID]);
  assert.deepEqual(replay.authorityTaskBindings, first.authorityTaskBindings);
  assert.deepEqual(replay.taskEnvelopeBindings, first.taskEnvelopeBindings);
  assert.equal(replay.taskBindings[0].taskEnvelope.childAgentId, CHILD_ID);

  const narrowed = bindSubagentSpawnTaskAuthorityV1(request({
    authorityRequest: authorityRequest({
      topologyRequest: topologyRequest({
        graph: first.graph,
        runtime: first.runtime,
        nowMs: 300,
      }),
      priorTaskBindings: first.authorityTaskBindings,
      ownerAllowedSourceIds: [],
    }),
    priorTaskEnvelopeBindings: first.taskEnvelopeBindings,
  }));
  assert.equal(narrowed.decision, 'DENY');
  assert.equal(narrowed.reasonCode, 'SPAWN_AUTHORITY_DENIED');
});

test('replay requires upstream child-task evidence and does not mask task-set drift', () => {
  const first = bindSubagentSpawnTaskAuthorityV1(request());

  const missing = bindSubagentSpawnTaskAuthorityV1(request({
    authorityRequest: authorityRequest({
      topologyRequest: topologyRequest({
        graph: first.graph,
        runtime: first.runtime,
        nowMs: 300,
      }),
    }),
    priorTaskEnvelopeBindings: first.taskEnvelopeBindings,
  }));
  assert.equal(missing.decision, 'DENY');
  assert.equal(missing.reasonCode, 'SPAWN_AUTHORITY_DENIED');
  assert.equal(
    missing.authorityReasonCode,
    'REPLAY_TASK_BINDING_EVIDENCE_REQUIRED',
  );

  const drift = bindSubagentSpawnTaskAuthorityV1(request({
    authorityRequest: authorityRequest({
      topologyRequest: topologyRequest({
        graph: first.graph,
        runtime: first.runtime,
        nowMs: 300,
      }),
      priorTaskBindings: first.authorityTaskBindings,
      childTasks: [{
        ...authorityRequest().childTasks[0],
        taskId: 'task.other',
      }],
    }),
    priorTaskEnvelopeBindings: first.taskEnvelopeBindings,
  }));
  assert.equal(drift.decision, 'DENY');
  assert.equal(drift.reasonCode, 'SPAWN_AUTHORITY_DENIED');
  assert.equal(drift.authorityReasonCode, 'REPLAY_TASK_BINDING_MISMATCH');
});

test('replay cannot replace durable task envelope, plan revision or OutcomeContract identity', () => {
  const first = bindSubagentSpawnTaskAuthorityV1(request());
  const replayAuthority = authorityRequest({
    topologyRequest: topologyRequest({
      graph: first.graph,
      runtime: first.runtime,
      nowMs: 300,
    }),
    priorTaskBindings: first.authorityTaskBindings,
  });

  for (const [name, overrides] of [
    ['envelope', {
      taskEnvelopes: [taskEnvelopeSpec({ envelopeId: 'envelope.changed' })],
    }],
    ['outcome', {
      taskEnvelopes: [taskEnvelopeSpec({
        outcomeContract: outcome({ contractId: 'outcome.changed' }),
      })],
    }],
    ['plan-revision', {
      plan: plan({ plan: { revision: 4 } }),
    }],
  ]) {
    const value = bindSubagentSpawnTaskAuthorityV1(request({
      ...overrides,
      authorityRequest: replayAuthority,
      priorTaskEnvelopeBindings: first.taskEnvelopeBindings,
    }));
    assert.equal(value.decision, 'DENY', name);
    assert.equal(
      value.reasonCode,
      'REPLAY_TASK_ENVELOPE_BINDING_MISMATCH',
      name,
    );
    assert.deepEqual(value.createdNodeIds, [], name);
    assert.equal(Object.hasOwn(value, 'graph'), false, name);
  }
});

test('replay rejects same-identity semantic drift inside the canonical task envelope', () => {
  const first = bindSubagentSpawnTaskAuthorityV1(request());
  const replayAuthority = authorityRequest({
    topologyRequest: topologyRequest({
      graph: first.graph,
      runtime: first.runtime,
      nowMs: 300,
    }),
    priorTaskBindings: first.authorityTaskBindings,
  });

  const cases = [
    ['artifact-hash', {
      taskEnvelopes: [taskEnvelopeSpec({
        inputArtifactRefs: [{
          ...artifactRef(),
          sha256: 'b'.repeat(64),
        }],
      })],
    }],
    ['objective', {
      plan: plan({ node: { objective: 'Different delegated objective.' } }),
    }],
    ['outcome-semantics', {
      taskEnvelopes: [taskEnvelopeSpec({
        outcomeContract: outcome({
          desiredResult: 'A materially different verified result.',
        }),
      })],
    }],
  ];

  for (const [name, overrides] of cases) {
    const value = bindSubagentSpawnTaskAuthorityV1(request({
      ...overrides,
      authorityRequest: replayAuthority,
      priorTaskEnvelopeBindings: first.taskEnvelopeBindings,
    }));
    assert.equal(value.decision, 'DENY', name);
    assert.equal(
      value.reasonCode,
      'REPLAY_TASK_ENVELOPE_BINDING_MISMATCH',
      name,
    );
    assert.equal(Object.hasOwn(value, 'graph'), false, name);
  }
});

test('prior task-envelope replay evidence is descriptor-safe and identity-bound', () => {
  const first = bindSubagentSpawnTaskAuthorityV1(request());
  const replayAuthority = authorityRequest({
    topologyRequest: topologyRequest({
      graph: first.graph,
      runtime: first.runtime,
      nowMs: 300,
    }),
    priorTaskBindings: first.authorityTaskBindings,
  });

  let reads = 0;
  const hostile = {
    childNodeId: CHILD_ID,
    taskId: 'task.one',
    taskEnvelope: first.taskEnvelopeBindings[0].taskEnvelope,
  };
  Object.defineProperty(hostile, 'taskEnvelope', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return first.taskEnvelopeBindings[0].taskEnvelope;
    },
  });
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(request({
      authorityRequest: replayAuthority,
      priorTaskEnvelopeBindings: [hostile],
    })),
    /taskEnvelope must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);

  const mismatched = {
    ...first.taskEnvelopeBindings[0],
    childNodeId: 'subagent:other:1',
  };
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(request({
      authorityRequest: replayAuthority,
      priorTaskEnvelopeBindings: [mismatched],
    })),
    /task envelope identity mismatch/u,
  );
});

test('prior task-envelope evidence is forbidden on initial child creation', () => {
  const initial = bindSubagentSpawnTaskAuthorityV1(request());
  const unexpected = bindSubagentSpawnTaskAuthorityV1(request({
    priorTaskEnvelopeBindings: initial.taskEnvelopeBindings,
  }));
  assert.equal(unexpected.decision, 'DENY');
  assert.equal(
    unexpected.reasonCode,
    'UNEXPECTED_PRIOR_TASK_ENVELOPE_BINDING_EVIDENCE',
  );
});

test('boundary rejects accessors, sparse arrays, symbols and duplicate envelope IDs without reading getters', () => {
  let reads = 0;
  const getter = request();
  Object.defineProperty(getter, 'plan', {
    enumerable: true,
    get() {
      reads += 1;
      return plan();
    },
  });
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(getter),
    /must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);

  const sparse = request();
  sparse.taskEnvelopes = new Array(2);
  sparse.taskEnvelopes[0] = taskEnvelopeSpec();
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(sparse),
    /dense data-only array/u,
  );

  const symbol = request();
  symbol[Symbol('authority')] = true;
  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(symbol),
    /contains symbol field/u,
  );

  assert.throws(
    () => bindSubagentSpawnTaskAuthorityV1(request({
      authorityRequest: authorityRequest({
        topologyRequest: topologyRequest({ requestedChildren: 2 }),
        childTasks: [
          authorityRequest().childTasks[0],
          {
            ...authorityRequest().childTasks[0],
            taskId: 'task.two',
          },
        ],
      }),
      taskEnvelopes: [
        taskEnvelopeSpec(),
        {
          ...taskEnvelopeSpec(),
          taskId: 'task.two',
        },
      ],
    })),
    /duplicate envelopeId/u,
  );
});
