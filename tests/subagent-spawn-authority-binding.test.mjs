import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationNodeLifecycle,
  createOrchestrationHierarchyRuntime,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from '../src/core/orchestration-hierarchy.js';
import { SubagentSpawnInitiator } from '../src/core/subagent-structure-policy.js';
import {
  SubagentSpawnAuthorityBindingDecision,
  bindSubagentSpawnAuthorityV1,
} from '../src/core/subagent-spawn-authority-binding.js';

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
    graphId: 'binding-graph',
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
    spawnId: overrides.spawnId || 'spawn-bind',
    nowMs: overrides.nowMs ?? 250,
  };
}

function tool(
  toolId,
  capabilityIds = ['cap.read'],
  providerId = 'provider.main',
) {
  return {
    schemaVersion: 1,
    toolId,
    providerId,
    label: toolId,
    description: '',
    capabilityIds,
    inputSchemaRef: null,
    outputSchemaRef: null,
    readOnly: true,
  };
}

function childTask(taskId, overrides = {}) {
  return {
    taskId,
    providerId: 'provider.main',
    taskRequestedCapabilityIds: ['cap.read'],
    taskSourceIds: ['source.repo'],
    taskArtifactIds: ['artifact.input'],
    requestedToolIds: ['tool.read'],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    topologyRequest: topologyRequest(),
    projectId: 'project.alpha',
    parentProviderIds: ['provider.main', 'provider.backup'],
    ownerAllowedProviderIds: ['provider.main'],
    providerCapabilities: [
      {
        providerId: 'provider.main',
        capabilityIds: ['cap.read', 'cap.write'],
      },
      {
        providerId: 'provider.backup',
        capabilityIds: ['cap.read'],
      },
    ],
    parentCapabilityIds: ['cap.read', 'cap.write', 'cap.admin'],
    ownerAllowedCapabilityIds: ['cap.read', 'cap.write'],
    parentSourceIds: ['source.repo', 'source.drive'],
    ownerAllowedSourceIds: ['source.repo', 'source.drive'],
    parentArtifactIds: ['artifact.input', 'artifact.private'],
    ownerAllowedArtifactIds: ['artifact.input', 'artifact.private'],
    parentToolIds: ['tool.read', 'tool.write'],
    ownerAllowedToolIds: ['tool.read', 'tool.write'],
    parentToolDescriptors: [
      tool('tool.read', ['cap.read']),
      tool('tool.write', ['cap.write']),
    ],
    childTasks: [childTask('task.one')],
    ...overrides,
  };
}

test('binds exact canonical topology identities to per-child least authority', () => {
  const result = bindSubagentSpawnAuthorityV1(request({
    topologyRequest: topologyRequest({ requestedChildren: 2 }),
    childTasks: [
      childTask('task.read'),
      childTask('task.write', {
        taskRequestedCapabilityIds: ['cap.write'],
        requestedToolIds: ['tool.write'],
      }),
    ],
  }));

  assert.equal(result.decision, SubagentSpawnAuthorityBindingDecision.ALLOW);
  assert.equal(result.reasonCode, 'SUBAGENT_SPAWN_AUTHORITY_BOUND');
  assert.equal(result.parentNodeId, 'root');
  assert.deepEqual(result.createdNodeIds, [
    'subagent:spawn-bind:1',
    'subagent:spawn-bind:2',
  ]);
  assert.deepEqual(
    result.authorityBindings.map(binding => ({
      childNodeId: binding.childNodeId,
      taskId: binding.taskId,
      providerId: binding.providerId,
      parentAgentId: binding.authorityEnvelope.parentAgentId,
      childAgentId: binding.authorityEnvelope.childAgentId,
    })),
    [
      {
        childNodeId: 'subagent:spawn-bind:1',
        taskId: 'task.read',
        providerId: 'provider.main',
        parentAgentId: 'root',
        childAgentId: 'subagent:spawn-bind:1',
      },
      {
        childNodeId: 'subagent:spawn-bind:2',
        taskId: 'task.write',
        providerId: 'provider.main',
        parentAgentId: 'root',
        childAgentId: 'subagent:spawn-bind:2',
      },
    ],
  );

  assert.deepEqual(
    result.authorityBindings.map(binding => binding.authorityEnvelope.capabilityIds),
    [['cap.read'], ['cap.write']],
  );
  assert.equal(result.activationAuthority, false);
  assert.equal(result.executionAuthority, false);
  assert.equal(result.credentialAuthority, false);
  assert.equal(result.policyAuthority, false);
  assert.equal(result.persistenceAuthority, false);
  assert.equal(result.schedulingAuthority, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.graph), true);
  assert.equal(Object.isFrozen(result.authorityBindings[0]), true);
  assert.equal(Object.isFrozen(result.authorityBindings[0].authorityEnvelope), true);
});

