import test from 'node:test';
import assert from 'node:assert/strict';
import { SpecialistAssignmentState, claimEligibleSpecialistAssignmentsV1, normalizeSpecialistAssignmentV1 } from '../src/core/specialist-assignment.js';

const AT = '2026-09-23T12:00:00.000Z';
function assignment(overrides = {}) { return { schemaVersion: 1, agentId: 'child-1', parentAgentId: 'parent-1', jobId: 'job-1', purpose: 'Inspect one bounded project slice.', specialistId: 'coding-specialist', requestedCapabilityIds: ['workspace.read'], ownershipKey: 'repo:main', depth: 2, priority: 5, state: 'READY', leaseId: '', leaseExpiresAt: '', deadlineAt: '2026-09-23T13:00:00.000Z', resultArtifactIds: [], updatedAt: AT, ...overrides }; }

test('Specialist assignments bind child identity, explicit capability scope, depth and deadline', () => {
  const value = normalizeSpecialistAssignmentV1(assignment());
  assert.equal(value.state, SpecialistAssignmentState.READY);
  assert.throws(() => normalizeSpecialistAssignmentV1(assignment({ depth: 3, parentAgentId: '' })), /parentAgentId/);
  assert.throws(() => normalizeSpecialistAssignmentV1(assignment({ unrestrictedCapabilities: true })), /unknown field/);
});

test('Specialist claiming is completion-driven, capacity-bounded and recovers only expired leases', () => {
  const result = claimEligibleSpecialistAssignmentsV1([
    assignment({ agentId: 'low', priority: 1 }),
    assignment({ agentId: 'high', priority: 9 }),
    assignment({ agentId: 'expired', priority: 5, state: 'LEASED', leaseId: 'lease:old', leaseExpiresAt: '2026-09-23T11:59:00.000Z' }),
  ], { now: AT, availableSlots: 2, leaseSeconds: 60 });
  assert.deepEqual(result.claimed, ['high', 'expired']);
  assert.equal(result.assignments.find(item => item.agentId === 'high').state, 'LEASED');
  assert.equal(result.assignments.find(item => item.agentId === 'low').state, 'READY');
  assert.throws(() => claimEligibleSpecialistAssignmentsV1([assignment(), assignment({ agentId: 'child-2' }), assignment({ agentId: 'child-3' }), assignment({ agentId: 'child-4' }), assignment({ agentId: 'child-5' })], { now: AT, maxChildrenPerAgent: 4 }), /child limit/);
});
