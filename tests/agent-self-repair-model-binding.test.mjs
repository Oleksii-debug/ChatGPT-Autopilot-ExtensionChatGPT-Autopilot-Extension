import test from 'node:test';
import assert from 'node:assert/strict';

import { AiRouteRole } from '../src/core/ai-route-pool.js';
import {
  AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
  bindAgentSelfRepairModelIntentV1,
  normalizeAgentSelfRepairModelIntentV1,
} from '../src/core/agent-self-repair-model-binding.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

function budget(overrides = {}) {
  return {
    maxModelCalls: 0,
    maxRuntimeSeconds: 0,
    maxCostUsdMicros: 0,
    ...overrides,
  };
}

function originPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'plan-self-repair-model',
    jobId: 'job-self-repair-model',
    objective: 'Repair and independently verify a failed result',
    successCriteria: ['Result verified'],
    createdAt: '2026-09-28T17:00:00.000Z',
    updatedAt: '2026-09-28T17:05:00.000Z',
    revision: 7,
    nodes: [
      {
        nodeId: 'setup',
        title: 'Prepare',
        objective: 'Prepare inputs',
        dependsOn: [],
        conflictKeys: [],
        ownerId: 'actor-1',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Inputs ready'],
        budget: budget(),
        state: 'VERIFIED',
        evidence: 'Prepared',
        updatedAt: '2026-09-28T17:02:00.000Z',
      },
      {
        nodeId: 'target',
        title: 'Produce output',
        objective: 'Produce target output',
        dependsOn: ['setup'],
        conflictKeys: ['artifact-target'],
        ownerId: 'actor-1',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Output is correct'],
        budget: budget(),
        state: 'FAILED',
        evidence: '',
        updatedAt: '2026-09-28T17:05:00.000Z',
      },
    ],
    ...overrides,
  };
}

function failure() {
  return {
    verifierId: 'verifier-1',
    subjectRevisionId: '2026-09-28T17:05:00.000Z',
    evidenceSha256: H1,
    completedAt: '2026-09-28T17:05:00.000Z',
  };
}

function diagnosis() {
  return {
    diagnosisId: 'diag-1',
    producerId: 'actor-1',
    hypothesisCodes: ['agent.output-mismatch'],
    createdAt: '2026-09-28T17:05:10.000Z',
  };
}

function repair() {
  return {
    repairId: 'repair-work-1',
    producerId: 'actor-1',
    fromRevisionId: '2026-09-28T17:05:00.000Z',
    toRevisionId: 'subject-revision-2',
    changeArtifactId: 'artifact-change-1',
    changeArtifactSha256: H2,
    appliedAt: '2026-09-28T17:05:20.000Z',
  };
}

function retest(outcome = 'PASS') {
  return {
    runId: 'retest-1',
    verifierId: 'verifier-1',
    verifierPlanRevisionId: 'verifier-plan-r1',
    subjectRevisionId: 'subject-revision-2',
    outcome,
    evidenceSha256: H2,
    startedAt: '2026-09-28T17:05:30.000Z',
    completedAt: '2026-09-28T17:05:40.000Z',
  };
}

function cycle({ attempts, maxAttempts = 3, updatedAt = '2026-09-28T17:05:10.000Z' } = {}) {
  return {
    schemaVersion: 1,
    cycleId: 'self-repair-cycle-model-1',
    subjectId: 'target',
    actorId: 'actor-1',
    verifierId: 'verifier-1',
    verifierPlanRevisionId: 'verifier-plan-r1',
    baselineRevisionId: '2026-09-28T17:05:00.000Z',
    maxAttempts,
    createdAt: '2026-09-28T17:05:00.000Z',
    updatedAt,
    attempts: attempts || [{
      attemptNumber: 1,
      failure: failure(),
      diagnosis: diagnosis(),
      repair: null,
      retest: null,
    }],
  };
}

function workNode(overrides = {}) {
  return {
    nodeId: 'repair-work-1',
    title: 'Repair failed output',
    objective: 'Apply the bounded repair',
    conflictKeys: ['artifact-target'],
    executionPlane: 'LOCAL',
    acceptanceCriteria: ['Repair artifact materialized'],
    budget: budget(),
    ...overrides,
  };
}

function repairSelfRepairRequest(overrides = {}) {
  const plan = originPlan();
  return {
    originPlan: plan,
    currentPlan: plan,
    failedNodeId: 'target',
    cycle: cycle(),
    workNode: workNode(),
    resourceEnvelope: budget(),
    at: '2026-09-28T17:06:00.000Z',
    ...overrides,
  };
}

