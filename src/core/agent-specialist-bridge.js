/**
 * Bridges a durable AgentPlan external node to the existing bounded
 * SpecialistAssignment contract.  This is deliberately not an executor: a
 * provider must separately perform the effect and an independent verifier
 * must separately certify the result.
 */
import { AgentExecutionPlane, AgentPlanNodeState, normalizeAgentPlanV1, reconcileAgentPlanV1, transitionAgentPlanNodeV1 } from './agent-plan.js';
import { SpecialistAssignmentState, claimEligibleSpecialistAssignmentsV1, normalizeSpecialistAssignmentV1 } from './specialist-assignment.js';
import { normalizeVerificationV1 } from './universal-agent-contracts.js';
import {
  ExecutionOwnershipState,
  createExecutionOwnershipV1,
  normalizeExecutionOwnershipV1,
  claimExecutionOwnershipV1,
  recoverExpiredExecutionOwnershipV1,
  resolveExecutionReconciliationV1,
  verifyExecutionByAuthorityV1,
} from './execution-plane-ownership.js';

const EXTERNAL_PLANES = new Set([AgentExecutionPlane.LOCAL, AgentExecutionPlane.CLOUD, AgentExecutionPlane.REMOTE]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function exact(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`); }
function id(value, label) { const out = String(value ?? '').trim(); if (!ID.test(out)) throw new Error(`${label} is invalid`); return out; }
function timestamp(value, label) { const ms = Date.parse(String(value ?? '')); if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`); return new Date(ms).toISOString(); }
function integer(value, label, min, max) { const out = Number(value); if (!Number.isInteger(out) || out < min || out > max) throw new Error(`${label} is invalid`); return out; }
function ids(value, label, max = 32) { if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`); const out = value.map((item, index) => id(item, `${label}[${index}]`)); if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`); return out; }
function text(value, label, max = 8000) { const out = typeof value === 'string' ? value.trim() : ''; if (!out || out.length > max) throw new Error(`${label} is invalid`); return out; }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }

export function specialistAssignmentIdForPlanNodeV1(planId, nodeId) {
  return id(`specialist:${id(planId, 'planId')}:${id(nodeId, 'nodeId')}`, 'specialist assignment id');
}

export function specialistEffectIdForPlanNodeV1(planId, nodeId) {
  return id(`specialist-effect:${id(planId, 'planId')}:${id(nodeId, 'nodeId')}`, 'specialist effect id');
}

export function specialistTaskIdForPlanV1(planId) {
  return id(`browser-agent-task:${id(planId, 'planId')}`, 'specialist task id');
}

function externalNode(plan, nodeId) {
  const node = plan.nodes.find(item => item.nodeId === nodeId);
  if (!node) throw new Error('AgentPlan node not found');
  if (!EXTERNAL_PLANES.has(node.executionPlane)) throw new Error('Only LOCAL, CLOUD or REMOTE plan nodes may use a specialist handoff');
  return node;
}

function validateAssignments(plan, rawAssignments = []) {
  if (!Array.isArray(rawAssignments) || rawAssignments.length > 128) throw new Error('Specialist handoffs must be a bounded array');
  const assignments = rawAssignments.map(normalizeSpecialistAssignmentV1);
  if (new Set(assignments.map(item => item.agentId)).size !== assignments.length) throw new Error('Specialist handoffs contain duplicate agentId');
  for (const assignment of assignments) {
    if (assignment.jobId !== plan.jobId) throw new Error('Specialist handoff jobId does not match AgentPlan');
    const node = plan.nodes.find(item => specialistAssignmentIdForPlanNodeV1(plan.planId, item.nodeId) === assignment.agentId);
    if (!node || !EXTERNAL_PLANES.has(node.executionPlane)) throw new Error('Specialist handoff does not bind an external AgentPlan node');
    if (assignment.ownershipKey !== (node.conflictKeys[0] || `plan:${plan.planId}:${node.nodeId}`)) throw new Error('Specialist handoff ownership key does not match AgentPlan node');
  }
  return assignments;
}

function nodeForAssignment(plan, assignment) {
  return plan.nodes.find(item => specialistAssignmentIdForPlanNodeV1(plan.planId, item.nodeId) === assignment.agentId);
}

