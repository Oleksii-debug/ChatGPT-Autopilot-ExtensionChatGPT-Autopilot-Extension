import {
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from './agent-plan.js';
import {
  ProviderHealthStatus,
  normalizeProviderReadinessV1,
} from './capability-discovery.js';
import {
  ResourceBudgetDecisionKind,
  evaluateResourceBudgetV1,
} from './resource-budget-governor.js';

export const DEADLINE_SLA_VERSION = 1;
export const MAX_DEADLINE_SLA_NODES = 128;
export const MAX_DEADLINE_SLA_PROVIDERS = 256;

export const DeadlineSlaRiskClass = Object.freeze({
  ON_TRACK: 'ON_TRACK',
  WATCH: 'WATCH',
  AT_RISK: 'AT_RISK',
  UNLIKELY: 'UNLIKELY',
  BLOCKED: 'BLOCKED',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
});

export const DeadlineSlaValueClass = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  NORMAL: 'NORMAL',
  SPECULATIVE: 'SPECULATIVE',
});

export const DeadlineSlaRecommendationKind = Object.freeze({
  INCREASE_SAFE_FANOUT: 'INCREASE_SAFE_FANOUT',
  ALLOCATE_FASTER_MODEL: 'ALLOCATE_FASTER_MODEL',
  ACTIVATE_CLOUD_CAPACITY: 'ACTIVATE_CLOUD_CAPACITY',
  DEFER_SPECULATIVE_WORK: 'DEFER_SPECULATIVE_WORK',
  PRIORITIZE_DEPENDENCY_UNLOCKERS: 'PRIORITIZE_DEPENDENCY_UNLOCKERS',
  REFRESH_PROVIDER_READINESS: 'REFRESH_PROVIDER_READINESS',
  SURFACE_OWNER_DECISION: 'SURFACE_OWNER_DECISION',
});

const VALUE_CLASSES = new Set(Object.values(DeadlineSlaValueClass));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'assessmentId',
  'assessedAt',
  'deadlineAt',
  'plan',
  'nodeForecasts',
  'throughput',
  'providerStates',
  'resourceBudget',
  'resourceUsage',
  'accelerationRequest',
  'currentSafeFanout',
  'maxSafeFanout',
]);
const NODE_FORECAST_KEYS = new Set([
  'nodeId',
  'remainingWorkUnits',
  'queueDelaySeconds',
  'uncertaintyBasisPoints',
  'requiredProviderIds',
  'valueClass',
]);
const THROUGHPUT_KEYS = new Set([
  'executionPlane',
  'completedWorkUnits',
  'observedRuntimeSeconds',
  'sampleCount',
]);

const MAX_WORK_UNITS = 1_000_000_000;
const MAX_RUNTIME_SECONDS = 31_536_000;
const MAX_QUEUE_SECONDS = 31_536_000;
const MAX_SAMPLE_COUNT = 1_000_000;
const MAX_FANOUT = 100_000;
const MAX_UNCERTAINTY_BPS = 10_000;

function snapshotRecord(value, label, allowed) {
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
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      throw new Error(label + ' is missing field: ' + key);
    }
  }
  return Object.freeze(out);
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded canonical array');
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index data');
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' entries must be enumerable own data properties');
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' must be dense');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(label + ' must be a timestamp');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(label + ' must be a timestamp');
  const canonical = new Date(milliseconds).toISOString();
  if (canonical !== value) throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  return value;
}

