import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentSelfRepairWorkKind,
  proposeAgentSelfRepairWorkV1,
} from '../src/core/agent-self-repair-bridge.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

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
    planId: 'plan-self-repair',
    jobId: 'job-self-repair',
    objective: 'Produce a verified result',
    successCriteria: ['Result verified'],
    createdAt: '2026-09-27T00:55:00.000Z',
    updatedAt: '2026-09-27T01:00:00.000Z',
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
        updatedAt: '2026-09-27T00:58:00.000Z',
      },
      {
        nodeId: 'target',
        title: 'Produce output',
        objective: 'Produce the target output',
        dependsOn: ['setup'],
        conflictKeys: ['artifact-target'],
        ownerId: 'actor-1',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Output is correct'],
        budget: budget(),
        state: 'FAILED',
        evidence: '',
        updatedAt: '2026-09-27T01:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function failure({
  revision = '2026-09-27T01:00:00.000Z',
  hash = H1,
  completedAt = '2026-09-27T01:00:00.000Z',
} = {}) {
  return {
    verifierId: 'verifier-1',
    subjectRevisionId: revision,
    evidenceSha256: hash,
    completedAt,
  };
}

function diagnosis({
  id = 'diag-1',
  createdAt = '2026-09-27T01:00:10.000Z',
} = {}) {
  return {
    diagnosisId: id,
    producerId: 'actor-1',
    hypothesisCodes: ['agent.output-mismatch'],
    createdAt,
  };
}

function repair({
  id = 'repair-work-1',
  from = '2026-09-27T01:00:00.000Z',
  to = 'subject-revision-2',
  appliedAt = '2026-09-27T01:00:20.000Z',
} = {}) {
  return {
    repairId: id,
    producerId: 'actor-1',
    fromRevisionId: from,
    toRevisionId: to,
    changeArtifactId: 'artifact-change-1',
    changeArtifactSha256: H2,
    appliedAt,
  };
}

function retest({
  outcome = 'PASS',
  revision = 'subject-revision-2',
  startedAt = '2026-09-27T01:00:30.000Z',
  completedAt = '2026-09-27T01:00:40.000Z',
} = {}) {
  return {
    runId: 'retest-1',
    verifierId: 'verifier-1',
    verifierPlanRevisionId: 'verifier-plan-r1',
    subjectRevisionId: revision,
    outcome,
    evidenceSha256: H3,
    startedAt,
    completedAt,
  };
}

function cycle({
  attempts,
  maxAttempts = 3,
  updatedAt = '2026-09-27T01:00:10.000Z',
  subjectId = 'target',
  baselineRevisionId = '2026-09-27T01:00:00.000Z',
} = {}) {
  return {
    schemaVersion: 1,
    cycleId: 'self-repair-cycle-1',
    subjectId,
    actorId: 'actor-1',
    verifierId: 'verifier-1',
    verifierPlanRevisionId: 'verifier-plan-r1',
    baselineRevisionId,
    maxAttempts,
    createdAt: '2026-09-27T01:00:00.000Z',
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
    objective: 'Apply the bounded repair for the failed output',
    conflictKeys: ['artifact-target'],
    executionPlane: 'LOCAL',
    acceptanceCriteria: ['Repair artifact is materialized'],
    budget: budget(),
    ...overrides,
  };
}

function request(overrides = {}) {
  const plan = originPlan();
  return {
    originPlan: plan,
    currentPlan: plan,
    failedNodeId: 'target',
    cycle: cycle(),
    workNode: workNode(),
    resourceEnvelope: budget(),
    at: '2026-09-27T01:01:00.000Z',
    ...overrides,
  };
}

test('READY_FOR_REPAIR produces an append-only actor work node with no new authority', () => {
  const result = proposeAgentSelfRepairWorkV1(request());
  assert.equal(result.workKind, AgentSelfRepairWorkKind.REPAIR);
  assert.equal(result.cycleState, 'READY_FOR_REPAIR');
  assert.equal(result.failedNodeRevisionId, '2026-09-27T01:00:00.000Z');
  assert.equal(result.extensionNode.ownerId, 'actor-1');
  assert.deepEqual(result.extensionNode.dependsOn, ['setup']);
  assert.deepEqual(result.extensionNode.conflictKeys, ['artifact-target', 'self-repair-cycle-1']);
  assert.equal(result.extensionNode.state, 'READY');
  assert.equal(result.proposedPlan.nodes.length, 3);
  assert.ok(result.proposedPlanRevision > result.currentPlanRevision);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.verificationAuthorized, false);
  assert.equal(result.completionAuthorized, false);
  assert.equal(result.policyGranted, false);
  assert.equal(result.evidenceTrust, 'UNVERIFIED_INPUT');
  assert.equal(result.requiresCanonicalEvidenceResolution, true);
  assert.equal(result.requiresCanonicalPlanStore, true);
});