function validateExecutionOwnerships(plan, assignments, rawOwnerships = []) {
  if (!Array.isArray(rawOwnerships) || rawOwnerships.length !== assignments.length) throw new Error('Specialist execution ownership must exactly cover specialist handoffs');
  const ownerships = rawOwnerships.map(normalizeExecutionOwnershipV1);
  if (new Set(ownerships.map(item => item.effectId)).size !== ownerships.length) throw new Error('Specialist execution ownership contains duplicate effect identity');
  for (const assignment of assignments) {
    const node = nodeForAssignment(plan, assignment);
    const ownership = ownerships.find(item => item.effectId === specialistEffectIdForPlanNodeV1(plan.planId, node.nodeId));
    if (!ownership) throw new Error('Specialist handoff lacks canonical execution ownership');
    if (ownership.taskId !== specialistTaskIdForPlanV1(plan.planId) || ownership.planId !== plan.planId || ownership.nodeId !== node.nodeId) throw new Error('Specialist execution ownership identity does not match AgentPlan node');
    if (ownership.ownerPlane && ownership.ownerPlane !== node.executionPlane) throw new Error('Specialist execution ownership plane does not match AgentPlan node');
    if (assignment.state === SpecialistAssignmentState.LEASED && ownership.state === ExecutionOwnershipState.OWNED && (ownership.ownerId !== assignment.agentId || ownership.leaseId !== assignment.leaseId || ownership.leaseUntil !== assignment.leaseExpiresAt)) throw new Error('Specialist execution ownership lease does not match specialist assignment');
    if (assignment.state === SpecialistAssignmentState.LEASED && ![ExecutionOwnershipState.OWNED, ExecutionOwnershipState.RECONCILE, ExecutionOwnershipState.MANUAL_REVIEW].includes(ownership.state)) throw new Error('Leased specialist assignment lacks a recoverable execution owner state');
  }
  return ownerships;
}

/** Builds a child scope only when an explicit parent capability envelope contains it. */
export function prepareAgentPlanSpecialistHandoffV1(rawPlan, { nodeId, specialistId, requestedCapabilityIds, parentCapabilityIds, deadlineAt, priority = 0, at = new Date().toISOString() } = {}) {
  const plan = reconcileAgentPlanV1(rawPlan, { at });
  const node = externalNode(plan, id(nodeId, 'nodeId'));
  if (node.state !== AgentPlanNodeState.READY) throw new Error('AgentPlan node must be READY before specialist handoff');
  const requested = ids(requestedCapabilityIds, 'requestedCapabilityIds');
  const parent = new Set(ids(parentCapabilityIds, 'parentCapabilityIds'));
  if (requested.some(capabilityId => !parent.has(capabilityId))) throw new Error('Specialist capability would exceed parent scope');
  const updatedAt = timestamp(at, 'at');
  return normalizeSpecialistAssignmentV1({
    schemaVersion: 1,
    agentId: specialistAssignmentIdForPlanNodeV1(plan.planId, node.nodeId),
    parentAgentId: id(`browser-agent:${plan.jobId}`, 'parentAgentId'),
    jobId: plan.jobId,
    purpose: node.objective,
    specialistId: id(specialistId, 'specialistId'),
    requestedCapabilityIds: requested,
    ownershipKey: node.conflictKeys[0] || `plan:${plan.planId}:${node.nodeId}`,
    depth: 2,
    priority: integer(priority, 'priority', 0, 1_000_000),
    state: SpecialistAssignmentState.READY,
    leaseId: '', leaseExpiresAt: '',
    deadlineAt: timestamp(deadlineAt, 'deadlineAt'),
    resultArtifactIds: [],
    updatedAt,
  });
}

/** Creates the one canonical effect-ownership record paired with a specialist handoff. */
export function prepareAgentPlanSpecialistExecutionOwnershipV1(rawPlan, { nodeId, policyEnvelopeId, at = new Date().toISOString() } = {}) {
  const plan = reconcileAgentPlanV1(rawPlan, { at });
  const node = externalNode(plan, id(nodeId, 'nodeId'));
  if (node.state !== AgentPlanNodeState.READY) throw new Error('AgentPlan node must be READY before specialist execution ownership is prepared');
  return createExecutionOwnershipV1({
    taskId: specialistTaskIdForPlanV1(plan.planId),
    planId: plan.planId,
    nodeId: node.nodeId,
    effectId: specialistEffectIdForPlanNodeV1(plan.planId, node.nodeId),
    policyEnvelopeId: id(policyEnvelopeId, 'policyEnvelopeId'),
    at,
  });
}