function integer(value, label, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0
      || value > max) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function idList(value, label, max = MAX_DEADLINE_SLA_PROVIDERS) {
  const out = denseArray(value, label, max)
    .map((item, index) => exactId(item, label + '[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicates');
  return Object.freeze(out.sort(codeUnitCompare));
}

function normalizeNodeForecast(input, index) {
  const label = 'nodeForecasts[' + index + ']';
  const raw = snapshotRecord(input, label, NODE_FORECAST_KEYS);
  if (typeof raw.valueClass !== 'string' || !VALUE_CLASSES.has(raw.valueClass)) {
    throw new Error(label + '.valueClass is invalid');
  }
  return deepFreeze({
    nodeId: exactId(raw.nodeId, label + '.nodeId'),
    remainingWorkUnits: integer(raw.remainingWorkUnits, label + '.remainingWorkUnits', MAX_WORK_UNITS),
    queueDelaySeconds: integer(raw.queueDelaySeconds, label + '.queueDelaySeconds', MAX_QUEUE_SECONDS),
    uncertaintyBasisPoints: integer(
      raw.uncertaintyBasisPoints,
      label + '.uncertaintyBasisPoints',
      MAX_UNCERTAINTY_BPS,
    ),
    requiredProviderIds: idList(raw.requiredProviderIds, label + '.requiredProviderIds'),
    valueClass: raw.valueClass,
  });
}

function normalizeThroughput(input, index) {
  const label = 'throughput[' + index + ']';
  const raw = snapshotRecord(input, label, THROUGHPUT_KEYS);
  return deepFreeze({
    executionPlane: exactId(raw.executionPlane, label + '.executionPlane'),
    completedWorkUnits: integer(raw.completedWorkUnits, label + '.completedWorkUnits', MAX_WORK_UNITS),
    observedRuntimeSeconds: integer(
      raw.observedRuntimeSeconds,
      label + '.observedRuntimeSeconds',
      MAX_RUNTIME_SECONDS,
    ),
    sampleCount: integer(raw.sampleCount, label + '.sampleCount', MAX_SAMPLE_COUNT),
  });
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new Error('deadline forecast divisor must be positive');
  return (numerator + denominator - 1n) / denominator;
}

function safeBigIntNumber(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(label + ' exceeds safe integer range');
  }
  return Number(value);
}

function durationFromThroughput(forecast, throughput, label) {
  if (!throughput
      || throughput.completedWorkUnits === 0
      || throughput.observedRuntimeSeconds === 0
      || throughput.sampleCount === 0) {
    return null;
  }
  const expected = safeBigIntNumber(ceilDiv(
    BigInt(forecast.remainingWorkUnits) * BigInt(throughput.observedRuntimeSeconds),
    BigInt(throughput.completedWorkUnits),
  ), label + ' expected runtime');
  const uncertainty = safeBigIntNumber(ceilDiv(
    BigInt(expected) * BigInt(forecast.uncertaintyBasisPoints),
    10_000n,
  ), label + ' uncertainty');
  const optimisticRuntime = Math.max(0, expected - uncertainty);
  const pessimisticRuntime = expected + uncertainty;
  if (!Number.isSafeInteger(pessimisticRuntime)) {
    throw new Error(label + ' pessimistic runtime exceeds safe integer range');
  }
  return deepFreeze({
    optimisticSeconds: forecast.queueDelaySeconds + optimisticRuntime,
    centralSeconds: forecast.queueDelaySeconds + expected,
    pessimisticSeconds: forecast.queueDelaySeconds + pessimisticRuntime,
    sampleCount: throughput.sampleCount,
  });
}

function providerReadinessClass(state) {
  if (!state) return 'UNKNOWN';
  if (state.health === ProviderHealthStatus.UNAVAILABLE) return 'BLOCKED';
  if (state.installationRequired && !state.installed) return 'BLOCKED';
  if (state.authenticationRequired && !state.authenticated) return 'BLOCKED';
  if (state.health === ProviderHealthStatus.UNKNOWN) return 'UNKNOWN';
  if (state.health === ProviderHealthStatus.DEGRADED) return 'DEGRADED';
  return 'READY';
}

