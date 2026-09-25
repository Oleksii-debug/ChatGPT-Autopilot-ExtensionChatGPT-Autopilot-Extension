import {
  ProviderHealthStatus,
  normalizeProviderReadinessV1,
} from './capability-discovery.js';
import {
  ResourceBudgetDecisionKind,
  evaluateResourceBudgetV1,
} from './resource-budget-governor.js';

export const HUMAN_TIME_ECONOMICS_VERSION = 1;

export const HumanTimeEconomicsStatus = Object.freeze({
  COMPARABLE: 'COMPARABLE',
  PARTIAL_EVIDENCE: 'PARTIAL_EVIDENCE',
  NO_COMPARABLE_ALTERNATIVES: 'NO_COMPARABLE_ALTERNATIVES',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_ALTERNATIVES = 128;
const MAX_MONEY_USD_MICROS = Number.MAX_SAFE_INTEGER;
const MAX_RUNTIME_MS = 31_536_000_000;
const MAX_OWNER_SECONDS = 31_536_000;
const MAX_TOTAL_REWORK_OWNER_SECONDS = 3_153_600_000_000;
const MAX_SAMPLE_COUNT = 10_000_000;
const MAX_OWNER_MINUTE_VALUE_USD_MICROS = 1_000_000_000;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'assessmentId',
  'projectId',
  'jobId',
  'asOf',
  'ownerMinuteValueUsdMicros',
  'minimumEvidenceSamples',
  'alternatives',
]);

const ALTERNATIVE_KEYS = new Set([
  'alternativeId',
  'providerReadiness',
  'machineApiCostUsdMicros',
  'runtimeMs',
  'ownerReviewSeconds',
  'ownerCoordinationSeconds',
  'deadlineCostUsdMicros',
  'deadlineFeasible',
  'deadlineEvidenceId',
  'deadlineAssessedAt',
  'outcomeEvidence',
  'resourceBudget',
]);

const OUTCOME_KEYS = new Set([
  'evidenceId',
  'sampleCount',
  'verifierPassCount',
  'reworkCount',
  'totalReworkOwnerSeconds',
  'observedAt',
]);

const RESOURCE_KEYS = new Set(['budget', 'usage', 'request']);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }

  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(label + ' must expose stable data descriptors');
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }

  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field');
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function dataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' length is invalid');
  }

  const length = lengthDescriptor.value;
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array data');
    }
  }

  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function exactInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeNumber(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(label + ' exceeds the safe integer range');
  }
  return Number(value);
}

