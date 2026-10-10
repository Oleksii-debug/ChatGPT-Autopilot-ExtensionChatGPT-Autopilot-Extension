import { AgentExecutionPlane, AgentPlanNodeState, normalizeAgentPlanV1 } from './agent-plan.js';
import {
  bindSpecialistHandoffToRegistryV1,
  discoverSpecialistsV1,
  normalizeSpecialistRegistryV1,
} from './specialist-registry.js';
import {
  prepareAgentPlanSpecialistExecutionOwnershipV1,
  prepareAgentPlanSpecialistHandoffV1,
} from './agent-specialist-bridge.js';
import { normalizeSpecialistHandoffV1 } from './universal-agent-contracts.js';
import { deriveChildResourceBudgetV1 } from './resource-budget-governor.js';

export const AGENT_SPECIALIST_DELEGATION_VERSION = 1;

const EXTERNAL_PLANES = new Set([
  AgentExecutionPlane.LOCAL,
  AgentExecutionPlane.CLOUD,
  AgentExecutionPlane.REMOTE,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'plan',
  'expectedPlanRevision',
  'nodeId',
  'registry',
  'parentCapabilityIds',
  'parentToolIds',
  'requiredCapabilityIds',
  'requiredToolIds',
  'policyEnvelopeId',
  'deadlineAt',
  'priority',
  'childBudget',
  'artifactRefs',
  'credentialRefs',
  'parentInvocationId',
  'at',
]);
const CHILD_BUDGET_KEYS = new Set([
  'maxModelCalls',
  'maxRuntimeSeconds',
  'maxCostUsdMicros',
]);

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function denseArray(value, label, max = 128) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(`${label} has invalid length`);
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }
  const output = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function ids(value, label, max = 128) {
  const output = denseArray(value, label, max).map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(output).size !== output.length) throw new Error(`${label} contains duplicate identity`);
  return Object.freeze([...output].sort(compareId));
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function normalizeChildBudget(input, nodeBudget) {
  const raw = input === undefined
    ? Object.create(null)
    : record(input, CHILD_BUDGET_KEYS, 'Agent specialist childBudget');
  const requestedModelCalls = Object.hasOwn(raw, 'maxModelCalls')
    ? integer(raw.maxModelCalls, 'childBudget.maxModelCalls', 0, 1_000_000)
    : nodeBudget.maxModelCalls;
  const requestedRuntimeSeconds = Object.hasOwn(raw, 'maxRuntimeSeconds')
    ? integer(raw.maxRuntimeSeconds, 'childBudget.maxRuntimeSeconds', 0, 31_536_000)
    : nodeBudget.maxRuntimeSeconds;
  const requestedCostUsdMicros = Object.hasOwn(raw, 'maxCostUsdMicros')
    ? integer(raw.maxCostUsdMicros, 'childBudget.maxCostUsdMicros')
    : nodeBudget.maxCostUsdMicros;

  const parentBudget = {
    maxConcurrentAgents: 0,
    maxChildAgents: 0,
    maxModelCalls: nodeBudget.maxModelCalls,
    maxModelInputTokens: 0,
    maxModelOutputTokens: 0,
    maxRuntimeSeconds: nodeBudget.maxRuntimeSeconds,
    maxCostUsdMicros: nodeBudget.maxCostUsdMicros,
  };
  const requestedBudget = {
    maxConcurrentAgents: 0,
    maxChildAgents: 0,
    maxModelCalls: requestedModelCalls,
    maxModelInputTokens: 0,
    maxModelOutputTokens: 0,
    maxRuntimeSeconds: requestedRuntimeSeconds,
    maxCostUsdMicros: requestedCostUsdMicros,
  };
  const narrowed = deriveChildResourceBudgetV1({
    parentBudget,
    requestedBudget,
  });
  return freeze({
    maxModelCalls: narrowed.maxModelCalls,
    maxRuntimeSeconds: narrowed.maxRuntimeSeconds,
    maxCostUsdMicros: narrowed.maxCostUsdMicros,
    narrowed: narrowed.maxModelCalls !== requestedModelCalls
      || narrowed.maxRuntimeSeconds !== requestedRuntimeSeconds
      || narrowed.maxCostUsdMicros !== requestedCostUsdMicros,
  });
}

function selectLeastAuthoritySpecialist(registry, discovery) {
  const byId = new Map(registry.definitions.map(definition => [definition.specialistId, definition]));
  const ranked = discovery.specialists.map(selection => {
    const definition = byId.get(selection.specialistId);
    if (!definition) throw new Error('Discovered specialist is missing from canonical registry');
    return {
      selection,
      capabilitySurplus: definition.capabilityIds.length - selection.requestedCapabilityIds.length,
      toolSurplus: definition.toolIds.length - selection.grantedToolIds.length,
    };
  }).sort((left, right) =>
    left.capabilitySurplus - right.capabilitySurplus
    || left.toolSurplus - right.toolSurplus
    || compareId(left.selection.specialistId, right.selection.specialistId));
  if (!ranked.length) throw new Error('No eligible specialist satisfies the AgentPlan delegation requirements');
  return ranked[0];
}

/**
 * Produces a deterministic, non-authorizing delegation proposal for one READY
 * external AgentPlan node. The canonical BrowserAgentManager must still
 * re-read the durable plan/registry/policy/capacity state before persisting or
 * executing the existing specialist handoff.
 */
