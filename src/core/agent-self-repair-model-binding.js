import { AiRouteRole } from './ai-route-pool.js';
import { AgentExecutionPlane } from './agent-plan.js';
import { SelfRepairCycleState } from './self-repair-cycle.js';
import {
  AgentSelfRepairWorkKind,
  proposeAgentSelfRepairWorkV1,
} from './agent-self-repair-bridge.js';

export const AGENT_SELF_REPAIR_MODEL_BINDING_VERSION = 1;

export const AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY = Object.freeze({
  advisoryOnly: true,
  routeIntentOnly: true,
  routeSelectionAuthorized: false,
  providerAuthorized: false,
  modelDispatchAuthorized: false,
  executionAuthorized: false,
  verificationAuthorized: false,
  completionAuthorized: false,
  policyAuthorized: false,
  credentialAuthorized: false,
  toolAuthorized: false,
  contextAuthorized: false,
  persistenceAuthorized: false,
  schedulingAuthorized: false,
  recoveryAuthorized: false,
  requiresCanonicalRouterRevalidation: true,
  requiresCanonicalPolicyRevalidation: true,
  requiresCanonicalBudgetRevalidation: true,
  requiresCanonicalVerifierPlanRevalidation: true,
  requiresCanonicalPlanCycleRevalidation: true,
  requiresCanonicalRoleRevalidation: true,
  requiresCanonicalCapabilityRevalidation: true,
});

const REQUEST_KEYS = new Set(['selfRepairRequest', 'routingRequest']);
const ROUTING_KEYS = new Set(['role', 'capabilityIds', 'requiresVision']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REPAIR_ROLES = new Set([
  AiRouteRole.PLANNER,
  AiRouteRole.CODER,
  AiRouteRole.FAST_WORKER,
]);
const TERMINAL_WORK_KINDS = new Set([
  AgentSelfRepairWorkKind.VERIFIED,
  AgentSelfRepairWorkKind.MANUAL_REVIEW,
  AgentSelfRepairWorkKind.EXHAUSTED,
]);
const ACTIVE_WORK_KINDS = new Set([
  AgentSelfRepairWorkKind.REPAIR,
  AgentSelfRepairWorkKind.RETEST,
]);
const EXECUTION_PLANES = new Set(Object.values(AgentExecutionPlane));
const CYCLE_STATE_TO_WORK_KIND = new Map([
  [SelfRepairCycleState.READY_FOR_REPAIR, AgentSelfRepairWorkKind.REPAIR],
  [SelfRepairCycleState.READY_FOR_RETEST, AgentSelfRepairWorkKind.RETEST],
  [SelfRepairCycleState.VERIFIED, AgentSelfRepairWorkKind.VERIFIED],
  [SelfRepairCycleState.MANUAL_REVIEW, AgentSelfRepairWorkKind.MANUAL_REVIEW],
  [SelfRepairCycleState.EXHAUSTED, AgentSelfRepairWorkKind.EXHAUSTED],
]);
const BUDGET_KEYS = new Set(['maxModelCalls', 'maxRuntimeSeconds', 'maxCostUsdMicros']);
const BINDING_KEYS = new Set([
  'schemaVersion',
  'planId',
  'jobId',
  'cycleId',
  'failedNodeId',
  'originPlanRevision',
  'currentPlanRevision',
  'proposedPlanRevision',
  'failedNodeRevisionId',
  'verifierPlanRevisionId',
  'cycleState',
  'workKind',
  'activeAttemptNumber',
  'currentSubjectRevisionId',
  'evidenceTrust',
  'requiresCanonicalEvidenceResolution',
  'actorId',
  'verifierId',
  'nodeId',
  'ownerId',
  'executionPlane',
  'workBudget',
  'routeIntent',
  'bindingKey',
  ...Object.keys(AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY),
]);

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
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return Object.freeze(out);
}

function required(value, key, label) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new Error(label + ' requires ' + key);
  }
  return value[key];
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactInteger(value, label, min = 0) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function normalizeWorkBudget(value) {
  const raw = strictRecord(value, BUDGET_KEYS, 'Agent self-repair model workBudget');
  return Object.freeze({
    maxModelCalls: exactInteger(
      required(raw, 'maxModelCalls', 'Agent self-repair model workBudget'),
      'Agent self-repair model workBudget maxModelCalls',
    ),
    maxRuntimeSeconds: exactInteger(
      required(raw, 'maxRuntimeSeconds', 'Agent self-repair model workBudget'),
      'Agent self-repair model workBudget maxRuntimeSeconds',
    ),
    maxCostUsdMicros: exactInteger(
      required(raw, 'maxCostUsdMicros', 'Agent self-repair model workBudget'),
      'Agent self-repair model workBudget maxCostUsdMicros',
    ),
  });
}