function retestSelfRepairRequest() {
  const origin = originPlan();
  const current = originPlan({
    revision: 9,
    updatedAt: '2026-09-28T17:05:25.000Z',
    nodes: [
      ...origin.nodes,
      {
        nodeId: 'repair-work-1',
        title: 'Repair failed output',
        objective: 'Apply the bounded repair',
        dependsOn: ['setup'],
        conflictKeys: ['artifact-target', 'self-repair-cycle-model-1'],
        ownerId: 'actor-1',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Repair artifact materialized'],
        budget: budget(),
        state: 'VERIFIED',
        evidence: 'repair applied',
        updatedAt: '2026-09-28T17:05:25.000Z',
      },
    ],
  });
  return {
    originPlan: origin,
    currentPlan: current,
    failedNodeId: 'target',
    cycle: cycle({
      updatedAt: '2026-09-28T17:05:20.000Z',
      attempts: [{
        attemptNumber: 1,
        failure: failure(),
        diagnosis: diagnosis(),
        repair: repair(),
        retest: null,
      }],
    }),
    workNode: workNode({
      nodeId: 'retest-work-1',
      title: 'Independently retest repaired output',
      objective: 'Verify repaired subject independently',
      conflictKeys: [],
      acceptanceCriteria: ['Independent retest complete'],
    }),
    predecessorNodeId: 'repair-work-1',
    resourceEnvelope: budget(),
    at: '2026-09-28T17:06:00.000Z',
  };
}

function routing(role, overrides = {}) {
  return {
    role,
    capabilityIds: ['cap.files.read', 'cap.reason'],
    requiresVision: false,
    ...overrides,
  };
}

test('REPAIR binds actor work to an allowed non-verifier route role', () => {
  const result = bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: repairSelfRepairRequest(),
    routingRequest: routing(AiRouteRole.CODER),
  });
  assert.equal(result.cycleState, 'READY_FOR_REPAIR');
  assert.equal(result.workKind, 'REPAIR');
  assert.equal(result.evidenceTrust, 'UNVERIFIED_INPUT');
  assert.equal(result.requiresCanonicalEvidenceResolution, true);
  assert.equal(result.nodeId, 'repair-work-1');
  assert.equal(result.ownerId, 'actor-1');
  assert.equal(result.actorId, 'actor-1');
  assert.equal(result.verifierId, 'verifier-1');
  assert.equal(result.failedNodeRevisionId, '2026-09-28T17:05:00.000Z');
  assert.equal(result.verifierPlanRevisionId, 'verifier-plan-r1');
  assert.equal(result.routeIntent.role, AiRouteRole.CODER);
  assert.deepEqual(result.routeIntent.capabilityIds, ['cap.files.read', 'cap.reason']);
  assert.equal(result.routeIntent.requiresVision, false);
  assert.deepEqual(result.workBudget, budget());
  assert.equal(Object.isFrozen(result.workBudget), true);
  assert.equal(result.routeSelectionAuthorized, false);
  assert.equal(result.modelDispatchAuthorized, false);
  assert.equal(result.requiresCanonicalRouterRevalidation, true);
  assert.equal(result.requiresCanonicalPlanCycleRevalidation, true);
  assert.equal(result.requiresCanonicalRoleRevalidation, true);
  assert.equal(result.requiresCanonicalCapabilityRevalidation, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.routeIntent), true);
  assert.equal(Object.isFrozen(result.routeIntent.capabilityIds), true);
});

test('REPAIR accepts planner and fast-worker but rejects verifier/critic/vision role inversion', () => {
  for (const role of [AiRouteRole.PLANNER, AiRouteRole.FAST_WORKER]) {
    const result = bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: routing(role),
    });
    assert.equal(result.routeIntent.role, role);
  }
  for (const role of [AiRouteRole.VERIFIER, AiRouteRole.CRITIC, AiRouteRole.VISION]) {
    assert.throws(
      () => bindAgentSelfRepairModelIntentV1({
        selfRepairRequest: repairSelfRepairRequest(),
        routingRequest: routing(role),
      }),
      /REPAIR model role must be planner, coder or fast-worker/u,
    );
  }
});