export function prepareAutomaticAgentSpecialistDelegationV1(input = {}) {
  const request = record(input, REQUEST_KEYS, 'Agent specialist delegation request');
  const schemaVersion = request.schemaVersion === undefined
    ? AGENT_SPECIALIST_DELEGATION_VERSION
    : request.schemaVersion;
  if (schemaVersion !== AGENT_SPECIALIST_DELEGATION_VERSION) {
    throw new Error('Unsupported Agent specialist delegation schemaVersion');
  }

  const plan = normalizeAgentPlanV1(request.plan);
  const expectedPlanRevision = integer(
    request.expectedPlanRevision,
    'expectedPlanRevision',
    1,
  );
  if (plan.revision !== expectedPlanRevision) throw new Error('AgentPlan revision conflict');

  const nodeId = id(request.nodeId, 'nodeId');
  const node = plan.nodes.find(candidate => candidate.nodeId === nodeId);
  if (!node) throw new Error('AgentPlan node not found');
  if (node.state !== AgentPlanNodeState.READY) {
    throw new Error('AgentPlan node must be READY before automatic delegation');
  }
  if (!EXTERNAL_PLANES.has(node.executionPlane)) {
    throw new Error('Automatic specialist delegation requires LOCAL, CLOUD or REMOTE execution plane');
  }

  const registry = normalizeSpecialistRegistryV1(request.registry);
  const parentCapabilityIds = ids(request.parentCapabilityIds, 'parentCapabilityIds', 64);
  const parentToolIds = ids(request.parentToolIds, 'parentToolIds', 128);
  const requiredCapabilityIds = ids(request.requiredCapabilityIds, 'requiredCapabilityIds', 64);
  if (!requiredCapabilityIds.length) throw new Error('requiredCapabilityIds must not be empty');
  const requiredToolIds = ids(request.requiredToolIds, 'requiredToolIds', 128);
  const discovery = discoverSpecialistsV1({
    registry,
    requiredCapabilityIds,
    requiredToolIds,
    parentCapabilityIds,
    parentToolIds,
    executionPlanes: [node.executionPlane],
  });
  const ranked = selectLeastAuthoritySpecialist(registry, discovery);
  const selection = ranked.selection;

  const at = timestamp(request.at, 'at');
  const deadlineAt = timestamp(request.deadlineAt, 'deadlineAt');
  if (Date.parse(deadlineAt) <= Date.parse(at)) {
    throw new Error('deadlineAt must be later than at');
  }
  const priority = request.priority === undefined
    ? 0
    : integer(request.priority, 'priority', 0, 1_000_000);
  const policyEnvelopeId = id(request.policyEnvelopeId, 'policyEnvelopeId');
  const parentInvocationId = request.parentInvocationId === undefined || request.parentInvocationId === ''
    ? ''
    : id(request.parentInvocationId, 'parentInvocationId');
  const childBudget = normalizeChildBudget(request.childBudget, node.budget);
  const artifactRefs = request.artifactRefs === undefined ? [] : request.artifactRefs;
  const credentialRefs = request.credentialRefs === undefined ? [] : request.credentialRefs;

  const handoff = normalizeSpecialistHandoffV1({
    schemaVersion: 1,
    handoffId: id(`handoff:${plan.planId}:${node.nodeId}:r${plan.revision}`, 'handoffId'),
    specialistId: selection.specialistId,
    goal: node.objective,
    requestedCapabilityIds: selection.requestedCapabilityIds,
    artifactRefs,
    credentialRefs,
    maxModelCalls: childBudget.maxModelCalls,
    maxRuntimeSeconds: childBudget.maxRuntimeSeconds,
    maxCostUsdMicros: childBudget.maxCostUsdMicros,
    createdAt: at,
    parentInvocationId,
  });

  const binding = bindSpecialistHandoffToRegistryV1({
    registry,
    selection,
    handoff,
    parentCapabilityIds,
    parentToolIds,
  });

  const runtimePrepareRequest = freeze({
    nodeId: node.nodeId,
    specialistId: selection.specialistId,
    requestedCapabilityIds: selection.requestedCapabilityIds,
    parentCapabilityIds,
    policyEnvelopeId,
    deadlineAt,
    priority,
    at,
  });
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan, runtimePrepareRequest);
  const executionOwnership = prepareAgentPlanSpecialistExecutionOwnershipV1(plan, runtimePrepareRequest);

  return freeze({
    schemaVersion: AGENT_SPECIALIST_DELEGATION_VERSION,
    planId: plan.planId,
    jobId: plan.jobId,
    nodeId: node.nodeId,
    planRevision: plan.revision,
    registryId: registry.registryId,
    registryRevision: registry.revision,
    selection,
    selectionReason: {
      kind: 'LEAST_AUTHORITY_ELIGIBLE',
      capabilitySurplus: ranked.capabilitySurplus,
      toolSurplus: ranked.toolSurplus,
    },
    childBudget,
    binding,
    runtimePrepareRequest,
    preview: {
      assignment,
      executionOwnership,
    },
    authority: {
      proposalOnly: true,
      executionAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
      credentialAuthorized: false,
      completionAuthorized: false,
      verificationAuthorized: false,
    },
    requiresCanonicalRevalidation: {
      planRevision: true,
      registryRevision: true,
      ownerSubagentPolicy: true,
      providerReadiness: true,
      productWideCapacityReservation: true,
    },
  });
}
