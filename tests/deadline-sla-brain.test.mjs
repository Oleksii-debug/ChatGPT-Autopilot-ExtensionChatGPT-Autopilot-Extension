import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeadlineSlaRecommendationKind,
  DeadlineSlaRiskClass,
  DeadlineSlaValueClass,
  assessDeadlineSlaV1,
} from '../src/core/deadline-sla-brain.js';

const ASSESSED_AT = '2026-09-25T08:00:00.000Z';

function deadlineAfter(seconds) {
  return new Date(Date.parse(ASSESSED_AT) + seconds * 1000).toISOString();
}

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'plan-sla-1',
    jobId: 'job-sla-1',
    objective: 'Finish the owner outcome before the deadline.',
    successCriteria: ['All nodes verified.'],
    nodes: [
      {
        nodeId: 'node-a',
        title: 'A',
        objective: 'A',
        dependsOn: [],
        conflictKeys: [],
        ownerId: 'agent-a',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['A verified'],
        budget: { maxModelCalls: 1, maxRuntimeSeconds: 600, maxCostUsdMicros: 1000 },
        state: 'READY',
        evidence: '',
        updatedAt: ASSESSED_AT,
      },
      {
        nodeId: 'node-b',
        title: 'B',
        objective: 'B',
        dependsOn: ['node-a'],
        conflictKeys: [],
        ownerId: 'agent-b',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['B verified'],
        budget: { maxModelCalls: 1, maxRuntimeSeconds: 600, maxCostUsdMicros: 1000 },
        state: 'PENDING',
        evidence: '',
        updatedAt: ASSESSED_AT,
      },
      {
        nodeId: 'node-c',
        title: 'C',
        objective: 'C',
        dependsOn: [],
        conflictKeys: [],
        ownerId: 'agent-c',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['C verified'],
        budget: { maxModelCalls: 1, maxRuntimeSeconds: 600, maxCostUsdMicros: 1000 },
        state: 'READY',
        evidence: '',
        updatedAt: ASSESSED_AT,
      },
    ],
    createdAt: ASSESSED_AT,
    updatedAt: ASSESSED_AT,
    revision: 1,
    ...overrides,
  };
}

function nodeForecasts(overrides = {}) {
  const values = {
    'node-a': {
      nodeId: 'node-a',
      remainingWorkUnits: 10,
      queueDelaySeconds: 0,
      uncertaintyBasisPoints: 2000,
      requiredProviderIds: ['github'],
      valueClass: DeadlineSlaValueClass.CRITICAL,
    },
    'node-b': {
      nodeId: 'node-b',
      remainingWorkUnits: 20,
      queueDelaySeconds: 0,
      uncertaintyBasisPoints: 2000,
      requiredProviderIds: ['github'],
      valueClass: DeadlineSlaValueClass.HIGH,
    },
    'node-c': {
      nodeId: 'node-c',
      remainingWorkUnits: 30,
      queueDelaySeconds: 0,
      uncertaintyBasisPoints: 2000,
      requiredProviderIds: ['github'],
      valueClass: DeadlineSlaValueClass.SPECULATIVE,
    },
  };
  for (const [nodeId, patch] of Object.entries(overrides)) {
    values[nodeId] = { ...values[nodeId], ...patch };
  }
  return [values['node-a'], values['node-b'], values['node-c']];
}

function throughput(overrides = {}) {
  return [{
    executionPlane: 'LOCAL',
    completedWorkUnits: 10,
    observedRuntimeSeconds: 100,
    sampleCount: 10,
    ...overrides,
  }];
}

function provider(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: 'github',
    toolId: '',
    health: 'READY',
    installationRequired: false,
    installed: true,
    authenticationRequired: true,
    authenticated: true,
    pathKind: 'API',
    latencyMs: 50,
    reasonCode: '',
    ...overrides,
  };
}