test('RETEST is identity-bound to independent verifier and verifier role only', () => {
  const result = bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: retestSelfRepairRequest(),
    routingRequest: routing(AiRouteRole.VERIFIER, {
      capabilityIds: ['cap.verify'],
      requiresVision: true,
    }),
  });
  assert.equal(result.cycleState, 'READY_FOR_RETEST');
  assert.equal(result.workKind, 'RETEST');
  assert.equal(result.evidenceTrust, 'UNVERIFIED_INPUT');
  assert.equal(result.requiresCanonicalEvidenceResolution, true);
  assert.equal(result.nodeId, 'retest-work-1');
  assert.equal(result.ownerId, 'verifier-1');
  assert.equal(result.actorId, 'actor-1');
  assert.equal(result.verifierId, 'verifier-1');
  assert.equal(result.routeIntent.role, AiRouteRole.VERIFIER);
  assert.deepEqual(result.routeIntent.capabilityIds, ['cap.verify']);
  assert.equal(result.routeIntent.requiresVision, true);

  for (const role of [AiRouteRole.PLANNER, AiRouteRole.CODER, AiRouteRole.FAST_WORKER, AiRouteRole.CRITIC]) {
    assert.throws(
      () => bindAgentSelfRepairModelIntentV1({
        selfRepairRequest: retestSelfRepairRequest(),
        routingRequest: routing(role),
      }),
      /RETEST model role must be verifier/u,
    );
  }
});

test('terminal VERIFIED cycle produces no route intent and rejects dispatch-shaped routing data', () => {
  const terminalCycle = cycle({
    updatedAt: '2026-09-28T17:05:40.000Z',
    attempts: [{
      attemptNumber: 1,
      failure: failure(),
      diagnosis: diagnosis(),
      repair: repair(),
      retest: retest('PASS'),
    }],
  });
  const request = {
    originPlan: originPlan(),
    currentPlan: originPlan(),
    failedNodeId: 'target',
    cycle: terminalCycle,
    at: '2026-09-28T17:06:00.000Z',
  };
  const result = bindAgentSelfRepairModelIntentV1({ selfRepairRequest: request });
  assert.equal(result.cycleState, 'VERIFIED');
  assert.equal(result.workKind, 'VERIFIED');
  assert.equal(result.evidenceTrust, 'UNVERIFIED_INPUT');
  assert.equal(result.requiresCanonicalEvidenceResolution, true);
  assert.equal(result.nodeId, null);
  assert.equal(result.ownerId, null);
  assert.equal(result.routeIntent, null);
  assert.equal(result.workBudget, null);
  assert.equal(result.originPlanRevision, 7);
  assert.equal(result.currentPlanRevision, 7);
  assert.equal(result.failedNodeRevisionId, '2026-09-28T17:05:00.000Z');
  assert.equal(result.verifierPlanRevisionId, 'verifier-plan-r1');
  assert.equal(result.modelDispatchAuthorized, false);

  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: request,
      routingRequest: routing(AiRouteRole.VERIFIER),
    }),
    /Terminal Agent self-repair state cannot request model routing/u,
  );
});

test('terminal MANUAL_REVIEW and EXHAUSTED states cannot manufacture model intent', () => {
  const cases = [
    ['MANUAL_REVIEW', 'ERROR', 3],
    ['EXHAUSTED', 'FAIL', 1],
  ];
  for (const [kind, outcome, maxAttempts] of cases) {
    const terminalCycle = cycle({
      maxAttempts,
      updatedAt: '2026-09-28T17:05:40.000Z',
      attempts: [{
        attemptNumber: 1,
        failure: failure(),
        diagnosis: diagnosis(),
        repair: repair(),
        retest: retest(outcome),
      }],
    });
    const request = {
      originPlan: originPlan(),
      currentPlan: originPlan(),
      failedNodeId: 'target',
      cycle: terminalCycle,
      at: '2026-09-28T17:06:00.000Z',
    };
    const result = bindAgentSelfRepairModelIntentV1({ selfRepairRequest: request });
    assert.equal(result.workKind, kind);
    assert.equal(result.routeIntent, null);
    assert.equal(result.routeSelectionAuthorized, false);
  }
});

