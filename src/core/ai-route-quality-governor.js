import {
  AiRouteCostClass,
  AiRouteRole,
  normalizeAiRoutePolicy,
  normalizeAiRoutePool,
  normalizeAiRouteStates,
  selectAiRouteCandidates,
} from './ai-route-pool.js';
import {
  BenchmarkEvaluationStatus,
  evaluateBenchmarkRunV1,
} from './benchmark-evaluation.js';

export const AI_ROUTE_QUALITY_GOVERNOR_VERSION = 1;

export const AiRouteQualityClass = Object.freeze({
  PASS: 'PASS',
  MISSING: 'MISSING',
  FAIL: 'FAIL',
});

const QUALITY_CLASS_ORDER = new Map([
  [AiRouteQualityClass.PASS, 0],
  [AiRouteQualityClass.MISSING, 1],
  [AiRouteQualityClass.FAIL, 2],
]);

const REQUEST_KEYS = new Set([
  'routes',
  'policy',
  'routeStates',
  'role',
  'capabilityIds',
  'requiresVision',
  'now',
  'benchmarkRequests',
]);

const BENCHMARK_BINDING_KEYS = new Set([
  'routeId',
  'evaluationRequest',
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_ROUTES = 32;

function record(value, allowed, label) {
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
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' has invalid length');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).length !== expected.size) {
    throw new Error(label + ' must be dense and data-only');
  }
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
    if (key === 'length') continue;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '[' + key + '] must be an enumerable own data property');
    }
    out[Number(key)] = descriptor.value;
  }
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(out, index)) throw new Error(label + ' must not be sparse');
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function exactEpoch(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error(label + ' must be an exact non-negative integer');
  }
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function qualityClass(evaluation) {
  if (!evaluation) return AiRouteQualityClass.MISSING;
  return evaluation.status === BenchmarkEvaluationStatus.PASS
    ? AiRouteQualityClass.PASS
    : AiRouteQualityClass.FAIL;
}

function compareQuality(left, right) {
  const classDelta = QUALITY_CLASS_ORDER.get(left.qualityClass)
    - QUALITY_CLASS_ORDER.get(right.qualityClass);
  if (classDelta) return classDelta;

  if (left.qualityClass === AiRouteQualityClass.MISSING) return 0;

  const leftPassed = left.quality.passedCaseCount;
  const leftCount = left.quality.caseCount;
  const rightPassed = right.quality.passedCaseCount;
  const rightCount = right.quality.caseCount;
  const ratioDelta = rightPassed * leftCount - leftPassed * rightCount;
  if (ratioDelta) return ratioDelta;

  return right.quality.passedCaseCount - left.quality.passedCaseCount;
}

function compareCost(left, right) {
  const leftClass = left.route.costClass === AiRouteCostClass.FREE ? 0 : 1;
  const rightClass = right.route.costClass === AiRouteCostClass.FREE ? 0 : 1;
  if (leftClass !== rightClass) return leftClass - rightClass;
  if (left.route.inputPricePerMillionUsd !== right.route.inputPricePerMillionUsd) {
    return left.route.inputPricePerMillionUsd - right.route.inputPricePerMillionUsd;
  }
  if (left.route.outputPricePerMillionUsd !== right.route.outputPricePerMillionUsd) {
    return left.route.outputPricePerMillionUsd - right.route.outputPricePerMillionUsd;
  }
  return 0;
}

function compareLatency(left, right) {
  if (left.latencyObserved !== right.latencyObserved) return left.latencyObserved ? -1 : 1;
  if (!left.latencyObserved) return 0;
  return left.lastLatencyMs - right.lastLatencyMs;
}

function normalizeBenchmarkBindings(value, routeIds) {
  const items = denseArray(value, 'AI route governor benchmarkRequests', MAX_ROUTES);
  const byRoute = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const raw = record(
      items[index],
      BENCHMARK_BINDING_KEYS,
      'AI route governor benchmarkRequests[' + index + ']',
    );
    const routeId = id(raw.routeId, 'AI route governor benchmark routeId');
    if (!routeIds.has(routeId)) {
      throw new Error('AI route governor benchmark evidence references unknown route: ' + routeId);
    }
    if (byRoute.has(routeId)) {
      throw new Error('AI route governor benchmark evidence is duplicated for route: ' + routeId);
    }
    const evaluation = evaluateBenchmarkRunV1(raw.evaluationRequest);
    if (evaluation.subjectId !== routeId) {
      throw new Error(
        'AI route governor benchmark subject must match routeId: '
          + routeId + ' != ' + evaluation.subjectId,
      );
    }
    byRoute.set(routeId, evaluation);
  }
  return byRoute;
}

