/**
 * VariantLabV1 is a deterministic comparison contract. It does not create Git
 * branches, mutate workspaces, execute merges/synthesis, run evaluators, grant
 * authority, or replace Artifact/Policy/Scheduler/Recovery ownership.
 */
export const VARIANT_LAB_CONTRACT_VERSION = 1;

export const VariantKind = Object.freeze({
  CODE: 'CODE',
  DESIGN: 'DESIGN',
  DOCUMENT: 'DOCUMENT',
  PROMPT: 'PROMPT',
  PLAN: 'PLAN',
  DATA: 'DATA',
  OTHER: 'OTHER',
});

export const VariantEvaluationStatus = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
});

export const VariantQualificationState = Object.freeze({
  QUALIFIED: 'QUALIFIED',
  REJECTED: 'REJECTED',
  INCOMPLETE: 'INCOMPLETE',
});

const KINDS = new Set(Object.values(VariantKind));
const EVALUATION = new Set(Object.values(VariantEvaluationStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CANDIDATES = 32;
const MAX_CRITERIA = 64;
const MAX_EVALUATIONS = MAX_CANDIDATES * MAX_CRITERIA;
const MAX_IDS = 256;

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} must be a plain data object`);
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) throw new Error(`${label} contains non-enumerable field: ${key}`);
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`${label} field must be a data property: ${key}`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    out[key] = descriptor.value;
  }
  return out;
}

function strictArray(input, label, { min = 0, max = MAX_IDS } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new Error(`${label} must be a plain array`);
  if (input.length < min || input.length > max) throw new Error(`${label} must contain ${min}-${max} items`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) throw new Error(`${label} contains non-index field`);
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= input.length) throw new Error(`${label} contains invalid index`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  const out = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`${label} must not be sparse`);
    out.push(descriptor.value);
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function text(value, label, max = 8000) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function asciiCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function idList(input, label, { min = 0, max = MAX_IDS } = {}) {
  const raw = strictArray(input, label, { min, max });
  const values = raw.map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values.sort(asciiCompare);
}

const CANDIDATE_KEYS = new Set([
  'schemaVersion', 'candidateId', 'labId', 'baseRevisionId', 'kind', 'producerId',
  'isolationRef', 'artifactIds', 'candidateSha256', 'createdAt', 'submittedAt',
]);

export function normalizeVariantCandidateV1(input) {
  const raw = strictRecord(input, CANDIDATE_KEYS, 'VariantCandidateV1');
  if (raw.schemaVersion !== VARIANT_LAB_CONTRACT_VERSION) throw new Error('Unsupported VariantCandidateV1 schemaVersion');
  const kind = id(raw.kind, 'kind');
  if (!KINDS.has(kind)) throw new Error('kind is invalid');
  const createdAt = timestamp(raw.createdAt, 'createdAt');
  const submittedAt = timestamp(raw.submittedAt, 'submittedAt');
  if (Date.parse(submittedAt) < Date.parse(createdAt)) throw new Error('submittedAt cannot predate createdAt');
  return frozen({
    schemaVersion: VARIANT_LAB_CONTRACT_VERSION,
    candidateId: id(raw.candidateId, 'candidateId'),
    labId: id(raw.labId, 'labId'),
    baseRevisionId: id(raw.baseRevisionId, 'baseRevisionId'),
    kind,
    producerId: id(raw.producerId, 'producerId'),
    isolationRef: id(raw.isolationRef, 'isolationRef'),
    artifactIds: idList(raw.artifactIds, 'artifactIds', { min: 1, max: 128 }),
    candidateSha256: sha256(raw.candidateSha256, 'candidateSha256'),
    createdAt,
    submittedAt,
  });
}

const CRITERION_KEYS = new Set(['criterionId', 'label', 'verificationContractRef']);
function normalizeCriterion(input, index) {
  const label = `criteria[${index}]`;
  const raw = strictRecord(input, CRITERION_KEYS, label);
  return frozen({
    criterionId: id(raw.criterionId, `${label}.criterionId`),
    label: text(raw.label, `${label}.label`, 500),
    verificationContractRef: id(raw.verificationContractRef, `${label}.verificationContractRef`),
  });
}

const EVALUATION_KEYS = new Set([
  'schemaVersion', 'evaluationId', 'labId', 'candidateId', 'criterionId', 'verifierId',
  'status', 'candidateSha256', 'evidenceArtifactIds', 'evaluatedAt',
]);

export function normalizeVariantEvaluationV1(input) {
  const raw = strictRecord(input, EVALUATION_KEYS, 'VariantEvaluationV1');
  if (raw.schemaVersion !== VARIANT_LAB_CONTRACT_VERSION) throw new Error('Unsupported VariantEvaluationV1 schemaVersion');
  const status = id(raw.status, 'status');
  if (!EVALUATION.has(status)) throw new Error('status is invalid');
  return frozen({
    schemaVersion: VARIANT_LAB_CONTRACT_VERSION,
    evaluationId: id(raw.evaluationId, 'evaluationId'),
    labId: id(raw.labId, 'labId'),
    candidateId: id(raw.candidateId, 'candidateId'),
    criterionId: id(raw.criterionId, 'criterionId'),
    verifierId: id(raw.verifierId, 'verifierId'),
    status,
    candidateSha256: sha256(raw.candidateSha256, 'candidateSha256'),
    evidenceArtifactIds: idList(raw.evidenceArtifactIds, 'evidenceArtifactIds', { min: 1, max: 128 }),
    evaluatedAt: timestamp(raw.evaluatedAt, 'evaluatedAt'),
  });
}

const LAB_KEYS = new Set([
  'schemaVersion', 'labId', 'objective', 'baseRevisionId', 'candidates', 'criteria',
  'evaluations', 'createdAt', 'updatedAt',
]);

export function normalizeVariantLabV1(input) {
  const raw = strictRecord(input, LAB_KEYS, 'VariantLabV1');
  if (raw.schemaVersion !== VARIANT_LAB_CONTRACT_VERSION) throw new Error('Unsupported VariantLabV1 schemaVersion');
  const labId = id(raw.labId, 'labId');
  const baseRevisionId = id(raw.baseRevisionId, 'baseRevisionId');
  const createdAt = timestamp(raw.createdAt, 'createdAt');
  const updatedAt = timestamp(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('updatedAt cannot predate createdAt');

  const candidateRaw = strictArray(raw.candidates, 'candidates', { min: 2, max: MAX_CANDIDATES });
  const candidates = candidateRaw.map((item, index) => {
    try { return normalizeVariantCandidateV1(item); }
    catch (error) { throw new Error(`candidates[${index}]: ${error.message}`); }
  }).sort((a, b) => asciiCompare(a.candidateId, b.candidateId));
  const candidateIds = new Set();
  const isolationRefs = new Set();
  const outputArtifacts = new Set();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) throw new Error(`candidates contains duplicate candidateId: ${candidate.candidateId}`);
    candidateIds.add(candidate.candidateId);
    if (candidate.labId !== labId) throw new Error(`candidate labId mismatch: ${candidate.candidateId}`);
    if (candidate.baseRevisionId !== baseRevisionId) throw new Error(`candidate baseRevisionId mismatch: ${candidate.candidateId}`);
    if (isolationRefs.has(candidate.isolationRef)) throw new Error(`candidates share isolationRef: ${candidate.isolationRef}`);
    isolationRefs.add(candidate.isolationRef);
    if (Date.parse(candidate.createdAt) < Date.parse(createdAt)) throw new Error(`candidate predates lab: ${candidate.candidateId}`);
    if (Date.parse(candidate.submittedAt) > Date.parse(updatedAt)) throw new Error(`updatedAt predates candidate submission: ${candidate.candidateId}`);
    for (const artifactId of candidate.artifactIds) {
      if (outputArtifacts.has(artifactId)) throw new Error(`candidate output artifact is not isolated: ${artifactId}`);
      outputArtifacts.add(artifactId);
    }
  }

  const criterionRaw = strictArray(raw.criteria, 'criteria', { min: 1, max: MAX_CRITERIA });
  const criteria = criterionRaw.map(normalizeCriterion).sort((a, b) => asciiCompare(a.criterionId, b.criterionId));
  if (new Set(criteria.map(item => item.criterionId)).size !== criteria.length) throw new Error('criteria contains duplicate criterionId');
  const criterionIds = new Set(criteria.map(item => item.criterionId));

  const evaluationRaw = strictArray(raw.evaluations, 'evaluations', { max: MAX_EVALUATIONS });
  const evaluations = evaluationRaw.map((item, index) => {
    try { return normalizeVariantEvaluationV1(item); }
    catch (error) { throw new Error(`evaluations[${index}]: ${error.message}`); }
  }).sort((a, b) => asciiCompare(a.candidateId, b.candidateId) || asciiCompare(a.criterionId, b.criterionId));
  const candidateById = new Map(candidates.map(item => [item.candidateId, item]));
  const evaluationIds = new Set();
  const evaluationPairs = new Set();
  for (const evaluation of evaluations) {
    if (evaluationIds.has(evaluation.evaluationId)) throw new Error(`evaluations contains duplicate evaluationId: ${evaluation.evaluationId}`);
    evaluationIds.add(evaluation.evaluationId);
    if (evaluation.labId !== labId) throw new Error(`evaluation labId mismatch: ${evaluation.evaluationId}`);
    const candidate = candidateById.get(evaluation.candidateId);
    if (!candidate) throw new Error(`evaluation references unknown candidate: ${evaluation.candidateId}`);
    if (!criterionIds.has(evaluation.criterionId)) throw new Error(`evaluation references unknown criterion: ${evaluation.criterionId}`);
    const pair = `${evaluation.candidateId}\u0000${evaluation.criterionId}`;
    if (evaluationPairs.has(pair)) throw new Error(`duplicate candidate/criterion evaluation: ${evaluation.candidateId}/${evaluation.criterionId}`);
    evaluationPairs.add(pair);
    if (evaluation.verifierId === candidate.producerId) throw new Error(`verifier must be independent for candidate: ${candidate.candidateId}`);
    if (evaluation.candidateSha256 !== candidate.candidateSha256) throw new Error(`evaluation candidateSha256 mismatch: ${evaluation.evaluationId}`);
    if (Date.parse(evaluation.evaluatedAt) < Date.parse(candidate.submittedAt)) throw new Error(`evaluation predates candidate submission: ${evaluation.evaluationId}`);
    if (Date.parse(evaluation.evaluatedAt) > Date.parse(updatedAt)) throw new Error(`updatedAt predates evaluation: ${evaluation.evaluationId}`);
  }

  return frozen({
    schemaVersion: VARIANT_LAB_CONTRACT_VERSION,
    labId,
    objective: text(raw.objective, 'objective', 16_000),
    baseRevisionId,
    candidates,
    criteria,
    evaluations,
    createdAt,
    updatedAt,
  });
}

function evaluationMap(lab) {
  return new Map(lab.evaluations.map(item => [`${item.candidateId}\u0000${item.criterionId}`, item]));
}

export function buildVariantComparisonV1(input) {
  const lab = normalizeVariantLabV1(input);
  const byPair = evaluationMap(lab);
  const candidates = lab.candidates.map(candidate => {
    let hasFailure = false;
    let missing = false;
    const results = lab.criteria.map(criterion => {
      const evaluation = byPair.get(`${candidate.candidateId}\u0000${criterion.criterionId}`);
      if (!evaluation) {
        missing = true;
        return frozen({ criterionId: criterion.criterionId, status: 'MISSING', verifierId: '', evidenceArtifactIds: [] });
      }
      if (evaluation.status === VariantEvaluationStatus.FAIL) hasFailure = true;
      return frozen({
        criterionId: criterion.criterionId,
        status: evaluation.status,
        verifierId: evaluation.verifierId,
        evidenceArtifactIds: evaluation.evidenceArtifactIds,
      });
    });
    const qualification = hasFailure
      ? VariantQualificationState.REJECTED
      : missing ? VariantQualificationState.INCOMPLETE : VariantQualificationState.QUALIFIED;
    return frozen({
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      artifactIds: candidate.artifactIds,
      candidateSha256: candidate.candidateSha256,
      qualification,
      results,
    });
  });
  return frozen({
    labId: lab.labId,
    baseRevisionId: lab.baseRevisionId,
    criteria: lab.criteria,
    candidates,
  });
}

export function assertVariantSynthesisEligibleV1(input, selectedVariantIdsInput, { at } = {}) {
  const lab = normalizeVariantLabV1(input);
  const selectedVariantIds = idList(selectedVariantIdsInput, 'selectedVariantIds', { min: 1, max: MAX_CANDIDATES });
  const candidateById = new Map(lab.candidates.map(item => [item.candidateId, item]));
  for (const candidateId of selectedVariantIds) {
    if (!candidateById.has(candidateId)) throw new Error(`selectedVariantIds contains unknown candidate: ${candidateId}`);
  }
  const comparison = buildVariantComparisonV1(lab);
  const comparisonById = new Map(comparison.candidates.map(item => [item.candidateId, item]));
  for (const candidateId of selectedVariantIds) {
    const row = comparisonById.get(candidateId);
    if (row.qualification !== VariantQualificationState.QUALIFIED) {
      throw new Error(`variant is not synthesis-eligible: ${candidateId}:${row.qualification}`);
    }
  }
  const decidedAt = timestamp(at, 'at');
  if (Date.parse(decidedAt) < Date.parse(lab.updatedAt)) throw new Error('synthesis decision cannot predate lab updatedAt');
  const artifactIds = [];
  const evidenceArtifactIds = [];
  const evidenceSet = new Set();
  for (const candidateId of selectedVariantIds) {
    const candidate = candidateById.get(candidateId);
    artifactIds.push(...candidate.artifactIds);
    for (const result of comparisonById.get(candidateId).results) {
      for (const evidenceId of result.evidenceArtifactIds) {
        if (!evidenceSet.has(evidenceId)) {
          evidenceSet.add(evidenceId);
          evidenceArtifactIds.push(evidenceId);
        }
      }
    }
  }
  artifactIds.sort(asciiCompare);
  evidenceArtifactIds.sort(asciiCompare);
  return frozen({
    labId: lab.labId,
    baseRevisionId: lab.baseRevisionId,
    selectedVariantIds,
    candidateDigests: selectedVariantIds.map(candidateId => frozen({
      candidateId,
      candidateSha256: candidateById.get(candidateId).candidateSha256,
    })),
    artifactIds,
    evidenceArtifactIds,
    decidedAt,
  });
}