test('READY_FOR_RETEST requires the verified repair node from the same cycle and assigns verifier', () => {
  const origin = originPlan();
  const current = originPlan({
    revision: 9,
    updatedAt: '2026-09-27T01:00:25.000Z',
    nodes: [
      ...origin.nodes,
      {
        nodeId: 'repair-work-1',
        title: 'Repair failed output',
        objective: 'Apply the bounded repair',
        dependsOn: ['setup'],
        conflictKeys: ['artifact-target', 'self-repair-cycle-1'],
        ownerId: 'actor-1',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Repair artifact is materialized'],
        budget: budget(),
        state: 'VERIFIED',
        evidence: 'repair applied',
        updatedAt: '2026-09-27T01:00:25.000Z',
      },
    ],
  });
  const repairingCycle = cycle({
    updatedAt: '2026-09-27T01:00:20.000Z',
    attempts: [{
      attemptNumber: 1,
      failure: failure(),
      diagnosis: diagnosis(),
      repair: repair(),
      retest: null,
    }],
  });
  const result = proposeAgentSelfRepairWorkV1({
    originPlan: origin,
    currentPlan: current,
    failedNodeId: 'target',
    cycle: repairingCycle,
    workNode: workNode({
      nodeId: 'retest-work-1',
      title: 'Independently retest repaired output',
      objective: 'Verify the repaired subject revision independently',
      conflictKeys: [],
      acceptanceCriteria: ['Independent retest completed'],
    }),
    predecessorNodeId: 'repair-work-1',
    resourceEnvelope: budget(),
    at: '2026-09-27T01:01:00.000Z',
  });
  assert.equal(result.workKind, AgentSelfRepairWorkKind.RETEST);
  assert.equal(result.extensionNode.ownerId, 'verifier-1');
  assert.deepEqual(result.extensionNode.dependsOn, ['repair-work-1']);
  assert.deepEqual(result.extensionNode.conflictKeys, ['self-repair-cycle-1']);
  assert.equal(result.extensionNode.state, 'READY');
});

test('RETEST rejects stale or unrelated predecessor evidence', () => {
  const origin = originPlan();
  const baseNode = {
    nodeId: 'repair-work-1',
    title: 'Repair failed output',
    objective: 'Apply the bounded repair',
    dependsOn: ['setup'],
    conflictKeys: ['self-repair-cycle-1'],
    ownerId: 'actor-1',
    executionPlane: 'LOCAL',
    acceptanceCriteria: [],
    budget: budget(),
    state: 'VERIFIED',
    evidence: 'repair applied',
    updatedAt: '2026-09-27T01:00:25.000Z',
  };
  const repairingCycle = cycle({
    updatedAt: '2026-09-27T01:00:20.000Z',
    attempts: [{
      attemptNumber: 1,
      failure: failure(),
      diagnosis: diagnosis(),
      repair: repair(),
      retest: null,
    }],
  });

  const wrongOwner = originPlan({
    revision: 9,
    updatedAt: '2026-09-27T01:00:25.000Z',
    nodes: [...origin.nodes, { ...baseNode, ownerId: 'other-actor' }],
  });
  assert.throws(() => proposeAgentSelfRepairWorkV1({
    originPlan: origin,
    currentPlan: wrongOwner,
    failedNodeId: 'target',
    cycle: repairingCycle,
    workNode: workNode({ nodeId: 'retest-work-1' }),
    predecessorNodeId: 'repair-work-1',
    resourceEnvelope: budget(),
    at: '2026-09-27T01:01:00.000Z',
  }), /predecessor must be owned by repair actor/u);

  const wrongRepairIdCycle = cycle({
    updatedAt: '2026-09-27T01:00:20.000Z',
    attempts: [{
      attemptNumber: 1,
      failure: failure(),
      diagnosis: diagnosis(),
      repair: repair({ id: 'different-repair-node' }),
      retest: null,
    }],
  });
  const validPredecessorPlan = originPlan({
    revision: 9,
    updatedAt: '2026-09-27T01:00:25.000Z',
    nodes: [...origin.nodes, baseNode],
  });
  assert.throws(() => proposeAgentSelfRepairWorkV1({
    originPlan: origin,
    currentPlan: validPredecessorPlan,
    failedNodeId: 'target',
    cycle: wrongRepairIdCycle,
    workNode: workNode({ nodeId: 'retest-work-1' }),
    predecessorNodeId: 'repair-work-1',
    resourceEnvelope: budget(),
    at: '2026-09-27T01:01:00.000Z',
  }), /predecessor nodeId must match cycle repairId/u);

  const wrongCycle = originPlan({
    revision: 9,
    updatedAt: '2026-09-27T01:00:25.000Z',
    nodes: [...origin.nodes, { ...baseNode, conflictKeys: ['other-cycle'] }],
  });
  assert.throws(() => proposeAgentSelfRepairWorkV1({
    originPlan: origin,
    currentPlan: wrongCycle,
    failedNodeId: 'target',
    cycle: repairingCycle,
    workNode: workNode({ nodeId: 'retest-work-1' }),
    predecessorNodeId: 'repair-work-1',
    resourceEnvelope: budget(),
    at: '2026-09-27T01:01:00.000Z',
  }), /not bound to this cycle/u);
});

