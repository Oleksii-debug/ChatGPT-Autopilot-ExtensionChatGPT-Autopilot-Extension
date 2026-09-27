import {
  OrchestrationActivationPurpose,
  OrchestrationBarrierMode,
  OrchestrationHierarchyEventType,
  OrchestrationNodeLifecycle,
  compactOrchestrationEventId,
  createOrchestrationHierarchyRuntime,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from './orchestration-hierarchy.js';
import {
  ResourceBudgetDecisionKind,
  evaluateResourceBudgetV1,
} from './resource-budget-governor.js';
import {
  SubagentSpawnInitiator,
  SubagentStructureDecision,
  evaluateSubagentStructureAdmissionV1,
} from './subagent-structure-policy.js';

/**
 * Pure topology mutation authority for bounded subagent creation.
 *
 * This module does not persist, schedule, activate, or execute children. The
 * canonical Orchestration V2 owner must call it inside its serialized durable
 * runtime mutation, supplying owner-controlled policy and resource budget.
 * Successful output is restart-valid graph/runtime state that can then flow
 * through the existing hierarchy reducer and scheduler.
 */
export const SUBAGENT_TOPOLOGY_MUTATION_VERSION = 1;

export const SubagentTopologyMutationDecision = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
});

const INPUT_KEYS = new Set([
  'graph',
  'runtime',
  'policy',
  'initiator',
  'parentNodeId',
  'requestedChildren',
  'resourceBudget',
  'spawnId',
  'nowMs',
]);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(label + ' contains symbol field');
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(value, key, fallback = undefined) {
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function requiredId(value, label, max = 120) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > max
      || value.trim() !== value
      || !/^[A-Za-z0-9._:@/+-]+$/u.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function graphDocument(graph) {
  return {
    schemaVersion: graph.schemaVersion,
    graphId: graph.graphId,
    controlEpoch: graph.controlEpoch,
    loopPolicy: clone(graph.loopPolicy),
    promptProfiles: clone(graph.promptProfiles),
    nodes: graph.nodeOrder.map(nodeId => clone(graph.nodesById[nodeId])),
  };
}

function childIdsForSpawn(spawnId, requestedChildren) {
  return Array.from(
    { length: requestedChildren },
    (_, index) => 'subagent:' + spawnId + ':' + (index + 1),
  );
}

function activationRequestsForSpawn(graph, spawnId, childNodeIds) {
  return childNodeIds.map((nodeId, index) => ({
    type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    eventId: compactOrchestrationEventId(
      'subagent-spawn',
      graph.graphId,
      spawnId,
      nodeId,
      1,
    ),
    controlEpoch: graph.controlEpoch,
    nodeId,
    generation: 1,
    activationId: 'spawn:' + spawnId + ':child:' + (index + 1),
    purpose: OrchestrationActivationPurpose.WORK,
  }));
}

function denial(reasonCode, details = {}) {
  return freezeDeep({
    schemaVersion: SUBAGENT_TOPOLOGY_MUTATION_VERSION,
    decision: SubagentTopologyMutationDecision.DENY,
    reasonCode,
    createdNodeIds: [],
    activationRequests: [],
    reused: false,
    activationAuthority: false,
    executionAuthority: false,
    ...details,
  });
}

function replayResult(graph, runtime, parentNodeId, spawnId, expectedChildIds) {
  const familyPrefix = 'subagent:' + spawnId + ':';
  const family = graph.nodeOrder.filter(nodeId => {
    if (!nodeId.startsWith(familyPrefix)) return false;
    const ordinal = nodeId.slice(familyPrefix.length);
    return /^[1-9][0-9]*$/u.test(ordinal);
  });
  if (!family.length) return null;
  const exactFamily = family.length === expectedChildIds.length
    && expectedChildIds.every(nodeId => family.includes(nodeId));
  const parent = graph.nodesById[parentNodeId];
  const exactAuthority = exactFamily
    && parent
    && !parent.providerBinding
    && expectedChildIds.every(nodeId => {
      const child = graph.nodesById[nodeId];
      return child?.parentId === parentNodeId
        && parent.childIds.includes(nodeId)
        && child.promptProfileId === parent.promptProfileId
        && child.recoveryPromptProfileId === parent.recoveryPromptProfileId
        && child.chatMode === parent.chatMode
        && child.providerBinding === null;
    });
  if (!exactAuthority) {
    return denial('SPAWN_IDENTITY_CONFLICT', {
      parentNodeId,
      spawnId,
      existingNodeIds: family,
    });
  }
  return freezeDeep({
    schemaVersion: SUBAGENT_TOPOLOGY_MUTATION_VERSION,
    decision: SubagentTopologyMutationDecision.ALLOW,
    reasonCode: 'SUBAGENT_TOPOLOGY_REUSED',
    parentNodeId,
    spawnId,
    createdNodeIds: expectedChildIds,
    activationRequests: activationRequestsForSpawn(graph, spawnId, expectedChildIds),
    reused: true,
    graph,
    runtime,
    activationAuthority: false,
    executionAuthority: false,
  });
}

function lifecycleAdmission(initiator, parentNode, parentRuntime) {
  if (parentNode.providerBinding) {
    return denial('PARENT_PROVIDER_BOUND');
  }
  if (parentRuntime.scopeState !== 'RUNNING') {
    return denial('PARENT_SCOPE_NOT_RUNNING');
  }
  if (initiator === SubagentSpawnInitiator.AGENT
      && parentRuntime.lifecycle !== OrchestrationNodeLifecycle.ACTIVE) {
    return denial('AGENT_PARENT_NOT_ACTIVE');
  }
  if (initiator === SubagentSpawnInitiator.OWNER
      && parentRuntime.lifecycle !== OrchestrationNodeLifecycle.IDLE) {
    return denial('OWNER_PARENT_NOT_IDLE');
  }
  return null;
}

export function mutateOrchestrationSubagentTopologyV1(input = {}) {
  const request = strictRecord(input, INPUT_KEYS, 'SubagentTopologyMutationRequestV1');
  const canonicalGraph = validateOrchestrationGraphV1(own(request, 'graph'));
  const canonicalRuntime = validateOrchestrationHierarchyRuntimeV1(
    canonicalGraph,
    own(request, 'runtime'),
  );
  const parentNodeId = requiredId(own(request, 'parentNodeId'), 'parentNodeId', 180);
  const spawnId = requiredId(own(request, 'spawnId'), 'spawnId');
  const requestedChildren = integer(
    own(request, 'requestedChildren'),
    'requestedChildren',
    { min: 1, max: 200 },
  );
  const nowMs = integer(
    own(request, 'nowMs'),
    'nowMs',
    { min: 0 },
  );
  const initiator = own(request, 'initiator');
  const expectedChildIds = childIdsForSpawn(spawnId, requestedChildren);

  const replay = replayResult(
    canonicalGraph,
    canonicalRuntime,
    parentNodeId,
    spawnId,
    expectedChildIds,
  );
  if (replay) return replay;

  const structure = evaluateSubagentStructureAdmissionV1({
    policy: own(request, 'policy', {}),
    initiator,
    graph: canonicalGraph,
    parentNodeId,
    requestedChildren,
  });
  if (structure.decision !== SubagentStructureDecision.ALLOW) {
    return denial('STRUCTURE_DENIED', { parentNodeId, spawnId, structure });
  }

  const existingChildAgents = canonicalGraph.nodeOrder.reduce(
    (count, nodeId) => count + (canonicalGraph.nodesById[nodeId].parentId === null ? 0 : 1),
    0,
  );
  const resource = evaluateResourceBudgetV1({
    budget: own(request, 'resourceBudget', {}),
    usage: { childAgents: existingChildAgents },
    request: { childAgents: requestedChildren },
  });
  if (resource.decision !== ResourceBudgetDecisionKind.ALLOW) {
    return denial('RESOURCE_BUDGET_DENIED', {
      parentNodeId,
      spawnId,
      structure,
      resource,
    });
  }

  const parentNode = canonicalGraph.nodesById[parentNodeId];
  const parentRuntime = canonicalRuntime.nodesById[parentNodeId];
  const lifecycleDenial = lifecycleAdmission(initiator, parentNode, parentRuntime);
  if (lifecycleDenial) {
    return denial(lifecycleDenial.reasonCode, {
      parentNodeId,
      spawnId,
      structure,
      resource,
    });
  }

  const rawGraph = graphDocument(canonicalGraph);
  const rawParent = rawGraph.nodes.find(node => node.id === parentNodeId);
  rawParent.childIds = [...rawParent.childIds, ...expectedChildIds];

  for (const childId of expectedChildIds) {
    rawGraph.nodes.push({
      id: childId,
      parentId: parentNodeId,
      childIds: [],
      chatMode: parentNode.chatMode,
      promptProfileId: parentNode.promptProfileId,
      recoveryPromptProfileId: parentNode.recoveryPromptProfileId,
      maxActiveChildren: 0,
      barrier: { mode: OrchestrationBarrierMode.NONE, childIds: [] },
      providerBinding: null,
    });
  }

  const nextGraph = validateOrchestrationGraphV1(rawGraph);
  const nextRuntime = createOrchestrationHierarchyRuntime(nextGraph, nowMs);
  nextRuntime.createdAt = canonicalRuntime.createdAt;
  nextRuntime.updatedAt = nowMs;
  nextRuntime.processedEventIds = clone(canonicalRuntime.processedEventIds);
  for (const nodeId of canonicalGraph.nodeOrder) {
    nextRuntime.nodesById[nodeId] = clone(canonicalRuntime.nodesById[nodeId]);
  }
  const validatedRuntime = validateOrchestrationHierarchyRuntimeV1(nextGraph, nextRuntime);

  return freezeDeep({
    schemaVersion: SUBAGENT_TOPOLOGY_MUTATION_VERSION,
    decision: SubagentTopologyMutationDecision.ALLOW,
    reasonCode: 'SUBAGENT_TOPOLOGY_CREATED',
    parentNodeId,
    spawnId,
    createdNodeIds: expectedChildIds,
    activationRequests: activationRequestsForSpawn(nextGraph, spawnId, expectedChildIds),
    reused: false,
    structure,
    resource,
    graph: nextGraph,
    runtime: validatedRuntime,
    activationAuthority: false,
    executionAuthority: false,
  });
}
