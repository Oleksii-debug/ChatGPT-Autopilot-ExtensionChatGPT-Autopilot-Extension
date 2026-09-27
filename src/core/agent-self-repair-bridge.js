import {
  AgentPlanNodeState,
  extendAgentPlanV1,
  normalizeAgentPlanV1,
} from './agent-plan.js';
import {
  SelfRepairCycleState,
  assessSelfRepairCycleV1,
  normalizeSelfRepairCycleV1,
} from './self-repair-cycle.js';

export const AGENT_SELF_REPAIR_BRIDGE_VERSION = 1;

export const AgentSelfRepairWorkKind = Object.freeze({
  REPAIR: 'REPAIR',
  RETEST: 'RETEST',
  VERIFIED: 'VERIFIED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  EXHAUSTED: 'EXHAUSTED',
});

const REQUEST_KEYS = new Set([
  'originPlan',
  'currentPlan',
  'failedNodeId',
  'cycle',
  'workNode',
  'predecessorNodeId',
  'resourceEnvelope',
  'at',
]);

const WORK_NODE_KEYS = new Set([
  'nodeId',
  'title',
  'objective',
  'conflictKeys',
  'executionPlane',
  'acceptanceCriteria',
  'budget',
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function strictRecord(value, label, allowedKeys) {
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
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(`${label} field ${String(key)} must be an enumerable own data property`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a canonical timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function denseDataArray(value, label, max = 128) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(`${label} must contain at most ${max} items`);
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

function sameNode(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeWorkNodeTemplate(value) {
  const raw = strictRecord(value, 'Agent self-repair workNode', WORK_NODE_KEYS);
  if (!Object.prototype.hasOwnProperty.call(raw, 'nodeId')) throw new Error('Agent self-repair workNode nodeId is required');
  if (!Object.prototype.hasOwnProperty.call(raw, 'title')) throw new Error('Agent self-repair workNode title is required');
  if (!Object.prototype.hasOwnProperty.call(raw, 'objective')) throw new Error('Agent self-repair workNode objective is required');
  if (!Object.prototype.hasOwnProperty.call(raw, 'executionPlane')) throw new Error('Agent self-repair workNode executionPlane is required');
  if (!Object.prototype.hasOwnProperty.call(raw, 'budget')) throw new Error('Agent self-repair workNode budget is required');
  const conflictKeys = Object.prototype.hasOwnProperty.call(raw, 'conflictKeys')
    ? denseDataArray(raw.conflictKeys, 'Agent self-repair workNode conflictKeys')
    : [];
  const acceptanceCriteria = Object.prototype.hasOwnProperty.call(raw, 'acceptanceCriteria')
    ? denseDataArray(raw.acceptanceCriteria, 'Agent self-repair workNode acceptanceCriteria', 32)
    : [];
  return Object.freeze({
    nodeId: raw.nodeId,
    title: raw.title,
    objective: raw.objective,
    conflictKeys,
    executionPlane: raw.executionPlane,
    acceptanceCriteria,
    budget: raw.budget,
  });
}

function validateOriginBinding(originPlan, failedNodeId, cycle) {
  const failedNode = originPlan.nodes.find((node) => node.nodeId === failedNodeId);
  if (!failedNode) throw new Error('Agent self-repair failed node does not exist in originPlan');
  if (failedNode.state !== AgentPlanNodeState.FAILED) {
    throw new Error('Agent self-repair origin node must be FAILED');
  }
  if (cycle.subjectId !== failedNodeId) {
    throw new Error('Agent self-repair cycle subjectId must match failedNodeId');
  }
  if (cycle.baselineRevisionId !== failedNode.updatedAt) {
    throw new Error('Agent self-repair cycle baselineRevisionId must match failed node updatedAt');
  }
  const initialFailure = cycle.attempts[0]?.failure;
  if (!initialFailure || initialFailure.subjectRevisionId !== failedNode.updatedAt) {
    throw new Error('Agent self-repair initial failure must bind the failed node revision');
  }
  if (Date.parse(initialFailure.completedAt) < Date.parse(failedNode.updatedAt)) {
    throw new Error('Agent self-repair failure evidence cannot predate the failed node revision');
  }
  return failedNode;
}

function validateCurrentPlan(originPlan, currentPlan, failedNode) {
  if (currentPlan.planId !== originPlan.planId || currentPlan.jobId !== originPlan.jobId) {
    throw new Error('Agent self-repair currentPlan identity does not match originPlan');
  }
  if (currentPlan.revision < originPlan.revision) {
    throw new Error('Agent self-repair currentPlan revision predates originPlan');
  }
  const currentFailedNode = currentPlan.nodes.find((node) => node.nodeId === failedNode.nodeId);
  if (!currentFailedNode || !sameNode(currentFailedNode, failedNode)) {
    throw new Error('Agent self-repair failed node drifted after origin binding');
  }
}

function workKindForState(state) {
  if (state === SelfRepairCycleState.READY_FOR_REPAIR) return AgentSelfRepairWorkKind.REPAIR;
  if (state === SelfRepairCycleState.READY_FOR_RETEST) return AgentSelfRepairWorkKind.RETEST;
  if (state === SelfRepairCycleState.VERIFIED) return AgentSelfRepairWorkKind.VERIFIED;
  if (state === SelfRepairCycleState.MANUAL_REVIEW) return AgentSelfRepairWorkKind.MANUAL_REVIEW;
  if (state === SelfRepairCycleState.EXHAUSTED) return AgentSelfRepairWorkKind.EXHAUSTED;
  throw new Error('Agent self-repair cycle state is unsupported');
}

function authorityFence() {
  return {
    advisoryOnly: true,
    executionAuthorized: false,
    mutationAuthorized: false,
    verificationAuthorized: false,
    completionAuthorized: false,
    policyGranted: false,
    requiresCanonicalExecutor: true,
    requiresCanonicalPolicy: true,
    requiresIndependentVerifier: true,
    requiresCanonicalPlanStore: true,
    requiresCanonicalCompletionCommit: true,
  };
}

export function proposeAgentSelfRepairWorkV1(input) {
  const raw = strictRecord(input, 'AgentSelfRepairBridge request', REQUEST_KEYS);
  const originPlan = normalizeAgentPlanV1(raw.originPlan);
  const currentPlan = normalizeAgentPlanV1(raw.currentPlan);
  const failedNodeId = id(raw.failedNodeId, 'Agent self-repair failedNodeId');
  const cycle = normalizeSelfRepairCycleV1(raw.cycle);
  const assessment = assessSelfRepairCycleV1(cycle);
  const failedNode = validateOriginBinding(originPlan, failedNodeId, cycle);
  validateCurrentPlan(originPlan, currentPlan, failedNode);

  const at = timestamp(raw.at, 'Agent self-repair at');
  if (Date.parse(at) < Date.parse(currentPlan.updatedAt)) {
    throw new Error('Agent self-repair at cannot predate currentPlan');
  }
  if (Date.parse(at) < Date.parse(cycle.updatedAt)) {
    throw new Error('Agent self-repair at cannot predate cycle evidence');
  }

  const kind = workKindForState(assessment.state);
  const terminal = kind === AgentSelfRepairWorkKind.VERIFIED
    || kind === AgentSelfRepairWorkKind.MANUAL_REVIEW
    || kind === AgentSelfRepairWorkKind.EXHAUSTED;

  const base = {
    schemaVersion: AGENT_SELF_REPAIR_BRIDGE_VERSION,
    planId: originPlan.planId,
    jobId: originPlan.jobId,
    failedNodeId,
    originPlanRevision: originPlan.revision,
    currentPlanRevision: currentPlan.revision,
    failedNodeRevisionId: failedNode.updatedAt,
    cycleId: cycle.cycleId,
    cycleState: assessment.state,
    workKind: kind,
    activeAttemptNumber: assessment.activeAttemptNumber,
    currentSubjectRevisionId: assessment.currentRevisionId,
    actorId: cycle.actorId,
    verifierId: cycle.verifierId,
    verifierPlanRevisionId: cycle.verifierPlanRevisionId,
    evidenceTrust: assessment.evidenceTrust,
    requiresCanonicalEvidenceResolution: assessment.requiresCanonicalEvidenceResolution,
    ...authorityFence(),
  };

  if (terminal) {
    if (raw.workNode != null || raw.predecessorNodeId != null) {
      throw new Error('Agent self-repair terminal state cannot admit new work');
    }
    return freezeDeep({
      ...base,
      extensionNode: null,
      proposedPlan: null,
    });
  }

  if (raw.workNode == null) throw new Error('Agent self-repair active state requires workNode');
  if (raw.resourceEnvelope == null) throw new Error('Agent self-repair active state requires resourceEnvelope');
  const template = normalizeWorkNodeTemplate(raw.workNode);

  let ownerId;
  let dependsOn;
  if (kind === AgentSelfRepairWorkKind.REPAIR) {
    if (raw.predecessorNodeId != null) {
      throw new Error('Agent self-repair REPAIR work cannot use predecessorNodeId');
    }
    ownerId = cycle.actorId;
    dependsOn = [...failedNode.dependsOn];
  } else {
    const predecessorNodeId = id(raw.predecessorNodeId, 'Agent self-repair predecessorNodeId');
    const predecessor = currentPlan.nodes.find((node) => node.nodeId === predecessorNodeId);
    if (!predecessor) throw new Error('Agent self-repair RETEST predecessor node does not exist');
    if (predecessor.state !== AgentPlanNodeState.VERIFIED) {
      throw new Error('Agent self-repair RETEST predecessor must be VERIFIED');
    }
    if (predecessor.ownerId !== cycle.actorId) {
      throw new Error('Agent self-repair RETEST predecessor must be owned by repair actor');
    }
    if (!predecessor.conflictKeys.includes(cycle.cycleId)) {
      throw new Error('Agent self-repair RETEST predecessor is not bound to this cycle');
    }
    const latestAttempt = cycle.attempts.at(-1);
    if (!latestAttempt?.repair) throw new Error('Agent self-repair RETEST requires cycle repair evidence');
    if (latestAttempt.repair.repairId !== predecessor.nodeId) {
      throw new Error('Agent self-repair RETEST predecessor nodeId must match cycle repairId');
    }
    if (Date.parse(predecessor.updatedAt) < Date.parse(latestAttempt.repair.appliedAt)) {
      throw new Error('Agent self-repair RETEST predecessor predates applied repair evidence');
    }
    ownerId = cycle.verifierId;
    dependsOn = [predecessor.nodeId];
  }

  const conflictKeys = [];
  if (kind === AgentSelfRepairWorkKind.REPAIR) {
    for (const conflictKey of failedNode.conflictKeys) {
      if (!conflictKeys.includes(conflictKey)) conflictKeys.push(conflictKey);
    }
  }
  for (const conflictKey of template.conflictKeys) {
    if (!conflictKeys.includes(conflictKey)) conflictKeys.push(conflictKey);
  }
  if (!conflictKeys.includes(cycle.cycleId)) conflictKeys.push(cycle.cycleId);

  const extension = {
    nodeId: template.nodeId,
    title: template.title,
    objective: template.objective,
    dependsOn,
    conflictKeys,
    ownerId,
    executionPlane: template.executionPlane,
    acceptanceCriteria: template.acceptanceCriteria,
    budget: template.budget,
    state: AgentPlanNodeState.PENDING,
    evidence: '',
    updatedAt: at,
  };

  const proposedPlan = extendAgentPlanV1(currentPlan, {
    expectedRevision: currentPlan.revision,
    nodes: [extension],
    resourceEnvelope: raw.resourceEnvelope,
    at,
  });
  const extensionNode = proposedPlan.nodes.find((node) => node.nodeId === template.nodeId);
  if (!extensionNode) throw new Error('Agent self-repair plan extension was not retained');

  return freezeDeep({
    ...base,
    proposedPlanRevision: proposedPlan.revision,
    extensionNode,
    proposedPlan,
  });
}
