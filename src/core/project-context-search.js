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

function boundedIds(value, label) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_IDS) throw new Error(`${label} must be a bounded array`);
  const out = value.map(item => String(item ?? '').trim()).filter(Boolean);
  if (out.length !== value.length || new Set(out).size !== out.length) throw new Error(`${label} must contain unique non-empty ids`);
  return new Set(out);
}

function queryTokens(query) {
  if (typeof query !== 'string') throw new Error('query must be text');
  const normalized = query.trim().toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > MAX_QUERY) throw new Error('query is invalid');
  const tokens = [...new Set(normalized.split(/[^\p{L}\p{N}._:@/+~-]+/u).filter(Boolean))];
  if (!tokens.length || tokens.length > 32) throw new Error('query has no bounded searchable tokens');
  return tokens;
}

function searchableText(snapshot, capsule, sources) {
  const sourceText = sources.map(source => [
    source.sourceId, source.kind, source.uri, source.revisionId, source.authority,
    JSON.stringify(source.metadata || {}),
  ].join(' ')).join(' ');
  return `${snapshot.title} ${snapshot.projectId} ${snapshot.revisionId} ${capsule.summary} ${capsule.capsuleId} ${sourceText}`.toLocaleLowerCase('en-US');
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

export function searchProjectContextV1({
  query,
  candidates = [],
  allowedSourceIds = null,
  allowedAuthorities = [SourceAuthorityKind.CANONICAL, SourceAuthorityKind.DERIVED, SourceAuthorityKind.ADVISORY],
  limit = 8,
} = {}) {
  const tokens = queryTokens(query);
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) throw new Error('candidates must be a bounded array');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error('limit is invalid');
  const allowedIds = boundedIds(allowedSourceIds, 'allowedSourceIds');
  if (!Array.isArray(allowedAuthorities) || allowedAuthorities.length > 3) throw new Error('allowedAuthorities must be bounded');
  const authoritySet = new Set(allowedAuthorities.map(value => String(value || '').toUpperCase()));
  for (const authority of authoritySet) {
    if (!(authority in AUTHORITY_RANK)) throw new Error(`Unsupported authority: ${authority}`);
  }

  const results = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const raw = candidates[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`candidates[${index}] must be an object`);
    const snapshot = normalizeProjectSnapshotV1(raw.snapshot);
    const capsule = normalizeContextCapsuleV1(raw.capsule);
    const currentSourceRefs = Array.isArray(raw.currentSourceRefs)
      ? raw.currentSourceRefs.map(normalizeProjectSourceRefV1)
      : [];
    if (capsule.projectId !== snapshot.projectId || capsule.projectRevisionId !== snapshot.revisionId) continue;

    const currentById = new Map(currentSourceRefs.map(source => [source.sourceId, source]));
    if (currentById.size !== currentSourceRefs.length) throw new Error(`candidates[${index}] has duplicate current source ids`);
    const snapshotById = new Map(snapshot.sourceRefs.map(source => [source.sourceId, source]));
    let permitted = true;
    let authorityFloor = 3;
    for (const binding of capsule.sourceBindings) {
      const source = currentById.get(binding.sourceId);
      const snapshotSource = snapshotById.get(binding.sourceId);
      if (!source || !snapshotSource || source.projectId !== snapshot.projectId) { permitted = false; break; }
      if (allowedIds && !allowedIds.has(source.sourceId)) { permitted = false; break; }
      if (!authoritySet.has(source.authority)) { permitted = false; break; }
      if (!sourceIdentityMatches(snapshotSource, source)) { permitted = false; break; }
      if (binding.revisionId !== source.revisionId || (binding.contentSha256 && binding.contentSha256 !== source.contentSha256)) {
        permitted = false; break;
      }
      authorityFloor = Math.min(authorityFloor, AUTHORITY_RANK[source.authority]);
    }
    if (!permitted) continue;

    const currentState = deriveProjectCurrentStateV1({ snapshot, capsule, currentSourceRefs });
    if (currentState.status !== 'FRESH') continue;
    const score = candidateScore(searchableText(snapshot, capsule, currentSourceRefs), tokens);
    if (!score) continue;
    results.push(frozen({
      schemaVersion: ProjectContextSearchVersion,
      projectId: snapshot.projectId,
      projectRevisionId: snapshot.revisionId,
      capsuleId: capsule.capsuleId,
      score,
      authorityFloor,
      sourceBindings: capsule.sourceBindings,
      artifactRefs: capsule.artifactRefs,
      summary: capsule.summary,
      advisoryOnly: true,
    }));
  }

  results.sort((a, b) => b.authorityFloor - a.authorityFloor || b.score - a.score || a.capsuleId.localeCompare(b.capsuleId));
  return frozen({
    schemaVersion: ProjectContextSearchVersion,
    query: query.trim(),
    resultCount: Math.min(results.length, limit),
    truncated: results.length > limit,
    results: results.slice(0, limit),
  });
}
