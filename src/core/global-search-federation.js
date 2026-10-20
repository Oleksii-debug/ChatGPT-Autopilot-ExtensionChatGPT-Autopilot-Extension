export const GlobalSearchFederationVersion = 1;

export const GlobalSearchDomain = Object.freeze({
  PROJECT: 'PROJECT',
  GITHUB: 'GITHUB',
  DRIVE: 'DRIVE',
  GMAIL: 'GMAIL',
  BROWSER: 'BROWSER',
  LOCAL_FILE: 'LOCAL_FILE',
  ARTIFACT: 'ARTIFACT',
  EXECUTION: 'EXECUTION',
});

const DOMAINS = new Set(Object.values(GlobalSearchDomain));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_QUERY = 2_000;
const MAX_URI = 4_096;
const MAX_TITLE = 1_000;
const MAX_PROVIDER_RESULTS = 32;
const MAX_HITS_PER_PROVIDER = 128;
const MAX_RESULTS = 100;
const RRF_SCALE = 1_000_000;
const RRF_K = 60;

const HIT_KEYS = new Set([
  'schemaVersion', 'hitId', 'sourceId', 'revisionId', 'uri', 'title',
  'observedAt', 'rank', 'contentSha256',
]);
const PROVIDER_RESULT_KEYS = new Set([
  'schemaVersion', 'searchId', 'query', 'providerId', 'domain', 'visibilityScopeId',
  'queriedAt', 'completedAt', 'hits',
]);
const ADMISSION_KEYS = new Set(['providerId', 'domain', 'visibilityScopeId']);
const FUSION_KEYS = new Set([
  'schemaVersion', 'searchId', 'query', 'providerResults', 'admittedSearchScopes', 'limit',
]);

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(length)
      || length < 0
      || length > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }

  const allowedKeys = new Set(['length']);
  for (let index = 0; index < length; index += 1) allowedKeys.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains non-canonical array property: ${String(key)}`);
    }
  }

  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out[index] = descriptor.value;
  }
  return out;
}
function version(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value !== GlobalSearchFederationVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return GlobalSearchFederationVersion;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function text(value, label, max) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalUri(value) {
  const uri = text(value, 'uri', MAX_URI);
  if (/[\u0000-\u001F\u007F]/u.test(uri)) throw new Error('uri is invalid');
  return uri;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a canonical timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function digest(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error('contentSha256 must be a lowercase SHA-256 digest');
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`);
  return value;
}

function codeUnitCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalTimestampCompare(a, b) {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (aMs < bMs) return -1;
  if (aMs > bMs) return 1;
  return 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function admissionKey(providerId, domain, visibilityScopeId) {
  return JSON.stringify([providerId, domain, visibilityScopeId]);
}

function normalizeAdmissionScopeV1(input, index) {
  const raw = snapshotRecord(input, ADMISSION_KEYS, `admittedSearchScopes[${index}]`);
  if (typeof raw.domain !== 'string' || !DOMAINS.has(raw.domain)) {
    throw new Error(`admittedSearchScopes[${index}].domain is invalid`);
  }
  return deepFreeze({
    providerId: id(raw.providerId, `admittedSearchScopes[${index}].providerId`),
    domain: raw.domain,
    visibilityScopeId: id(raw.visibilityScopeId, `admittedSearchScopes[${index}].visibilityScopeId`),
  });
}

function admittedScopeSet(value) {
  const items = denseArray(value, 'admittedSearchScopes', MAX_PROVIDER_RESULTS);
  if (!items.length) throw new Error('admittedSearchScopes must not be empty');
  const keys = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const scope = normalizeAdmissionScopeV1(items[index], index);
    const key = admissionKey(scope.providerId, scope.domain, scope.visibilityScopeId);
    if (keys.has(key)) throw new Error('admittedSearchScopes must contain unique tuples');
    keys.add(key);
  }
  return keys;
}