function addSeconds(timestamp, seconds) {
  const base = Date.parse(timestamp);
  const delta = seconds * 1000;
  if (!Number.isSafeInteger(delta)) throw new Error('deadline completion projection is invalid');
  const result = base + delta;
  if (!Number.isFinite(result) || result > 8_640_000_000_000_000) {
    throw new Error('deadline completion projection is outside supported time range');
  }
  return new Date(result).toISOString();
}

function recommendation(kind, reasonCode) {
  return deepFreeze({
    kind,
    reasonCode,
    advisoryOnly: true,
    actionAuthorized: false,
    requiresCanonicalPolicy: true,
    requiresCanonicalScheduler: true,
    requiresAtomicResourceReservation: true,
    requiresFreshWorldState: true,
  });
}

function rankRisk(risk) {
  return {
    [DeadlineSlaRiskClass.ON_TRACK]: 0,
    [DeadlineSlaRiskClass.WATCH]: 1,
    [DeadlineSlaRiskClass.AT_RISK]: 2,
    [DeadlineSlaRiskClass.UNLIKELY]: 3,
    [DeadlineSlaRiskClass.INSUFFICIENT_EVIDENCE]: 4,
    [DeadlineSlaRiskClass.BLOCKED]: 5,
  }[risk] ?? 99;
}

