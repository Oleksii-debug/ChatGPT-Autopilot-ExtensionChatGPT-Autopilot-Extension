/**
 * WorldStateV1 is a deterministic observation/freshness contract. It does not
 * poll resources, persist state, grant authority, dispatch effects, or replace
 * the canonical provider/policy/exact-effect/recovery layers.
 */
export const WORLD_STATE_CONTRACT_VERSION = 1;

export const WorldStateFreshnessStatus = Object.freeze({
  FRESH: 'FRESH',
  STALE: 'STALE',
});

export const WorldStateDriftReason = Object.freeze({
  MISSING_RESOURCE: 'MISSING_RESOURCE',
  PROVIDER_CHANGED: 'PROVIDER_CHANGED',
  REVISION_CHANGED: 'REVISION_CHANGED',
  CONTENT_CHANGED: 'CONTENT_CHANGED',
  OBSERVATION_REGRESSED: 'OBSERVATION_REGRESSED',
  EXPIRED: 'EXPIRED',
  FUTURE_OBSERVATION: 'FUTURE_OBSERVATION',
});

const DRIFT_REASONS = new Set(Object.values(WorldStateDriftReason));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_OBSERVATIONS = 256;
const MAX_IDS = 256;

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) throw new Error(`${label} contains non-enumerable field: ${key}`);
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field must be a data property: ${key}`);
    }
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    out[key] = descriptor.value;
  }
  return out;
}

function strictArray(input, label, { min = 0, max = MAX_IDS } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be a plain array`);
  }
  if (input.length < min || input.length > max) {
    throw new Error(`${label} must contain ${min}-${max} items`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index field`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= input.length) {
      throw new Error(`${label} contains invalid index`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  const out = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function id(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function normalizeIdList(input, label, { min = 0, max = MAX_IDS } = {}) {
  const raw = strictArray(input, label, { min, max });
  const values = raw.map((value, index) => id(value, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values.sort(asciiCompare);
}

const OBSERVATION_KEYS = new Set([
  'schemaVersion', 'observationId', 'scopeId', 'providerId', 'resourceId',
  'revisionId', 'contentSha256', 'observedAt', 'validUntil', 'evidenceArtifactIds',
]);

export function normalizeWorldStateObservationV1(input) {
  const raw = strictRecord(input, OBSERVATION_KEYS, 'WorldStateObservationV1');
  if (raw.schemaVersion !== WORLD_STATE_CONTRACT_VERSION) {
    throw new Error('Unsupported WorldStateObservationV1 schemaVersion');
  }
  const observedAt = timestamp(raw.observedAt, 'observedAt');
  const validUntil = timestamp(raw.validUntil, 'validUntil', { optional: true });
  if (validUntil && Date.parse(validUntil) <= Date.parse(observedAt)) {
    throw new Error('validUntil must be later than observedAt');
  }
  return frozen({
    schemaVersion: WORLD_STATE_CONTRACT_VERSION,
    observationId: id(raw.observationId, 'observationId'),
    scopeId: id(raw.scopeId, 'scopeId'),
    providerId: id(raw.providerId, 'providerId'),
    resourceId: id(raw.resourceId, 'resourceId'),
    revisionId: id(raw.revisionId, 'revisionId'),
    contentSha256: sha256(raw.contentSha256, 'contentSha256'),
    observedAt,
    validUntil,
    evidenceArtifactIds: normalizeIdList(raw.evidenceArtifactIds, 'evidenceArtifactIds', { min: 1, max: 128 }),
  });
}

function normalizeObservationList(input, label, { min = 0 } = {}) {
  const raw = strictArray(input, label, { min, max: MAX_OBSERVATIONS });
  const observations = raw.map((value, index) => {
    try {
      return normalizeWorldStateObservationV1(value);
    } catch (error) {
      throw new Error(`${label}[${index}]: ${error.message}`);
    }
  });
  const seenResource = new Set();
  const seenObservation = new Set();
  for (const observation of observations) {
    if (seenResource.has(observation.resourceId)) {
      throw new Error(`${label} contains duplicate resourceId: ${observation.resourceId}`);
    }
    if (seenObservation.has(observation.observationId)) {
      throw new Error(`${label} contains duplicate observationId: ${observation.observationId}`);
    }
    seenResource.add(observation.resourceId);
    seenObservation.add(observation.observationId);
  }
  return observations.sort((a, b) => asciiCompare(a.resourceId, b.resourceId));
}

const SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'snapshotId', 'scopeId', 'revision', 'observations', 'capturedAt',
]);

export function normalizeWorldStateSnapshotV1(input) {
  const raw = strictRecord(input, SNAPSHOT_KEYS, 'WorldStateSnapshotV1');
  if (raw.schemaVersion !== WORLD_STATE_CONTRACT_VERSION) {
    throw new Error('Unsupported WorldStateSnapshotV1 schemaVersion');
  }
  const scopeId = id(raw.scopeId, 'scopeId');
  const observations = normalizeObservationList(raw.observations, 'observations', { min: 1 });
  const capturedAt = timestamp(raw.capturedAt, 'capturedAt');
  for (const observation of observations) {
    if (observation.scopeId !== scopeId) {
      throw new Error(`observation scopeId mismatch: ${observation.resourceId}`);
    }
    if (Date.parse(observation.observedAt) > Date.parse(capturedAt)) {
      throw new Error(`capturedAt predates observation: ${observation.resourceId}`);
    }
    if (observation.validUntil && Date.parse(observation.validUntil) <= Date.parse(capturedAt)) {
      throw new Error(`snapshot contains expired observation: ${observation.resourceId}`);
    }
  }
  return frozen({
    schemaVersion: WORLD_STATE_CONTRACT_VERSION,
    snapshotId: id(raw.snapshotId, 'snapshotId'),
    scopeId,
    revision: integer(raw.revision, 'revision', { min: 1, max: 1_000_000_000 }),
    observations,
    capturedAt,
  });
}

const RESOURCE_BINDING_KEYS = new Set([
  'providerId', 'resourceId', 'revisionId', 'contentSha256', 'observedAt', 'validUntil',
]);

function resourceBindingFromObservation(observation) {
  return frozen({
    providerId: observation.providerId,
    resourceId: observation.resourceId,
    revisionId: observation.revisionId,
    contentSha256: observation.contentSha256,
    observedAt: observation.observedAt,
    validUntil: observation.validUntil,
  });
}

function normalizeResourceBinding(input, label) {
  const raw = strictRecord(input, RESOURCE_BINDING_KEYS, label);
  const observedAt = timestamp(raw.observedAt, `${label}.observedAt`);
  const validUntil = timestamp(raw.validUntil, `${label}.validUntil`, { optional: true });
  if (validUntil && Date.parse(validUntil) <= Date.parse(observedAt)) {
    throw new Error(`${label}.validUntil must be later than observedAt`);
  }
  return frozen({
    providerId: id(raw.providerId, `${label}.providerId`),
    resourceId: id(raw.resourceId, `${label}.resourceId`),
    revisionId: id(raw.revisionId, `${label}.revisionId`),
    contentSha256: sha256(raw.contentSha256, `${label}.contentSha256`),
    observedAt,
    validUntil,
  });
}

function normalizeResourceBindings(input, label = 'requiredBindings') {
  const raw = strictArray(input, label, { min: 1, max: MAX_OBSERVATIONS });
  const bindings = raw.map((value, index) => normalizeResourceBinding(value, `${label}[${index}]`));
  const seen = new Set();
  for (const binding of bindings) {
    if (seen.has(binding.resourceId)) throw new Error(`${label} contains duplicate resourceId: ${binding.resourceId}`);
    seen.add(binding.resourceId);
  }
  return bindings.sort((a, b) => asciiCompare(a.resourceId, b.resourceId));
}

const PRECONDITION_KEYS = new Set([
  'schemaVersion', 'guardId', 'invocationId', 'snapshotId', 'scopeId',
  'snapshotRevision', 'requiredBindings', 'createdAt', 'expiresAt',
]);

export function normalizeWorldStatePreconditionV1(input) {
  const raw = strictRecord(input, PRECONDITION_KEYS, 'WorldStatePreconditionV1');
  if (raw.schemaVersion !== WORLD_STATE_CONTRACT_VERSION) {
    throw new Error('Unsupported WorldStatePreconditionV1 schemaVersion');
  }
  const createdAt = timestamp(raw.createdAt, 'createdAt');
  const expiresAt = timestamp(raw.expiresAt, 'expiresAt', { optional: true });
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error('expiresAt must be later than createdAt');
  }
  return frozen({
    schemaVersion: WORLD_STATE_CONTRACT_VERSION,
    guardId: id(raw.guardId, 'guardId'),
    invocationId: id(raw.invocationId, 'invocationId'),
    snapshotId: id(raw.snapshotId, 'snapshotId'),
    scopeId: id(raw.scopeId, 'scopeId'),
    snapshotRevision: integer(raw.snapshotRevision, 'snapshotRevision', { min: 1, max: 1_000_000_000 }),
    requiredBindings: normalizeResourceBindings(raw.requiredBindings),
    createdAt,
    expiresAt,
  });
}

function assessmentTime(value, snapshot) {
  const at = timestamp(value, 'at');
  if (Date.parse(at) < Date.parse(snapshot.capturedAt)) {
    throw new Error('assessment time cannot predate snapshot capturedAt');
  }
  return at;
}

function requestedResources(snapshot, requiredResourceIds) {
  if (requiredResourceIds == null) return snapshot.observations.map(item => item.resourceId);
  const ids = normalizeIdList(requiredResourceIds, 'requiredResourceIds', { min: 1 });
  const available = new Set(snapshot.observations.map(item => item.resourceId));
  for (const resourceId of ids) {
    if (!available.has(resourceId)) throw new Error(`requiredResourceIds contains resource outside snapshot: ${resourceId}`);
  }
  return ids;
}

function drift(resourceId, reason) {
  if (!DRIFT_REASONS.has(reason)) throw new Error('internal drift reason is invalid');
  return frozen({ resourceId, reason });
}

export function assessWorldStateSnapshotFreshnessV1(
  snapshotInput,
  currentObservationsInput,
  { at, requiredResourceIds = null } = {},
) {
  const snapshot = normalizeWorldStateSnapshotV1(snapshotInput);
  const checkedResourceIds = requestedResources(snapshot, requiredResourceIds);
  const current = normalizeObservationList(currentObservationsInput, 'currentObservations');
  for (const observation of current) {
    if (observation.scopeId !== snapshot.scopeId) {
      throw new Error(`currentObservations scopeId mismatch: ${observation.resourceId}`);
    }
  }
  const now = assessmentTime(at, snapshot);
  const expectedById = new Map(snapshot.observations.map(item => [item.resourceId, item]));
  const currentById = new Map(current.map(item => [item.resourceId, item]));
  const driftItems = [];

  for (const resourceId of checkedResourceIds) {
    const expected = expectedById.get(resourceId);
    const actual = currentById.get(resourceId);
    if (!actual) {
      driftItems.push(drift(resourceId, WorldStateDriftReason.MISSING_RESOURCE));
      continue;
    }
    if (Date.parse(actual.observedAt) > Date.parse(now)) {
      driftItems.push(drift(resourceId, WorldStateDriftReason.FUTURE_OBSERVATION));
      continue;
    }
    if (actual.providerId !== expected.providerId) {
      driftItems.push(drift(resourceId, WorldStateDriftReason.PROVIDER_CHANGED));
      continue;
    }
    if (Date.parse(actual.observedAt) < Date.parse(expected.observedAt)) {
      driftItems.push(drift(resourceId, WorldStateDriftReason.OBSERVATION_REGRESSED));
      continue;
    }
    if (actual.revisionId !== expected.revisionId) {
      driftItems.push(drift(resourceId, WorldStateDriftReason.REVISION_CHANGED));
      continue;
    }
    if (actual.contentSha256 !== expected.contentSha256) {
      driftItems.push(drift(resourceId, WorldStateDriftReason.CONTENT_CHANGED));
      continue;
    }
    const expiries = [expected.validUntil, actual.validUntil].filter(Boolean).map(Date.parse);
    if (expiries.length && Math.min(...expiries) <= Date.parse(now)) {
      driftItems.push(drift(resourceId, WorldStateDriftReason.EXPIRED));
    }
  }

  driftItems.sort((a, b) => asciiCompare(a.resourceId, b.resourceId) || asciiCompare(a.reason, b.reason));
  return frozen({
    snapshotId: snapshot.snapshotId,
    scopeId: snapshot.scopeId,
    snapshotRevision: snapshot.revision,
    assessedAt: now,
    checkedResourceIds,
    status: driftItems.length ? WorldStateFreshnessStatus.STALE : WorldStateFreshnessStatus.FRESH,
    drift: driftItems,
  });
}

export function assertWorldStateSnapshotFreshV1(snapshotInput, currentObservationsInput, options = {}) {
  const report = assessWorldStateSnapshotFreshnessV1(snapshotInput, currentObservationsInput, options);
  if (report.status !== WorldStateFreshnessStatus.FRESH) {
    const evidence = report.drift.map(item => `${item.resourceId}:${item.reason}`).join(', ');
    throw new Error(`world-state snapshot is stale: ${evidence}`);
  }
  return report;
}

export function assertWorldStatePreconditionFreshV1({
  precondition: preconditionInput,
  snapshot: snapshotInput,
  currentObservations: currentObservationsInput,
  invocationId: invocationIdInput,
  at,
} = {}) {
  const precondition = normalizeWorldStatePreconditionV1(preconditionInput);
  const snapshot = normalizeWorldStateSnapshotV1(snapshotInput);
  const invocationId = id(invocationIdInput, 'invocationId');
  if (precondition.invocationId !== invocationId) throw new Error('precondition invocationId mismatch');
  if (precondition.snapshotId !== snapshot.snapshotId) throw new Error('precondition snapshotId mismatch');
  if (precondition.scopeId !== snapshot.scopeId) throw new Error('precondition scopeId mismatch');
  if (precondition.snapshotRevision !== snapshot.revision) throw new Error('precondition snapshotRevision mismatch');
  if (Date.parse(precondition.createdAt) < Date.parse(snapshot.capturedAt)) {
    throw new Error('precondition createdAt cannot predate snapshot capturedAt');
  }
  const snapshotByResource = new Map(snapshot.observations.map(item => [item.resourceId, item]));
  for (const binding of precondition.requiredBindings) {
    const observed = snapshotByResource.get(binding.resourceId);
    if (!observed) throw new Error(`precondition resource is absent from snapshot: ${binding.resourceId}`);
    const actualBinding = resourceBindingFromObservation(observed);
    if (JSON.stringify(actualBinding) !== JSON.stringify(binding)) {
      throw new Error(`precondition resource binding mismatch: ${binding.resourceId}`);
    }
  }
  const now = timestamp(at, 'at');
  if (Date.parse(now) < Date.parse(precondition.createdAt)) {
    throw new Error('assessment time cannot predate precondition createdAt');
  }
  if (precondition.expiresAt && Date.parse(precondition.expiresAt) <= Date.parse(now)) {
    throw new Error('world-state precondition is expired');
  }
  const report = assertWorldStateSnapshotFreshV1(snapshot, currentObservationsInput, {
    at: now,
    requiredResourceIds: precondition.requiredBindings.map(item => item.resourceId),
  });
  return frozen({ precondition, snapshot, freshness: report });
}
