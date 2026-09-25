/**
 * User-facing ROI / Automation Opportunity Engine V1.
 *
 * Pure deterministic projection over records resolved by a canonical trusted
 * run-evidence authority supplied by the integration layer. This module does
 * not own a store, verifier, scheduler, policy engine, provider, budget, Recipe
 * registry, Skill registry, or execution authority.
 */

export const ROI_OPPORTUNITY_ENGINE_VERSION = 1;

export const RoiRunOutcomeStatus = Object.freeze({
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
});

export const RoiAutomationKind = Object.freeze({
  MANUAL: 'MANUAL',
  RECIPE: 'RECIPE',
  SKILL: 'SKILL',
});

export const RoiAutomationQualificationStatus = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNQUALIFIED: 'UNQUALIFIED',
});

export const RoiTimeAvoidedQuality = Object.freeze({
  NONE: 'NONE',
  OBSERVED: 'OBSERVED',
  ESTIMATED: 'ESTIMATED',
});

export const RoiReportStatus = Object.freeze({
  SUFFICIENT_EVIDENCE: 'SUFFICIENT_EVIDENCE',
  PARTIAL_EVIDENCE: 'PARTIAL_EVIDENCE',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_RUNS = 256;
const MAX_IDS = 128;
const MAX_EVENTS_PER_RUN = 10_000;
const MAX_SECONDS_PER_RUN = 31_536_000;
const MAX_RUNTIME_MS = 31_536_000_000;
const MAX_BYTES_PER_RUN = 1_000_000_000_000;
const MAX_MONEY_USD_MICROS_PER_RUN = Number.MAX_SAFE_INTEGER;
const MAX_TOTAL = Number.MAX_SAFE_INTEGER;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'reportId',
  'projectId',
  'evaluatedAt',
  'minimumEvidenceRuns',
  'minimumOpportunityOccurrences',
  'runEvidenceIds',
]);

const TRUSTED_RUN_KEYS = new Set([
  'schemaVersion',
  'recordId',
  'projectId',
  'runId',
  'workflowClassId',
  'sourceRevisionId',
  'startedAt',
  'finishedAt',
  'recordedAt',
  'validThrough',
  'outcomeStatus',
  'verificationRecordId',
  'verificationAuthorityId',
  'evidenceArtifactIds',
  'machineApiCostUsdMicros',
  'runtimeMs',
  'ownerCoordinationSeconds',
  'ownerReviewSeconds',
  'reworkCount',
  'reworkOwnerSeconds',
  'verifierReopenCount',
  'repeatedContextBytesAvoided',
  'automationKind',
  'automationAssetId',
  'automationQualificationRecordId',
  'automationQualificationStatus',
  'timeAvoidedQuality',
  'ownerTimeAvoidedLowerSeconds',
  'ownerTimeAvoidedUpperSeconds',
  'delayCauseIds',
]);

const OUTCOMES = new Set(Object.values(RoiRunOutcomeStatus));
const AUTOMATION_KINDS = new Set(Object.values(RoiAutomationKind));
const QUALIFICATIONS = new Set(Object.values(RoiAutomationQualificationStatus));
const TIME_QUALITIES = new Set(Object.values(RoiTimeAvoidedQuality));

function dataRecord(input, allowedKeys, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(label + ' must be a plain data object');
  }

  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(input);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new Error(label + ' must expose stable data descriptors');
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }

  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
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

function dataArray(input, label, { min = 0, max = MAX_RUNS } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }

  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new Error(label + ' must expose stable data descriptors');
  }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
    || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || Object.is(lengthDescriptor.value, -0)
    || lengthDescriptor.value < min
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

