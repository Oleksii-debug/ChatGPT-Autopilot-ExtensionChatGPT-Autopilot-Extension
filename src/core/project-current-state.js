import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
} from './project-context-artifact.js';

export const ProjectCurrentStateVersion = 1;

const MAX_SOURCES = 128;
const MAX_ARTIFACTS = 128;

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function bounded(value, label, max, normalize) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`);
  return value.map((item, index) => {
    try { return normalize(item); }
    catch (error) { throw new Error(`${label}[${index}]: ${error.message}`); }
  });
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${key}: ${value}`);
    seen.add(value);
  }
  return items;
}

function artifactIdentity(ref) {
  return `${ref.artifactId}:${ref.sha256 || ''}:${ref.sizeBytes}`;
}

export function deriveProjectCurrentStateV1({ snapshot, capsule, currentSourceRefs = [] } = {}) {
  const normalizedSnapshot = normalizeProjectSnapshotV1(snapshot);
  const normalizedCapsule = normalizeContextCapsuleV1(capsule);
  if (normalizedCapsule.projectId !== normalizedSnapshot.projectId) {
    throw new Error('Context capsule projectId does not match project snapshot');
  }
  if (normalizedCapsule.projectRevisionId !== normalizedSnapshot.revisionId) {
    throw new Error('Context capsule projectRevisionId does not match project snapshot revisionId');
  }

  const current = unique(
    bounded(currentSourceRefs, 'currentSourceRefs', MAX_SOURCES, normalizeProjectSourceRefV1),
    'sourceId',
    'currentSourceRefs',
  );
  for (const source of current) {
    if (source.projectId !== normalizedSnapshot.projectId) {
      throw new Error(`currentSourceRefs projectId mismatch: ${source.sourceId}`);
    }
  }

  const snapshotSources = new Map(normalizedSnapshot.sourceRefs.map(source => [source.sourceId, source]));
  const capsuleBindings = new Map(normalizedCapsule.sourceBindings.map(binding => [binding.sourceId, binding]));
  const currentSources = new Map(current.map(source => [source.sourceId, source]));
  const sourceIds = [...new Set([
    ...snapshotSources.keys(),
    ...capsuleBindings.keys(),
    ...currentSources.keys(),
  ])].sort();

  if (sourceIds.length > MAX_SOURCES) throw new Error('combined source identity set is too large');

  const sources = sourceIds.map(sourceId => {
    const snapshotSource = snapshotSources.get(sourceId) || null;
    const capsuleBinding = capsuleBindings.get(sourceId) || null;
    const currentSource = currentSources.get(sourceId) || null;
    const reasons = [];

    if (!snapshotSource) reasons.push('NOT_IN_SNAPSHOT');
    if (!capsuleBinding) reasons.push('NOT_IN_CAPSULE');
    if (!currentSource) reasons.push('CURRENT_SOURCE_MISSING');

    if (snapshotSource && capsuleBinding) {
      if (snapshotSource.revisionId !== capsuleBinding.revisionId) reasons.push('CAPSULE_REVISION_DIFFERS_FROM_SNAPSHOT');
      if (capsuleBinding.contentSha256 && snapshotSource.contentSha256 !== capsuleBinding.contentSha256) {
        reasons.push('CAPSULE_HASH_DIFFERS_FROM_SNAPSHOT');
      }
    }
    if (snapshotSource && currentSource) {
      if (snapshotSource.revisionId !== currentSource.revisionId) reasons.push('CURRENT_REVISION_DIFFERS_FROM_SNAPSHOT');
      if (snapshotSource.contentSha256 && snapshotSource.contentSha256 !== currentSource.contentSha256) {
        reasons.push('CURRENT_HASH_DIFFERS_FROM_SNAPSHOT');
      }
    }
    if (capsuleBinding && currentSource) {
      if (capsuleBinding.revisionId !== currentSource.revisionId) reasons.push('CURRENT_REVISION_DIFFERS_FROM_CAPSULE');
      if (capsuleBinding.contentSha256 && capsuleBinding.contentSha256 !== currentSource.contentSha256) {
        reasons.push('CURRENT_HASH_DIFFERS_FROM_CAPSULE');
      }
    }

    return frozen({
      sourceId,
      status: reasons.length ? 'STALE' : 'FRESH',
      reasons,
      snapshotRevisionId: snapshotSource?.revisionId || null,
      capsuleRevisionId: capsuleBinding?.revisionId || null,
      currentRevisionId: currentSource?.revisionId || null,
    });
  });

  const snapshotArtifacts = unique(normalizedSnapshot.artifactRefs, 'artifactId', 'snapshot.artifactRefs');
  const capsuleArtifacts = unique(normalizedCapsule.artifactRefs, 'artifactId', 'capsule.artifactRefs');
  if (snapshotArtifacts.length > MAX_ARTIFACTS || capsuleArtifacts.length > MAX_ARTIFACTS) {
    throw new Error('artifactRefs are too large');
  }
  const snapshotArtifactMap = new Map(snapshotArtifacts.map(ref => [ref.artifactId, ref]));
  const capsuleArtifactMap = new Map(capsuleArtifacts.map(ref => [ref.artifactId, ref]));
  const artifactIds = [...new Set([...snapshotArtifactMap.keys(), ...capsuleArtifactMap.keys()])].sort();
  if (artifactIds.length > MAX_ARTIFACTS) throw new Error('combined artifact identity set is too large');

  const artifacts = artifactIds.map(artifactId => {
    const snapshotArtifact = snapshotArtifactMap.get(artifactId) || null;
    const capsuleArtifact = capsuleArtifactMap.get(artifactId) || null;
    let status = 'MATCH';
    if (!snapshotArtifact) status = 'CAPSULE_ONLY';
    else if (!capsuleArtifact) status = 'SNAPSHOT_ONLY';
    else if (artifactIdentity(snapshotArtifact) !== artifactIdentity(capsuleArtifact)) status = 'IDENTITY_DRIFT';
    return frozen({ artifactId, status });
  });

  const staleSourceCount = sources.filter(source => source.status !== 'FRESH').length;
  const artifactDriftCount = artifacts.filter(artifact => artifact.status !== 'MATCH').length;
  return frozen({
    schemaVersion: ProjectCurrentStateVersion,
    projectId: normalizedSnapshot.projectId,
    projectRevisionId: normalizedSnapshot.revisionId,
    status: staleSourceCount || artifactDriftCount ? 'STALE' : 'FRESH',
    staleSourceCount,
    artifactDriftCount,
    sources,
    artifacts,
  });
}
