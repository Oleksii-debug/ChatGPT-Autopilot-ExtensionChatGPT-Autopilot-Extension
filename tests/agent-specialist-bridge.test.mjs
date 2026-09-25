import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareAgentPlanSpecialistHandoffV1,
  prepareAgentPlanSpecialistExecutionOwnershipV1,
  claimAgentPlanSpecialistHandoffsV1,
  authorizeAgentPlanSpecialistSafeRetryV1,
  completeAgentPlanSpecialistHandoffV1,
  verifyAgentPlanSpecialistHandoffV1,
} from '../src/core/agent-specialist-bridge.js';

const T0 = '2026-09-23T12:00:00.000Z';
const T1 = '2026-09-23T12:01:00.000Z';
function plan() { return { schemaVersion:1, planId:'plan-1', jobId:'job-1', objective:'Complete safely', successCriteria:['Verified'], createdAt:T0, updatedAt:T0, revision:1, nodes:[{ nodeId:'browser', title:'Inspect', objective:'Inspect', dependsOn:[], conflictKeys:['web'], ownerId:'parent', executionPlane:'BROWSER', acceptanceCriteria:[], budget:{}, state:'VERIFIED', evidence:'Observed', updatedAt:T0 }, { nodeId:'local', title:'Archive', objective:'Create a bounded archive', dependsOn:['browser'], conflictKeys:['files'], ownerId:'parent', executionPlane:'LOCAL', acceptanceCriteria:['Archive exists'], budget:{}, state:'PENDING', evidence:'', updatedAt:T0 }] }; }
function scope(overrides = {}) { return { nodeId:'local', specialistId:'native-companion', requestedCapabilityIds:['filesystem.archive'], parentCapabilityIds:['filesystem.read','filesystem.archive'], policyEnvelopeId:'policy:archive', deadlineAt:'2026-09-23T13:00:00.000Z', priority:4, at:T0, ...overrides }; }
function ownership(rawPlan = plan(), rawScope = scope()) { return prepareAgentPlanSpecialistExecutionOwnershipV1(rawPlan, rawScope); }

function safeRetryVerification(leaseId, overrides = {}) {
  return {
    schemaVersion: 1,
    verificationId: 'verification-no-effect-specialist',
    invocationId: 'invoke-specialist-local',
    observationId: 'observation-no-effect-specialist',
    status: 'VERIFIED',
    reasonCode: 'NO_EFFECT_OBSERVED',
    summary: 'Fresh independent verifier proves the specialist effect did not commit.',
    evidenceArtifactIds: ['artifact:no-effect-specialist'],
    verifiedAt: '2026-09-23T12:01:01.000Z',
    verifierId: 'reconciler-1',
    verificationAuthorityId: 'policy:archive',
    effectId: 'specialist-effect:plan-1:local',
    executionId: leaseId,
    attempt: 1,
    ...overrides,
  };
}

test('external AgentPlan node becomes a bounded child handoff only inside explicit parent scope', () => {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  assert.equal(assignment.state, 'READY');
  assert.equal(assignment.parentAgentId, 'browser-agent:job-1');
  assert.equal(assignment.depth, 2);
  assert.equal(ownership().effectId, 'specialist-effect:plan-1:local');
  assert.throws(() => prepareAgentPlanSpecialistHandoffV1(plan(), scope({ requestedCapabilityIds:['filesystem.delete'] })), /exceed parent scope/);
});

test('specialist bridge rejects non-canonical durable timestamp aliases', () => {
  assert.throws(
    () => prepareAgentPlanSpecialistHandoffV1(plan(), scope({ at:'2026-09-23T12:00:00Z' })),
    /canonical ISO-8601 UTC representation/,
  );
  assert.throws(
    () => prepareAgentPlanSpecialistHandoffV1(plan(), scope({ deadlineAt:'2026-09-23T15:00:00.000+02:00' })),
    /canonical ISO-8601 UTC representation/,
  );
});