function exactId(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < min
    || value > max) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function enumValue(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function compareCodeUnit(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function idList(input, label, { min = 0, max = MAX_IDS } = {}) {
  const values = dataArray(input, label, { min, max })
    .map((value, index) => exactId(value, label + '[' + index + ']'));
  if (new Set(values).size !== values.length) {
    throw new Error(label + ' contains duplicate identities');
  }
  return Object.freeze(values.sort(compareCodeUnit));
}

function safeSum(values, label) {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  if (total < 0n || total > BigInt(MAX_TOTAL)) {
    throw new Error(label + ' exceeds exact safe-integer range');
  }
  return Number(total);
}

function empiricalBasisPoints(numerator, denominator) {
  if (denominator < 1) return null;
  return Number((BigInt(numerator) * 10_000n) / BigInt(denominator));
}

function normalizeAutomation(raw, label) {
  const automationKind = enumValue(raw.automationKind, AUTOMATION_KINDS, label + '.automationKind');
  const automationAssetId = exactId(raw.automationAssetId, label + '.automationAssetId', { optional: true });
  const automationQualificationRecordId = exactId(
    raw.automationQualificationRecordId,
    label + '.automationQualificationRecordId',
    { optional: true },
  );
  const automationQualificationStatus = enumValue(
    raw.automationQualificationStatus,
    QUALIFICATIONS,
    label + '.automationQualificationStatus',
  );

  if (automationKind === RoiAutomationKind.MANUAL) {
    if (automationAssetId || automationQualificationRecordId
      || automationQualificationStatus !== RoiAutomationQualificationStatus.UNQUALIFIED) {
      throw new Error(label + ' manual run cannot claim automation qualification');
    }
  } else {
    if (!automationAssetId || !automationQualificationRecordId) {
      throw new Error(label + ' automated run requires exact asset and qualification identities');
    }
  }

  return {
    automationKind,
    automationAssetId,
    automationQualificationRecordId,
    automationQualificationStatus,
    verifiedAutomation: automationKind !== RoiAutomationKind.MANUAL
      && automationQualificationStatus === RoiAutomationQualificationStatus.PASS,
  };
}

function normalizeTimeAvoided(raw, label) {
  const quality = enumValue(raw.timeAvoidedQuality, TIME_QUALITIES, label + '.timeAvoidedQuality');
  const lower = integer(
    raw.ownerTimeAvoidedLowerSeconds,
    label + '.ownerTimeAvoidedLowerSeconds',
    0,
    MAX_SECONDS_PER_RUN,
  );
  const upper = integer(
    raw.ownerTimeAvoidedUpperSeconds,
    label + '.ownerTimeAvoidedUpperSeconds',
    0,
    MAX_SECONDS_PER_RUN,
  );
  if (upper < lower) throw new Error(label + ' owner-time avoided range is inverted');

  if (quality === RoiTimeAvoidedQuality.NONE && (lower !== 0 || upper !== 0)) {
    throw new Error(label + ' NONE owner-time evidence must be zero');
  }
  if (quality === RoiTimeAvoidedQuality.OBSERVED && lower !== upper) {
    throw new Error(label + ' OBSERVED owner-time evidence must be exact');
  }
  if (quality !== RoiTimeAvoidedQuality.NONE && upper === 0) {
    throw new Error(label + ' owner-time evidence must be positive when present');
  }

  return { quality, lower, upper };
}

function normalizeTrustedRun(input, expectedRecordId, request) {
  const label = 'TrustedRoiRunEvidenceV1[' + expectedRecordId + ']';
  const raw = dataRecord(input, TRUSTED_RUN_KEYS, label);
  if (raw.schemaVersion !== ROI_OPPORTUNITY_ENGINE_VERSION) {
    throw new Error(label + ' schemaVersion must be 1');
  }

  const recordId = exactId(raw.recordId, label + '.recordId');
  if (recordId !== expectedRecordId) {
    throw new Error(label + ' recordId does not match requested trusted record identity');
  }
  const projectId = exactId(raw.projectId, label + '.projectId');
  if (projectId !== request.projectId) {
    throw new Error(label + ' projectId does not match ROI report project');
  }

  const startedAt = exactTimestamp(raw.startedAt, label + '.startedAt');
  const finishedAt = exactTimestamp(raw.finishedAt, label + '.finishedAt');
  const recordedAt = exactTimestamp(raw.recordedAt, label + '.recordedAt');
  const validThrough = exactTimestamp(raw.validThrough, label + '.validThrough');
  if (finishedAt < startedAt) throw new Error(label + ' finishedAt predates startedAt');
  if (recordedAt < finishedAt) throw new Error(label + ' recordedAt predates finishedAt');
  if (validThrough < recordedAt) throw new Error(label + ' validThrough predates recordedAt');
  if (recordedAt > request.evaluatedAt) throw new Error(label + ' is future-recorded');
  if (validThrough < request.evaluatedAt) throw new Error(label + ' trusted evidence is stale');

  const outcomeStatus = enumValue(raw.outcomeStatus, OUTCOMES, label + '.outcomeStatus');
  const verificationRecordId = exactId(raw.verificationRecordId, label + '.verificationRecordId');
  const verificationAuthorityId = exactId(raw.verificationAuthorityId, label + '.verificationAuthorityId');
  const evidenceArtifactIds = idList(raw.evidenceArtifactIds, label + '.evidenceArtifactIds', { min: 1 });
  const delayCauseIds = idList(raw.delayCauseIds, label + '.delayCauseIds', { max: 32 });
  const automation = normalizeAutomation(raw, label);
  const timeAvoided = normalizeTimeAvoided(raw, label);

  const ownerCoordinationSeconds = integer(
    raw.ownerCoordinationSeconds,
    label + '.ownerCoordinationSeconds',
    0,
    MAX_SECONDS_PER_RUN,
  );
  const ownerReviewSeconds = integer(
    raw.ownerReviewSeconds,
    label + '.ownerReviewSeconds',
    0,
    MAX_SECONDS_PER_RUN,
  );
  const reworkCount = integer(raw.reworkCount, label + '.reworkCount', 0, MAX_EVENTS_PER_RUN);
  const reworkOwnerSeconds = integer(
    raw.reworkOwnerSeconds,
    label + '.reworkOwnerSeconds',
    0,
    MAX_SECONDS_PER_RUN,
  );
  if (reworkCount === 0 && reworkOwnerSeconds !== 0) {
    throw new Error(label + ' rework owner time requires rework observations');
  }
  if (reworkCount > 0 && reworkOwnerSeconds === 0) {
    throw new Error(label + ' rework observations require measured owner time');
  }

  const verifierReopenCount = integer(
    raw.verifierReopenCount,
    label + '.verifierReopenCount',
    0,
    MAX_EVENTS_PER_RUN,
  );
  const machineApiCostUsdMicros = integer(
    raw.machineApiCostUsdMicros,
    label + '.machineApiCostUsdMicros',
    0,
    MAX_MONEY_USD_MICROS_PER_RUN,
  );
  const runtimeMs = integer(raw.runtimeMs, label + '.runtimeMs', 0, MAX_RUNTIME_MS);
  const repeatedContextBytesAvoided = integer(
    raw.repeatedContextBytesAvoided,
    label + '.repeatedContextBytesAvoided',
    0,
    MAX_BYTES_PER_RUN,
  );

  const directOwnerAttentionSeconds = safeSum(
    [ownerCoordinationSeconds, ownerReviewSeconds],
    label + ' direct owner attention',
  );
  const totalObservedOwnerAttentionSeconds = safeSum(
    [directOwnerAttentionSeconds, reworkOwnerSeconds],
    label + ' total observed owner attention',
  );

  return deepFreeze({
    schemaVersion: ROI_OPPORTUNITY_ENGINE_VERSION,
    recordId,
    projectId,
    runId: exactId(raw.runId, label + '.runId'),
    workflowClassId: exactId(raw.workflowClassId, label + '.workflowClassId'),
    sourceRevisionId: exactId(raw.sourceRevisionId, label + '.sourceRevisionId'),
    startedAt,
    finishedAt,
    recordedAt,
    validThrough,
    outcomeStatus,
    verificationRecordId,
    verificationAuthorityId,
    evidenceArtifactIds,
    machineApiCostUsdMicros,
    runtimeMs,
    ownerCoordinationSeconds,
    ownerReviewSeconds,
    directOwnerAttentionSeconds,
    reworkCount,
    reworkOwnerSeconds,
    totalObservedOwnerAttentionSeconds,
    verifierReopenCount,
    repeatedContextBytesAvoided,
    automationKind: automation.automationKind,
    automationAssetId: automation.automationAssetId,
    automationQualificationRecordId: automation.automationQualificationRecordId,
    automationQualificationStatus: automation.automationQualificationStatus,
    verifiedAutomation: automation.verifiedAutomation,
    timeAvoidedQuality: timeAvoided.quality,
    ownerTimeAvoidedLowerSeconds: timeAvoided.lower,
    ownerTimeAvoidedUpperSeconds: timeAvoided.upper,
    delayCauseIds,
  });
}

function summarizeWorkflow(workflowClassId, runs, request) {
  const ordered = [...runs].sort((a, b) => compareCodeUnit(a.runId, b.runId));
  const manual = ordered.filter(run => run.automationKind === RoiAutomationKind.MANUAL);
  const verifiedManual = manual.filter(run => run.outcomeStatus === RoiRunOutcomeStatus.VERIFIED);
  const verifiedAutomation = ordered.filter(run => run.verifiedAutomation);
  const ownerAttentionSeconds = safeSum(
    ordered.map(run => run.totalObservedOwnerAttentionSeconds),
    workflowClassId + ' owner attention',
  );
  const manualOwnerAttentionSeconds = safeSum(
    manual.map(run => run.totalObservedOwnerAttentionSeconds),
    workflowClassId + ' manual owner attention',
  );

  const repeated = ordered.length >= request.minimumOpportunityOccurrences;
  const candidateEligible = repeated
    && manual.length >= request.minimumOpportunityOccurrences
    && verifiedManual.length >= request.minimumEvidenceRuns
    && verifiedAutomation.length === 0
    && manualOwnerAttentionSeconds > 0;

  return deepFreeze({
    workflowClassId,
    occurrenceCount: ordered.length,
    verifiedOutcomeCount: ordered.filter(run => run.outcomeStatus === RoiRunOutcomeStatus.VERIFIED).length,
    manualOccurrenceCount: manual.length,
    verifiedManualOccurrenceCount: verifiedManual.length,
    verifiedAutomationOccurrenceCount: verifiedAutomation.length,
    ownerAttentionSeconds,
    manualOwnerAttentionSeconds,
    repeated,
    opportunityEligible: candidateEligible,
    supportingRunIds: ordered.map(run => run.runId),
    manualSupportingRunIds: manual.map(run => run.runId),
  });
}

function buildDelayCauses(runs) {
  const byCause = new Map();
  for (const run of runs) {
    for (const causeId of run.delayCauseIds) {
      const current = byCause.get(causeId) ?? { causeId, occurrenceCount: 0, runIds: [] };
      current.occurrenceCount += 1;
      current.runIds.push(run.runId);
      byCause.set(causeId, current);
    }
  }
  return [...byCause.values()]
    .map(item => deepFreeze({
      causeId: item.causeId,
      occurrenceCount: item.occurrenceCount,
      runIds: Object.freeze(item.runIds.sort(compareCodeUnit)),
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount || compareCodeUnit(a.causeId, b.causeId));
}

function buildOpportunityCandidates(workflows) {
  return workflows
    .filter(item => item.opportunityEligible)
    .map(item => deepFreeze({
      workflowClassId: item.workflowClassId,
      opportunityKind: 'CONSIDER_RECIPE_OR_SKILL',
      reasonCode: 'REPEATED_VERIFIED_MANUAL_WORKFLOW',
      occurrenceCount: item.occurrenceCount,
      manualOccurrenceCount: item.manualOccurrenceCount,
      verifiedManualOccurrenceCount: item.verifiedManualOccurrenceCount,
      observedManualOwnerAttentionSeconds: item.manualOwnerAttentionSeconds,
      supportingRunIds: item.manualSupportingRunIds,
      recommendationAuthorized: false,
      automationAuthorized: false,
      requiresOwnerPolicyAndCanonicalRecipeSkillQualification: true,
    }))
    .sort((a, b) => b.observedManualOwnerAttentionSeconds - a.observedManualOwnerAttentionSeconds
      || b.manualOccurrenceCount - a.manualOccurrenceCount
      || compareCodeUnit(a.workflowClassId, b.workflowClassId));
}

export async function buildRoiOpportunityReportV1(
  input = {},
  { resolveTrustedRunEvidence } = {},
) {
  if (typeof resolveTrustedRunEvidence !== 'function') {
    throw new Error('Canonical trusted run-evidence resolver is required');
  }

  const raw = dataRecord(input, REQUEST_KEYS, 'RoiOpportunityReportRequestV1');
  if (raw.schemaVersion !== ROI_OPPORTUNITY_ENGINE_VERSION) {
    throw new Error('RoiOpportunityReportRequestV1 schemaVersion must be 1');
  }

  const request = deepFreeze({
    schemaVersion: ROI_OPPORTUNITY_ENGINE_VERSION,
    reportId: exactId(raw.reportId, 'RoiOpportunityReportRequestV1.reportId'),
    projectId: exactId(raw.projectId, 'RoiOpportunityReportRequestV1.projectId'),
    evaluatedAt: exactTimestamp(raw.evaluatedAt, 'RoiOpportunityReportRequestV1.evaluatedAt'),
    minimumEvidenceRuns: integer(
      raw.minimumEvidenceRuns,
      'RoiOpportunityReportRequestV1.minimumEvidenceRuns',
      2,
      MAX_RUNS,
    ),
    minimumOpportunityOccurrences: integer(
      raw.minimumOpportunityOccurrences,
      'RoiOpportunityReportRequestV1.minimumOpportunityOccurrences',
      2,
      MAX_RUNS,
    ),
    runEvidenceIds: idList(raw.runEvidenceIds, 'RoiOpportunityReportRequestV1.runEvidenceIds', {
      min: 1,
      max: MAX_RUNS,
    }),
  });

  const runs = [];
  for (const recordId of request.runEvidenceIds) {
    const resolved = await resolveTrustedRunEvidence(recordId);
    if (!resolved) {
      throw new Error('Trusted ROI run evidence not found: ' + recordId);
    }
    runs.push(normalizeTrustedRun(resolved, recordId, request));
  }

  const runIds = new Set();
  for (const run of runs) {
    if (runIds.has(run.runId)) {
      throw new Error('Trusted ROI history contains duplicate runId: ' + run.runId);
    }
    runIds.add(run.runId);
  }
  runs.sort((a, b) => compareCodeUnit(a.runId, b.runId));

  const byWorkflow = new Map();
  for (const run of runs) {
    const bucket = byWorkflow.get(run.workflowClassId) ?? [];
    bucket.push(run);
    byWorkflow.set(run.workflowClassId, bucket);
  }
  const workflows = [...byWorkflow.entries()]
    .map(([workflowClassId, workflowRuns]) => summarizeWorkflow(workflowClassId, workflowRuns, request))
    .sort((a, b) => compareCodeUnit(a.workflowClassId, b.workflowClassId));

  const repeatedWorkflowIds = new Set(
    workflows.filter(item => item.repeated).map(item => item.workflowClassId),
  );
  const repeatedRuns = runs.filter(run => repeatedWorkflowIds.has(run.workflowClassId));
  const verifiedAutomationRepeatedRuns = repeatedRuns.filter(run => run.verifiedAutomation);

  const observedTimeRuns = runs.filter(run => run.timeAvoidedQuality === RoiTimeAvoidedQuality.OBSERVED);
  const estimatedTimeRuns = runs.filter(run => run.timeAvoidedQuality === RoiTimeAvoidedQuality.ESTIMATED);
  const observedOwnerTimeAvoidedSeconds = safeSum(
    observedTimeRuns.map(run => run.ownerTimeAvoidedLowerSeconds),
    'observed owner time avoided',
  );
  const estimatedOwnerTimeAvoidedLowerSeconds = safeSum(
    estimatedTimeRuns.map(run => run.ownerTimeAvoidedLowerSeconds),
    'estimated owner time avoided lower bound',
  );
  const estimatedOwnerTimeAvoidedUpperSeconds = safeSum(
    estimatedTimeRuns.map(run => run.ownerTimeAvoidedUpperSeconds),
    'estimated owner time avoided upper bound',
  );
  const boundedOwnerTimeAvoidedLowerSeconds = safeSum(
    [observedOwnerTimeAvoidedSeconds, estimatedOwnerTimeAvoidedLowerSeconds],
    'bounded owner time avoided lower bound',
  );
  const boundedOwnerTimeAvoidedUpperSeconds = safeSum(
    [observedOwnerTimeAvoidedSeconds, estimatedOwnerTimeAvoidedUpperSeconds],
    'bounded owner time avoided upper bound',
  );

  const verifiedOutcomesCompleted = runs
    .filter(run => run.outcomeStatus === RoiRunOutcomeStatus.VERIFIED).length;
  const runWithReopenCount = runs.filter(run => run.verifierReopenCount > 0).length;
  const runWithReworkCount = runs.filter(run => run.reworkCount > 0).length;
  const totalReworkEvents = safeSum(runs.map(run => run.reworkCount), 'total rework events');
  const totalVerifierReopenEvents = safeSum(
    runs.map(run => run.verifierReopenCount),
    'total verifier reopen events',
  );

  const opportunityCandidates = buildOpportunityCandidates(workflows);
  const delayCauses = buildDelayCauses(runs);
  const manualRecurringWorkflows = workflows
    .filter(item => item.repeated && item.manualOccurrenceCount >= request.minimumOpportunityOccurrences)
    .sort((a, b) => b.manualOccurrenceCount - a.manualOccurrenceCount
      || b.manualOwnerAttentionSeconds - a.manualOwnerAttentionSeconds
      || compareCodeUnit(a.workflowClassId, b.workflowClassId));

  let status = RoiReportStatus.SUFFICIENT_EVIDENCE;
  if (runs.length < request.minimumEvidenceRuns) {
    status = RoiReportStatus.INSUFFICIENT_EVIDENCE;
  } else if (runs.some(run => run.timeAvoidedQuality === RoiTimeAvoidedQuality.NONE)) {
    status = RoiReportStatus.PARTIAL_EVIDENCE;
  }

  return deepFreeze({
    schemaVersion: ROI_OPPORTUNITY_ENGINE_VERSION,
    reportId: request.reportId,
    projectId: request.projectId,
    evaluatedAt: request.evaluatedAt,
    status,
    evidence: {
      trustedRecordIds: runs.map(run => run.recordId),
      runIds: runs.map(run => run.runId),
      verificationRecordIds: runs.map(run => run.verificationRecordId).sort(compareCodeUnit),
      evidenceArtifactIds: [...new Set(runs.flatMap(run => run.evidenceArtifactIds))].sort(compareCodeUnit),
    },
    outcomes: {
      totalRunCount: runs.length,
      verifiedOutcomesCompleted,
      failedRunCount: runs.filter(run => run.outcomeStatus === RoiRunOutcomeStatus.FAILED).length,
      blockedRunCount: runs.filter(run => run.outcomeStatus === RoiRunOutcomeStatus.BLOCKED).length,
    },
    ownerTime: {
      observedOwnerTimeAvoidedSeconds,
      estimatedOwnerTimeAvoidedLowerSeconds,
      estimatedOwnerTimeAvoidedUpperSeconds,
      boundedOwnerTimeAvoidedLowerSeconds,
      boundedOwnerTimeAvoidedUpperSeconds,
      hasEstimatedTimeAvoided: estimatedTimeRuns.length > 0,
      precisePointEstimateAuthorized: estimatedTimeRuns.length === 0,
      totalObservedOwnerAttentionSeconds: safeSum(
        runs.map(run => run.totalObservedOwnerAttentionSeconds),
        'total observed owner attention',
      ),
    },
    context: {
      repeatedContextBytesAvoided: safeSum(
        runs.map(run => run.repeatedContextBytesAvoided),
        'repeated context bytes avoided',
      ),
    },
    automationCoverage: {
      repeatedWorkflowClassCount: repeatedWorkflowIds.size,
      repeatedWorkflowRunCount: repeatedRuns.length,
      verifiedRecipeOrSkillRunCount: verifiedAutomationRepeatedRuns.length,
      verifiedRecipeOrSkillCoverageBasisPoints: empiricalBasisPoints(
        verifiedAutomationRepeatedRuns.length,
        repeatedRuns.length,
      ),
      empiricalRateOnly: true,
    },
    spend: {
      machineApiSpendUsdMicros: safeSum(
        runs.map(run => run.machineApiCostUsdMicros),
        'machine/API spend',
      ),
      runtimeMs: safeSum(runs.map(run => run.runtimeMs), 'runtime'),
    },
    quality: {
      totalReworkEvents,
      runWithReworkCount,
      empiricalReworkRunRateBasisPoints: empiricalBasisPoints(runWithReworkCount, runs.length),
      totalVerifierReopenEvents,
      runWithVerifierReopenCount: runWithReopenCount,
      empiricalVerifierReopenRunRateBasisPoints: empiricalBasisPoints(runWithReopenCount, runs.length),
      empiricalRatesAreProbabilities: false,
    },
    topDelayCauses: delayCauses,
    recurringManualWorkflows: manualRecurringWorkflows,
    automationOpportunities: status === RoiReportStatus.INSUFFICIENT_EVIDENCE
      ? Object.freeze([])
      : opportunityCandidates,
    recommendationAuthorized: false,
    automationAuthorized: false,
    budgetAuthorized: false,
    executionAuthorized: false,
    evidenceAuthorityMinted: false,
    requiresCanonicalEvidenceResolution: true,
    requiresOwnerPolicyAndQualificationBeforeAutomation: true,
  });
}
