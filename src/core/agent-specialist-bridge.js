/**
 * Bridges a durable AgentPlan external node to the existing bounded
 * SpecialistAssignment contract.  This is deliberately not an executor: a
 * provider must separately perform the effect and an independent verifier
 * must separately certify the result.
 */
import { AgentExecutionPlane, AgentPlanNodeState, normalizeAgentPlanV1, reconcileAgentPlanV1, transitionAgentPlanNodeV1 } from './agent-plan.js';
import { SpecialistAssignmentState, claimEligibleSpecialistAssignmentsV1, normalizeSpecialistAssignmentV1 } from './specialist-assignment.js';

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

/** Claims only READY handoffs. Expired effect leases are returned for reconciliation, never silently reclaimed. */
export function claimAgentPlanSpecialistHandoffsV1(rawPlan, rawAssignments, { availableSlots = 0, maxChildrenPerAgent = 4, maxDepth = 2, leaseSeconds = 900, at = new Date().toISOString() } = {}) {
  let plan = reconcileAgentPlanV1(rawPlan, { at });
  const assignments = validateAssignments(plan, rawAssignments).map(item => structuredClone(item));
  const now = timestamp(at, 'at');
  const expired = assignments.filter(item => item.state === SpecialistAssignmentState.LEASED && item.leaseExpiresAt <= now).map(item => item.agentId);
  const eligible = assignments.filter(item => item.state === SpecialistAssignmentState.READY);
  const claimedResult = claimEligibleSpecialistAssignmentsV1(eligible, { now, availableSlots, maxChildrenPerAgent, maxDepth, leaseSeconds });
  const claimedById = new Map(claimedResult.assignments.map(item => [item.agentId, item]));
  const merged = assignments.map(item => claimedById.get(item.agentId) || item).map(normalizeSpecialistAssignmentV1);
  for (const agentId of claimedResult.claimed) {
    const node = plan.nodes.find(item => specialistAssignmentIdForPlanNodeV1(plan.planId, item.nodeId) === agentId);
    plan = transitionAgentPlanNodeV1(plan, { nodeId: node.nodeId, state: AgentPlanNodeState.RUNNING, at: now });
  }
  return freeze({ plan, assignments: merged, claimed: claimedResult.claimed, reconciliationRequired: expired });
}

export function completeAgentPlanSpecialistHandoffV1(rawPlan, rawAssignments, { agentId, leaseId, resultArtifactIds, at = new Date().toISOString() } = {}) {
  const plan = normalizeAgentPlanV1(rawPlan);
  const assignments = validateAssignments(plan, rawAssignments).map(item => structuredClone(item));
  const target = assignments.find(item => item.agentId === id(agentId, 'agentId'));
  if (!target || target.state !== SpecialistAssignmentState.LEASED || target.leaseId !== id(leaseId, 'leaseId')) throw new Error('Only the current specialist lease may report completion');
  if (target.leaseExpiresAt <= timestamp(at, 'at')) throw new Error('Expired specialist lease requires reconciliation');
  const artifacts = ids(resultArtifactIds, 'resultArtifactIds');
  if (!artifacts.length) throw new Error('Specialist completion requires result artifact evidence');
  target.state = SpecialistAssignmentState.COMPLETED;
  target.leaseId = ''; target.leaseExpiresAt = ''; target.resultArtifactIds = artifacts; target.updatedAt = timestamp(at, 'at');
  return freeze({ plan, assignments: assignments.map(normalizeSpecialistAssignmentV1), verificationRequired: target.agentId });
}

/** A result is not a completed plan node until a distinct verifier supplies evidence. */
export function verifyAgentPlanSpecialistHandoffV1(rawPlan, rawAssignments, { agentId, verifierId, evidence, at = new Date().toISOString() } = {}) {
  let plan = normalizeAgentPlanV1(rawPlan);
  const assignments = validateAssignments(plan, rawAssignments);
  const assignment = assignments.find(item => item.agentId === id(agentId, 'agentId'));
  if (!assignment || assignment.state !== SpecialistAssignmentState.COMPLETED) throw new Error('Specialist handoff is not awaiting verification');
  const verifier = id(verifierId, 'verifierId');
  if ([assignment.agentId, assignment.parentAgentId].includes(verifier)) throw new Error('Verifier must be independent from specialist and parent');
  const node = plan.nodes.find(item => specialistAssignmentIdForPlanNodeV1(plan.planId, item.nodeId) === assignment.agentId);
  if (node.state !== AgentPlanNodeState.RUNNING) throw new Error('Specialist plan node is not running');
  plan = transitionAgentPlanNodeV1(plan, { nodeId: node.nodeId, state: AgentPlanNodeState.VERIFIED, evidence: text(evidence, 'verification evidence'), at });
  return freeze({ plan, assignments, verifiedAgentId: assignment.agentId });
}