function resourceBudget() {
  return {
    maxConcurrentAgents: 10,
    maxChildAgents: 10,
    maxModelCalls: 100,
    maxModelInputTokens: 1_000_000,
    maxModelOutputTokens: 1_000_000,
    maxRuntimeSeconds: 100_000,
    maxCostUsdMicros: 1_000_000,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    assessmentId: 'sla-1',
    assessedAt: ASSESSED_AT,
    deadlineAt: deadlineAfter(400),
    plan: plan(),
    nodeForecasts: nodeForecasts(),
    throughput: throughput(),
    providerStates: [provider()],
    resourceBudget: resourceBudget(),
    resourceUsage: {},
    accelerationRequest: {
      concurrentAgents: 1,
      modelCalls: 1,
      runtimeSeconds: 100,
      costUsdMicros: 1000,
    },
    currentSafeFanout: 2,
    maxSafeFanout: 4,
    ...overrides,
  };
}

test('deadline forecast uses dependency critical path, fanout capacity floor and uncertainty bounds', () => {
  const result = assessDeadlineSlaV1(request());

  assert.equal(result.riskClass, DeadlineSlaRiskClass.ON_TRACK);
  assert.deepEqual(result.criticalPathBounds, {
    optimisticSeconds: 240,
    centralSeconds: 300,
    pessimisticSeconds: 360,
  });
  assert.deepEqual(result.fanoutCapacityFloor, {
    fanout: 2,
    optimisticSeconds: 240,
    centralSeconds: 300,
    pessimisticSeconds: 360,
  });
  assert.equal(result.completionBounds.centralSeconds, 300);
  assert.equal(result.completionBounds.pessimisticSeconds, 360);
  assert.equal(result.availableSeconds, 400);
  assert.equal(result.probabilityEstimate, null);
  assert.equal(result.probabilityEstimateAuthorized, false);
  assert.equal(result.actionAuthorized, false);
  assert.equal(Object.isFrozen(result), true);
});

test('deadline thresholds produce bounded operational risk classes without probabilities', () => {
  assert.equal(
    assessDeadlineSlaV1(request({ deadlineAt: deadlineAfter(320) })).riskClass,
    DeadlineSlaRiskClass.WATCH,
  );
  assert.equal(
    assessDeadlineSlaV1(request({ deadlineAt: deadlineAfter(260) })).riskClass,
    DeadlineSlaRiskClass.AT_RISK,
  );
  assert.equal(
    assessDeadlineSlaV1(request({ deadlineAt: deadlineAfter(200) })).riskClass,
    DeadlineSlaRiskClass.UNLIKELY,
  );

  const serialized = JSON.stringify(assessDeadlineSlaV1(request()));
  assert.equal(serialized.includes('"probability":'), false);
  assert.equal(serialized.includes('"successProbability"'), false);
});

test('safe fanout capacity prevents critical-path-only optimism', () => {
  const result = assessDeadlineSlaV1(request({
    currentSafeFanout: 1,
    maxSafeFanout: 1,
    deadlineAt: deadlineAfter(400),
  }));
  assert.equal(result.criticalPathBounds.centralSeconds, 300);
  assert.equal(result.fanoutCapacityFloor.centralSeconds, 600);
  assert.equal(result.completionBounds.centralSeconds, 600);
  assert.equal(result.riskClass, DeadlineSlaRiskClass.UNLIKELY);
});

test('zero safe fanout blocks an incomplete plan rather than forecasting execution', () => {
  const result = assessDeadlineSlaV1(request({
    currentSafeFanout: 0,
    maxSafeFanout: 0,
    accelerationRequest: {},
  }));
  assert.equal(result.riskClass, DeadlineSlaRiskClass.BLOCKED);
  assert.equal(
    result.blockers.some(item => item.reasonCode === 'NO_SAFE_FANOUT_CAPACITY'),
    true,
  );
});

