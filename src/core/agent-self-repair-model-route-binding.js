import {
  AgentSelfRepairWorkKind,
  normalizeAgentSelfRepairModelIntentV1,
} from './agent-self-repair-model-binding.js';
import {
  rankBoundAgentModelRouteCandidatesV1,
} from './agent-model-route-candidate-binding.js';

export const AGENT_SELF_REPAIR_MODEL_ROUTE_BINDING_VERSION = 1;

export const AGENT_SELF_REPAIR_MODEL_ROUTE_BINDING_AUTHORITY = Object.freeze({
  advisoryOnly: true,
  routeIntentOnly: true,
  routeSelectionAuthorized: false,
  providerCallAuthorized: false,
  modelDispatchAuthorized: false,
  executionAuthorized: false,
  policyAuthorized: false,
  persistenceAuthorized: false,
  schedulingAuthorized: false,
  recoveryAuthorized: false,
  completionAuthorized: false,
  verificationAuthorized: false,
  requiresCurrentSelfRepairBinding: true,
  requiresCurrentAgentPolicyBinding: true,
  requiresCanonicalPlanCycleRevalidation: true,
  providerDispatchRevalidationRequired: true,
});

const INPUT_KEYS = new Set([
  'selfRepairModelIntent',
  'currentSelfRepairModelBindingKey',
  'definitionModelPolicyBinding',
  'currentDefinitionModelPolicyBindingKey',
  'currentDefinitionSelection',
  'currentJobId',
  'currentProjectId',
  'currentParentModelPolicyBinding',
  'currentParentModelPolicyBindingKey',
  'currentRoutePoolRevision',
  'routes',
  'routeStates',
  'now',
]);

const ACTIVE_WORK_KINDS = new Set([
  AgentSelfRepairWorkKind.REPAIR,
  AgentSelfRepairWorkKind.RETEST,
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactBindingKey(value, label) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > 100_000
      || value !== value.trim()) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/**
 * Project a durable self-repair model intent into the canonical Agent-policy
 * candidate ranker. The caller cannot supply role/capability/vision aliases:
 * those facts come only from the exact current self-repair binding.
 *
 * This function does not select a route or authorize provider I/O.
 */
export function rankBoundAgentSelfRepairModelCandidatesV1(input) {
  const raw = strictRecord(
    input,
    INPUT_KEYS,
    'Bound Agent self-repair model candidate request',
  );
  const intent = normalizeAgentSelfRepairModelIntentV1(
    own(raw, 'selfRepairModelIntent'),
  );
  const currentSelfRepairBindingKey = exactBindingKey(
    own(raw, 'currentSelfRepairModelBindingKey'),
    'currentSelfRepairModelBindingKey',
  );
  if (intent.bindingKey !== currentSelfRepairBindingKey) {
    throw new Error('Agent self-repair model binding is not the current owner binding');
  }
  if (!ACTIVE_WORK_KINDS.has(intent.workKind)
      || intent.routeIntent === null
      || intent.ownerId === null) {
    throw new Error('Terminal Agent self-repair state has no model route candidates');
  }

  const currentJobId = exactId(own(raw, 'currentJobId'), 'currentJobId');
  if (currentJobId !== intent.ownerId) {
    throw new Error('Agent self-repair model route owner does not match current Agent identity');
  }

  const candidateRequest = {
    definitionModelPolicyBinding: own(raw, 'definitionModelPolicyBinding'),
    currentDefinitionModelPolicyBindingKey: own(raw, 'currentDefinitionModelPolicyBindingKey'),
    currentDefinitionSelection: own(raw, 'currentDefinitionSelection'),
    currentJobId,
    currentProjectId: own(raw, 'currentProjectId'),
    currentRoutePoolRevision: own(raw, 'currentRoutePoolRevision'),
    routes: own(raw, 'routes'),
    routeStates: own(raw, 'routeStates') ?? {},
    role: intent.routeIntent.role,
    capabilityIds: [...intent.routeIntent.capabilityIds],
    requiresVision: intent.routeIntent.requiresVision,
    ...(Object.hasOwn(raw, 'now') ? { now: own(raw, 'now') } : {}),
  };
  if (Object.hasOwn(raw, 'currentParentModelPolicyBinding')) {
    candidateRequest.currentParentModelPolicyBinding = own(
      raw,
      'currentParentModelPolicyBinding',
    );
  }
  if (Object.hasOwn(raw, 'currentParentModelPolicyBindingKey')) {
    candidateRequest.currentParentModelPolicyBindingKey = own(
      raw,
      'currentParentModelPolicyBindingKey',
    );
  }

  const candidates = rankBoundAgentModelRouteCandidatesV1(candidateRequest);

  return freezeDeep({
    schemaVersion: AGENT_SELF_REPAIR_MODEL_ROUTE_BINDING_VERSION,
    selfRepairModelBindingKey: intent.bindingKey,
    planId: intent.planId,
    jobId: intent.jobId,
    cycleId: intent.cycleId,
    workKind: intent.workKind,
    activeAttemptNumber: intent.activeAttemptNumber,
    nodeId: intent.nodeId,
    ownerId: intent.ownerId,
    executionPlane: intent.executionPlane,
    workBudget: intent.workBudget,
    routeIntent: intent.routeIntent,
    definitionModelPolicyBindingKey: candidates.definitionModelPolicyBindingKey,
    modelPolicyBindingKey: candidates.modelPolicyBindingKey,
    routePoolRevision: candidates.routePoolRevision,
    candidates,
    authority: AGENT_SELF_REPAIR_MODEL_ROUTE_BINDING_AUTHORITY,
  });
}