test('claim is durable and never silently retries an expired external lease', () => {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  const claimed = claimAgentPlanSpecialistHandoffsV1(plan(), [assignment], { executionOwnerships:[ownership()], availableSlots:1, leaseSeconds:30, at:T0 });
  assert.equal(claimed.claimed.length, 1);
  assert.equal(claimed.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  const afterExpiry = claimAgentPlanSpecialistHandoffsV1(claimed.plan, claimed.assignments, { executionOwnerships:claimed.executionOwnerships, availableSlots:1, at:'2026-09-23T12:01:00.000Z' });
  assert.deepEqual(afterExpiry.claimed, []);
  assert.deepEqual(afterExpiry.reconciliationRequired, [claimed.assignments[0].agentId]);
  assert.equal(afterExpiry.executionOwnerships[0].state, 'RECONCILE');
  const repeated = claimAgentPlanSpecialistHandoffsV1(afterExpiry.plan, afterExpiry.assignments, { executionOwnerships:afterExpiry.executionOwnerships, availableSlots:1, at:'2026-09-23T12:02:00.000Z' });
  assert.equal(repeated.executionOwnerships[0].state, 'RECONCILE');
});

test('expired handoff remains fenced when verification has no canonical provenance', () => {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  const claimed = claimAgentPlanSpecialistHandoffsV1(plan(), [assignment], {
    executionOwnerships:[ownership()],
    availableSlots:1,
    leaseSeconds:30,
    at:T0,
  });
  const expired = claimAgentPlanSpecialistHandoffsV1(claimed.plan, claimed.assignments, {
    executionOwnerships:claimed.executionOwnerships,
    availableSlots:1,
    at:T1,
  });
  const agentId = claimed.assignments[0].agentId;
  const leaseId = claimed.assignments[0].leaseId;

  assert.throws(() => authorizeAgentPlanSpecialistSafeRetryV1(expired.plan, expired.assignments, {
    executionOwnerships: expired.executionOwnerships,
    agentId,
    leaseId,
    verification: safeRetryVerification(leaseId),
    at:'2026-09-23T12:01:01.000Z',
  }), /trusted verifier provenance/);

  assert.equal(expired.assignments[0].state, 'LEASED');
  assert.equal(expired.assignments[0].leaseId, leaseId);
  assert.equal(expired.executionOwnerships[0].state, 'RECONCILE');
  assert.equal(expired.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');

  const repeated = claimAgentPlanSpecialistHandoffsV1(expired.plan, expired.assignments, {
    executionOwnerships:expired.executionOwnerships,
    availableSlots:1,
    at:'2026-09-23T12:02:00.000Z',
  });
  assert.deepEqual(repeated.claimed, []);
  assert.equal(repeated.executionOwnerships[0].state, 'RECONCILE');
});

test('completed specialist result cannot mint verification authority from caller-owned verifier data', () => {
  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  const claimed = claimAgentPlanSpecialistHandoffsV1(plan(), [assignment], { executionOwnerships:[ownership()], availableSlots:1, at:T0 });
  const completed = completeAgentPlanSpecialistHandoffV1(claimed.plan, claimed.assignments, { executionOwnerships:claimed.executionOwnerships, agentId:claimed.claimed[0], leaseId:claimed.assignments[0].leaseId, resultArtifactIds:['artifact:archive'], at:T1 });
  assert.equal(completed.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.equal(completed.assignments[0].state, 'COMPLETED');
  assert.equal(completed.executionOwnerships[0].state, 'OWNED');

  assert.throws(
    () => verifyAgentPlanSpecialistHandoffV1(completed.plan, completed.assignments, {
      executionOwnerships:completed.executionOwnerships,
      agentId:claimed.claimed[0],
      verifierId:'verifier-forged-but-distinct',
      verificationAuthorityId:'policy:archive',
      evidence:'Caller-created text claims the artifact matches.',
      at:T1,
    }),
    /trusted verifier provenance/,
  );

  assert.equal(completed.plan.nodes.find(node => node.nodeId === 'local').state, 'RUNNING');
  assert.equal(completed.assignments[0].state, 'COMPLETED');
  assert.equal(completed.executionOwnerships[0].state, 'OWNED');
});


test('specialist bridge snapshots caller-owned request and array authority without coercion or getters', () => {
  let optionReads = 0;
  const proxyScope = new Proxy(scope(), {
    get(target, property, receiver) {
      optionReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const prepared = prepareAgentPlanSpecialistHandoffV1(plan(), proxyScope);
  assert.equal(prepared.state, 'READY');
  assert.equal(optionReads, 0, 'request Proxy get trap must not execute');

  let arrayReads = 0;
  const capabilityProxy = new Proxy(['filesystem.archive'], {
    get(target, property, receiver) {
      arrayReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const withProxyArray = prepareAgentPlanSpecialistHandoffV1(
    plan(),
    scope({ requestedCapabilityIds: capabilityProxy }),
  );
  assert.deepEqual(withProxyArray.requestedCapabilityIds, ['filesystem.archive']);
  assert.equal(arrayReads, 0, 'authority array Proxy get trap must not execute');

  let getterCalls = 0;
  const accessorScope = scope();
  Object.defineProperty(accessorScope, 'nodeId', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'local';
    },
  });
  assert.throws(
    () => prepareAgentPlanSpecialistHandoffV1(plan(), accessorScope),
    /nodeId must be an enumerable data property/,
  );
  assert.equal(getterCalls, 0, 'request accessor must never execute');

  let coercions = 0;
  const coerciveId = {
    toString() {
      coercions += 1;
      return 'native-companion';
    },
  };
  assert.throws(
    () => prepareAgentPlanSpecialistHandoffV1(plan(), scope({ specialistId: coerciveId })),
    /specialistId is invalid/,
  );
  assert.equal(coercions, 0, 'identity coercion must never execute');

  assert.throws(
    () => prepareAgentPlanSpecialistHandoffV1(plan(), scope({ authorizationGranted: true })),
    /unknown field: authorizationGranted/,
  );

  const assignment = prepareAgentPlanSpecialistHandoffV1(plan(), scope());
  let assignmentReads = 0;
  const assignmentArray = new Proxy([assignment], {
    get(target, property, receiver) {
      assignmentReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const claimed = claimAgentPlanSpecialistHandoffsV1(plan(), assignmentArray, {
    executionOwnerships: [ownership()],
    availableSlots: 1,
    at: T0,
  });
  assert.equal(claimed.claimed.length, 1);
  assert.equal(assignmentReads, 0, 'handoff array Proxy get trap must not execute');
});
