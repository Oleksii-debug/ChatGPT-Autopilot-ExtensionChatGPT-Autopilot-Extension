export const OUTCOME_CONTRACT_VERSION = 1;

export const OutcomeCriterionStatus = Object.freeze({
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  PARTIAL: 'PARTIAL',
  AMBIGUOUS: 'AMBIGUOUS',
});

export const OutcomeEvidenceStatus = Object.freeze({
  EVIDENCE_READY: 'EVIDENCE_READY',
  INCOMPLETE: 'INCOMPLETE',
});

const CRITERION_STATUSES = new Set(Object.values(OutcomeCriterionStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_TEXT = 16_000;
const MAX_ITEMS = 128;
const MAX_CONCURRENCY = 128;
const MAX_RUNTIME_SECONDS = 31_536_000;
const MAX_MODEL_CALLS = 1_000_000;

const CONTRACT_KEYS = new Set([
  'schemaVersion',
  'contractId',
  'projectId',
  'desiredResult',
  'completionCriteria',
  'constraints',
  'sourceTruth',
  'allowedAuthority',
  'budgetBoundaries',
  'deliverables',
  'verifierPlan',
  'triggerRefs',
  'createdAt',
  'revision',
  'advisoryOnly',
  'ownerAccepted',
  'executionAuthorized',
]);

const CRITERION_KEYS = new Set([
  'criterionId',
  'description',
  'observable',
  'requiredEvidenceKinds',
]);

const SOURCE_KEYS = new Set([
  'sourceId',
  'location',
  'revisionId',
  'purpose',
]);

const AUTHORITY_KEYS = new Set([
  'authorityId',
  'scopeId',
  'purpose',
  'authorityEffect',
]);

const BUDGET_KEYS = new Set([
  'maxModelCalls',
  'maxRuntimeSeconds',
  'maxCostUsdMicros',
  'maxConcurrency',
  'enforcementAuthority',
]);

const DELIVERABLE_KEYS = new Set([
  'deliverableId',
  'kind',
  'description',
  'criterionIds',
]);

const VERIFIER_PLAN_KEYS = new Set([
  'planId',
  'actorId',
  'verifierId',
  'criterionIds',
  'requiredEvidenceArtifactCount',
  'independent',
  'verificationAuthority',
]);

const TRIGGER_KEYS = new Set([
  'triggerId',
  'kind',
  'schedulingAuthority',
]);

const ASSESSMENT_KEYS = new Set([
  'criterionId',
  'status',
  'evidenceArtifactIds',
  'assessedBy',
  'assessedAt',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.size) throw new Error(`${label} contains unknown fields`);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
  }
}

function own(value, key, label, { optional = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (optional) return undefined;
    throw new Error(`${label} must provide ${key} as an own field`);
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} field ${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function id(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be an exact id`);
  }
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an exact integer in ${min}..${max}`);
  }
  return value;
}

function denseArray(value, label, max = MAX_ITEMS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index array property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data array`);
    }
  }
  return value;
}

function compareCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values;
}

function idList(value, label, { min = 0, max = MAX_ITEMS } = {}) {
  const raw = denseArray(value, label, max);
  if (raw.length < min) throw new Error(`${label} must contain at least ${min} item(s)`);
  const out = raw.map((item, index) => id(item, `${label}[${index}]`));
  unique(out, label);
  return out.sort(compareCodeUnit);
}

function textList(value, label, { min = 0, max = MAX_ITEMS, itemMax = 4_000 } = {}) {
  const raw = denseArray(value, label, max);
  if (raw.length < min) throw new Error(`${label} must contain at least ${min} item(s)`);
  const out = raw.map((item, index) => text(item, `${label}[${index}]`, { max: itemMax }));
  unique(out, label);
  return out.sort(compareCodeUnit);
}

function objectList(value, label, normalize, { min = 0, max = MAX_ITEMS } = {}) {
  const raw = denseArray(value, label, max);
  if (raw.length < min) throw new Error(`${label} must contain at least ${min} item(s)`);
  return raw.map((item, index) => {
    try {
      return normalize(item);
    } catch (error) {
      throw new Error(`${label}[${index}]: ${error.message}`);
    }
  });
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeCriterion(input) {
  const raw = record(input, 'OutcomeCriterionV1');
  exactKeys(raw, CRITERION_KEYS, 'OutcomeCriterionV1');
  return {
    criterionId: id(own(raw, 'criterionId', 'OutcomeCriterionV1'), 'criterionId'),
    description: text(own(raw, 'description', 'OutcomeCriterionV1'), 'criterion description', { max: 8_000 }),
    observable: text(own(raw, 'observable', 'OutcomeCriterionV1'), 'criterion observable', { max: 8_000 }),
    requiredEvidenceKinds: idList(
      own(raw, 'requiredEvidenceKinds', 'OutcomeCriterionV1'),
      'requiredEvidenceKinds',
      { min: 1, max: 32 },
    ),
  };
}

function normalizeSource(input) {
  const raw = record(input, 'OutcomeSourceTruthV1');
  exactKeys(raw, SOURCE_KEYS, 'OutcomeSourceTruthV1');
  return {
    sourceId: id(own(raw, 'sourceId', 'OutcomeSourceTruthV1'), 'sourceId'),
    location: text(own(raw, 'location', 'OutcomeSourceTruthV1'), 'source location', { max: 8_000 }),
    revisionId: id(own(raw, 'revisionId', 'OutcomeSourceTruthV1'), 'revisionId'),
    purpose: text(own(raw, 'purpose', 'OutcomeSourceTruthV1'), 'source purpose', { max: 4_000 }),
  };
}

function normalizeAuthority(input) {
  const raw = record(input, 'OutcomeAuthorityRequirementV1');
  exactKeys(raw, AUTHORITY_KEYS, 'OutcomeAuthorityRequirementV1');
  const authorityEffect = own(raw, 'authorityEffect', 'OutcomeAuthorityRequirementV1', { optional: true });
  if (authorityEffect != null && authorityEffect !== 'REQUIREMENT_ONLY') {
    throw new Error('Outcome authority requirement cannot grant authority');
  }
  return {
    authorityId: id(own(raw, 'authorityId', 'OutcomeAuthorityRequirementV1'), 'authorityId'),
    scopeId: id(own(raw, 'scopeId', 'OutcomeAuthorityRequirementV1'), 'scopeId'),
    purpose: text(own(raw, 'purpose', 'OutcomeAuthorityRequirementV1'), 'authority purpose', { max: 4_000 }),
    authorityEffect: 'REQUIREMENT_ONLY',
  };
}

function normalizeBudget(input) {
  const raw = record(input, 'OutcomeBudgetBoundariesV1');
  exactKeys(raw, BUDGET_KEYS, 'OutcomeBudgetBoundariesV1');
  const enforcementAuthority = own(raw, 'enforcementAuthority', 'OutcomeBudgetBoundariesV1', { optional: true });
  if (enforcementAuthority != null && enforcementAuthority !== 'NONE') {
    throw new Error('Outcome budget boundaries cannot become enforcement authority');
  }
  return {
    maxModelCalls: integer(own(raw, 'maxModelCalls', 'OutcomeBudgetBoundariesV1'), 'maxModelCalls', 0, MAX_MODEL_CALLS),
    maxRuntimeSeconds: integer(
      own(raw, 'maxRuntimeSeconds', 'OutcomeBudgetBoundariesV1'),
      'maxRuntimeSeconds',
      1,
      MAX_RUNTIME_SECONDS,
    ),
    maxCostUsdMicros: integer(
      own(raw, 'maxCostUsdMicros', 'OutcomeBudgetBoundariesV1'),
      'maxCostUsdMicros',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    maxConcurrency: integer(
      own(raw, 'maxConcurrency', 'OutcomeBudgetBoundariesV1'),
      'maxConcurrency',
      1,
      MAX_CONCURRENCY,
    ),
    enforcementAuthority: 'NONE',
  };
}

function normalizeDeliverable(input) {
  const raw = record(input, 'OutcomeDeliverableV1');
  exactKeys(raw, DELIVERABLE_KEYS, 'OutcomeDeliverableV1');
  return {
    deliverableId: id(own(raw, 'deliverableId', 'OutcomeDeliverableV1'), 'deliverableId'),
    kind: id(own(raw, 'kind', 'OutcomeDeliverableV1'), 'deliverable kind'),
    description: text(own(raw, 'description', 'OutcomeDeliverableV1'), 'deliverable description', { max: 8_000 }),
    criterionIds: idList(own(raw, 'criterionIds', 'OutcomeDeliverableV1'), 'deliverable criterionIds', { min: 1 }),
  };
}

function normalizeVerifierPlan(input) {
  const raw = record(input, 'OutcomeVerifierPlanV1');
  exactKeys(raw, VERIFIER_PLAN_KEYS, 'OutcomeVerifierPlanV1');
  const actorId = id(own(raw, 'actorId', 'OutcomeVerifierPlanV1'), 'actorId');
  const verifierId = id(own(raw, 'verifierId', 'OutcomeVerifierPlanV1'), 'verifierId');
  if (actorId === verifierId) throw new Error('Outcome verifier must be independent from actor');
  const independent = own(raw, 'independent', 'OutcomeVerifierPlanV1');
  if (independent !== true) throw new Error('Outcome verifier plan must explicitly require independence');
  const verificationAuthority = own(raw, 'verificationAuthority', 'OutcomeVerifierPlanV1', { optional: true });
  if (verificationAuthority != null && verificationAuthority !== 'EXTERNAL_REQUIRED') {
    throw new Error('Outcome verifier plan cannot mint verifier authority');
  }
  return {
    planId: id(own(raw, 'planId', 'OutcomeVerifierPlanV1'), 'verifier planId'),
    actorId,
    verifierId,
    criterionIds: idList(own(raw, 'criterionIds', 'OutcomeVerifierPlanV1'), 'verifier criterionIds', { min: 1 }),
    requiredEvidenceArtifactCount: integer(
      own(raw, 'requiredEvidenceArtifactCount', 'OutcomeVerifierPlanV1'),
      'requiredEvidenceArtifactCount',
      1,
      MAX_ITEMS,
    ),
    independent: true,
    verificationAuthority: 'EXTERNAL_REQUIRED',
  };
}

function normalizeTrigger(input) {
  const raw = record(input, 'OutcomeTriggerRefV1');
  exactKeys(raw, TRIGGER_KEYS, 'OutcomeTriggerRefV1');
  const schedulingAuthority = own(raw, 'schedulingAuthority', 'OutcomeTriggerRefV1', { optional: true });
  if (schedulingAuthority != null && schedulingAuthority !== 'REFERENCE_ONLY') {
    throw new Error('Outcome trigger reference cannot grant scheduling authority');
  }
  return {
    triggerId: id(own(raw, 'triggerId', 'OutcomeTriggerRefV1'), 'triggerId'),
    kind: id(own(raw, 'kind', 'OutcomeTriggerRefV1'), 'trigger kind'),
    schedulingAuthority: 'REFERENCE_ONLY',
  };
}

function assertUniqueBy(items, key, label) {
  unique(items.map(item => item[key]), label);
}

function assertExactSet(actual, expected, label) {
  const left = [...actual].sort(compareCodeUnit);
  const right = [...expected].sort(compareCodeUnit);
  if (left.length !== right.length || left.some((item, index) => item !== right[index])) {
    throw new Error(`${label} must exactly cover all completion criteria`);
  }
}

function assertCrossReferences(contract) {
  const criterionIds = contract.completionCriteria.map(item => item.criterionId);
  const criterionSet = new Set(criterionIds);

  for (const deliverable of contract.deliverables) {
    for (const criterionId of deliverable.criterionIds) {
      if (!criterionSet.has(criterionId)) {
        throw new Error(`Deliverable ${deliverable.deliverableId} references unknown criterionId: ${criterionId}`);
      }
    }
  }

  assertExactSet(contract.verifierPlan.criterionIds, criterionIds, 'verifierPlan.criterionIds');

  const coveredByDeliverables = new Set(contract.deliverables.flatMap(item => item.criterionIds));
  for (const criterionId of criterionIds) {
    if (!coveredByDeliverables.has(criterionId)) {
      throw new Error(`Completion criterion lacks a required deliverable binding: ${criterionId}`);
    }
  }
}

export function normalizeOutcomeContractV1(input) {
  const raw = record(input, 'OutcomeContractV1');
  exactKeys(raw, CONTRACT_KEYS, 'OutcomeContractV1');
  if (own(raw, 'schemaVersion', 'OutcomeContractV1') !== OUTCOME_CONTRACT_VERSION) {
    throw new Error('Unsupported OutcomeContractV1 schemaVersion');
  }

  const completionCriteria = objectList(
    own(raw, 'completionCriteria', 'OutcomeContractV1'),
    'completionCriteria',
    normalizeCriterion,
    { min: 1 },
  ).sort((a, b) => compareCodeUnit(a.criterionId, b.criterionId));
  assertUniqueBy(completionCriteria, 'criterionId', 'completionCriteria criterionId');

  const sourceTruth = objectList(
    own(raw, 'sourceTruth', 'OutcomeContractV1'),
    'sourceTruth',
    normalizeSource,
    { min: 1 },
  ).sort((a, b) => compareCodeUnit(a.sourceId, b.sourceId));
  assertUniqueBy(sourceTruth, 'sourceId', 'sourceTruth sourceId');

  const allowedAuthority = objectList(
    own(raw, 'allowedAuthority', 'OutcomeContractV1'),
    'allowedAuthority',
    normalizeAuthority,
    { min: 0 },
  ).sort((a, b) => compareCodeUnit(a.authorityId, b.authorityId) || compareCodeUnit(a.scopeId, b.scopeId));
  assertUniqueBy(
    allowedAuthority.map(item => ({ key: `${item.authorityId}\u0000${item.scopeId}` })),
    'key',
    'allowedAuthority authority/scope',
  );

  const deliverables = objectList(
    own(raw, 'deliverables', 'OutcomeContractV1'),
    'deliverables',
    normalizeDeliverable,
    { min: 1 },
  ).sort((a, b) => compareCodeUnit(a.deliverableId, b.deliverableId));
  assertUniqueBy(deliverables, 'deliverableId', 'deliverables deliverableId');

  const triggerRefs = objectList(
    own(raw, 'triggerRefs', 'OutcomeContractV1'),
    'triggerRefs',
    normalizeTrigger,
    { min: 0 },
  ).sort((a, b) => compareCodeUnit(a.triggerId, b.triggerId));
  assertUniqueBy(triggerRefs, 'triggerId', 'triggerRefs triggerId');

  const revision = integer(own(raw, 'revision', 'OutcomeContractV1'), 'revision', 1, Number.MAX_SAFE_INTEGER);
  const state = {
    schemaVersion: OUTCOME_CONTRACT_VERSION,
    contractId: id(own(raw, 'contractId', 'OutcomeContractV1'), 'contractId'),
    projectId: id(own(raw, 'projectId', 'OutcomeContractV1', { optional: true }), 'projectId', { optional: true }),
    desiredResult: text(own(raw, 'desiredResult', 'OutcomeContractV1'), 'desiredResult', { max: 50_000 }),
    completionCriteria,
    constraints: textList(own(raw, 'constraints', 'OutcomeContractV1'), 'constraints', { min: 0, itemMax: 8_000 }),
    sourceTruth,
    allowedAuthority,
    budgetBoundaries: normalizeBudget(own(raw, 'budgetBoundaries', 'OutcomeContractV1')),
    deliverables,
    verifierPlan: normalizeVerifierPlan(own(raw, 'verifierPlan', 'OutcomeContractV1')),
    triggerRefs,
    createdAt: timestamp(own(raw, 'createdAt', 'OutcomeContractV1'), 'createdAt'),
    revision,
    advisoryOnly: true,
    ownerAccepted: false,
    executionAuthorized: false,
  };

  if (Object.hasOwn(raw, 'advisoryOnly') && own(raw, 'advisoryOnly', 'OutcomeContractV1') !== true) {
    throw new Error('OutcomeContractV1 advisoryOnly must remain true');
  }
  if (Object.hasOwn(raw, 'ownerAccepted') && own(raw, 'ownerAccepted', 'OutcomeContractV1') !== false) {
    throw new Error('OutcomeContractV1 cannot authenticate owner acceptance');
  }
  if (Object.hasOwn(raw, 'executionAuthorized') && own(raw, 'executionAuthorized', 'OutcomeContractV1') !== false) {
    throw new Error('OutcomeContractV1 cannot grant execution authority');
  }

  assertCrossReferences(state);
  return freezeDeep(state);
}

export function createOutcomeContractV1(input) {
  const raw = record(input, 'OutcomeContractBuildV1');
  const allowed = new Set([...CONTRACT_KEYS].filter(key => ![
    'schemaVersion',
    'revision',
    'advisoryOnly',
    'ownerAccepted',
    'executionAuthorized',
  ].includes(key)));
  exactKeys(raw, allowed, 'OutcomeContractBuildV1');
  return normalizeOutcomeContractV1({
    schemaVersion: OUTCOME_CONTRACT_VERSION,
    ...raw,
    revision: 1,
    advisoryOnly: true,
    ownerAccepted: false,
    executionAuthorized: false,
  });
}

function normalizeAssessment(input) {
  const raw = record(input, 'OutcomeCriterionAssessmentV1');
  exactKeys(raw, ASSESSMENT_KEYS, 'OutcomeCriterionAssessmentV1');
  const status = own(raw, 'status', 'OutcomeCriterionAssessmentV1');
  if (typeof status !== 'string' || !CRITERION_STATUSES.has(status)) {
    throw new Error('Outcome criterion assessment status is invalid');
  }
  return {
    criterionId: id(own(raw, 'criterionId', 'OutcomeCriterionAssessmentV1'), 'criterionId'),
    status,
    evidenceArtifactIds: idList(
      own(raw, 'evidenceArtifactIds', 'OutcomeCriterionAssessmentV1'),
      'assessment evidenceArtifactIds',
      { min: status === OutcomeCriterionStatus.VERIFIED ? 1 : 0 },
    ),
    assessedBy: id(own(raw, 'assessedBy', 'OutcomeCriterionAssessmentV1'), 'assessedBy'),
    assessedAt: timestamp(own(raw, 'assessedAt', 'OutcomeCriterionAssessmentV1'), 'assessedAt'),
  };
}

export function projectOutcomeEvidenceV1({ contract, assessments } = {}) {
  const normalized = normalizeOutcomeContractV1(contract);
  const rows = objectList(
    assessments,
    'assessments',
    normalizeAssessment,
    { min: 1 },
  ).sort((a, b) => compareCodeUnit(a.criterionId, b.criterionId));

  assertUniqueBy(rows, 'criterionId', 'assessments criterionId');
  assertExactSet(
    rows.map(item => item.criterionId),
    normalized.completionCriteria.map(item => item.criterionId),
    'assessments',
  );

  for (const row of rows) {
    if (row.assessedBy !== normalized.verifierPlan.verifierId) {
      throw new Error(`Assessment ${row.criterionId} is not attributed to the declared verifier`);
    }
    if (row.status === OutcomeCriterionStatus.VERIFIED
        && row.evidenceArtifactIds.length < normalized.verifierPlan.requiredEvidenceArtifactCount) {
      throw new Error(`Assessment ${row.criterionId} lacks required evidence artifacts`);
    }
  }

  const verifiedCount = rows.filter(item => item.status === OutcomeCriterionStatus.VERIFIED).length;
  const evidenceReady = verifiedCount === rows.length;

  return freezeDeep({
    schemaVersion: OUTCOME_CONTRACT_VERSION,
    contractId: normalized.contractId,
    contractRevision: normalized.revision,
    status: evidenceReady ? OutcomeEvidenceStatus.EVIDENCE_READY : OutcomeEvidenceStatus.INCOMPLETE,
    verifiedCriteria: verifiedCount,
    totalCriteria: rows.length,
    assessments: rows,
    verificationProvenance: 'UNVERIFIED_INPUT',
    completionAuthorized: false,
    executionAuthorized: false,
  });
}