export function assessDeadlineSlaV1(input) {
  const raw = snapshotRecord(input, 'DeadlineSlaAssessmentV1', REQUEST_KEYS);
  if (raw.schemaVersion !== DEADLINE_SLA_VERSION) {
    throw new Error('Unsupported DeadlineSlaAssessmentV1 schemaVersion');
  }
  const assessmentId = exactId(raw.assessmentId, 'assessmentId');
  const assessedAt = exactTimestamp(raw.assessedAt, 'assessedAt');
  const deadlineAt = exactTimestamp(raw.deadlineAt, 'deadlineAt');
  const plan = normalizeAgentPlanV1(raw.plan);
  if (Date.parse(plan.updatedAt) > Date.parse(assessedAt)) {
    throw new Error('AgentPlan cannot be newer than SLA assessment');
  }

  const nodeForecasts = denseArray(
    raw.nodeForecasts,
    'nodeForecasts',
    MAX_DEADLINE_SLA_NODES,
  ).map(normalizeNodeForecast);
  if (nodeForecasts.length !== plan.nodes.length) {
    throw new Error('nodeForecasts must bind every AgentPlan node exactly once');
  }
  const forecastByNode = new Map();
  for (const forecast of nodeForecasts) {
    if (forecastByNode.has(forecast.nodeId)) throw new Error('nodeForecasts contains duplicate nodeId');
    forecastByNode.set(forecast.nodeId, forecast);
  }
  for (const node of plan.nodes) {
    if (!forecastByNode.has(node.nodeId)) throw new Error('nodeForecasts references do not match AgentPlan nodes');
  }
  for (const nodeId of forecastByNode.keys()) {
    if (!plan.nodes.some(node => node.nodeId === nodeId)) {
      throw new Error('nodeForecasts references unknown AgentPlan node');
    }
  }

  const throughput = denseArray(raw.throughput, 'throughput', MAX_DEADLINE_SLA_NODES)
    .map(normalizeThroughput);
  const throughputByPlane = new Map();
  for (const item of throughput) {
    if (throughputByPlane.has(item.executionPlane)) {
      throw new Error('throughput contains duplicate executionPlane');
    }
    throughputByPlane.set(item.executionPlane, item);
  }

  const providerStates = denseArray(
    raw.providerStates,
    'providerStates',
    MAX_DEADLINE_SLA_PROVIDERS,
  ).map(normalizeProviderReadinessV1);
  const providerById = new Map();
  for (const state of providerStates) {
    if (state.toolId) throw new Error('Deadline SLA providerStates must be provider-wide readiness records');
    if (providerById.has(state.providerId)) throw new Error('providerStates contains duplicate providerId');
    providerById.set(state.providerId, state);
  }

  const currentSafeFanout = integer(raw.currentSafeFanout, 'currentSafeFanout', MAX_FANOUT);
  const maxSafeFanout = integer(raw.maxSafeFanout, 'maxSafeFanout', MAX_FANOUT);
  if (currentSafeFanout > maxSafeFanout) throw new Error('currentSafeFanout cannot exceed maxSafeFanout');

  const acceleration = evaluateResourceBudgetV1({
    budget: raw.resourceBudget,
    usage: raw.resourceUsage,
    request: raw.accelerationRequest,
  });

  const nodeById = new Map(plan.nodes.map(node => [node.nodeId, node]));
  const projected = new Map();
  const blockers = [];
  const unknownEvidence = [];
  let providerDegraded = false;
  let lowSampleEvidence = false;

  for (const node of plan.nodes) {
    const forecast = forecastByNode.get(node.nodeId);
    if (node.state === AgentPlanNodeState.FAILED
        || node.state === AgentPlanNodeState.CANCELLED
        || node.state === AgentPlanNodeState.BLOCKED) {
      blockers.push({ nodeId: node.nodeId, reasonCode: 'PLAN_NODE_' + node.state });
    }
    if (node.state === AgentPlanNodeState.VERIFIED) {
      projected.set(node.nodeId, deepFreeze({
        nodeId: node.nodeId,
        optimisticSeconds: 0,
        centralSeconds: 0,
        pessimisticSeconds: 0,
        evidenceClass: 'TERMINAL_VERIFIED',
        providerClass: 'READY',
      }));
      continue;
    }

    let nodeProviderClass = 'READY';
    for (const providerId of forecast.requiredProviderIds) {
      const providerClass = providerReadinessClass(providerById.get(providerId));
      if (providerClass === 'BLOCKED') {
        nodeProviderClass = 'BLOCKED';
        blockers.push({ nodeId: node.nodeId, reasonCode: 'PROVIDER_BLOCKED:' + providerId });
      } else if (providerClass === 'UNKNOWN' && nodeProviderClass !== 'BLOCKED') {
        nodeProviderClass = 'UNKNOWN';
        unknownEvidence.push({ nodeId: node.nodeId, reasonCode: 'PROVIDER_UNKNOWN:' + providerId });
      } else if (providerClass === 'DEGRADED'
          && nodeProviderClass !== 'BLOCKED'
          && nodeProviderClass !== 'UNKNOWN') {
        nodeProviderClass = 'DEGRADED';
        providerDegraded = true;
      }
    }

    const throughputEvidence = throughputByPlane.get(node.executionPlane);
    const duration = durationFromThroughput(forecast, throughputEvidence, 'node ' + node.nodeId);
    if (!duration) {
      unknownEvidence.push({ nodeId: node.nodeId, reasonCode: 'THROUGHPUT_MISSING:' + node.executionPlane });
      projected.set(node.nodeId, deepFreeze({
        nodeId: node.nodeId,
        optimisticSeconds: 0,
        centralSeconds: 0,
        pessimisticSeconds: 0,
        evidenceClass: 'INSUFFICIENT',
        providerClass: nodeProviderClass,
      }));
      continue;
    }
    if (duration.sampleCount < 3) lowSampleEvidence = true;
    projected.set(node.nodeId, deepFreeze({
      nodeId: node.nodeId,
      optimisticSeconds: duration.optimisticSeconds,
      centralSeconds: duration.centralSeconds,
      pessimisticSeconds: duration.pessimisticSeconds,
      evidenceClass: duration.sampleCount < 3 ? 'LOW_SAMPLE' : 'EMPIRICAL',
      providerClass: nodeProviderClass,
    }));
  }

  const finishMemo = new Map();
  function finishFor(nodeId, field) {
    const key = field + ':' + nodeId;
    if (finishMemo.has(key)) return finishMemo.get(key);
    const node = nodeById.get(nodeId);
    let dependencyFinish = 0;
    for (const dependencyId of node.dependsOn) {
      dependencyFinish = Math.max(dependencyFinish, finishFor(dependencyId, field));
    }
    const duration = projected.get(nodeId)[field];
    const finish = dependencyFinish + duration;
    if (!Number.isSafeInteger(finish)) throw new Error('deadline critical path exceeds safe integer range');
    finishMemo.set(key, finish);
    return finish;
  }

  const optimisticSeconds = Math.max(
    0,
    ...plan.nodes.map(node => finishFor(node.nodeId, 'optimisticSeconds')),
  );
  const centralSeconds = Math.max(
    0,
    ...plan.nodes.map(node => finishFor(node.nodeId, 'centralSeconds')),
  );
  const pessimisticSeconds = Math.max(
    0,
    ...plan.nodes.map(node => finishFor(node.nodeId, 'pessimisticSeconds')),
  );

  const availableSeconds = Math.max(
    0,
    Math.floor((Date.parse(deadlineAt) - Date.parse(assessedAt)) / 1000),
  );
  const incomplete = plan.nodes.some(node => node.state !== AgentPlanNodeState.VERIFIED);

  let riskClass;
  let reasonCode;
  if (blockers.length > 0) {
    riskClass = DeadlineSlaRiskClass.BLOCKED;
    reasonCode = 'BLOCKING_DEPENDENCY_OR_PROVIDER';
  } else if (unknownEvidence.length > 0 || lowSampleEvidence) {
    riskClass = DeadlineSlaRiskClass.INSUFFICIENT_EVIDENCE;
    reasonCode = unknownEvidence.length > 0 ? 'FORECAST_INPUT_EVIDENCE_MISSING' : 'FORECAST_SAMPLE_TOO_SMALL';
  } else if (!incomplete) {
    riskClass = DeadlineSlaRiskClass.ON_TRACK;
    reasonCode = 'PLAN_ALREADY_VERIFIED';
  } else if (pessimisticSeconds <= availableSeconds && !providerDegraded) {
    riskClass = DeadlineSlaRiskClass.ON_TRACK;
    reasonCode = 'PESSIMISTIC_BOUND_WITHIN_DEADLINE';
  } else if (centralSeconds <= availableSeconds) {
    riskClass = DeadlineSlaRiskClass.WATCH;
    reasonCode = providerDegraded
      ? 'DEGRADED_PROVIDER_WITH_CENTRAL_BOUND'
      : 'CENTRAL_BOUND_WITHIN_DEADLINE';
  } else if (optimisticSeconds <= availableSeconds) {
    riskClass = DeadlineSlaRiskClass.AT_RISK;
    reasonCode = 'ONLY_OPTIMISTIC_BOUND_WITHIN_DEADLINE';
  } else {
    riskClass = DeadlineSlaRiskClass.UNLIKELY;
    reasonCode = 'OPTIMISTIC_BOUND_EXCEEDS_DEADLINE';
  }

  const recommendations = [];
  const mitigationKinds = new Set();
  const addRecommendation = (kind, reason) => {
    if (mitigationKinds.has(kind)) return;
    mitigationKinds.add(kind);
    recommendations.push(recommendation(kind, reason));
  };

  if (riskClass !== DeadlineSlaRiskClass.ON_TRACK) {
    if (currentSafeFanout < maxSafeFanout) {
      addRecommendation(DeadlineSlaRecommendationKind.INCREASE_SAFE_FANOUT, 'SAFE_FANOUT_HEADROOM');
    }
    const accelerationRequested = Object.values(acceleration.request).some(value => value > 0);
    if (accelerationRequested && acceleration.decision === ResourceBudgetDecisionKind.ALLOW) {
      addRecommendation(DeadlineSlaRecommendationKind.ALLOCATE_FASTER_MODEL, 'ACCELERATION_WITHIN_RESOURCE_BUDGET');
      addRecommendation(DeadlineSlaRecommendationKind.ACTIVATE_CLOUD_CAPACITY, 'ACCELERATION_WITHIN_RESOURCE_BUDGET');
    }
    if (nodeForecasts.some(item => item.valueClass === DeadlineSlaValueClass.SPECULATIVE
        && nodeById.get(item.nodeId).state !== AgentPlanNodeState.VERIFIED)) {
      addRecommendation(DeadlineSlaRecommendationKind.DEFER_SPECULATIVE_WORK, 'SPECULATIVE_WORK_REMAINS');
    }
    if (plan.nodes.some(node => node.dependsOn.length > 0 && node.state !== AgentPlanNodeState.VERIFIED)) {
      addRecommendation(
        DeadlineSlaRecommendationKind.PRIORITIZE_DEPENDENCY_UNLOCKERS,
        'DEPENDENCY_CRITICAL_PATH_PRESENT',
      );
    }
    if (unknownEvidence.some(item => item.reasonCode.startsWith('PROVIDER_UNKNOWN:'))) {
      addRecommendation(DeadlineSlaRecommendationKind.REFRESH_PROVIDER_READINESS, 'PROVIDER_READINESS_UNKNOWN');
    }
  }

  const automaticMitigationCandidate = recommendations.some(item =>
    item.kind !== DeadlineSlaRecommendationKind.REFRESH_PROVIDER_READINESS
    && item.kind !== DeadlineSlaRecommendationKind.SURFACE_OWNER_DECISION);
  if ((riskClass === DeadlineSlaRiskClass.UNLIKELY || riskClass === DeadlineSlaRiskClass.BLOCKED)
      && !automaticMitigationCandidate) {
    addRecommendation(
      DeadlineSlaRecommendationKind.SURFACE_OWNER_DECISION,
      'AUTOMATIC_REALLOCATION_CANNOT_ESTABLISH_DEADLINE_PATH',
    );
  }

  recommendations.sort((left, right) => codeUnitCompare(left.kind, right.kind));
  blockers.sort((left, right) =>
    codeUnitCompare(left.nodeId, right.nodeId) || codeUnitCompare(left.reasonCode, right.reasonCode));
  unknownEvidence.sort((left, right) =>
    codeUnitCompare(left.nodeId, right.nodeId) || codeUnitCompare(left.reasonCode, right.reasonCode));

  const nodeForecastOutput = [...projected.values()].sort((left, right) =>
    codeUnitCompare(left.nodeId, right.nodeId));

  return deepFreeze({
    schemaVersion: DEADLINE_SLA_VERSION,
    assessmentId,
    planId: plan.planId,
    jobId: plan.jobId,
    planRevision: plan.revision,
    assessedAt,
    deadlineAt,
    availableSeconds,
    riskClass,
    riskRank: rankRisk(riskClass),
    reasonCode,
    completionBounds: {
      optimisticSeconds,
      centralSeconds,
      pessimisticSeconds,
      optimisticAt: addSeconds(assessedAt, optimisticSeconds),
      centralAt: addSeconds(assessedAt, centralSeconds),
      pessimisticAt: addSeconds(assessedAt, pessimisticSeconds),
    },
    nodeForecasts: nodeForecastOutput,
    blockers,
    evidenceGaps: unknownEvidence,
    providerDegraded,
    lowSampleEvidence,
    resourceAcceleration: {
      decision: acceleration.decision,
      reasonCode: acceleration.reasonCode,
      exceeded: [...acceleration.exceeded],
      request: { ...acceleration.request },
      remaining: { ...acceleration.remaining },
    },
    recommendations,
    probabilityEstimate: null,
    probabilityEstimateAuthorized: false,
    advisoryOnly: true,
    actionAuthorized: false,
    requiresCanonicalPolicy: true,
    requiresCanonicalScheduler: true,
    requiresAtomicResourceReservation: true,
    requiresFreshProviderReadiness: true,
    requiresFreshWorldState: true,
  });
}