/** Claims only READY handoffs. Expired effect leases are returned for reconciliation, never silently reclaimed. */
export function claimAgentPlanSpecialistHandoffsV1(rawPlan, rawAssignments, { executionOwnerships = [], availableSlots = 0, maxChildrenPerAgent = 4, maxDepth = 2, leaseSeconds = 900, at = new Date().toISOString() } = {}) {
  let plan = reconcileAgentPlanV1(rawPlan, { at });
  const assignments = validateAssignments(plan, rawAssignments).map(item => structuredClone(item));
  let ownerships = validateExecutionOwnerships(plan, assignments, executionOwnerships).map(item => structuredClone(item));
  const now = timestamp(at, 'at');
  const expired = assignments.filter(item => item.state === SpecialistAssignmentState.LEASED && item.leaseExpiresAt <= now).map(item => item.agentId);
  ownerships = ownerships.map(item => item.state === ExecutionOwnershipState.OWNED && expired.some(agentId => {
    const assignment = assignments.find(candidate => candidate.agentId === agentId);
    const node = nodeForAssignment(plan, assignment);
    return item.effectId === specialistEffectIdForPlanNodeV1(plan.planId, node.nodeId);
  }) ? recoverExpiredExecutionOwnershipV1(item, { at: now }) : item);
  const eligible = assignments.filter(item => item.state === SpecialistAssignmentState.READY);
  const claimedResult = claimEligibleSpecialistAssignmentsV1(eligible, { now, availableSlots, maxChildrenPerAgent, maxDepth, leaseSeconds });
  const claimedById = new Map(claimedResult.assignments.map(item => [item.agentId, item]));
  const merged = assignments.map(item => claimedById.get(item.agentId) || item).map(normalizeSpecialistAssignmentV1);
  for (const agentId of claimedResult.claimed) {
    const node = plan.nodes.find(item => specialistAssignmentIdForPlanNodeV1(plan.planId, item.nodeId) === agentId);
    const assignment = merged.find(item => item.agentId === agentId);
    const effectId = specialistEffectIdForPlanNodeV1(plan.planId, node.nodeId);
    ownerships = ownerships.map(item => item.effectId === effectId
      ? claimExecutionOwnershipV1(item, { plane:node.executionPlane, ownerId:assignment.agentId, leaseId:assignment.leaseId, leaseUntil:assignment.leaseExpiresAt, at:now })
      : item);
    plan = transitionAgentPlanNodeV1(plan, { nodeId: node.nodeId, state: AgentPlanNodeState.RUNNING, at: now });
  }
  return freeze({ plan, assignments: merged, executionOwnerships: ownerships.map(normalizeExecutionOwnershipV1), claimed: claimedResult.claimed, reconciliationRequired: expired });
}

/**
 * Makes an expired handoff eligible for a new lease only after an independent
 * verifier proves that the ambiguous attempt committed no effect.  This does
 * not dispatch the retry: normal bounded admission must claim it again.
 */
export function authorizeAgentPlanSpecialistSafeRetryV1(rawPlan, rawAssignments, {
  executionOwnerships = [], agentId, leaseId, verification,
  at = new Date().toISOString(),
} = {}) {
  let plan = normalizeAgentPlanV1(rawPlan);
  const assignments = validateAssignments(plan, rawAssignments).map(item => structuredClone(item));
  const assignment = assignments.find(item => item.agentId === id(agentId, 'agentId'));
  const preservedLeaseId = id(leaseId, 'leaseId');
  if (!assignment || assignment.state !== SpecialistAssignmentState.LEASED || assignment.leaseId !== preservedLeaseId) {
    throw new Error('SAFE_RETRY requires the preserved specialist lease identity');
  }
  let normalizedVerification;
  try {
    normalizedVerification = normalizeVerificationV1(verification);
  } catch (error) {
    throw new Error(`SAFE_RETRY requires canonical verification: ${error.message}`);
  }
  const verifier = normalizedVerification.verifierId;
  if (!verifier || [assignment.agentId, assignment.parentAgentId].includes(verifier)) {
    throw new Error('SAFE_RETRY verifier must be independent from specialist and parent');
  }
  const ownerships = validateExecutionOwnerships(plan, assignments, executionOwnerships);
  const node = nodeForAssignment(plan, assignment);
  if (node.state !== AgentPlanNodeState.RUNNING) throw new Error('SAFE_RETRY requires the ambiguous AgentPlan node to remain RUNNING');
  const effectId = specialistEffectIdForPlanNodeV1(plan.planId, node.nodeId);
  const ownership = ownerships.find(item => item.effectId === effectId);
  if (ownership.state !== ExecutionOwnershipState.RECONCILE || ownership.leaseId !== preservedLeaseId) {
    throw new Error('SAFE_RETRY requires matching canonical execution reconciliation');
  }
  const availableOwnership = resolveExecutionReconciliationV1(ownership, {
    leaseId: preservedLeaseId,
    outcome: 'SAFE_RETRY',
    verification: normalizedVerification,
    at,
  });
  assignment.state = SpecialistAssignmentState.READY;
  assignment.leaseId = '';
  assignment.leaseExpiresAt = '';
  assignment.resultArtifactIds = [];
  assignment.updatedAt = timestamp(at, 'at');
  plan = transitionAgentPlanNodeV1(plan, { nodeId: node.nodeId, state: AgentPlanNodeState.READY, at });
  return freeze({
    plan,
    assignments: assignments.map(normalizeSpecialistAssignmentV1),
    executionOwnerships: ownerships.map(item => item.effectId === effectId ? availableOwnership : item),
    retriableAgentId: assignment.agentId,
    safeRetryVerification: normalizedVerification,
  });
}