function normalizeAuthorityFields(raw) {
  const out = {};
  for (const [key, expected] of Object.entries(AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY)) {
    const value = required(raw, key, 'AgentSelfRepairModelBindingV1');
    if (value !== expected) {
      throw new Error('AgentSelfRepairModelBindingV1 ' + key + ' must be ' + String(expected));
    }
    out[key] = expected;
  }
  return out;
}

function denseIds(value, label, max = 64) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' has invalid length');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' must be dense and data-only');
    }
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out.push(exactId(descriptor.value, label + '[' + index + ']'));
  }
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicates');
  out.sort();
  return Object.freeze(out);
}

function routingRequestForWorkKind(raw, workKind) {
  if (TERMINAL_WORK_KINDS.has(workKind)) {
    if (raw !== undefined && raw !== null) {
      throw new Error('Terminal Agent self-repair state cannot request model routing');
    }
    return null;
  }

  const request = strictRecord(raw, ROUTING_KEYS, 'Agent self-repair routingRequest');
  const role = required(request, 'role', 'Agent self-repair routingRequest');
  const capabilityIds = denseIds(
    required(request, 'capabilityIds', 'Agent self-repair routingRequest'),
    'Agent self-repair routingRequest capabilityIds',
  );
  const requiresVision = required(
    request,
    'requiresVision',
    'Agent self-repair routingRequest',
  );
  if (typeof requiresVision !== 'boolean') {
    throw new Error('Agent self-repair routingRequest requiresVision must be boolean');
  }

  if (workKind === AgentSelfRepairWorkKind.REPAIR) {
    if (typeof role !== 'string' || !REPAIR_ROLES.has(role)) {
      throw new Error('Agent self-repair REPAIR model role must be planner, coder or fast-worker');
    }
  } else if (workKind === AgentSelfRepairWorkKind.RETEST) {
    if (role !== AiRouteRole.VERIFIER) {
      throw new Error('Agent self-repair RETEST model role must be verifier');
    }
  } else {
    throw new Error('Agent self-repair active work kind is unsupported');
  }

  return Object.freeze({ role, capabilityIds, requiresVision });
}

