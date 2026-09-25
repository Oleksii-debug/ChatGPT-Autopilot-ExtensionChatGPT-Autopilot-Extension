export const TruthArbitrationContractVersion = 1;

export const TruthResolutionStatus = Object.freeze({
  RESOLVED: 'RESOLVED',
  REFRESH_REQUIRED: 'REFRESH_REQUIRED',
  CONFLICT: 'CONFLICT',
  UNAVAILABLE: 'UNAVAILABLE',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_AUTHORITIES = 64;
const MAX_SOURCES = 128;
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

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
  if (value !== TruthArbitrationContractVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return TruthArbitrationContractVersion;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function boundedInteger(value, label, min, max, fallback = 0) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const RULE_KEYS = new Set([
  'schemaVersion',
  'ruleId',
  'factClass',
  'authorityOrder',
  'maxAgeMs',
]);

export function normalizeTruthRuleV1(input) {
  const raw = plain(input, 'TruthRuleV1');
  exactKeys(raw, RULE_KEYS, 'TruthRuleV1');
  const authorityOrder = dataArray(raw.authorityOrder, 'authorityOrder', MAX_AUTHORITIES)
    .map((authorityClass, index) => exactId(authorityClass, `authorityOrder[${index}]`));
  if (authorityOrder.length === 0) throw new Error('authorityOrder must not be empty');
  if (new Set(authorityOrder).size !== authorityOrder.length) {
    throw new Error('authorityOrder contains duplicates');
  }
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'TruthRuleV1'),
    ruleId: exactId(raw.ruleId, 'ruleId'),
    factClass: exactId(raw.factClass, 'factClass'),
    authorityOrder,
    maxAgeMs: boundedInteger(raw.maxAgeMs, 'maxAgeMs', 0, MAX_AGE_MS, 0),
  });
}

const SOURCE_KEYS = new Set([
  'schemaVersion',
  'sourceId',
  'authorityClass',
  'available',
  'refreshable',
  'revisionId',
  'contentSha256',
  'observedAt',
  'validUntil',
]);

export function normalizeTruthSourceStateV1(input) {
  const raw = plain(input, 'TruthSourceStateV1');
  exactKeys(raw, SOURCE_KEYS, 'TruthSourceStateV1');
  const sourceId = exactId(raw.sourceId, 'sourceId');
  const authorityClass = exactId(raw.authorityClass, 'authorityClass');
  const available = bool(raw.available, 'available');
  const refreshable = bool(raw.refreshable, 'refreshable');

  const hasRevision = raw.revisionId != null && raw.revisionId !== '';
  const hasDigest = raw.contentSha256 != null && raw.contentSha256 !== '';
  const hasObservedAt = raw.observedAt != null && raw.observedAt !== '';
  if (hasRevision !== hasDigest || hasRevision !== hasObservedAt) {
    throw new Error('revisionId, contentSha256 and observedAt must be provided together');
  }
  if (!hasRevision && raw.validUntil != null && raw.validUntil !== '') {
    throw new Error('validUntil requires observed evidence');
  }

  const revisionId = hasRevision ? exactId(raw.revisionId, 'revisionId') : '';
  const contentSha256 = hasDigest ? digest(raw.contentSha256, 'contentSha256') : '';
  const observedAt = hasObservedAt ? canonicalTimestamp(raw.observedAt, 'observedAt') : '';
  const validUntil = raw.validUntil == null || raw.validUntil === ''
    ? ''
    : canonicalTimestamp(raw.validUntil, 'validUntil');

  if (observedAt && validUntil && Date.parse(validUntil) < Date.parse(observedAt)) {
    throw new Error('validUntil cannot predate observedAt');
  }

  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'TruthSourceStateV1'),
    sourceId,
    authorityClass,
    available,
    refreshable,
    revisionId,
    contentSha256,
    observedAt,
    validUntil,
  });
}

function isFresh(state, rule, asOfMs) {
  if (!state.observedAt) return false;
  const observedMs = Date.parse(state.observedAt);
  if (state.validUntil && asOfMs > Date.parse(state.validUntil)) return false;
  if (rule.maxAgeMs > 0 && asOfMs - observedMs > rule.maxAgeMs) return false;
  return true;
}

