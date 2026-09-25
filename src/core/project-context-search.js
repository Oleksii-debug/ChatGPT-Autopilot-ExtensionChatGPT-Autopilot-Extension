import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
  SourceAuthorityKind,
} from './project-context-artifact.js';
import { deriveProjectCurrentStateV1 } from './project-current-state.js';

export const ProjectContextSearchVersion = 1;
const MAX_CANDIDATES = 128;
const MAX_RESULTS = 32;
const MAX_QUERY = 512;
const MAX_ALLOWED_IDS = 128;
const MAX_CURRENT_SOURCES = 512;
const AUTHORITY_RANK = Object.freeze({
  [SourceAuthorityKind.ADVISORY]: 1,
  [SourceAuthorityKind.DERIVED]: 2,
  [SourceAuthorityKind.CANONICAL]: 3,
});

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const AUTHORITIES = new Set(Object.values(SourceAuthorityKind));
const CANDIDATE_KEYS = new Set(['snapshot', 'capsule', 'currentSourceRefs']);

function denseDataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
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
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} entries must be enumerable own data properties`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function snapshotCandidate(value, index) {
  const label = `candidates[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !CANDIDATE_KEYS.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
  }
  if (Object.hasOwn(out, 'currentSourceRefs')) {
    throw new Error(`${label} must not inject currentSourceRefs`);
  }
  if (!Object.hasOwn(out, 'snapshot') || !Object.hasOwn(out, 'capsule')) {
    throw new Error(`${label} must contain snapshot and capsule`);
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must contain exact canonical ids`);
  }
  return value;
}

function boundedIds(value, label) {
  const out = denseDataArray(value, label, MAX_ALLOWED_IDS)
    .map((item, index) => exactId(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) {
    throw new Error(`${label} must contain unique exact canonical ids`);
  }
  return new Set(out);
}

function boundedAuthorities(value) {
  const items = denseDataArray(value, 'allowedAuthorities', 3);
  const out = items.map((authority, index) => {
    if (typeof authority !== 'string'
        || authority !== authority.trim()
        || !AUTHORITIES.has(authority)) {
      throw new Error(`allowedAuthorities[${index}] must be an exact SourceAuthorityKind`);
    }
    return authority;
  });
  if (new Set(out).size !== out.length) {
    throw new Error('allowedAuthorities must not contain duplicates');
  }
  return new Set(out);
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function queryTokens(query) {
  if (typeof query !== 'string') throw new Error('query must be text');
  const normalized = query.trim().toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > MAX_QUERY) throw new Error('query is invalid');
  const tokens = [...new Set(normalized.split(/[^\p{L}\p{N}._:@/+~-]+/u).filter(Boolean))];
  if (!tokens.length || tokens.length > 32) throw new Error('query has no bounded searchable tokens');
  return tokens;
}

// Search is deliberately limited to provenance/identity fields whose visibility is
// established by the explicit source permission envelope. Capsule summary and
// arbitrary source metadata are content, not authority-bearing identity; exposing
// or indexing them requires a separate content-visibility authority and therefore
// stays outside this conservative retrieval boundary.
function searchableText(snapshot, capsule, admittedSources) {
  const sourceText = admittedSources.map(source => [
    source.sourceId, source.kind, source.uri, source.revisionId, source.authority,
  ].join(' ')).join(' ');
  return `${snapshot.title} ${snapshot.projectId} ${snapshot.revisionId} ${capsule.capsuleId} ${sourceText}`.toLocaleLowerCase('en-US');
}

function candidateScore(text, tokens) {
  let score = 0;
  for (const token of tokens) {
    if (!text.includes(token)) return 0;
    score += text.split(token).length - 1;
  }
  return score;
}

function sourceIdentityMatches(snapshotSource, currentSource) {
  return snapshotSource.kind === currentSource.kind
    && snapshotSource.uri === currentSource.uri
    && snapshotSource.authority === currentSource.authority
    && snapshotSource.revisionId === currentSource.revisionId
    && (!snapshotSource.contentSha256 || snapshotSource.contentSha256 === currentSource.contentSha256);
}

function currentSourceKey(source) {
  return `${source.projectId}\u001f${source.sourceId}`;
}

export function searchProjectContextV1({
  query,
  candidates = [],
  currentSourceRefs,
  allowedSourceIds,
  allowedAuthorities = [SourceAuthorityKind.CANONICAL, SourceAuthorityKind.DERIVED, SourceAuthorityKind.ADVISORY],
  limit = 8,
} = {}) {
  const tokens = queryTokens(query);
  const candidateRows = denseDataArray(candidates, 'candidates', MAX_CANDIDATES);
  const currentRows = denseDataArray(
    currentSourceRefs,
    'currentSourceRefs',
    MAX_CURRENT_SOURCES,
  );
  if (!Number.isSafeInteger(limit)
      || Object.is(limit, -0)
      || limit < 1
      || limit > MAX_RESULTS) {
    throw new Error('limit is invalid');
  }
  const allowedIds = boundedIds(allowedSourceIds, 'allowedSourceIds');
  const authoritySet = boundedAuthorities(allowedAuthorities);

  const normalizedCurrent = currentRows.map(normalizeProjectSourceRefV1);
  const currentByProjectAndId = new Map(normalizedCurrent.map(source => [currentSourceKey(source), source]));
  if (currentByProjectAndId.size !== normalizedCurrent.length) throw new Error('currentSourceRefs has duplicate project/source ids');

  const results = [];
  for (let index = 0; index < candidateRows.length; index += 1) {
    const raw = snapshotCandidate(candidateRows[index], index);
    const snapshot = normalizeProjectSnapshotV1(raw.snapshot);
    const capsule = normalizeContextCapsuleV1(raw.capsule);
    if (capsule.projectId !== snapshot.projectId || capsule.projectRevisionId !== snapshot.revisionId) continue;
    if (!capsule.sourceBindings.length) continue;

    const snapshotById = new Map(snapshot.sourceRefs.map(source => [source.sourceId, source]));
    const admittedSources = [];
    let permitted = true;
    let authorityFloor = 3;
    for (const binding of capsule.sourceBindings) {
      const source = currentByProjectAndId.get(`${snapshot.projectId}\u001f${binding.sourceId}`);
      const snapshotSource = snapshotById.get(binding.sourceId);
      if (!source || !snapshotSource || source.projectId !== snapshot.projectId) { permitted = false; break; }
      if (!allowedIds.has(source.sourceId)) { permitted = false; break; }
      if (!authoritySet.has(source.authority)) { permitted = false; break; }
      if (!sourceIdentityMatches(snapshotSource, source)) { permitted = false; break; }
      if (binding.revisionId !== source.revisionId || (binding.contentSha256 && binding.contentSha256 !== source.contentSha256)) {
        permitted = false; break;
      }
      admittedSources.push(source);
      authorityFloor = Math.min(authorityFloor, AUTHORITY_RANK[source.authority]);
    }
    if (!permitted) continue;

    const currentState = deriveProjectCurrentStateV1({ snapshot, capsule, currentSourceRefs: admittedSources });
    if (currentState.status !== 'FRESH') continue;
    const score = candidateScore(searchableText(snapshot, capsule, admittedSources), tokens);
    if (!score) continue;
    results.push(frozen({
      schemaVersion: ProjectContextSearchVersion,
      projectId: snapshot.projectId,
      projectRevisionId: snapshot.revisionId,
      capsuleId: capsule.capsuleId,
      score,
      authorityFloor,
      sourceBindings: capsule.sourceBindings,
      advisoryOnly: true,
    }));
  }

  results.sort((a, b) =>
    b.authorityFloor - a.authorityFloor
    || b.score - a.score
    || codeUnitCompare(a.capsuleId, b.capsuleId));
  return frozen({
    schemaVersion: ProjectContextSearchVersion,
    query: query.trim(),
    resultCount: Math.min(results.length, limit),
    truncated: results.length > limit,
    results: results.slice(0, limit),
  });
}