test('routing intent stays bound to exact failed-node and verifier-plan revisions', () => {
  const result = bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: retestSelfRepairRequest(),
    routingRequest: routing(AiRouteRole.VERIFIER, { capabilityIds: [] }),
  });
  assert.equal(result.failedNodeRevisionId, '2026-09-28T17:05:00.000Z');
  assert.equal(result.verifierPlanRevisionId, 'verifier-plan-r1');
  assert.equal(result.originPlanRevision, 7);
  assert.equal(result.currentPlanRevision, 9);
  assert.equal(result.proposedPlanRevision, 10);

  const changedVerifierPlan = retestSelfRepairRequest();
  changedVerifierPlan.cycle = {
    ...changedVerifierPlan.cycle,
    verifierPlanRevisionId: 'verifier-plan-r2',
  };
  const rebound = bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: changedVerifierPlan,
    routingRequest: routing(AiRouteRole.VERIFIER, { capabilityIds: [] }),
  });
  assert.equal(rebound.verifierPlanRevisionId, 'verifier-plan-r2');
  assert.notEqual(rebound.verifierPlanRevisionId, result.verifierPlanRevisionId);
  assert.equal(rebound.requiresCanonicalVerifierPlanRevalidation, true);
});

test('capability requirements are canonicalized deterministically without granting capability authority', () => {
  const result = bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: repairSelfRepairRequest(),
    routingRequest: routing(AiRouteRole.PLANNER, {
      capabilityIds: ['z.capability', 'a.capability'],
    }),
  });
  assert.deepEqual(result.routeIntent.capabilityIds, ['a.capability', 'z.capability']);
  assert.equal(result.policyAuthorized, false);
  assert.equal(result.providerAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.toolAuthorized, false);
  assert.equal(result.contextAuthorized, false);
});

test('work budget is derived from canonical self-repair node and remains inside the AgentPlan envelope', () => {
  const result = bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: repairSelfRepairRequest({
      workNode: workNode({
        budget: budget({
          maxModelCalls: 2,
          maxRuntimeSeconds: 60,
          maxCostUsdMicros: 5000,
        }),
      }),
      resourceEnvelope: budget({
        maxModelCalls: 2,
        maxRuntimeSeconds: 60,
        maxCostUsdMicros: 5000,
      }),
    }),
    routingRequest: routing(AiRouteRole.PLANNER),
  });
  assert.deepEqual(result.workBudget, {
    maxModelCalls: 2,
    maxRuntimeSeconds: 60,
    maxCostUsdMicros: 5000,
  });

  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest({
        workNode: workNode({ budget: budget({ maxModelCalls: 3 }) }),
        resourceEnvelope: budget({ maxModelCalls: 2 }),
      }),
      routingRequest: routing(AiRouteRole.PLANNER),
    }),
    /exceeds resourceEnvelope maxModelCalls/u,
  );
});

test('duplicate, invalid, sparse and side-data capability lists fail closed', () => {
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: routing(AiRouteRole.PLANNER, {
        capabilityIds: ['cap.same', 'cap.same'],
      }),
    }),
    /contains duplicates/u,
  );
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: routing(AiRouteRole.PLANNER, {
        capabilityIds: [' bad '],
      }),
    }),
    /is invalid/u,
  );

  const sparse = new Array(1);
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: routing(AiRouteRole.PLANNER, { capabilityIds: sparse }),
    }),
    /dense and data-only|enumerable own data property/u,
  );

  const sideData = ['cap.ok'];
  sideData.authority = true;
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: routing(AiRouteRole.PLANNER, { capabilityIds: sideData }),
    }),
    /dense and data-only/u,
  );
});

test('routing boundary rejects accessors, unknown fields and coercive requiresVision values without reading getters', () => {
  let reads = 0;
  const hostile = routing(AiRouteRole.PLANNER);
  Object.defineProperty(hostile, 'role', {
    enumerable: true,
    get() {
      reads += 1;
      return AiRouteRole.VERIFIER;
    },
  });
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: hostile,
    }),
    /role must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);

  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: { ...routing(AiRouteRole.PLANNER), dispatchAuthorized: true },
    }),
    /unknown field/u,
  );
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: routing(AiRouteRole.PLANNER, { requiresVision: 1 }),
    }),
    /requiresVision must be boolean/u,
  );
});

test('top-level boundary rejects caller-supplied identity or authority aliases', () => {
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: routing(AiRouteRole.PLANNER),
      workKind: 'RETEST',
    }),
    /unknown field: workKind/u,
  );
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: repairSelfRepairRequest(),
      routingRequest: routing(AiRouteRole.PLANNER),
      executionAuthorized: true,
    }),
    /unknown field: executionAuthorized/u,
  );
});