function modelIntentBindingKey({
  planId,
  jobId,
  cycleId,
  failedNodeId,
  originPlanRevision,
  currentPlanRevision,
  proposedPlanRevision = null,
  failedNodeRevisionId,
  verifierPlanRevisionId,
  cycleState,
  workKind,
  activeAttemptNumber,
  currentSubjectRevisionId,
  evidenceTrust,
  actorId,
  verifierId,
  nodeId = null,
  ownerId = null,
  executionPlane = null,
  workBudget = null,
  routeIntent = null,
}) {
  return JSON.stringify([
    AGENT_SELF_REPAIR_MODEL_BINDING_VERSION,
    planId,
    jobId,
    cycleId,
    failedNodeId,
    originPlanRevision,
    currentPlanRevision,
    proposedPlanRevision,
    failedNodeRevisionId,
    verifierPlanRevisionId,
    cycleState,
    workKind,
    activeAttemptNumber,
    currentSubjectRevisionId,
    evidenceTrust,
    actorId,
    verifierId,
    nodeId,
    ownerId,
    executionPlane,
    workBudget
      ? [workBudget.maxModelCalls, workBudget.maxRuntimeSeconds, workBudget.maxCostUsdMicros]
      : null,
    routeIntent
      ? [routeIntent.role, routeIntent.capabilityIds, routeIntent.requiresVision]
      : null,
  ]);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Normalize a durable self-repair model intent after restart.
 *
 * This proves structural/identity consistency only. Fresh Router state, Agent
 * policy, budget and verifier-plan authority still have to be re-observed by
 * their canonical owners before model/provider I/O.
 */
export function normalizeAgentSelfRepairModelIntentV1(input) {
  const raw = strictRecord(
    input,
    BINDING_KEYS,
    'AgentSelfRepairModelBindingV1',
  );
  if (required(raw, 'schemaVersion', 'AgentSelfRepairModelBindingV1')
      !== AGENT_SELF_REPAIR_MODEL_BINDING_VERSION) {
    throw new Error('Unsupported AgentSelfRepairModelBindingV1 schemaVersion');
  }

  const planId = exactId(required(raw, 'planId', 'AgentSelfRepairModelBindingV1'), 'planId');
  const jobId = exactId(required(raw, 'jobId', 'AgentSelfRepairModelBindingV1'), 'jobId');
  const cycleId = exactId(required(raw, 'cycleId', 'AgentSelfRepairModelBindingV1'), 'cycleId');
  const failedNodeId = exactId(
    required(raw, 'failedNodeId', 'AgentSelfRepairModelBindingV1'),
    'failedNodeId',
  );
  const originPlanRevision = exactInteger(
    required(raw, 'originPlanRevision', 'AgentSelfRepairModelBindingV1'),
    'originPlanRevision',
    1,
  );
  const currentPlanRevision = exactInteger(
    required(raw, 'currentPlanRevision', 'AgentSelfRepairModelBindingV1'),
    'currentPlanRevision',
    1,
  );
  if (currentPlanRevision < originPlanRevision) {
    throw new Error('Agent self-repair model currentPlanRevision predates originPlanRevision');
  }
  const failedNodeRevisionId = exactId(
    required(raw, 'failedNodeRevisionId', 'AgentSelfRepairModelBindingV1'),
    'failedNodeRevisionId',
  );
  const verifierPlanRevisionId = exactId(
    required(raw, 'verifierPlanRevisionId', 'AgentSelfRepairModelBindingV1'),
    'verifierPlanRevisionId',
  );
  const currentSubjectRevisionId = exactId(
    required(raw, 'currentSubjectRevisionId', 'AgentSelfRepairModelBindingV1'),
    'currentSubjectRevisionId',
  );
  const actorId = exactId(
    required(raw, 'actorId', 'AgentSelfRepairModelBindingV1'),
    'actorId',
  );
  const verifierId = exactId(
    required(raw, 'verifierId', 'AgentSelfRepairModelBindingV1'),
    'verifierId',
  );
  if (actorId === verifierId) {
    throw new Error('Agent self-repair model binding requires independent actor and verifier identities');
  }

  const cycleState = required(raw, 'cycleState', 'AgentSelfRepairModelBindingV1');
  const workKind = required(raw, 'workKind', 'AgentSelfRepairModelBindingV1');
  if (typeof cycleState !== 'string' || CYCLE_STATE_TO_WORK_KIND.get(cycleState) !== workKind) {
    throw new Error('Agent self-repair model cycleState/workKind binding is inconsistent');
  }
  const evidenceTrust = required(raw, 'evidenceTrust', 'AgentSelfRepairModelBindingV1');
  if (evidenceTrust !== 'UNVERIFIED_INPUT') {
    throw new Error('Agent self-repair model evidenceTrust must remain UNVERIFIED_INPUT');
  }
  const requiresCanonicalEvidenceResolution = required(
    raw,
    'requiresCanonicalEvidenceResolution',
    'AgentSelfRepairModelBindingV1',
  );
  if (requiresCanonicalEvidenceResolution !== true) {
    throw new Error('Agent self-repair model requiresCanonicalEvidenceResolution must be true');
  }
  const activeAttemptNumber = exactInteger(
    required(raw, 'activeAttemptNumber', 'AgentSelfRepairModelBindingV1'),
    'activeAttemptNumber',
  );
  const authority = normalizeAuthorityFields(raw);

  if (TERMINAL_WORK_KINDS.has(workKind)) {
    if (activeAttemptNumber !== 0) {
      throw new Error('Terminal Agent self-repair model binding activeAttemptNumber must be zero');
    }
    for (const key of ['proposedPlanRevision', 'executionPlane']) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        throw new Error('Terminal Agent self-repair model binding cannot contain ' + key);
      }
    }
    if (required(raw, 'nodeId', 'AgentSelfRepairModelBindingV1') !== null
        || required(raw, 'ownerId', 'AgentSelfRepairModelBindingV1') !== null
        || required(raw, 'workBudget', 'AgentSelfRepairModelBindingV1') !== null
        || required(raw, 'routeIntent', 'AgentSelfRepairModelBindingV1') !== null) {
      throw new Error('Terminal Agent self-repair model binding cannot contain active work');
    }
    const expectedBindingKey = modelIntentBindingKey({
      planId,
      jobId,
      cycleId,
      failedNodeId,
      originPlanRevision,
      currentPlanRevision,
      failedNodeRevisionId,
      verifierPlanRevisionId,
      cycleState,
      workKind,
      activeAttemptNumber,
      currentSubjectRevisionId,
      evidenceTrust,
      actorId,
      verifierId,
    });
    if (required(raw, 'bindingKey', 'AgentSelfRepairModelBindingV1') !== expectedBindingKey) {
      throw new Error('Agent self-repair model bindingKey is inconsistent');
    }
    return deepFreeze({
      schemaVersion: AGENT_SELF_REPAIR_MODEL_BINDING_VERSION,
      planId,
      jobId,
      cycleId,
      failedNodeId,
      originPlanRevision,
      currentPlanRevision,
      failedNodeRevisionId,
      verifierPlanRevisionId,
      cycleState,
      workKind,
      activeAttemptNumber,
      currentSubjectRevisionId,
      evidenceTrust,
      requiresCanonicalEvidenceResolution,
      actorId,
      verifierId,
      nodeId: null,
      ownerId: null,
      workBudget: null,
      routeIntent: null,
      bindingKey: expectedBindingKey,
      ...authority,
    });
  }

  if (!ACTIVE_WORK_KINDS.has(workKind)) {
    throw new Error('Agent self-repair model workKind is invalid');
  }
  if (activeAttemptNumber < 1) {
    throw new Error('Active Agent self-repair model binding requires activeAttemptNumber');
  }
  const proposedPlanRevision = exactInteger(
    required(raw, 'proposedPlanRevision', 'AgentSelfRepairModelBindingV1'),
    'proposedPlanRevision',
    1,
  );
  if (proposedPlanRevision !== currentPlanRevision + 1) {
    throw new Error('Agent self-repair model proposedPlanRevision must be the exact next plan revision');
  }
  const nodeId = exactId(required(raw, 'nodeId', 'AgentSelfRepairModelBindingV1'), 'nodeId');
  const ownerId = exactId(required(raw, 'ownerId', 'AgentSelfRepairModelBindingV1'), 'ownerId');
  if (workKind === AgentSelfRepairWorkKind.REPAIR && ownerId !== actorId) {
    throw new Error('Agent self-repair REPAIR model binding owner must be the repair actor');
  }
  if (workKind === AgentSelfRepairWorkKind.RETEST && ownerId !== verifierId) {
    throw new Error('Agent self-repair RETEST model binding owner must be the independent verifier');
  }
  const executionPlane = required(raw, 'executionPlane', 'AgentSelfRepairModelBindingV1');
  if (typeof executionPlane !== 'string' || !EXECUTION_PLANES.has(executionPlane)) {
    throw new Error('Agent self-repair model executionPlane is invalid');
  }
  const workBudget = normalizeWorkBudget(
    required(raw, 'workBudget', 'AgentSelfRepairModelBindingV1'),
  );
  const routing = routingRequestForWorkKind(
    required(raw, 'routeIntent', 'AgentSelfRepairModelBindingV1'),
    workKind,
  );
  const expectedBindingKey = modelIntentBindingKey({
    planId,
    jobId,
    cycleId,
    failedNodeId,
    originPlanRevision,
    currentPlanRevision,
    proposedPlanRevision,
    failedNodeRevisionId,
    verifierPlanRevisionId,
    cycleState,
    workKind,
    activeAttemptNumber,
    currentSubjectRevisionId,
    evidenceTrust,
    actorId,
    verifierId,
    nodeId,
    ownerId,
    executionPlane,
    workBudget,
    routeIntent: routing,
  });
  if (required(raw, 'bindingKey', 'AgentSelfRepairModelBindingV1') !== expectedBindingKey) {
    throw new Error('Agent self-repair model bindingKey is inconsistent');
  }

  return deepFreeze({
    schemaVersion: AGENT_SELF_REPAIR_MODEL_BINDING_VERSION,
    planId,
    jobId,
    cycleId,
    failedNodeId,
    originPlanRevision,
    currentPlanRevision,
    proposedPlanRevision,
    failedNodeRevisionId,
    verifierPlanRevisionId,
    cycleState,
    workKind,
    activeAttemptNumber,
    currentSubjectRevisionId,
    evidenceTrust,
    requiresCanonicalEvidenceResolution,
    actorId,
    verifierId,
    nodeId,
    ownerId,
    executionPlane,
    workBudget,
    routeIntent: {
      role: routing.role,
      capabilityIds: [...routing.capabilityIds],
      requiresVision: routing.requiresVision,
    },
    bindingKey: expectedBindingKey,
    ...authority,
  });
}