export function normalizeGlobalSearchHitV1(input) {
  const raw = snapshotRecord(input, HIT_KEYS, 'GlobalSearchHitV1');
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'GlobalSearchHitV1'),
    hitId: id(raw.hitId, 'hitId'),
    sourceId: id(raw.sourceId, 'sourceId'),
    revisionId: id(raw.revisionId, 'revisionId'),
    uri: canonicalUri(raw.uri),
    title: text(raw.title, 'title', MAX_TITLE),
    observedAt: canonicalTimestamp(raw.observedAt, 'observedAt'),
    rank: integer(raw.rank, 'rank', 1, MAX_HITS_PER_PROVIDER),
    contentSha256: digest(raw.contentSha256),
  });
}

export function normalizeGlobalSearchProviderResultV1(input) {
  const raw = snapshotRecord(input, PROVIDER_RESULT_KEYS, 'GlobalSearchProviderResultV1');
  if (typeof raw.domain !== 'string' || !DOMAINS.has(raw.domain)) throw new Error('domain is invalid');
  const queriedAt = canonicalTimestamp(raw.queriedAt, 'queriedAt');
  const completedAt = canonicalTimestamp(raw.completedAt, 'completedAt');
  if (Date.parse(queriedAt) > Date.parse(completedAt)) throw new Error('queriedAt cannot be later than completedAt');

  const rawHits = denseArray(raw.hits, 'hits', MAX_HITS_PER_PROVIDER);
  const hits = rawHits.map(normalizeGlobalSearchHitV1);
  const hitIds = new Set();
  const ranks = new Set();
  const sourceIdentities = new Set();
  for (const hit of hits) {
    if (Date.parse(hit.observedAt) > Date.parse(completedAt)) {
      throw new Error(`hit ${hit.hitId} observedAt cannot be later than completedAt`);
    }
    if (hitIds.has(hit.hitId)) throw new Error(`duplicate hitId: ${hit.hitId}`);
    if (ranks.has(hit.rank)) throw new Error(`duplicate provider rank: ${hit.rank}`);
    const sourceIdentity = JSON.stringify([hit.sourceId, hit.revisionId, hit.uri]);
    if (sourceIdentities.has(sourceIdentity)) throw new Error(`duplicate provider source identity: ${hit.sourceId}`);
    hitIds.add(hit.hitId);
    ranks.add(hit.rank);
    sourceIdentities.add(sourceIdentity);
  }
  hits.sort((a, b) => a.rank - b.rank || codeUnitCompare(a.hitId, b.hitId));
  for (let index = 0; index < hits.length; index += 1) {
    if (hits[index].rank !== index + 1) {
      throw new Error('provider ranks must be contiguous from 1');
    }
  }

  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'GlobalSearchProviderResultV1'),
    searchId: id(raw.searchId, 'searchId'),
    query: text(raw.query, 'query', MAX_QUERY),
    providerId: id(raw.providerId, 'providerId'),
    domain: raw.domain,
    visibilityScopeId: id(raw.visibilityScopeId, 'visibilityScopeId'),
    queriedAt,
    completedAt,
    hits,
    advisoryOnly: true,
    permissionAuthority: false,
    metadataAuthority: false,
    contentRetrievalAuthorized: false,
  });
}

function sourceKey(batch, hit) {
  return JSON.stringify([batch.domain, hit.sourceId, hit.revisionId, hit.uri]);
}

function providerBatchKey(batch) {
  return JSON.stringify([batch.providerId, batch.domain]);
}

function rrfContribution(rank) {
  return Math.floor(RRF_SCALE / (RRF_K + rank));
}