test('task/model input cannot supply parent, child or provider-capability authority aliases', () => {
  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({
      childTasks: [{
        ...childTask('task.one'),
        childAgentId: 'attacker-child',
      }],
    })),
    /childTasks\[0\] contains unknown field: childAgentId/u,
  );

  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({
      childTasks: [{
        ...childTask('task.one'),
        providerCapabilityIds: ['cap.admin'],
      }],
    })),
    /childTasks\[0\] contains unknown field: providerCapabilityIds/u,
  );

  assert.throws(
    () => bindSubagentSpawnAuthorityV1({
      ...request(),
      parentAgentId: 'attacker-parent',
    }),
    /contains unknown field: parentAgentId/u,
  );

  assert.throws(
    () => bindSubagentSpawnAuthorityV1({
      ...request(),
      topologyResult: {
        decision: 'ALLOW',
        parentNodeId: 'attacker-parent',
        createdNodeIds: ['attacker-child'],
      },
    }),
    /contains unknown field: topologyResult/u,
  );
});

test('provider capability truth is selected only from the canonical provider snapshot', () => {
  const missing = bindSubagentSpawnAuthorityV1(request({
    providerCapabilities: [{
      providerId: 'provider.backup',
      capabilityIds: ['cap.read'],
    }],
  }));
  assert.equal(missing.decision, 'DENY');
  assert.equal(missing.reasonCode, 'PROVIDER_CAPABILITY_SNAPSHOT_MISSING');
  assert.equal(missing.deniedProviderId, 'provider.main');
  assert.equal(missing.deniedChildNodeId, 'subagent:spawn-bind:1');
  assert.deepEqual(missing.createdNodeIds, []);
  assert.equal(Object.hasOwn(missing, 'graph'), false);

  const narrowed = bindSubagentSpawnAuthorityV1(request({
    providerCapabilities: [{
      providerId: 'provider.main',
      capabilityIds: ['cap.write'],
    }],
  }));
  assert.equal(narrowed.reasonCode, 'CHILD_AUTHORITY_DENIED');
  assert.equal(narrowed.childReasonCode, 'CAPABILITY_ESCALATION');
});

test('child task cardinality must exactly match the canonical created child set', () => {
  const result = bindSubagentSpawnAuthorityV1(request({
    topologyRequest: topologyRequest({ requestedChildren: 2 }),
    childTasks: [childTask('task.only')],
  }));

  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'CHILD_TASK_COUNT_MISMATCH');
  assert.equal(result.expectedChildTaskCount, 2);
  assert.equal(result.actualChildTaskCount, 1);
  assert.deepEqual(result.createdNodeIds, []);
  assert.deepEqual(result.authorityBindings, []);
  assert.deepEqual(result.activationRequests, []);
  assert.equal(Object.hasOwn(result, 'graph'), false);
  assert.equal(Object.hasOwn(result, 'runtime'), false);
});

test('one denied child fails the whole composition atomically without topology output', () => {
  const result = bindSubagentSpawnAuthorityV1(request({
    topologyRequest: topologyRequest({ requestedChildren: 2 }),
    childTasks: [
      childTask('task.allowed'),
      childTask('task.denied', {
        taskRequestedCapabilityIds: ['cap.admin'],
      }),
    ],
  }));

  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'CHILD_AUTHORITY_DENIED');
  assert.equal(result.deniedChildNodeId, 'subagent:spawn-bind:2');
  assert.equal(result.deniedTaskId, 'task.denied');
  assert.equal(result.childReasonCode, 'CAPABILITY_ESCALATION');
  assert.deepEqual(result.createdNodeIds, []);
  assert.deepEqual(result.authorityBindings, []);
  assert.deepEqual(result.activationRequests, []);
  assert.equal(Object.hasOwn(result, 'graph'), false);
  assert.equal(Object.hasOwn(result, 'runtime'), false);
});

