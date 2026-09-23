import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareAgentPlanSpecialistHandoffV1,
  claimAgentPlanSpecialistHandoffsV1,
  completeAgentPlanSpecialistHandoffV1,
  verifyAgentPlanSpecialistHandoffV1,
} from '../src/core/agent-specialist-bridge.js';

const T0 = '2026-09-23T12:00:00.000Z';
const T1 = '2026-09-23T12:01:00.000Z';
function plan() { return { schemaVersion:1, planId:'plan-1', jobId:'job-1', objective:'Complete safely', successCriteria:['Verified'], createdAt:T0, updatedAt:T0, revision:1, nodes:[{ nodeId:'browser', title:'Inspect', objective:'Inspect', dependsOn:[], conflictKeys:['web'], ownerId:'parent', executionPlane:'BROWSER', acceptanceCriteria:[], budget:{}, state:'VERIFIED', evidence:'Observed', updatedAt:T0 }, { nodeId:'local', title:'Archive', objective:'Create a bounded archive', dependsOn:['browser'], conflictKeys:['files'], ownerId:'parent', executionPlane:'LOCAL', acceptanceCriteria:['Archive exists'], budget:{}, state:'PENDING', evidence:'', updatedAt:T0 }] }; }
function scope(overrides = {}) { return { nodeId:'local', specialistId:'native-companion', requestedCapabilityIds:['filesystem.archive'], parentCapabilityIds:['filesystem.read','filesystem.archive'], deadlineAt:'2026-09-23T13:00:00.000Z', priority:4, at:T0, ...overrides }; }

test('external AgentPlan node becomes a bounded child handoff only inside explicit parent scope', () => {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  assert.equal(assignment.state, 'READY');
  assert.equal(assignment.parentAgentId, 'browser-agent:job-1');
  assert.equal(assignment.depth, 2);
  assert.throws(() => prepareAgentPlanSpecialistHandoffV1(plan(), scope({ requestedCapabilityIds:['filesystem.delete'] })), /exceed parent scope/);
});

test('claim is durable and never silently retries an expired external lease', () => {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  const claimed = claimAgentPlanSpecialistHandoffsV1(plan(), [assignment], { availableSlots:1, leaseSeconds:30, at:T0 });
  assert.equal(claimed.claimed.length, 1);
  assert.equal(claimed.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  const afterExpiry = claimAgentPlanSpecialistHandoffsV1(claimed.plan, claimed.assignments, { availableSlots:1, at:'2026-09-23T12:01:00.000Z' });
  assert.deepEqual(afterExpiry.claimed, []);
  assert.deepEqual(afterExpiry.reconciliationRequired, [claimed.assignments[0].agentId]);
});

test('completed specialist result cannot finish a plan without independent verification', () => {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  const claimed = claimAgentPlanSpecialistHandoffsV1(plan(), [assignment], { availableSlots:1, at:T0 });
  const completed = completeAgentPlanSpecialistHandoffV1(claimed.plan, claimed.assignments, { agentId:claimed.claimed[0], leaseId:claimed.assignments[0].leaseId, resultArtifactIds:['artifact:archive'], at:T1 });
  assert.equal(completed.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.throws(() => verifyAgentPlanSpecialistHandoffV1(completed.plan, completed.assignments, { agentId:claimed.claimed[0], verifierId:'browser-agent:job-1', evidence:'looks fine', at:T1 }), /independent/);
  const verified = verifyAgentPlanSpecialistHandoffV1(completed.plan, completed.assignments, { agentId:claimed.claimed[0], verifierId:'verifier-1', evidence:'Artifact archive hash matches fresh observation.', at:T1 });
  assert.equal(verified.plan.nodes.find(node => node.nodeId === 'local').state, 'VERIFIED');
});