/**
 * Bind canonical self-repair work identity to a least-authority model-routing
 * intent. This function never selects a route or authorizes provider I/O.
 *
 * The self-repair proposal is re-derived from its original strict request so a
 * caller cannot substitute workKind/owner/node identity around the actor vs.
 * independent-verifier separation already enforced by SelfRepairCycleV1.
 */
export function bindAgentSelfRepairModelIntentV1(input) {
  const raw = strictRecord(input, REQUEST_KEYS, 'AgentSelfRepairModelBindingV1 request');
  const selfRepairRequest = required(
    raw,
    'selfRepairRequest',
    'AgentSelfRepairModelBindingV1 request',
  );
  const proposal = proposeAgentSelfRepairWorkV1(selfRepairRequest);
  const routing = routingRequestForWorkKind(raw.routingRequest, proposal.workKind);

  if (routing === null) {
    if (proposal.extensionNode !== null || proposal.proposedPlan !== null) {
      throw new Error('Terminal Agent self-repair proposal unexpectedly contains active work');
    }
    const terminalBinding = {
      schemaVersion: AGENT_SELF_REPAIR_MODEL_BINDING_VERSION,
      planId: proposal.planId,
      jobId: proposal.jobId,
      cycleId: proposal.cycleId,
      failedNodeId: proposal.failedNodeId,
      originPlanRevision: proposal.originPlanRevision,
      currentPlanRevision: proposal.currentPlanRevision,
      failedNodeRevisionId: proposal.failedNodeRevisionId,
      verifierPlanRevisionId: proposal.verifierPlanRevisionId,
      cycleState: proposal.cycleState,
      workKind: proposal.workKind,
      activeAttemptNumber: proposal.activeAttemptNumber,
      currentSubjectRevisionId: proposal.currentSubjectRevisionId,
      evidenceTrust: proposal.evidenceTrust,
      requiresCanonicalEvidenceResolution: proposal.requiresCanonicalEvidenceResolution,
      actorId: proposal.actorId,
      verifierId: proposal.verifierId,
      nodeId: null,
      ownerId: null,
      workBudget: null,
      routeIntent: null,
      ...AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
    };
    terminalBinding.bindingKey = modelIntentBindingKey(terminalBinding);
    return normalizeAgentSelfRepairModelIntentV1(terminalBinding);
  }

  const node = proposal.extensionNode;
  if (!node || !proposal.proposedPlan) {
    throw new Error('Active Agent self-repair proposal must contain extension work');
  }
  if (proposal.workKind === AgentSelfRepairWorkKind.REPAIR
      && node.ownerId !== proposal.actorId) {
    throw new Error('Agent self-repair REPAIR model binding owner must be the repair actor');
  }
  if (proposal.workKind === AgentSelfRepairWorkKind.RETEST
      && node.ownerId !== proposal.verifierId) {
    throw new Error('Agent self-repair RETEST model binding owner must be the independent verifier');
  }
  if (proposal.actorId === proposal.verifierId) {
    throw new Error('Agent self-repair model binding requires independent actor and verifier identities');
  }

  const activeBinding = {
    schemaVersion: AGENT_SELF_REPAIR_MODEL_BINDING_VERSION,
    planId: proposal.planId,
    jobId: proposal.jobId,
    cycleId: proposal.cycleId,
    failedNodeId: proposal.failedNodeId,
    originPlanRevision: proposal.originPlanRevision,
    currentPlanRevision: proposal.currentPlanRevision,
    proposedPlanRevision: proposal.proposedPlanRevision,
    failedNodeRevisionId: proposal.failedNodeRevisionId,
    verifierPlanRevisionId: proposal.verifierPlanRevisionId,
    cycleState: proposal.cycleState,
    workKind: proposal.workKind,
    activeAttemptNumber: proposal.activeAttemptNumber,
    currentSubjectRevisionId: proposal.currentSubjectRevisionId,
    evidenceTrust: proposal.evidenceTrust,
    requiresCanonicalEvidenceResolution: proposal.requiresCanonicalEvidenceResolution,
    actorId: proposal.actorId,
    verifierId: proposal.verifierId,
    nodeId: node.nodeId,
    ownerId: node.ownerId,
    executionPlane: node.executionPlane,
    workBudget: {
      maxModelCalls: node.budget.maxModelCalls,
      maxRuntimeSeconds: node.budget.maxRuntimeSeconds,
      maxCostUsdMicros: node.budget.maxCostUsdMicros,
    },
    routeIntent: {
      role: routing.role,
      capabilityIds: [...routing.capabilityIds],
      requiresVision: routing.requiresVision,
    },
    ...AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
  };
  activeBinding.bindingKey = modelIntentBindingKey(activeBinding);
  return normalizeAgentSelfRepairModelIntentV1(activeBinding);
}