function safeSum(values, label) {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return safeNumber(total, label);
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new Error('internal denominator must be positive');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function empiricalBasisPoints(numerator, denominator, label) {
  if (denominator < 1) return null;
  return safeNumber(
    (BigInt(numerator) * 10_000n) / BigInt(denominator),
    label,
  );
}

function conservativeAverageSeconds(totalSeconds, sampleCount) {
  if (sampleCount < 1) return null;
  return safeNumber(
    ceilDiv(BigInt(totalSeconds), BigInt(sampleCount)),
    'expected rework owner seconds',
  );
}

function ownerTimeCostUsdMicros(seconds, ownerMinuteValueUsdMicros) {
  return safeNumber(
    ceilDiv(BigInt(seconds) * BigInt(ownerMinuteValueUsdMicros), 60n),
    'owner attention cost',
  );
}

function readinessBlockers(readiness) {
  const blockers = [];
  if (readiness.health === ProviderHealthStatus.UNAVAILABLE) {
    blockers.push('PROVIDER_UNAVAILABLE');
  } else if (readiness.health === ProviderHealthStatus.UNKNOWN) {
    blockers.push('PROVIDER_HEALTH_UNKNOWN');
  }
  if (readiness.installationRequired && !readiness.installed) {
    blockers.push('PROVIDER_NOT_INSTALLED');
  }
  if (readiness.authenticationRequired && !readiness.authenticated) {
    blockers.push('PROVIDER_NOT_AUTHENTICATED');
  }
  return blockers;
}

function normalizeOutcomeEvidence(value, minimumEvidenceSamples, asOf) {
  const raw = strictRecord(value, OUTCOME_KEYS, 'HumanTimeOutcomeEvidenceV1');
  const sampleCount = exactInteger(
    raw.sampleCount,
    'HumanTimeOutcomeEvidenceV1.sampleCount',
    0,
    MAX_SAMPLE_COUNT,
  );
  const verifierPassCount = exactInteger(
    raw.verifierPassCount,
    'HumanTimeOutcomeEvidenceV1.verifierPassCount',
    0,
    sampleCount,
  );
  const reworkCount = exactInteger(
    raw.reworkCount,
    'HumanTimeOutcomeEvidenceV1.reworkCount',
    0,
    sampleCount,
  );
  const totalReworkOwnerSeconds = exactInteger(
    raw.totalReworkOwnerSeconds,
    'HumanTimeOutcomeEvidenceV1.totalReworkOwnerSeconds',
    0,
    MAX_TOTAL_REWORK_OWNER_SECONDS,
  );

  if (sampleCount === 0
      && (verifierPassCount !== 0 || reworkCount !== 0 || totalReworkOwnerSeconds !== 0)) {
    throw new Error('HumanTimeOutcomeEvidenceV1 zero samples cannot contain outcomes');
  }
  if (reworkCount === 0 && totalReworkOwnerSeconds !== 0) {
    throw new Error('HumanTimeOutcomeEvidenceV1 rework time requires rework observations');
  }
  if (reworkCount > 0 && totalReworkOwnerSeconds === 0) {
    throw new Error('HumanTimeOutcomeEvidenceV1 rework observations require measured owner time');
  }

  const observedAt = exactTimestamp(raw.observedAt, 'HumanTimeOutcomeEvidenceV1.observedAt');
  if (Date.parse(observedAt) > Date.parse(asOf)) {
    throw new Error('HumanTimeOutcomeEvidenceV1 postdates assessment');
  }

  const evidenceSufficient = sampleCount >= minimumEvidenceSamples;
  return deepFreeze({
    evidenceId: exactId(raw.evidenceId, 'HumanTimeOutcomeEvidenceV1.evidenceId'),
    sampleCount,
    verifierPassCount,
    reworkCount,
    totalReworkOwnerSeconds,
    observedAt,
    evidenceSufficient,
    empiricalVerifierPassRateBasisPoints: evidenceSufficient
      ? empiricalBasisPoints(verifierPassCount, sampleCount, 'empirical verifier pass rate')
      : null,
    empiricalReworkRateBasisPoints: evidenceSufficient
      ? empiricalBasisPoints(reworkCount, sampleCount, 'empirical rework rate')
      : null,
    expectedReworkOwnerSeconds: evidenceSufficient
      ? conservativeAverageSeconds(totalReworkOwnerSeconds, sampleCount)
      : null,
  });
}

function normalizeResourceBudget(value, machineApiCostUsdMicros, runtimeMs) {
  const raw = strictRecord(value, RESOURCE_KEYS, 'HumanTimeResourceBudgetV1');
  const evaluation = evaluateResourceBudgetV1({
    budget: raw.budget,
    usage: raw.usage,
    request: raw.request,
  });
  const minimumRuntimeSeconds = Math.floor((runtimeMs + 999) / 1000);

  if (evaluation.request.costUsdMicros < machineApiCostUsdMicros) {
    throw new Error('ResourceRequestV1 understates machine/API money cost');
  }
  if (evaluation.request.runtimeSeconds < minimumRuntimeSeconds) {
    throw new Error('ResourceRequestV1 understates runtime');
  }
  return evaluation;
}

function normalizeAlternative(
  value,
  index,
  {
    asOf,
    ownerMinuteValueUsdMicros,
    minimumEvidenceSamples,
  },
) {
  const label = 'alternatives[' + index + ']';
  const raw = strictRecord(value, ALTERNATIVE_KEYS, label);
  const alternativeId = exactId(raw.alternativeId, label + '.alternativeId');
  const readiness = normalizeProviderReadinessV1(raw.providerReadiness);

  const machineApiCostUsdMicros = exactInteger(
    raw.machineApiCostUsdMicros,
    label + '.machineApiCostUsdMicros',
    0,
    MAX_MONEY_USD_MICROS,
  );
  const runtimeMs = exactInteger(raw.runtimeMs, label + '.runtimeMs', 0, MAX_RUNTIME_MS);
  const ownerReviewSeconds = exactInteger(
    raw.ownerReviewSeconds,
    label + '.ownerReviewSeconds',
    0,
    MAX_OWNER_SECONDS,
  );
  const ownerCoordinationSeconds = exactInteger(
    raw.ownerCoordinationSeconds,
    label + '.ownerCoordinationSeconds',
    0,
    MAX_OWNER_SECONDS,
  );
  const deadlineCostUsdMicros = exactInteger(
    raw.deadlineCostUsdMicros,
    label + '.deadlineCostUsdMicros',
    0,
    MAX_MONEY_USD_MICROS,
  );
  const deadlineFeasible = bool(raw.deadlineFeasible, label + '.deadlineFeasible');
  const deadlineEvidenceId = exactId(raw.deadlineEvidenceId, label + '.deadlineEvidenceId');
  const deadlineAssessedAt = exactTimestamp(raw.deadlineAssessedAt, label + '.deadlineAssessedAt');
  if (Date.parse(deadlineAssessedAt) > Date.parse(asOf)) {
    throw new Error(label + '.deadlineAssessedAt postdates assessment');
  }

  const outcomeEvidence = normalizeOutcomeEvidence(
    raw.outcomeEvidence,
    minimumEvidenceSamples,
    asOf,
  );
  const budget = normalizeResourceBudget(
    raw.resourceBudget,
    machineApiCostUsdMicros,
    runtimeMs,
  );

  const blockers = readinessBlockers(readiness);
  if (budget.decision !== ResourceBudgetDecisionKind.ALLOW) {
    blockers.push('RESOURCE_BUDGET_DENIED');
  }
  if (!deadlineFeasible) blockers.push('DEADLINE_INFEASIBLE');
  if (!outcomeEvidence.evidenceSufficient) blockers.push('OUTCOME_EVIDENCE_INSUFFICIENT');

  const directOwnerAttentionSeconds = safeSum(
    [ownerReviewSeconds, ownerCoordinationSeconds],
    label + ' direct owner attention',
  );
  const expectedReworkOwnerSeconds = outcomeEvidence.expectedReworkOwnerSeconds;
  const expectedOwnerAttentionSeconds = expectedReworkOwnerSeconds == null
    ? null
    : safeSum(
      [directOwnerAttentionSeconds, expectedReworkOwnerSeconds],
      label + ' expected owner attention',
    );
  const ownerAttentionCostUsdMicros = expectedOwnerAttentionSeconds == null
    ? null
    : ownerTimeCostUsdMicros(expectedOwnerAttentionSeconds, ownerMinuteValueUsdMicros);
  const totalEconomicBurdenUsdMicros = ownerAttentionCostUsdMicros == null
    ? null
    : safeSum(
      [machineApiCostUsdMicros, deadlineCostUsdMicros, ownerAttentionCostUsdMicros],
      label + ' total economic burden',
    );

  return deepFreeze({
    schemaVersion: HUMAN_TIME_ECONOMICS_VERSION,
    alternativeId,
    providerId: readiness.providerId,
    toolId: readiness.toolId,
    providerHealth: readiness.health,
    providerPathKind: readiness.pathKind,
    machineApiCostUsdMicros,
    runtimeMs,
    ownerReviewSeconds,
    ownerCoordinationSeconds,
    directOwnerAttentionSeconds,
    deadlineCostUsdMicros,
    deadlineFeasibleClaimed: deadlineFeasible,
    deadlineEvidenceId,
    deadlineAssessedAt,
    outcomeEvidence,
    expectedReworkOwnerSeconds,
    expectedOwnerAttentionSeconds,
    ownerAttentionCostUsdMicros,
    totalEconomicBurdenUsdMicros,
    resourceBudgetDecision: budget.decision,
    resourceBudgetReasonCode: budget.reasonCode,
    blockers: Object.freeze(blockers),
    comparable: blockers.length === 0,
    selectionAuthorized: false,
    routingAuthorized: false,
    executionAuthorized: false,
    budgetAuthorized: false,
  });
}

function readinessRank(health) {
  if (health === ProviderHealthStatus.READY) return 0;
  if (health === ProviderHealthStatus.DEGRADED) return 1;
  return 2;
}

function dominates(left, right) {
  if (!left.comparable || !right.comparable) return false;

  const leftPass = left.outcomeEvidence.empiricalVerifierPassRateBasisPoints;
  const rightPass = right.outcomeEvidence.empiricalVerifierPassRateBasisPoints;
  const dimensions = [
    [left.totalEconomicBurdenUsdMicros, right.totalEconomicBurdenUsdMicros, 'lower'],
    [left.runtimeMs, right.runtimeMs, 'lower'],
    [left.expectedOwnerAttentionSeconds, right.expectedOwnerAttentionSeconds, 'lower'],
    [leftPass, rightPass, 'higher'],
    [readinessRank(left.providerHealth), readinessRank(right.providerHealth), 'lower'],
  ];

  let strict = false;
  for (const [a, b, direction] of dimensions) {
    if (direction === 'lower') {
      if (a > b) return false;
      if (a < b) strict = true;
    } else {
      if (a < b) return false;
      if (a > b) strict = true;
    }
  }
  return strict;
}

export function assessHumanTimeEconomicsV1(input) {
  const raw = strictRecord(input, REQUEST_KEYS, 'HumanTimeEconomicsV1');
  if (raw.schemaVersion !== HUMAN_TIME_ECONOMICS_VERSION) {
    throw new Error('HumanTimeEconomicsV1 schemaVersion must be 1');
  }

  const asOf = exactTimestamp(raw.asOf, 'HumanTimeEconomicsV1.asOf');
  const ownerMinuteValueUsdMicros = exactInteger(
    raw.ownerMinuteValueUsdMicros,
    'HumanTimeEconomicsV1.ownerMinuteValueUsdMicros',
    1,
    MAX_OWNER_MINUTE_VALUE_USD_MICROS,
  );
  const minimumEvidenceSamples = exactInteger(
    raw.minimumEvidenceSamples,
    'HumanTimeEconomicsV1.minimumEvidenceSamples',
    2,
    MAX_SAMPLE_COUNT,
  );

  const alternatives = dataArray(
    raw.alternatives,
    'HumanTimeEconomicsV1.alternatives',
    MAX_ALTERNATIVES,
  ).map((alternative, index) => normalizeAlternative(alternative, index, {
    asOf,
    ownerMinuteValueUsdMicros,
    minimumEvidenceSamples,
  }));

  if (alternatives.length === 0) {
    throw new Error('HumanTimeEconomicsV1.alternatives must not be empty');
  }

  const ids = new Set();
  for (const alternative of alternatives) {
    if (ids.has(alternative.alternativeId)) {
      throw new Error('HumanTimeEconomicsV1 contains duplicate alternativeId');
    }
    ids.add(alternative.alternativeId);
  }

  const sorted = [...alternatives].sort((a, b) =>
    a.alternativeId < b.alternativeId ? -1 : a.alternativeId > b.alternativeId ? 1 : 0);
  const comparable = sorted.filter(item => item.comparable);
  const dominance = [];
  const dominated = new Set();

  for (const left of comparable) {
    for (const right of comparable) {
      if (left.alternativeId === right.alternativeId) continue;
      if (dominates(left, right)) {
        dominance.push(deepFreeze({
          dominantAlternativeId: left.alternativeId,
          dominatedAlternativeId: right.alternativeId,
        }));
        dominated.add(right.alternativeId);
      }
    }
  }

  dominance.sort((a, b) =>
    a.dominantAlternativeId < b.dominantAlternativeId ? -1
      : a.dominantAlternativeId > b.dominantAlternativeId ? 1
        : a.dominatedAlternativeId < b.dominatedAlternativeId ? -1
          : a.dominatedAlternativeId > b.dominatedAlternativeId ? 1 : 0);

  const paretoAlternativeIds = comparable
    .filter(item => !dominated.has(item.alternativeId))
    .map(item => item.alternativeId);

  let status;
  if (comparable.length === 0) {
    status = HumanTimeEconomicsStatus.NO_COMPARABLE_ALTERNATIVES;
  } else if (comparable.length !== sorted.length) {
    status = HumanTimeEconomicsStatus.PARTIAL_EVIDENCE;
  } else {
    status = HumanTimeEconomicsStatus.COMPARABLE;
  }

  return deepFreeze({
    schemaVersion: HUMAN_TIME_ECONOMICS_VERSION,
    assessmentId: exactId(raw.assessmentId, 'HumanTimeEconomicsV1.assessmentId'),
    projectId: exactId(raw.projectId, 'HumanTimeEconomicsV1.projectId'),
    jobId: exactId(raw.jobId, 'HumanTimeEconomicsV1.jobId'),
    asOf,
    ownerMinuteValueUsdMicros,
    minimumEvidenceSamples,
    status,
    alternatives: sorted,
    comparableAlternativeCount: comparable.length,
    paretoAlternativeIds,
    dominance,
    methodology: 'EMPIRICAL_COUNTS_EXACT_MONEY_PARETO',
    probabilityClaimed: false,
    deadlineEvidenceTrusted: false,
    singleWinnerSelected: false,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalBudgetAdmission: true,
    requiresFreshProviderReadiness: true,
    requiresCanonicalDeadlineAssessment: true,
    requiresTrustedOutcomeEvidenceBinding: true,
    selectionAuthorized: false,
    routingAuthorized: false,
    executionAuthorized: false,
    budgetAuthorized: false,
  });
}