test('terminal cycle states never append work or authorize completion', () => {
  const cases = [
    ['VERIFIED', retest({ outcome: 'PASS' }), 3],
    ['MANUAL_REVIEW', retest({ outcome: 'ERROR' }), 3],
    ['EXHAUSTED', retest({ outcome: 'FAIL' }), 1],
  ];
  for (const [state, retestValue, maxAttempts] of cases) {
    const terminalCycle = cycle({
      maxAttempts,
      updatedAt: '2026-09-27T01:00:40.000Z',
      attempts: [{
        attemptNumber: 1,
        failure: failure(),
        diagnosis: diagnosis(),
        repair: repair(),
        retest: retestValue,
      }],
    });
    const result = proposeAgentSelfRepairWorkV1({
      originPlan: originPlan(),
      currentPlan: originPlan(),
      failedNodeId: 'target',
      cycle: terminalCycle,
      at: '2026-09-27T01:01:00.000Z',
    });
    assert.equal(result.workKind, state);
    assert.equal(result.extensionNode, null);
    assert.equal(result.proposedPlan, null);
    assert.equal(result.completionAuthorized, false);
    assert.equal(result.executionAuthorized, false);
  }
});

test('cycle must bind exact failed node identity and failed-node revision', () => {
  assert.throws(
    () => proposeAgentSelfRepairWorkV1(request({ cycle: cycle({ subjectId: 'other-node' }) })),
    /subjectId must match failedNodeId/u,
  );
  assert.throws(
    () => proposeAgentSelfRepairWorkV1(request({
      cycle: cycle({ baselineRevisionId: '2026-09-27T00:59:59.000Z' }),
    })),
    /baselineRevisionId must match failed node updatedAt/u,
  );

  const notFailed = originPlan({
    nodes: originPlan().nodes.map((node) => node.nodeId === 'target' ? { ...node, state: 'BLOCKED' } : node),
  });
  assert.throws(
    () => proposeAgentSelfRepairWorkV1(request({ originPlan: notFailed, currentPlan: notFailed })),
    /origin node must be FAILED/u,
  );
});

test('current plan may advance only if the bound failed node itself is unchanged', () => {
  const origin = originPlan();
  const advanced = originPlan({
    revision: 8,
    updatedAt: '2026-09-27T01:00:30.000Z',
    nodes: [
      ...origin.nodes,
      {
        nodeId: 'unrelated',
        title: 'Unrelated',
        objective: 'Continue unrelated work',
        dependsOn: ['setup'],
        conflictKeys: [],
        ownerId: 'actor-2',
        executionPlane: 'LOCAL',
        acceptanceCriteria: [],
        budget: budget(),
        state: 'READY',
        evidence: '',
        updatedAt: '2026-09-27T01:00:30.000Z',
      },
    ],
  });
  const ok = proposeAgentSelfRepairWorkV1(request({
    originPlan: origin,
    currentPlan: advanced,
    at: '2026-09-27T01:01:00.000Z',
  }));
  assert.equal(ok.currentPlanRevision, 8);

  const drifted = structuredClone(advanced);
  drifted.nodes[1].updatedAt = '2026-09-27T01:00:01.000Z';
  assert.throws(
    () => proposeAgentSelfRepairWorkV1(request({
      originPlan: origin,
      currentPlan: drifted,
      at: '2026-09-27T01:01:00.000Z',
    })),
    /failed node drifted/u,
  );
});

test('resource envelope remains the canonical budget authority', () => {
  assert.throws(
    () => proposeAgentSelfRepairWorkV1(request({
      workNode: workNode({ budget: budget({ maxModelCalls: 2 }) }),
      resourceEnvelope: budget({ maxModelCalls: 1 }),
    })),
    /exceeds resourceEnvelope maxModelCalls/u,
  );
});

test('hostile request and work-node accessors are rejected without execution', () => {
  let requestReads = 0;
  const hostileRequest = request();
  Object.defineProperty(hostileRequest, 'cycle', {
    enumerable: true,
    get() {
      requestReads += 1;
      return cycle();
    },
  });
  assert.throws(
    () => proposeAgentSelfRepairWorkV1(hostileRequest),
    /field cycle must be an enumerable own data property/u,
  );
  assert.equal(requestReads, 0);

  let workReads = 0;
  const hostileWorkNode = workNode();
  Object.defineProperty(hostileWorkNode, 'objective', {
    enumerable: true,
    get() {
      workReads += 1;
      return 'hostile';
    },
  });
  assert.throws(
    () => proposeAgentSelfRepairWorkV1(request({ workNode: hostileWorkNode })),
    /workNode field objective must be an enumerable own data property/u,
  );
  assert.equal(workReads, 0);
});

test('null-prototype bridge request remains portable', () => {
  const base = request();
  const portable = Object.create(null);
  for (const [key, value] of Object.entries(base)) portable[key] = value;
  const result = proposeAgentSelfRepairWorkV1(portable);
  assert.equal(result.workKind, AgentSelfRepairWorkKind.REPAIR);
  assert.equal(result.extensionNode.ownerId, 'actor-1');
});