test('provider readiness is causal evidence: degraded warns, unavailable blocks, unknown is insufficient', () => {
  const degraded = assessDeadlineSlaV1(request({
    providerStates: [provider({ health: 'DEGRADED', reasonCode: 'HIGH_LATENCY' })],
  }));
  assert.equal(degraded.riskClass, DeadlineSlaRiskClass.WATCH);
  assert.equal(degraded.providerDegraded, true);

  const unavailable = assessDeadlineSlaV1(request({
    providerStates: [provider({ health: 'UNAVAILABLE', reasonCode: 'OUTAGE' })],
  }));
  assert.equal(unavailable.riskClass, DeadlineSlaRiskClass.BLOCKED);
  assert.equal(
    unavailable.blockers.some(item => item.reasonCode === 'PROVIDER_BLOCKED:github'),
    true,
  );

  const unknown = assessDeadlineSlaV1(request({
    providerStates: [],
  }));
  assert.equal(unknown.riskClass, DeadlineSlaRiskClass.INSUFFICIENT_EVIDENCE);
  assert.equal(
    unknown.evidenceGaps.some(item => item.reasonCode === 'PROVIDER_UNKNOWN:github'),
    true,
  );
  assert.equal(
    unknown.recommendations.some(item =>
      item.kind === DeadlineSlaRecommendationKind.REFRESH_PROVIDER_READINESS),
    true,
  );
});

test('low throughput sample count cannot become a calibrated-looking deadline claim', () => {
  const result = assessDeadlineSlaV1(request({
    throughput: throughput({ sampleCount: 2 }),
  }));
  assert.equal(result.riskClass, DeadlineSlaRiskClass.INSUFFICIENT_EVIDENCE);
  assert.equal(result.lowSampleEvidence, true);
  assert.equal(result.reasonCode, 'FORECAST_SAMPLE_TOO_SMALL');
});

test('risk mitigation recommendations are candidates only and preserve canonical authorities', () => {
  const result = assessDeadlineSlaV1(request({
    deadlineAt: deadlineAfter(200),
  }));
  const kinds = new Set(result.recommendations.map(item => item.kind));
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.INCREASE_SAFE_FANOUT), true);
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.ALLOCATE_FASTER_MODEL), true);
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.ACTIVATE_CLOUD_CAPACITY), true);
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.DEFER_SPECULATIVE_WORK), true);
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.PRIORITIZE_DEPENDENCY_UNLOCKERS), true);
  for (const item of result.recommendations) {
    assert.equal(item.advisoryOnly, true);
    assert.equal(item.actionAuthorized, false);
    assert.equal(item.requiresCanonicalPolicy, true);
    assert.equal(item.requiresCanonicalScheduler, true);
    assert.equal(item.requiresAtomicResourceReservation, true);
  }
});

test('resource ceiling suppresses stronger-capacity recommendations when acceleration request is denied', () => {
  const result = assessDeadlineSlaV1(request({
    deadlineAt: deadlineAfter(200),
    resourceBudget: {
      ...resourceBudget(),
      maxConcurrentAgents: 2,
      maxModelCalls: 0,
      maxRuntimeSeconds: 0,
      maxCostUsdMicros: 0,
    },
  }));
  assert.equal(result.resourceAcceleration.decision, 'DENY');
  const kinds = new Set(result.recommendations.map(item => item.kind));
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.ALLOCATE_FASTER_MODEL), false);
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.ACTIVATE_CLOUD_CAPACITY), false);
});