test('provider, tool and context escalation from one child cannot survive binding', () => {
  const provider = bindSubagentSpawnAuthorityV1(request({
    childTasks: [childTask('task.provider', {
      providerId: 'provider.backup',
    })],
  }));
  assert.equal(provider.reasonCode, 'CHILD_AUTHORITY_DENIED');
  assert.equal(provider.childReasonCode, 'PROVIDER_SCOPE_ESCALATION');

  const toolEscalation = bindSubagentSpawnAuthorityV1(request({
    childTasks: [childTask('task.tool', {
      requestedToolIds: ['tool.write'],
    })],
  }));
  assert.equal(toolEscalation.childReasonCode, 'TOOL_CAPABILITY_ESCALATION');

  const sourceEscalation = bindSubagentSpawnAuthorityV1(request({
    childTasks: [childTask('task.source', {
      taskSourceIds: ['source.secret'],
    })],
  }));
  assert.equal(sourceEscalation.childReasonCode, 'CONTEXT_SOURCE_ESCALATION');
});

test('topology denial is terminal and cannot mint authority bindings', () => {
  const result = bindSubagentSpawnAuthorityV1(request({
    topologyRequest: topologyRequest({
      policy: {
        schemaVersion: 1,
        allowAgentCreatedChildren: false,
        maxDepth: 2,
        maxChildrenPerAgent: 4,
      },
    }),
  }));

  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'TOPOLOGY_DENIED');
  assert.equal(result.topologyReasonCode, 'STRUCTURE_DENIED');
  assert.deepEqual(result.authorityBindings, []);
  assert.equal(result.executionAuthority, false);
});

test('exact spawn replay reuses the same child identity and re-derives current authority', () => {
  const first = bindSubagentSpawnAuthorityV1(request());
  assert.equal(first.decision, 'ALLOW');
  assert.equal(first.reused, false);

  const second = bindSubagentSpawnAuthorityV1(request({
    topologyRequest: topologyRequest({
      graph: first.graph,
      runtime: first.runtime,
      spawnId: 'spawn-bind',
      nowMs: 300,
    }),
    ownerAllowedCapabilityIds: ['cap.read'],
    childTasks: [childTask('task.one')],
  }));

  assert.equal(second.decision, 'ALLOW');
  assert.equal(second.reused, true);
  assert.deepEqual(second.createdNodeIds, first.createdNodeIds);
  assert.equal(
    second.authorityBindings[0].authorityEnvelope.childAgentId,
    first.authorityBindings[0].authorityEnvelope.childAgentId,
  );
});

test('replay under revoked child authority fails closed even when topology already exists', () => {
  const first = bindSubagentSpawnAuthorityV1(request());
  assert.equal(first.decision, 'ALLOW');

  const revoked = bindSubagentSpawnAuthorityV1(request({
    topologyRequest: topologyRequest({
      graph: first.graph,
      runtime: first.runtime,
      spawnId: 'spawn-bind',
      nowMs: 300,
    }),
    ownerAllowedCapabilityIds: ['cap.write'],
  }));

  assert.equal(revoked.decision, 'DENY');
  assert.equal(revoked.reasonCode, 'CHILD_AUTHORITY_DENIED');
  assert.equal(revoked.childReasonCode, 'CAPABILITY_ESCALATION');
  assert.deepEqual(revoked.activationRequests, []);
  assert.equal(Object.hasOwn(revoked, 'graph'), false);
});

test('duplicate task and provider identities are rejected instead of ambiguously binding authority', () => {
  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({
      topologyRequest: topologyRequest({ requestedChildren: 2 }),
      childTasks: [
        childTask('task.same'),
        childTask('task.same'),
      ],
    })),
    /childTasks contains duplicate taskId/u,
  );

  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({
      providerCapabilities: [
        { providerId: 'provider.main', capabilityIds: ['cap.read'] },
        { providerId: 'provider.main', capabilityIds: ['cap.write'] },
      ],
    })),
    /providerCapabilities contains duplicate providerId/u,
  );
});

test('outer, child and provider snapshot boundaries reject getters, sparse arrays and symbols without reads', () => {
  let outerReads = 0;
  const outer = request();
  Object.defineProperty(outer, 'projectId', {
    enumerable: true,
    configurable: true,
    get() {
      outerReads += 1;
      return 'project.alpha';
    },
  });
  assert.throws(
    () => bindSubagentSpawnAuthorityV1(outer),
    /projectId.*enumerable own data property/u,
  );
  assert.equal(outerReads, 0);

  let childReads = 0;
  const hostileChild = childTask('task.hostile');
  Object.defineProperty(hostileChild, 'providerId', {
    enumerable: true,
    configurable: true,
    get() {
      childReads += 1;
      return 'provider.main';
    },
  });
  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({
      childTasks: [hostileChild],
    })),
    /providerId.*enumerable own data property/u,
  );
  assert.equal(childReads, 0);

  let providerReads = 0;
  const providerEntry = {
    providerId: 'provider.main',
    capabilityIds: ['cap.read'],
  };
  Object.defineProperty(providerEntry, 'capabilityIds', {
    enumerable: true,
    configurable: true,
    get() {
      providerReads += 1;
      return ['cap.read'];
    },
  });
  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({
      providerCapabilities: [providerEntry],
    })),
    /capabilityIds.*enumerable own data property/u,
  );
  assert.equal(providerReads, 0);

  const sparse = new Array(2);
  sparse[0] = childTask('task.one');
  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({ childTasks: sparse })),
    /childTasks must be a dense data-only array/u,
  );

  const symbol = request();
  symbol[Symbol('executionAuthority')] = true;
  assert.throws(
    () => bindSubagentSpawnAuthorityV1(symbol),
    /contains symbol field/u,
  );
});