function evidenceProjection(state, rank) {
  return deepFreeze({
    sourceId: state.sourceId,
    authorityClass: state.authorityClass,
    authorityRank: rank,
    revisionId: state.revisionId,
    contentSha256: state.contentSha256,
    observedAt: state.observedAt,
    validUntil: state.validUntil,
  });
}

function refreshProjection(state, reasonCode) {
  return deepFreeze({
    sourceId: state.sourceId,
    authorityClass: state.authorityClass,
    reasonCode,
    executionAuthorized: false,
  });
}

function attentionProjection(factId, factClass, kind, reasonCode, sourceIds) {
  return deepFreeze({
    dedupeKey: `truth:${factId}`,
    kind,
    factId,
    factClass,
    reasonCode,
    sourceIds: [...sourceIds].sort(asciiCompare),
    attentionItemAuthorized: false,
    decisionAuthorized: false,
  });
}

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'factId',
  'factClass',
  'asOf',
  'rule',
  'sourceStates',
]);

export function arbitrateTruthFactV1(input) {
  const raw = plain(input, 'TruthArbitrationRequestV1');
  exactKeys(raw, REQUEST_KEYS, 'TruthArbitrationRequestV1');
  version(raw.schemaVersion, 'TruthArbitrationRequestV1');
  const factId = exactId(raw.factId, 'factId');
  const factClass = exactId(raw.factClass, 'factClass');
  const asOf = canonicalTimestamp(raw.asOf, 'asOf');
  const asOfMs = Date.parse(asOf);
  const rule = normalizeTruthRuleV1(raw.rule);
  if (rule.factClass !== factClass) throw new Error('factClass does not match TruthRuleV1');

  const states = dataArray(raw.sourceStates, 'sourceStates', MAX_SOURCES)
    .map(normalizeTruthSourceStateV1);
  const sourceIds = new Set();
  const rankByAuthority = new Map(rule.authorityOrder.map((authorityClass, rank) => [authorityClass, rank]));
  for (const state of states) {
    if (sourceIds.has(state.sourceId)) throw new Error('sourceStates contains duplicate sourceId');
    sourceIds.add(state.sourceId);
    if (!rankByAuthority.has(state.authorityClass)) {
      throw new Error(`source ${state.sourceId} uses authorityClass outside TruthRuleV1`);
    }
    if (state.observedAt && Date.parse(state.observedAt) > asOfMs) {
      throw new Error(`source ${state.sourceId} observation is from the future`);
    }
  }

  const orderedStates = [...states].sort((a, b) =>
    rankByAuthority.get(a.authorityClass) - rankByAuthority.get(b.authorityClass)
      || asciiCompare(a.sourceId, b.sourceId));

  const fresh = orderedStates.filter(state => isFresh(state, rule, asOfMs));
  const bestFreshRank = fresh.length
    ? Math.min(...fresh.map(state => rankByAuthority.get(state.authorityClass)))
    : null;
  const available = orderedStates.filter(state => state.available);
  const highestAvailableRank = available.length
    ? Math.min(...available.map(state => rankByAuthority.get(state.authorityClass)))
    : null;

  if (highestAvailableRank != null
      && (bestFreshRank == null || highestAvailableRank < bestFreshRank)) {
    const highestAvailable = available.filter(
      state => rankByAuthority.get(state.authorityClass) === highestAvailableRank,
    );
    const refreshable = highestAvailable.filter(state => state.refreshable);
    if (refreshable.length) {
      return deepFreeze({
        schemaVersion: TruthArbitrationContractVersion,
        factId,
        factClass,
        ruleId: rule.ruleId,
        asOf,
        status: TruthResolutionStatus.REFRESH_REQUIRED,
        canonical: null,
        refreshRequests: refreshable
          .map(state => refreshProjection(state, 'HIGHER_AUTHORITY_STALE_OR_MISSING'))
          .sort((a, b) => asciiCompare(a.sourceId, b.sourceId)),
        conflicts: [],
        overriddenDisagreements: [],
        unavailableHigherAuthoritySourceIds: [],
        attention: null,
      });
    }
    return deepFreeze({
      schemaVersion: TruthArbitrationContractVersion,
      factId,
      factClass,
      ruleId: rule.ruleId,
      asOf,
      status: TruthResolutionStatus.UNAVAILABLE,
      canonical: null,
      refreshRequests: [],
      conflicts: [],
      overriddenDisagreements: [],
      unavailableHigherAuthoritySourceIds: [],
      attention: attentionProjection(
        factId,
        factClass,
        'TRUTH_UNAVAILABLE',
        'HIGHER_AUTHORITY_REFRESH_UNAVAILABLE',
        highestAvailable.map(state => state.sourceId),
      ),
    });
  }

  if (bestFreshRank == null) {
    return deepFreeze({
      schemaVersion: TruthArbitrationContractVersion,
      factId,
      factClass,
      ruleId: rule.ruleId,
      asOf,
      status: TruthResolutionStatus.UNAVAILABLE,
      canonical: null,
      refreshRequests: [],
      conflicts: [],
      overriddenDisagreements: [],
      unavailableHigherAuthoritySourceIds: [],
      attention: attentionProjection(
        factId,
        factClass,
        'TRUTH_UNAVAILABLE',
        'NO_FRESH_AUTHORITY_EVIDENCE',
        orderedStates.map(state => state.sourceId),
      ),
    });
  }

  const selectedRankStates = fresh.filter(
    state => rankByAuthority.get(state.authorityClass) === bestFreshRank,
  );
  const hashes = new Set(selectedRankStates.map(state => state.contentSha256));
  if (hashes.size > 1) {
    const conflicts = selectedRankStates
      .map(state => evidenceProjection(state, bestFreshRank))
      .sort((a, b) => asciiCompare(a.sourceId, b.sourceId));
    const refreshRequests = selectedRankStates
      .filter(state => state.available && state.refreshable)
      .map(state => refreshProjection(state, 'CONFLICT_RECHECK'))
      .sort((a, b) => asciiCompare(a.sourceId, b.sourceId));
    return deepFreeze({
      schemaVersion: TruthArbitrationContractVersion,
      factId,
      factClass,
      ruleId: rule.ruleId,
      asOf,
      status: TruthResolutionStatus.CONFLICT,
      canonical: null,
      refreshRequests,
      conflicts,
      overriddenDisagreements: [],
      unavailableHigherAuthoritySourceIds: [],
      attention: attentionProjection(
        factId,
        factClass,
        'TRUTH_CONFLICT',
        'EQUAL_AUTHORITY_CONFLICT',
        conflicts.map(item => item.sourceId),
      ),
    });
  }

  const selected = [...selectedRankStates].sort((a, b) => {
    const timeDelta = Date.parse(b.observedAt) - Date.parse(a.observedAt);
    return timeDelta || asciiCompare(a.sourceId, b.sourceId);
  })[0];
  const canonical = evidenceProjection(selected, bestFreshRank);

  const overriddenDisagreements = fresh
    .filter(state =>
      rankByAuthority.get(state.authorityClass) > bestFreshRank
      && state.contentSha256 !== selected.contentSha256)
    .map(state => deepFreeze({
      ...evidenceProjection(state, rankByAuthority.get(state.authorityClass)),
      overriddenByAuthority: true,
    }))
    .sort((a, b) =>
      a.authorityRank - b.authorityRank || asciiCompare(a.sourceId, b.sourceId));

  const unavailableHigherAuthoritySourceIds = orderedStates
    .filter(state =>
      rankByAuthority.get(state.authorityClass) < bestFreshRank && !state.available)
    .map(state => state.sourceId)
    .sort(asciiCompare);

  return deepFreeze({
    schemaVersion: TruthArbitrationContractVersion,
    factId,
    factClass,
    ruleId: rule.ruleId,
    asOf,
    status: TruthResolutionStatus.RESOLVED,
    canonical,
    refreshRequests: [],
    conflicts: [],
    overriddenDisagreements,
    unavailableHigherAuthoritySourceIds,
    attention: null,
  });
}