export function completeAgentPlanSpecialistHandoffV1(rawPlan, rawAssignments, { executionOwnerships = [], agentId, leaseId, resultArtifactIds, at = new Date().toISOString() } = {}) {
  const plan = normalizeAgentPlanV1(rawPlan);
  const assignments = validateAssignments(plan, rawAssignments).map(item => structuredClone(item));
  const target = assignments.find(item => item.agentId === id(agentId, 'agentId'));
  if (!target || target.state !== SpecialistAssignmentState.LEASED || target.leaseId !== id(leaseId, 'leaseId')) throw new Error('Only the current specialist lease may report completion');
  if (target.leaseExpiresAt <= timestamp(at, 'at')) throw new Error('Expired specialist lease requires reconciliation');
  const ownerships = validateExecutionOwnerships(plan, assignments, executionOwnerships);
  const node = nodeForAssignment(plan, target);
  const ownership = ownerships.find(item => item.effectId === specialistEffectIdForPlanNodeV1(plan.planId, node.nodeId));
  if (ownership.state !== ExecutionOwnershipState.OWNED || ownership.leaseId !== target.leaseId) throw new Error('Specialist completion requires the matching canonical execution owner lease');
  const artifacts = ids(resultArtifactIds, 'resultArtifactIds');
  if (!artifacts.length) throw new Error('Specialist completion requires result artifact evidence');
  target.state = SpecialistAssignmentState.COMPLETED;
  target.leaseId = ''; target.leaseExpiresAt = ''; target.resultArtifactIds = artifacts; target.updatedAt = timestamp(at, 'at');
  return freeze({ plan, assignments: assignments.map(normalizeSpecialistAssignmentV1), executionOwnerships: ownerships, verificationRequired: target.agentId });
}

/** A result is not a completed plan node until a distinct verifier supplies evidence. */
export function verifyAgentPlanSpecialistHandoffV1(rawPlan, rawAssignments, { executionOwnerships = [], agentId, verifierId, verificationAuthorityId, evidence, at = new Date().toISOString() } = {}) {
  let plan = normalizeAgentPlanV1(rawPlan);
  const assignments = validateAssignments(plan, rawAssignments);
  const assignment = assignments.find(item => item.agentId === id(agentId, 'agentId'));
  if (!assignment || assignment.state !== SpecialistAssignmentState.COMPLETED) throw new Error('Specialist handoff is not awaiting verification');
  const verifier = id(verifierId, 'verifierId');
  if ([assignment.agentId, assignment.parentAgentId].includes(verifier)) throw new Error('Verifier must be independent from specialist and parent');
  const node = plan.nodes.find(item => specialistAssignmentIdForPlanNodeV1(plan.planId, item.nodeId) === assignment.agentId);
  if (node.state !== AgentPlanNodeState.RUNNING) throw new Error('Specialist plan node is not running');
  const ownerships = validateExecutionOwnerships(plan, assignments, executionOwnerships);
  const effectId = specialistEffectIdForPlanNodeV1(plan.planId, node.nodeId);
  const ownership = ownerships.find(item => item.effectId === effectId);
  const verifiedOwnership = verifyExecutionByAuthorityV1(ownership, { leaseId:ownership.leaseId, verifierId:verifier, verificationAuthorityId, evidence, at });
  plan = transitionAgentPlanNodeV1(plan, { nodeId: node.nodeId, state: AgentPlanNodeState.VERIFIED, evidence: text(evidence, 'verification evidence'), at });
  return freeze({ plan, assignments, executionOwnerships: ownerships.map(item => item.effectId === effectId ? verifiedOwnership : item), verifiedAgentId: assignment.agentId });
}