function qualityProjection(evaluation) {
  if (!evaluation) {
    return freeze({
      class: AiRouteQualityClass.MISSING,
      suiteId: '',
      suiteRevisionId: '',
      subjectRevisionId: '',
      caseCount: 0,
      passedCaseCount: 0,
      failedCaseCount: 0,
    });
  }
  return freeze({
    class: qualityClass(evaluation),
    suiteId: evaluation.suiteId,
    suiteRevisionId: evaluation.suiteRevisionId,
    subjectRevisionId: evaluation.subjectRevisionId,
    caseCount: evaluation.caseCount,
    passedCaseCount: evaluation.passedCaseCount,
    failedCaseCount: evaluation.failedCaseCount,
  });
}

export function rankAiRouteCandidatesByEvidenceV1(input = {}) {
  const request = record(input, REQUEST_KEYS, 'AiRouteQualityGovernorV1 request');
  const routes = normalizeAiRoutePool(request.routes ?? []);
  const policy = normalizeAiRoutePolicy(request.policy ?? {});
  const routeStates = normalizeAiRouteStates(request.routeStates ?? {}, routes);
  const role = request.role ?? AiRouteRole.PLANNER;
  const capabilityIds = request.capabilityIds ?? [];
  const requiresVision = request.requiresVision === undefined
    ? false
    : exactBoolean(request.requiresVision, 'AI route governor requiresVision');
  const now = request.now === undefined
    ? Date.now()
    : exactEpoch(request.now, 'AI route governor now');
  const benchmarkRequests = request.benchmarkRequests ?? [];

  const routeIds = new Set(routes.map((route) => route.routeId));
  const benchmarkByRoute = normalizeBenchmarkBindings(benchmarkRequests, routeIds);

  const selected = selectAiRouteCandidates({
    routes,
    policy,
    routeStates,
    role,
    capabilityIds,
    requiresVision,
    now,
  });

  const ownerOrder = new Map(
    policy.orderedRouteIds.map((routeId, index) => [routeId, index]),
  );
  const baselineIndex = new Map(
    selected.candidates.map((route, index) => [route.routeId, index]),
  );

  const rows = selected.candidates.map((route) => {
    const state = routeStates[route.routeId];
    const observations = state ? state.successes + state.failures : 0;
    const evaluation = benchmarkByRoute.get(route.routeId);
    const quality = qualityProjection(evaluation);
    return {
      route,
      ownerOrderIndex: ownerOrder.has(route.routeId) ? ownerOrder.get(route.routeId) : null,
      quality,
      qualityClass: quality.class,
      latencyObserved: Boolean(state && observations > 0),
      lastLatencyMs: state && observations > 0 ? state.lastLatencyMs : 0,
      baselineRank: baselineIndex.get(route.routeId) + 1,
    };
  });

  rows.sort((left, right) => {
    const leftOrder = left.ownerOrderIndex ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.ownerOrderIndex ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder
      || right.route.priority - left.route.priority
      || compareQuality(left, right)
      || compareCost(left, right)
      || compareLatency(left, right)
      || left.baselineRank - right.baselineRank
      || compareId(left.route.routeId, right.route.routeId);
  });

  const candidates = rows.map((row, index) => freeze({
    routeId: row.route.routeId,
    governorRank: index + 1,
    baselineRank: row.baselineRank,
    ownerOrderIndex: row.ownerOrderIndex,
    ownerPriority: row.route.priority,
    quality: row.quality,
    cost: freeze({
      costClass: row.route.costClass,
      inputPricePerMillionUsd: row.route.inputPricePerMillionUsd,
      outputPricePerMillionUsd: row.route.outputPricePerMillionUsd,
    }),
    latency: freeze({
      observed: row.latencyObserved,
      lastLatencyMs: row.lastLatencyMs,
    }),
  }));

  return freeze({
    schemaVersion: AI_ROUTE_QUALITY_GOVERNOR_VERSION,
    advisoryOnly: true,
    selectionAuthorized: false,
    dispatchAuthorized: false,
    policyAuthorized: false,
    budgetAuthorized: false,
    routeStateMutationAuthorized: false,
    qualityStoreAuthorized: false,
    requiresCanonicalRouterSelectionAtDispatch: true,
    requiresFreshPolicyAtDispatch: true,
    qualityEvidenceDoesNotGrantExecution: true,
    recommendedRouteId: candidates[0]?.routeId ?? '',
    rankedRouteIds: Object.freeze(candidates.map((item) => item.routeId)),
    eligibleRouteIds: selected.eligibleRouteIds,
    retryAt: selected.retryAt,
    candidates: Object.freeze(candidates),
  });
}