test('common authority and provider capability arrays remain descriptor-safe', () => {
  let authorityReads = 0;
  const hostileAuthority = ['cap.read'];
  Object.defineProperty(hostileAuthority, '0', {
    enumerable: true,
    configurable: true,
    get() {
      authorityReads += 1;
      return 'cap.read';
    },
  });

  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({
      parentCapabilityIds: hostileAuthority,
    })),
    /parentCapabilityIds must be a dense data-only array/u,
  );
  assert.equal(authorityReads, 0);

  let providerReads = 0;
  const hostileProviderCaps = ['cap.read'];
  Object.defineProperty(hostileProviderCaps, '0', {
    enumerable: true,
    configurable: true,
    get() {
      providerReads += 1;
      return 'cap.read';
    },
  });

  assert.throws(
    () => bindSubagentSpawnAuthorityV1(request({
      providerCapabilities: [{
        providerId: 'provider.main',
        capabilityIds: hostileProviderCaps,
      }],
    })),
    /providerCapabilities\[0\]\.capabilityIds must be a dense data-only array/u,
  );
  assert.equal(providerReads, 0);
});

test('caller mutations after binding cannot widen frozen child authority', () => {
  const task = childTask('task.mutable');
  const parentCapabilities = ['cap.read', 'cap.write'];
  const providerCaps = ['cap.read', 'cap.write'];
  const descriptors = [tool('tool.read', ['cap.read'])];
  const input = request({
    parentCapabilityIds: parentCapabilities,
    providerCapabilities: [{
      providerId: 'provider.main',
      capabilityIds: providerCaps,
    }],
    parentToolDescriptors: descriptors,
    childTasks: [task],
  });

  const result = bindSubagentSpawnAuthorityV1(input);
  assert.equal(result.decision, 'ALLOW');

  parentCapabilities.push('cap.admin');
  providerCaps.push('cap.admin');
  task.taskRequestedCapabilityIds.push('cap.write');
  task.taskSourceIds.push('source.drive');
  descriptors[0].capabilityIds.push('cap.write');

  const envelope = result.authorityBindings[0].authorityEnvelope;
  assert.deepEqual(envelope.capabilityIds, ['cap.read']);
  assert.deepEqual(envelope.sourceIds, ['source.repo']);
  assert.deepEqual(envelope.toolDescriptors[0].capabilityIds, ['cap.read']);
  assert.equal(Object.isFrozen(envelope.capabilityIds), true);
  assert.equal(Object.isFrozen(envelope.toolDescriptors[0].capabilityIds), true);
});


test('child task input order cannot remap durable ordinal child identities', () => {
  const canonical = bindSubagentSpawnAuthorityV1(request({
    topologyRequest: topologyRequest({ requestedChildren: 2 }),
    childTasks: [
      childTask('task.alpha'),
      childTask('task.beta', {
        taskRequestedCapabilityIds: ['cap.write'],
        requestedToolIds: ['tool.write'],
      }),
    ],
  }));
  assert.equal(canonical.decision, 'ALLOW');

  const replay = bindSubagentSpawnAuthorityV1(request({
    topologyRequest: topologyRequest({
      graph: canonical.graph,
      runtime: canonical.runtime,
      requestedChildren: 2,
      spawnId: 'spawn-bind',
      nowMs: 300,
    }),
    childTasks: [
      childTask('task.beta', {
        taskRequestedCapabilityIds: ['cap.write'],
        requestedToolIds: ['tool.write'],
      }),
      childTask('task.alpha'),
    ],
  }));
  assert.equal(replay.decision, 'ALLOW');
  assert.equal(replay.reused, true);
  assert.deepEqual(
    replay.authorityBindings.map(binding => [binding.childNodeId, binding.taskId]),
    [
      ['subagent:spawn-bind:1', 'task.alpha'],
      ['subagent:spawn-bind:2', 'task.beta'],
    ],
  );
});