test('canonical self-repair proposal is re-derived, so actor/verifier identity substitution fails before routing', () => {
  const bad = repairSelfRepairRequest();
  bad.cycle = {
    ...bad.cycle,
    verifierId: 'actor-1',
  };
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: bad,
      routingRequest: routing(AiRouteRole.PLANNER),
    }),
    /independent from actorId/u,
  );

  const badTarget = repairSelfRepairRequest();
  badTarget.cycle = {
    ...badTarget.cycle,
    subjectId: 'other-node',
  };
  assert.throws(
    () => bindAgentSelfRepairModelIntentV1({
      selfRepairRequest: badTarget,
      routingRequest: routing(AiRouteRole.PLANNER),
    }),
    /subjectId must match failedNodeId/u,
  );
});

test('null-prototype top-level and routing requests remain portable', () => {
  const top = Object.create(null);
  top.selfRepairRequest = repairSelfRepairRequest();
  const route = Object.create(null);
  route.role = AiRouteRole.PLANNER;
  route.capabilityIds = ['cap.reason'];
  route.requiresVision = false;
  top.routingRequest = route;
  const result = bindAgentSelfRepairModelIntentV1(top);
  assert.equal(result.routeIntent.role, AiRouteRole.PLANNER);
  assert.deepEqual(result.routeIntent.capabilityIds, ['cap.reason']);
});

test('durable normalization round-trips active routing intent after JSON restart', () => {
  const binding = bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: repairSelfRepairRequest({
      workNode: workNode({
        budget: budget({
          maxModelCalls: 2,
          maxRuntimeSeconds: 60,
          maxCostUsdMicros: 5000,
        }),
      }),
      resourceEnvelope: budget({
        maxModelCalls: 2,
        maxRuntimeSeconds: 60,
        maxCostUsdMicros: 5000,
      }),
    }),
    routingRequest: routing(AiRouteRole.CODER, {
      capabilityIds: ['cap.reason', 'cap.files.read'],
    }),
  });
  const restarted = normalizeAgentSelfRepairModelIntentV1(
    JSON.parse(JSON.stringify(binding)),
  );
  assert.deepEqual(restarted, binding);
  assert.equal(Object.isFrozen(restarted), true);
  assert.equal(Object.isFrozen(restarted.routeIntent), true);
  assert.equal(Object.isFrozen(restarted.routeIntent.capabilityIds), true);
  assert.equal(Object.isFrozen(restarted.workBudget), true);
});

test('durable normalization round-trips terminal binding without inventing dispatch state', () => {
  const terminalCycle = cycle({
    updatedAt: '2026-09-28T17:05:40.000Z',
    attempts: [{
      attemptNumber: 1,
      failure: failure(),
      diagnosis: diagnosis(),
      repair: repair(),
      retest: retest('PASS'),
    }],
  });
  const binding = bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: {
      originPlan: originPlan(),
      currentPlan: originPlan(),
      failedNodeId: 'target',
      cycle: terminalCycle,
      at: '2026-09-28T17:06:00.000Z',
    },
  });
  const restarted = normalizeAgentSelfRepairModelIntentV1(
    JSON.parse(JSON.stringify(binding)),
  );
  assert.deepEqual(restarted, binding);
  assert.equal(restarted.routeIntent, null);
  assert.equal(restarted.workBudget, null);

  const terminalRevisionSwap = JSON.parse(JSON.stringify(binding));
  terminalRevisionSwap.verifierPlanRevisionId = 'verifier-plan-r2';
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(terminalRevisionSwap),
    /bindingKey is inconsistent/u,
  );
});

test('restart normalization fails closed on actor/verifier role or owner substitution', () => {
  const binding = JSON.parse(JSON.stringify(bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: repairSelfRepairRequest(),
    routingRequest: routing(AiRouteRole.CODER),
  })));

  const verifierRole = structuredClone(binding);
  verifierRole.routeIntent.role = AiRouteRole.VERIFIER;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(verifierRole),
    /REPAIR model role must be planner, coder or fast-worker/u,
  );

  const wrongOwner = structuredClone(binding);
  wrongOwner.ownerId = 'verifier-1';
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(wrongOwner),
    /owner must be the repair actor/u,
  );

  const collapsedIdentity = structuredClone(binding);
  collapsedIdentity.verifierId = 'actor-1';
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(collapsedIdentity),
    /independent actor and verifier identities/u,
  );
});

