import {
  OrchestrationBarrierMode,
  OrchestrationNodeLifecycle,
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
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

function allocateChildIds(graph, requestedChildren) {
  const used = new Set(graph.nodeOrder);
  const ids = [];
  let ordinal = 1;
  while (ids.length < requestedChildren) {
    const candidate = 'subagent-' + ordinal;
    ordinal += 1;
    if (used.has(candidate)) continue;
    used.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

function denial(reasonCode, details = {}) {
  return freezeDeep({
    schemaVersion: SUBAGENT_TOPOLOGY_MUTATION_VERSION,
    decision: SubagentTopologyMutationDecision.DENY,
    reasonCode,
    createdNodeIds: [],
    activationAuthority: false,
    executionAuthority: false,
    ...details,
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
  const parentNodeId = own(request, 'parentNodeId');
  const requestedChildren = integer(
    own(request, 'requestedChildren'),
    'requestedChildren',
    { min: 1, max: 200 },
  );
  const nowMs = integer(
    own(request, 'nowMs', Date.now()),
    'nowMs',
    { min: 0 },
  );
  const initiator = own(request, 'initiator');

  const structure = evaluateSubagentStructureAdmissionV1({
    policy: own(request, 'policy', {}),
    initiator,
    graph: canonicalGraph,
    parentNodeId,
    requestedChildren,
  });
  if (structure.decision !== SubagentStructureDecision.ALLOW) {
    return denial('STRUCTURE_DENIED', { structure });
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
    return denial('RESOURCE_BUDGET_DENIED', { structure, resource });
  }

  const parentNode = canonicalGraph.nodesById[parentNodeId];
  const parentRuntime = canonicalRuntime.nodesById[parentNodeId];
  const lifecycleDenial = lifecycleAdmission(initiator, parentNode, parentRuntime);
  if (lifecycleDenial) {
    return denial(lifecycleDenial.reasonCode, { structure, resource });
  }

  const createdNodeIds = allocateChildIds(canonicalGraph, requestedChildren);
  const rawGraph = graphDocument(canonicalGraph);
  const rawParent = rawGraph.nodes.find(node => node.id === parentNodeId);
  rawParent.childIds = [...rawParent.childIds, ...createdNodeIds];

  for (const childId of createdNodeIds) {
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
    createdNodeIds,
    structure,
    resource,
    graph: nextGraph,
    runtime: validatedRuntime,
    activationAuthority: false,
    executionAuthority: false,
  });
}
