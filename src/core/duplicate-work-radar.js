export const DuplicateWorkRadarContractVersion = 1;

export const WorkIntentMode = Object.freeze({
  MUTATION: 'MUTATION',
  REVIEW: 'REVIEW',
  AUDIT: 'AUDIT',
});

export const WorkIntentLifecycle = Object.freeze({
  ACTIVE: 'ACTIVE',
  PLANNED: 'PLANNED',
});

export const WorkOverlapClassification = Object.freeze({
  RELATED: 'RELATED',
  HIGH_OVERLAP: 'HIGH_OVERLAP',
  HARD_CONFLICT: 'HARD_CONFLICT',
  COMPLEMENTARY_REVIEW: 'COMPLEMENTARY_REVIEW',
  INTENTIONAL_VARIANT: 'INTENTIONAL_VARIANT',
});

export const WorkOverlapDisposition = Object.freeze({
  COORDINATE_SCOPE: 'COORDINATE_SCOPE',
  MERGE_OR_NARROW: 'MERGE_OR_NARROW',
  MERGE_OR_REDIRECT_REVIEW: 'MERGE_OR_REDIRECT_REVIEW',
  KEEP_REVIEW: 'KEEP_REVIEW',
  KEEP_EXPLICIT_VARIANT: 'KEEP_EXPLICIT_VARIANT',
});

