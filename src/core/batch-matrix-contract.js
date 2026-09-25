import { createSha256FingerprintV1 } from './fingerprint.js';

export const BATCH_MATRIX_SCHEMA_VERSION = 1;
export const MAX_BATCH_AXES = 16;
export const MAX_BATCH_VALUES_PER_AXIS = 32;
export const MAX_BATCH_ITEMS = 1024;
export const MAX_BATCH_CONCURRENCY_INTENT = 64;

export const BatchItemStatus = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  PASS: 'PASS',
  FAIL: 'FAIL',
  CANCELLED: 'CANCELLED',
});

export const BatchMatrixState = Object.freeze({
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
});

const STATUSES = new Set(Object.values(BatchItemStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const SPEC_KEYS = new Set([
  'schemaVersion',
  'batchId',
  'workloadId',
  'workloadRevisionId',
  'workloadSha256',
  'producerId',
  'createdAt',
  'maxConcurrency',
  'axes',
]);
const AXIS_KEYS = new Set(['axisId', 'values']);
const VALUE_KEYS = new Set(['valueId', 'valueRef', 'sensitive']);
const EVIDENCE_REF_KEYS = new Set(['projectId', 'artifactId', 'versionId', 'sha256']);
const RESULT_KEYS = new Set([
  'schemaVersion',
  'batchId',
  'itemId',
  'itemSha256',
  'status',
  'actorId',
  'verifierId',
  'reasonCode',
  'evidenceRefs',
  'startedAt',
  'completedAt',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' must not contain symbol fields');
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain enumerable own data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
  }
}

function denseArray(value, label, { min = 0, max }) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded array');
  }
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index array data');
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || !Object.hasOwn(descriptor, 'value')
        || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain canonical enumerable data indices only');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' must not be sparse');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA256.test(value)) {
    throw new Error(label + ' must be canonical lowercase SHA-256');
  }
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function integer(value, label, { min, max }) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < min
      || value > max) {
    throw new Error(label + ' is out of bounds');
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeValue(input, axisLabel, index) {
  const label = axisLabel + '.values[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, VALUE_KEYS, label);
  return freezeDeep({
    valueId: id(raw.valueId, label + ' valueId'),
    valueRef: id(raw.valueRef, label + ' valueRef'),
    sensitive: bool(raw.sensitive, label + ' sensitive'),
  });
}

function normalizeAxis(input, index) {
  const label = 'axes[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, AXIS_KEYS, label);
  const values = denseArray(raw.values, label + '.values', {
    min: 1,
    max: MAX_BATCH_VALUES_PER_AXIS,
  }).map((value, valueIndex) => normalizeValue(value, label, valueIndex));

  const valueIds = new Set();
  const valueRefs = new Set();
  for (const value of values) {
    if (valueIds.has(value.valueId)) throw new Error(label + ' contains duplicate valueId');
    if (valueRefs.has(value.valueRef)) throw new Error(label + ' contains duplicate valueRef alias');
    valueIds.add(value.valueId);
    valueRefs.add(value.valueRef);
  }
  values.sort((a, b) => compareText(a.valueId, b.valueId));

  return freezeDeep({
    axisId: id(raw.axisId, label + ' axisId'),
    values: Object.freeze(values),
  });
}

export function normalizeBatchMatrixSpecV1(input) {
  const raw = record(input, 'BatchMatrixSpecV1');
  exactKeys(raw, SPEC_KEYS, 'BatchMatrixSpecV1');
  if (raw.schemaVersion !== BATCH_MATRIX_SCHEMA_VERSION) {
    throw new Error('Unsupported BatchMatrixSpecV1 schemaVersion');
  }

  const axes = denseArray(raw.axes, 'axes', {
    min: 1,
    max: MAX_BATCH_AXES,
  }).map(normalizeAxis);

  const axisIds = new Set();
  const globalValueRefs = new Set();
  let product = 1;
  for (const axis of axes) {
    if (axisIds.has(axis.axisId)) throw new Error('axes contains duplicate axisId');
    axisIds.add(axis.axisId);
    for (const value of axis.values) {
      if (globalValueRefs.has(value.valueRef)) {
        throw new Error('axes contains duplicate valueRef alias');
      }
      globalValueRefs.add(value.valueRef);
    }
    if (product > Math.floor(MAX_BATCH_ITEMS / axis.values.length)) {
      throw new Error('batch matrix Cartesian product exceeds item bound');
    }
    product *= axis.values.length;
  }
  axes.sort((a, b) => compareText(a.axisId, b.axisId));

  return freezeDeep({
    schemaVersion: BATCH_MATRIX_SCHEMA_VERSION,
    batchId: id(raw.batchId, 'batchId'),
    workloadId: id(raw.workloadId, 'workloadId'),
    workloadRevisionId: id(raw.workloadRevisionId, 'workloadRevisionId'),
    workloadSha256: sha256(raw.workloadSha256, 'workloadSha256'),
    producerId: id(raw.producerId, 'producerId'),
    createdAt: timestamp(raw.createdAt, 'createdAt'),
    maxConcurrency: integer(raw.maxConcurrency, 'maxConcurrency', {
      min: 1,
      max: MAX_BATCH_CONCURRENCY_INTENT,
    }),
    itemCount: product,
    axes: Object.freeze(axes),
  });
}

function parameterAssignments(axes) {
  let rows = [[]];
  for (const axis of axes) {
    const next = [];
    for (const row of rows) {
      for (const value of axis.values) {
        next.push([
          ...row,
          freezeDeep({
            axisId: axis.axisId,
            valueId: value.valueId,
            valueRef: value.valueRef,
            sensitive: value.sensitive,
          }),
        ]);
      }
    }
    rows = next;
  }
  return rows;
}

async function itemDigest(spec, parameters, cryptoApi) {
  const canonical = JSON.stringify([
    'chatgpt-autopilot-batch-item-v1',
    spec.batchId,
    spec.producerId,
    spec.workloadId,
    spec.workloadRevisionId,
    spec.workloadSha256,
    parameters,
  ]);
  const tagged = await createSha256FingerprintV1(canonical, { cryptoApi });
  if (typeof tagged !== 'string' || !tagged.startsWith('sha256:')) {
    throw new Error('Batch item fingerprint helper returned invalid output');
  }
  return sha256(tagged.slice('sha256:'.length), 'batch item SHA-256');
}

export async function expandBatchMatrixV1(
  input,
  { cryptoApi = globalThis.crypto } = {},
) {
  const spec = normalizeBatchMatrixSpecV1(input);
  const assignments = parameterAssignments(spec.axes);
  const items = [];
  const itemIds = new Set();

  for (const parameters of assignments) {
    const digest = await itemDigest(spec, parameters, cryptoApi);
    const itemId = 'batch-item:' + digest.slice(0, 32);
    if (itemIds.has(itemId)) throw new Error('batch item identity collision');
    itemIds.add(itemId);
    items.push(freezeDeep({
      schemaVersion: BATCH_MATRIX_SCHEMA_VERSION,
      batchId: spec.batchId,
      itemId,
      itemSha256: digest,
      producerId: spec.producerId,
      workloadId: spec.workloadId,
      workloadRevisionId: spec.workloadRevisionId,
      workloadSha256: spec.workloadSha256,
      parameters: Object.freeze(parameters),
    }));
  }

  items.sort((a, b) => compareText(a.itemId, b.itemId));
  return freezeDeep({
    schemaVersion: BATCH_MATRIX_SCHEMA_VERSION,
    spec,
    items: Object.freeze(items),
    schedulingAuthorized: false,
    executionAuthorized: false,
    maxConcurrencyIsIntentOnly: true,
  });
}

function normalizeEvidenceRef(input, label) {
  const raw = record(input, label);
  exactKeys(raw, EVIDENCE_REF_KEYS, label);
  return freezeDeep({
    projectId: id(raw.projectId, label + ' projectId'),
    artifactId: id(raw.artifactId, label + ' artifactId'),
    versionId: id(raw.versionId, label + ' versionId'),
    sha256: sha256(raw.sha256, label + ' sha256'),
  });
}

function normalizeEvidenceRefs(input, label) {
  const refs = denseArray(input, label, { max: 128 })
    .map((item, index) => normalizeEvidenceRef(item, label + '[' + index + ']'));
  const seen = new Set();
  for (const ref of refs) {
    const identity = ref.projectId + '\\u0000' + ref.artifactId + '\\u0000' + ref.versionId;
    if (seen.has(identity)) throw new Error(label + ' contains duplicate artifact version identity');
    seen.add(identity);
  }
  refs.sort((left, right) =>
    compareText(left.projectId, right.projectId)
    || compareText(left.artifactId, right.artifactId)
    || compareText(left.versionId, right.versionId));
  return refs;
}

function normalizeResult(input, index, spec, itemById, assessedAt) {
  const label = 'results[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, RESULT_KEYS, label);
  if (raw.schemaVersion !== BATCH_MATRIX_SCHEMA_VERSION) {
    throw new Error(label + ' schemaVersion is invalid');
  }
  const batchId = id(raw.batchId, label + ' batchId');
  if (batchId !== spec.batchId) throw new Error(label + ' batchId mismatch');

  const itemId = id(raw.itemId, label + ' itemId');
  const item = itemById.get(itemId);
  if (!item) throw new Error(label + ' references unknown itemId');
  const itemSha256 = sha256(raw.itemSha256, label + ' itemSha256');
  if (itemSha256 !== item.itemSha256) throw new Error(label + ' itemSha256 mismatch');

  const status = id(raw.status, label + ' status');
  if (!STATUSES.has(status)) throw new Error(label + ' status is invalid');

  const actorId = id(raw.actorId, label + ' actorId', { optional: true });
  const verifierId = id(raw.verifierId, label + ' verifierId', { optional: true });
  const reasonCode = id(raw.reasonCode, label + ' reasonCode', { optional: true });
  const evidenceRefs = normalizeEvidenceRefs(
    raw.evidenceRefs ?? [],
    label + ' evidenceRefs',
  );
  const startedAt = timestamp(raw.startedAt, label + ' startedAt', { optional: true });
  const completedAt = timestamp(raw.completedAt, label + ' completedAt', { optional: true });

  const createdMs = Date.parse(spec.createdAt);
  if (startedAt && Date.parse(startedAt) < createdMs) {
    throw new Error(label + ' startedAt predates batch creation');
  }
  if (completedAt && Date.parse(completedAt) < createdMs) {
    throw new Error(label + ' completedAt predates batch creation');
  }
  if (startedAt && completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error(label + ' completedAt predates startedAt');
  }
  const assessedMs = Date.parse(assessedAt);
  if (startedAt && Date.parse(startedAt) > assessedMs) {
    throw new Error(label + ' startedAt exceeds assessedAt');
  }
  if (completedAt && Date.parse(completedAt) > assessedMs) {
    throw new Error(label + ' completedAt exceeds assessedAt');
  }

  if (status === BatchItemStatus.PENDING) {
    if (actorId || verifierId || reasonCode || evidenceRefs.length || startedAt || completedAt) {
      throw new Error(label + ' PENDING cannot carry execution or terminal evidence');
    }
  } else if (status === BatchItemStatus.RUNNING) {
    if (!actorId || !startedAt) throw new Error(label + ' RUNNING requires actorId and startedAt');
    if (verifierId || reasonCode || evidenceRefs.length || completedAt) {
      throw new Error(label + ' RUNNING cannot carry terminal evidence');
    }
  } else {
    if (!actorId || !verifierId || !startedAt || !completedAt || !evidenceRefs.length) {
      throw new Error(label + ' terminal result requires actor, verifier, times and evidence');
    }
    if (actorId === verifierId) {
      throw new Error(label + ' terminal verifier must be independent from actor');
    }
    if ((status === BatchItemStatus.FAIL || status === BatchItemStatus.CANCELLED) && !reasonCode) {
      throw new Error(label + ' failed/cancelled result requires reasonCode');
    }
    if (status === BatchItemStatus.PASS && reasonCode) {
      throw new Error(label + ' PASS must not carry failure reasonCode');
    }
  }

  return freezeDeep({
    schemaVersion: BATCH_MATRIX_SCHEMA_VERSION,
    batchId,
    itemId,
    itemSha256,
    status,
    actorId,
    verifierId,
    reasonCode,
    evidenceRefs: Object.freeze(evidenceRefs),
    startedAt,
    completedAt,
  });
}

function implicitPending(spec, item) {
  return freezeDeep({
    schemaVersion: BATCH_MATRIX_SCHEMA_VERSION,
    batchId: spec.batchId,
    itemId: item.itemId,
    itemSha256: item.itemSha256,
    status: BatchItemStatus.PENDING,
    actorId: '',
    verifierId: '',
    reasonCode: '',
    evidenceRefs: Object.freeze([]),
    startedAt: '',
    completedAt: '',
  });
}

export async function assessBatchMatrixV1(
  specInput,
  resultsInput = [],
  { cryptoApi = globalThis.crypto, assessedAt } = {},
) {
  const assessedAtCanonical = timestamp(assessedAt, 'assessedAt');
  const expansion = await expandBatchMatrixV1(specInput, { cryptoApi });
  const spec = expansion.spec;
  if (Date.parse(assessedAtCanonical) < Date.parse(spec.createdAt)) {
    throw new Error('assessedAt predates batch creation');
  }
  const itemById = new Map(expansion.items.map((item) => [item.itemId, item]));
  const rawResults = denseArray(resultsInput, 'results', {
    max: MAX_BATCH_ITEMS,
  });
  const resultById = new Map();

  for (let index = 0; index < rawResults.length; index += 1) {
    const result = normalizeResult(
      rawResults[index],
      index,
      spec,
      itemById,
      assessedAtCanonical,
    );
    if (resultById.has(result.itemId)) throw new Error('results contains duplicate itemId');
    resultById.set(result.itemId, result);
  }

  const results = expansion.items.map((item) => (
    resultById.get(item.itemId) ?? implicitPending(spec, item)
  ));

  const counts = {
    pending: 0,
    running: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
  };
  for (const result of results) {
    if (result.status === BatchItemStatus.PENDING) counts.pending += 1;
    if (result.status === BatchItemStatus.RUNNING) counts.running += 1;
    if (result.status === BatchItemStatus.PASS) counts.pass += 1;
    if (result.status === BatchItemStatus.FAIL) counts.fail += 1;
    if (result.status === BatchItemStatus.CANCELLED) counts.cancelled += 1;
  }

  const unfinished = counts.pending + counts.running;
  const state = unfinished > 0
    ? BatchMatrixState.IN_PROGRESS
    : counts.fail === 0 && counts.cancelled === 0
      ? BatchMatrixState.COMPLETE
      : BatchMatrixState.PARTIAL;

  const resumeCandidateItemIds = results
    .filter((result) => result.status === BatchItemStatus.PENDING)
    .map((result) => result.itemId)
    .sort(compareText);
  const reconciliationRequiredItemIds = results
    .filter((result) => result.status === BatchItemStatus.RUNNING)
    .map((result) => result.itemId)
    .sort(compareText);

  return freezeDeep({
    schemaVersion: BATCH_MATRIX_SCHEMA_VERSION,
    batchId: spec.batchId,
    producerId: spec.producerId,
    workloadId: spec.workloadId,
    workloadRevisionId: spec.workloadRevisionId,
    workloadSha256: spec.workloadSha256,
    assessedAt: assessedAtCanonical,
    state,
    totalItems: results.length,
    counts: freezeDeep(counts),
    results: Object.freeze(results),
    resumeCandidateItemIds: Object.freeze(resumeCandidateItemIds),
    reconciliationRequiredItemIds: Object.freeze(reconciliationRequiredItemIds),
    reportedAllPassed: state === BatchMatrixState.COMPLETE,
    reportedPartialFailure: state === BatchMatrixState.PARTIAL,
    resultEvidenceTrust: 'UNVERIFIED_INPUT',
    completionAuthorized: false,
    requiresCanonicalEvidenceResolution: true,
    requiresIndependentVerifierAuthority: true,
    schedulingAuthorized: false,
    executionAuthorized: false,
    resumeAuthorized: false,
    reconciliationAuthorized: false,
    maxConcurrencyIsIntentOnly: true,
    maxConcurrency: spec.maxConcurrency,
  });
}