test('owner escalation is emitted only when severe risk has no automatic mitigation candidate', () => {
  const forecasts = nodeForecasts({
    'node-a': { valueClass: DeadlineSlaValueClass.NORMAL },
    'node-b': { valueClass: DeadlineSlaValueClass.NORMAL },
    'node-c': { valueClass: DeadlineSlaValueClass.NORMAL },
  });
  const result = assessDeadlineSlaV1(request({
    deadlineAt: deadlineAfter(200),
    nodeForecasts: forecasts,
    currentSafeFanout: 2,
    maxSafeFanout: 2,
    accelerationRequest: {},
  }));
  const kinds = new Set(result.recommendations.map(item => item.kind));
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.PRIORITIZE_DEPENDENCY_UNLOCKERS), true);
  assert.equal(kinds.has(DeadlineSlaRecommendationKind.SURFACE_OWNER_DECISION), false);

  const independentPlan = plan({
    nodes: [{
      ...plan().nodes[0],
      nodeId: 'single-node',
      dependsOn: [],
      state: 'BLOCKED',
    }],
  });
  const blocked = assessDeadlineSlaV1(request({
    plan: independentPlan,
    nodeForecasts: [{
      nodeId: 'single-node',
      remainingWorkUnits: 10,
      queueDelaySeconds: 0,
      uncertaintyBasisPoints: 1000,
      requiredProviderIds: ['github'],
      valueClass: DeadlineSlaValueClass.NORMAL,
    }],
    currentSafeFanout: 1,
    maxSafeFanout: 1,
    accelerationRequest: {},
  }));
  assert.equal(blocked.riskClass, DeadlineSlaRiskClass.BLOCKED);
  assert.equal(
    blocked.recommendations.some(item =>
      item.kind === DeadlineSlaRecommendationKind.SURFACE_OWNER_DECISION),
    true,
  );
});

test('forecast inputs bind exactly to AgentPlan nodes and canonical provider-wide readiness', () => {
  assert.throws(
    () => assessDeadlineSlaV1(request({
      nodeForecasts: nodeForecasts().slice(0, 2),
    })),
    /bind every AgentPlan node/,
  );
  assert.throws(
    () => assessDeadlineSlaV1(request({
      nodeForecasts: [
        ...nodeForecasts().slice(0, 2),
        { ...nodeForecasts()[2], nodeId: 'unknown-node' },
      ],
    })),
    /references do not match|unknown AgentPlan node/,
  );
  assert.throws(
    () => assessDeadlineSlaV1(request({
      providerStates: [provider({ toolId: 'github.read' })],
    })),
    /provider-wide readiness/,
  );
  assert.throws(
    () => assessDeadlineSlaV1(request({
      throughput: [...throughput(), ...throughput()],
    })),
    /duplicate executionPlane/,
  );
});

test('timestamps and fanout are exact and fail closed', () => {
  assert.throws(
    () => assessDeadlineSlaV1(request({
      assessedAt: '2026-09-25T08:00:00Z',
    })),
    /canonical ISO-8601 UTC/,
  );
  assert.throws(
    () => assessDeadlineSlaV1(request({
      currentSafeFanout: 3,
      maxSafeFanout: 2,
    })),
    /cannot exceed/,
  );
  assert.throws(
    () => assessDeadlineSlaV1(request({
      plan: plan({ updatedAt: '2026-09-25T08:00:01.000Z' }),
    })),
    /newer than SLA assessment/,
  );
});

test('top-level and array accessors fail without ordinary getter reads', () => {
  let topReads = 0;
  const accessor = request();
  Object.defineProperty(accessor, 'deadlineAt', {
    enumerable: true,
    get() {
      topReads += 1;
      return deadlineAfter(400);
    },
  });
  assert.throws(
    () => assessDeadlineSlaV1(accessor),
    /enumerable own data property/,
  );
  assert.equal(topReads, 0);

  let arrayReads = 0;
  const proxiedForecasts = new Proxy(nodeForecasts(), {
    get(target, key, receiver) {
      if (key === 'length' || /^(?:0|1|2)$/u.test(String(key))) arrayReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const result = assessDeadlineSlaV1(request({ nodeForecasts: proxiedForecasts }));
  assert.equal(result.nodeForecasts.length, 3);
  assert.equal(arrayReads, 0);

  const sparse = new Array(3);
  assert.throws(
    () => assessDeadlineSlaV1(request({ nodeForecasts: sparse })),
    /must be dense/,
  );
});