const MODES = new Set(Object.values(WorkIntentMode));
const LIFECYCLES = new Set(Object.values(WorkIntentLifecycle));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_WORK_ITEMS = 128;
const MAX_SET = 128;
const MAX_PATH = 512;
const MAX_WEIGHT = 1000;

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
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

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field`);
    }
  }
}

function version(value, label) {
  if (value !== DuplicateWorkRadarContractVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return DuplicateWorkRadarContractVersion;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function exactEnum(value, allowed, label) {
  if (typeof value !== 'string' || value !== value.trim() || !allowed.has(value)) {
    throw new Error(`${label} must use exact canonical enum representation`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function dataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
      throw new Error(`${label} contains non-index array data`);
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
      throw new Error(`${label} entries must be enumerable own data properties`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function idSet(value, label) {
  const out = dataArray(value, label, MAX_SET)
    .map((item, index) => exactId(item, `${label}[${index}]`))
    .sort(asciiCompare);
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function repoPath(value, label) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > MAX_PATH
      || value.startsWith('/')
      || value.includes('\\')
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be an exact safe repository-relative path`);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be an exact safe repository-relative path`);
  }
  return value;
}

function pathSet(value, label) {
  const out = dataArray(value, label, MAX_SET)
    .map((item, index) => repoPath(item, `${label}[${index}]`))
    .sort(asciiCompare);
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function optionalIdPair(groupValue, variantValue) {
  const hasGroup = groupValue != null && groupValue !== '';
  const hasVariant = variantValue != null && variantValue !== '';
  if (hasGroup !== hasVariant) throw new Error('variantGroupId and variantId must be provided together');
  if (!hasGroup) return { variantGroupId:'', variantId:'' };
  return {
    variantGroupId: exactId(groupValue, 'variantGroupId'),
    variantId: exactId(variantValue, 'variantId'),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const WORK_KEYS = new Set([
  'schemaVersion',
  'workId',
  'workerId',
  'lifecycle',
  'mode',
  'conflictKeys',
  'subsystemIds',
  'filePaths',
  'resourceIds',
  'outcomeTags',
  'dependencyIds',
  'acceptanceCriterionIds',
  'semanticTags',
  'sideEffectTags',
  'variantGroupId',
  'variantId',
]);

export function normalizeWorkIntentV1(input) {
  const raw = plain(input, 'WorkIntentV1');
  exactKeys(raw, WORK_KEYS, 'WorkIntentV1');
  const variant = optionalIdPair(raw.variantGroupId, raw.variantId);
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'WorkIntentV1'),
    workId: exactId(raw.workId, 'workId'),
    workerId: exactId(raw.workerId, 'workerId'),
    lifecycle: exactEnum(raw.lifecycle, LIFECYCLES, 'lifecycle'),
    mode: exactEnum(raw.mode, MODES, 'mode'),
    conflictKeys: idSet(raw.conflictKeys, 'conflictKeys'),
    subsystemIds: idSet(raw.subsystemIds, 'subsystemIds'),
    filePaths: pathSet(raw.filePaths, 'filePaths'),
    resourceIds: idSet(raw.resourceIds, 'resourceIds'),
    outcomeTags: idSet(raw.outcomeTags, 'outcomeTags'),
    dependencyIds: idSet(raw.dependencyIds, 'dependencyIds'),
    acceptanceCriterionIds: idSet(raw.acceptanceCriterionIds, 'acceptanceCriterionIds'),
    semanticTags: idSet(raw.semanticTags, 'semanticTags'),
    sideEffectTags: idSet(raw.sideEffectTags, 'sideEffectTags'),
    ...variant,
  });
}

const WEIGHT_KEYS = new Set([
  'conflictKeys',
  'subsystems',
  'files',
  'resources',
  'outcomes',
  'dependencies',
  'acceptanceCriteria',
  'semanticTags',
  'sideEffects',
]);

function normalizeWeights(input) {
  const raw = plain(input, 'DuplicateWorkRadarWeightsV1');
  exactKeys(raw, WEIGHT_KEYS, 'DuplicateWorkRadarWeightsV1');
  const out = {};
  let sum = 0;
  for (const key of [...WEIGHT_KEYS].sort(asciiCompare)) {
    const value = integer(raw[key], `weights.${key}`, 0, MAX_WEIGHT);
    out[key] = value;
    sum += value;
  }
  if (sum === 0) throw new Error('weights must contain at least one positive value');
  return deepFreeze(out);
}

const POLICY_KEYS = new Set([
  'schemaVersion',
  'policyId',
  'highOverlapBasisPoints',
  'minHighOverlapDimensions',
  'weights',
]);

export function normalizeDuplicateWorkRadarPolicyV1(input) {
  const raw = plain(input, 'DuplicateWorkRadarPolicyV1');
  exactKeys(raw, POLICY_KEYS, 'DuplicateWorkRadarPolicyV1');
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'DuplicateWorkRadarPolicyV1'),
    policyId: exactId(raw.policyId, 'policyId'),
    highOverlapBasisPoints: integer(
      raw.highOverlapBasisPoints,
      'highOverlapBasisPoints',
      1,
      10_000,
    ),
    minHighOverlapDimensions: integer(
      raw.minHighOverlapDimensions,
      'minHighOverlapDimensions',
      1,
      DIMENSIONS.length,
    ),
    weights: normalizeWeights(raw.weights),
  });
}

function intersection(a, b) {
  const bSet = new Set(b);
  return a.filter(item => bSet.has(item));
}

function unionSize(a, b) {
  return new Set([...a, ...b]).size;
}

function dimensionBasisPoints(a, b) {
  const union = unionSize(a, b);
  if (union === 0) return null;
  return Math.floor((intersection(a, b).length * 10_000) / union);
}

const DIMENSIONS = Object.freeze([
  ['conflictKeys', 'conflictKeys', 'conflictKeys'],
  ['subsystems', 'subsystemIds', 'subsystemIds'],
  ['files', 'filePaths', 'filePaths'],
  ['resources', 'resourceIds', 'resourceIds'],
  ['outcomes', 'outcomeTags', 'outcomeTags'],
  ['dependencies', 'dependencyIds', 'dependencyIds'],
  ['acceptanceCriteria', 'acceptanceCriterionIds', 'acceptanceCriterionIds'],
  ['semanticTags', 'semanticTags', 'semanticTags'],
  ['sideEffects', 'sideEffectTags', 'sideEffectTags'],
]);

function scorePair(a, b, policy) {
  let weighted = 0;
  let weightTotal = 0;
  let matchedDimensionCount = 0;
  const basisPointsByDimension = {};
  const overlap = {};
  for (const [weightKey, field, outputField] of DIMENSIONS) {
    const shared = intersection(a[field], b[field]).sort(asciiCompare);
    overlap[outputField] = shared;
    const basisPoints = dimensionBasisPoints(a[field], b[field]);
    basisPointsByDimension[weightKey] = basisPoints == null ? 0 : basisPoints;
    const weight = policy.weights[weightKey];
    if (basisPoints != null && weight > 0) {
      weighted += basisPoints * weight;
      weightTotal += weight;
      if (shared.length > 0) matchedDimensionCount += 1;
    }
  }
  return {
    scoreBasisPoints: weightTotal ? Math.floor(weighted / weightTotal) : 0,
    matchedDimensionCount,
    basisPointsByDimension,
    overlap,
  };
}

function isIntentionalVariant(a, b) {
  return a.mode === WorkIntentMode.MUTATION
    && b.mode === WorkIntentMode.MUTATION
    && a.variantGroupId
    && a.variantGroupId === b.variantGroupId
    && a.variantId !== b.variantId;
}

function isComplementaryReview(a, b) {
  const aMutation = a.mode === WorkIntentMode.MUTATION;
  const bMutation = b.mode === WorkIntentMode.MUTATION;
  return aMutation !== bMutation;
}

function classifyPair(a, b, policy, scored) {
  const sharedConflictKey = scored.overlap.conflictKeys.length > 0;
  const hasHardConflictKey = sharedConflictKey
    && a.mode === WorkIntentMode.MUTATION
    && b.mode === WorkIntentMode.MUTATION;
  const high = scored.scoreBasisPoints >= policy.highOverlapBasisPoints
    && scored.matchedDimensionCount >= policy.minHighOverlapDimensions;
  const strongOverlap = sharedConflictKey || high;

  if (isIntentionalVariant(a, b) && strongOverlap) {
    return WorkOverlapClassification.INTENTIONAL_VARIANT;
  }
  if (isComplementaryReview(a, b) && strongOverlap) {
    return WorkOverlapClassification.COMPLEMENTARY_REVIEW;
  }
  if (hasHardConflictKey) return WorkOverlapClassification.HARD_CONFLICT;
  if (high) return WorkOverlapClassification.HIGH_OVERLAP;
  if (scored.scoreBasisPoints > 0) return WorkOverlapClassification.RELATED;
  return null;
}

function dispositionFor(classification) {
  return {
    [WorkOverlapClassification.RELATED]: WorkOverlapDisposition.COORDINATE_SCOPE,
    [WorkOverlapClassification.HIGH_OVERLAP]: WorkOverlapDisposition.MERGE_OR_REDIRECT_REVIEW,
    [WorkOverlapClassification.HARD_CONFLICT]: WorkOverlapDisposition.MERGE_OR_NARROW,
    [WorkOverlapClassification.COMPLEMENTARY_REVIEW]: WorkOverlapDisposition.KEEP_REVIEW,
    [WorkOverlapClassification.INTENTIONAL_VARIANT]: WorkOverlapDisposition.KEEP_EXPLICIT_VARIANT,
  }[classification];
}

function pairProjection(a, b, policy) {
  const scored = scorePair(a, b, policy);
  const classification = classifyPair(a, b, policy, scored);
  if (!classification) return null;
  return deepFreeze({
    pairId: `pair:${a.workId.length}:${a.workId}:${b.workId.length}:${b.workId}`,
    workIdA: a.workId,
    workIdB: b.workId,
    workerIdA: a.workerId,
    workerIdB: b.workerId,
    classification,
    scoreBasisPoints: scored.scoreBasisPoints,
    matchedDimensionCount: scored.matchedDimensionCount,
    basisPointsByDimension: scored.basisPointsByDimension,
    overlap: scored.overlap,
    explicitParallelVariant: classification === WorkOverlapClassification.INTENTIONAL_VARIANT,
    recommendedDisposition: dispositionFor(classification),
    decisionAuthorized: false,
    mutationAuthorized: false,
  });
}

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'policy',
  'workItems',
]);

export function analyzeDuplicateWorkV1(input) {
  const raw = plain(input, 'DuplicateWorkRadarRequestV1');
  exactKeys(raw, REQUEST_KEYS, 'DuplicateWorkRadarRequestV1');
  version(raw.schemaVersion, 'DuplicateWorkRadarRequestV1');
  const policy = normalizeDuplicateWorkRadarPolicyV1(raw.policy);
  const workItems = dataArray(raw.workItems, 'workItems', MAX_WORK_ITEMS)
    .map(normalizeWorkIntentV1)
    .sort((a, b) => asciiCompare(a.workId, b.workId));
  const workIds = new Set();
  for (const item of workItems) {
    if (workIds.has(item.workId)) throw new Error('workItems contains duplicate workId');
    workIds.add(item.workId);
  }

  const pairs = [];
  let comparedPairCount = 0;
  for (let left = 0; left < workItems.length; left += 1) {
    for (let right = left + 1; right < workItems.length; right += 1) {
      comparedPairCount += 1;
      const pair = pairProjection(workItems[left], workItems[right], policy);
      if (pair) pairs.push(pair);
    }
  }

  const highClassifications = new Set([
    WorkOverlapClassification.HIGH_OVERLAP,
    WorkOverlapClassification.HARD_CONFLICT,
  ]);
  const highOverlapPairs = pairs.filter(pair => highClassifications.has(pair.classification));
  const conflictingWorkerIds = [...new Set(
    highOverlapPairs.flatMap(pair => [pair.workerIdA, pair.workerIdB]),
  )].sort(asciiCompare);
  const distinctWorkerIds = [...new Set(workItems.map(item => item.workerId))].sort(asciiCompare);
  const conflictingWorkerRateBasisPoints = distinctWorkerIds.length
    ? Math.floor((conflictingWorkerIds.length * 10_000) / distinctWorkerIds.length)
    : 0;

  return deepFreeze({
    schemaVersion: DuplicateWorkRadarContractVersion,
    policyId: policy.policyId,
    workItemCount: workItems.length,
    comparedPairCount,
    pairs,
    metrics: {
      distinctWorkerCount: distinctWorkerIds.length,
      relatedPairCount: pairs.length,
      highOverlapPairCount: pairs.filter(
        pair => pair.classification === WorkOverlapClassification.HIGH_OVERLAP,
      ).length,
      hardConflictPairCount: pairs.filter(
        pair => pair.classification === WorkOverlapClassification.HARD_CONFLICT,
      ).length,
      complementaryReviewPairCount: pairs.filter(
        pair => pair.classification === WorkOverlapClassification.COMPLEMENTARY_REVIEW,
      ).length,
      intentionalVariantPairCount: pairs.filter(
        pair => pair.classification === WorkOverlapClassification.INTENTIONAL_VARIANT,
      ).length,
      potentialAvoidableDuplicatePairCount: highOverlapPairs.length,
      conflictingWorkerIds,
      conflictingWorkerRateBasisPoints,
    },
    decisionAuthorized: false,
    mutationAuthorized: false,
  });
}