test('durable binding key rejects same-class route, node and revision substitution after restart', () => {
  const original = JSON.parse(JSON.stringify(bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: repairSelfRepairRequest(),
    routingRequest: routing(AiRouteRole.CODER),
  })));

  assert.equal(typeof original.bindingKey, 'string');
  assert.ok(original.bindingKey.length > 0);

  const roleSwap = structuredClone(original);
  roleSwap.routeIntent.role = AiRouteRole.PLANNER;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(roleSwap),
    /bindingKey is inconsistent/u,
  );

  const capabilitySwap = structuredClone(original);
  capabilitySwap.routeIntent.capabilityIds = ['cap.reason'];
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(capabilitySwap),
    /bindingKey is inconsistent/u,
  );

  const nodeSwap = structuredClone(original);
  nodeSwap.nodeId = 'repair-work-other';
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(nodeSwap),
    /bindingKey is inconsistent/u,
  );

  const revisionSwap = structuredClone(original);
  revisionSwap.failedNodeRevisionId = '2026-09-28T17:05:01.000Z';
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(revisionSwap),
    /bindingKey is inconsistent/u,
  );

  const missingKey = structuredClone(original);
  delete missingKey.bindingKey;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(missingKey),
    /requires bindingKey/u,
  );
});

test('restart normalization preserves self-repair cycle state and unverified evidence provenance', () => {
  const binding = JSON.parse(JSON.stringify(bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: repairSelfRepairRequest(),
    routingRequest: routing(AiRouteRole.CODER),
  })));

  const wrongState = structuredClone(binding);
  wrongState.cycleState = 'READY_FOR_RETEST';
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(wrongState),
    /cycleState\/workKind binding is inconsistent/u,
  );

  const promotedEvidence = structuredClone(binding);
  promotedEvidence.evidenceTrust = 'TRUSTED';
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(promotedEvidence),
    /evidenceTrust must remain UNVERIFIED_INPUT/u,
  );

  const bypassResolution = structuredClone(binding);
  bypassResolution.requiresCanonicalEvidenceResolution = false;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(bypassResolution),
    /requiresCanonicalEvidenceResolution must be true/u,
  );
});

test('restart normalization rejects authority widening, budget aliases and revision rollback', () => {
  const binding = JSON.parse(JSON.stringify(bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: repairSelfRepairRequest(),
    routingRequest: routing(AiRouteRole.PLANNER),
  })));

  const authority = structuredClone(binding);
  authority.modelDispatchAuthorized = true;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(authority),
    /modelDispatchAuthorized must be false/u,
  );

  const signedZero = structuredClone(binding);
  signedZero.workBudget.maxCostUsdMicros = -0;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(signedZero),
    /workBudget maxCostUsdMicros is invalid/u,
  );

  const rollback = structuredClone(binding);
  rollback.currentPlanRevision = rollback.originPlanRevision - 1;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(rollback),
    /currentPlanRevision predates originPlanRevision/u,
  );

  const noAdvance = structuredClone(binding);
  noAdvance.proposedPlanRevision = noAdvance.currentPlanRevision;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(noAdvance),
    /proposedPlanRevision must be the exact next plan revision/u,
  );

  const skippedRevision = structuredClone(binding);
  skippedRevision.proposedPlanRevision = skippedRevision.currentPlanRevision + 2;
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(skippedRevision),
    /proposedPlanRevision must be the exact next plan revision/u,
  );
});

test('terminal durable binding rejects active-work resurrection after restart', () => {
  const terminalCycle = cycle({
    updatedAt: '2026-09-28T17:05:40.000Z',
    attempts: [{
      attemptNumber: 1,
      failure: failure(),
      diagnosis: diagnosis(),
      repair: repair(),
      retest: retest('ERROR'),
    }],
  });
  const binding = JSON.parse(JSON.stringify(bindAgentSelfRepairModelIntentV1({
    selfRepairRequest: {
      originPlan: originPlan(),
      currentPlan: originPlan(),
      failedNodeId: 'target',
      cycle: terminalCycle,
      at: '2026-09-28T17:06:00.000Z',
    },
  })));
  binding.routeIntent = routing(AiRouteRole.VERIFIER);
  assert.throws(
    () => normalizeAgentSelfRepairModelIntentV1(binding),
    /cannot contain active work/u,
  );
});

test('authority declaration stays explicitly non-authorizing', () => {
  assert.deepEqual(AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY, {
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
});