export function fuseGlobalSearchV1(input) {
  const raw = snapshotRecord(input, FUSION_KEYS, 'GlobalSearchFusionV1');
  const searchId = id(raw.searchId, 'searchId');
  const query = text(raw.query, 'query', MAX_QUERY);
  const admittedScopes = admittedScopeSet(raw.admittedSearchScopes);
  const limit = integer(raw.limit, 'limit', 1, MAX_RESULTS);
  const providerResults = denseArray(raw.providerResults, 'providerResults', MAX_PROVIDER_RESULTS)
    .map(normalizeGlobalSearchProviderResultV1);

  const batchKeys = new Set();
  const fused = new Map();
  for (const batch of providerResults) {
    if (batch.searchId !== searchId) throw new Error('provider result searchId mismatch');
    if (batch.query !== query) throw new Error('provider result query mismatch');
    const scopeKey = admissionKey(batch.providerId, batch.domain, batch.visibilityScopeId);
    if (!admittedScopes.has(scopeKey)) {
      throw new Error(`provider/domain/visibility scope tuple is not admitted: ${batch.providerId}`);
    }
    const batchKey = providerBatchKey(batch);
    if (batchKeys.has(batchKey)) throw new Error(`duplicate provider/domain batch: ${batchKey}`);
    batchKeys.add(batchKey);

    for (const hit of batch.hits) {
      const key = sourceKey(batch, hit);
      let item = fused.get(key);
      if (!item) {
        item = {
          schemaVersion: GlobalSearchFederationVersion,
          domain: batch.domain,
          sourceId: hit.sourceId,
          revisionId: hit.revisionId,
          uri: hit.uri,
          title: hit.title,
          contentSha256: hit.contentSha256,
          fusionScore: 0,
          providerCount: 0,
          bestRank: hit.rank,
          latestObservedAt: hit.observedAt,
          latestSearchCompletedAt: batch.completedAt,
          providerRefs: [],
        };
        fused.set(key, item);
      } else {
        if (item.contentSha256 && hit.contentSha256 && item.contentSha256 !== hit.contentSha256) {
          throw new Error(`conflicting content digest for source revision: ${hit.sourceId}`);
        }
        if (!item.contentSha256 && hit.contentSha256) item.contentSha256 = hit.contentSha256;
      }
      item.fusionScore += rrfContribution(hit.rank);
      item.providerCount += 1;
      item.bestRank = Math.min(item.bestRank, hit.rank);
      if (canonicalTimestampCompare(hit.observedAt, item.latestObservedAt) > 0) {
        item.latestObservedAt = hit.observedAt;
      }
      if (canonicalTimestampCompare(batch.completedAt, item.latestSearchCompletedAt) > 0) {
        item.latestSearchCompletedAt = batch.completedAt;
      }
      if (codeUnitCompare(hit.title, item.title) < 0) item.title = hit.title;
      item.providerRefs.push({
        providerId: batch.providerId,
        hitId: hit.hitId,
        contentSha256: hit.contentSha256,
        rank: hit.rank,
        visibilityScopeId: batch.visibilityScopeId,
        observedAt: hit.observedAt,
        queriedAt: batch.queriedAt,
        completedAt: batch.completedAt,
      });
    }
  }

  const results = [...fused.values()].map(item => {
    item.providerRefs.sort((a, b) => codeUnitCompare(a.providerId, b.providerId) || a.rank - b.rank || codeUnitCompare(a.hitId, b.hitId));
    return deepFreeze({
      ...item,
      providerRefs: item.providerRefs,
      advisoryOnly: true,
      permissionAuthority: false,
      metadataAuthority: false,
      contentRetrievalAuthorized: false,
      executionAuthorized: false,
      requiresCanonicalContentAdmission: true,
    });
  });

  results.sort((a, b) => b.fusionScore - a.fusionScore
    || b.providerCount - a.providerCount
    || a.bestRank - b.bestRank
    || canonicalTimestampCompare(b.latestObservedAt, a.latestObservedAt)
    || codeUnitCompare(a.domain, b.domain)
    || codeUnitCompare(a.sourceId, b.sourceId)
    || codeUnitCompare(a.revisionId, b.revisionId)
    || codeUnitCompare(a.uri, b.uri));

  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'GlobalSearchFusionV1'),
    searchId,
    query,
    providerBatchCount: providerResults.length,
    resultCount: Math.min(results.length, limit),
    truncated: results.length > limit,
    results: results.slice(0, limit),
    advisoryOnly: true,
    permissionAuthority: false,
    metadataAuthority: false,
    contentRetrievalAuthorized: false,
    executionAuthorized: false,
    requiresCanonicalContentAdmission: true,
  });
}
