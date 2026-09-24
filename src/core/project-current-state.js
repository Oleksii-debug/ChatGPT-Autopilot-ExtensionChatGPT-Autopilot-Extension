import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
} from './project-context-artifact.js';

export const ProjectCurrentStateVersion = 1;
export const ProjectCurrentStateDigestVersion = 1;

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
      if (snapshotSource.kind !== currentSource.kind) reasons.push('CURRENT_KIND_DIFFERS_FROM_SNAPSHOT');
      if (snapshotSource.uri !== currentSource.uri) reasons.push('CURRENT_URI_DIFFERS_FROM_SNAPSHOT');
      if (snapshotSource.authority !== currentSource.authority) reasons.push('CURRENT_AUTHORITY_DIFFERS_FROM_SNAPSHOT');
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


function sourceStateFingerprint(source, sourceRef) {
  if (!source) return null;
  return JSON.stringify([
    source.status,
    source.reasons,
    source.snapshotRevisionId,
    source.capsuleRevisionId,
    source.currentRevisionId,
    sourceRef?.kind || null,
    sourceRef?.uri || null,
    sourceRef?.authority || null,
    sourceRef?.contentSha256 || '',
  ]);
}

function digestSourceView(source, sourceRef) {
  if (!source) return null;
  return frozen({
    status: source.status,
    kind: sourceRef?.kind || null,
    uri: sourceRef?.uri || null,
    authority: sourceRef?.authority || null,
    contentSha256: sourceRef?.contentSha256 || '',
    snapshotRevisionId: source.snapshotRevisionId,
    capsuleRevisionId: source.capsuleRevisionId,
    currentRevisionId: source.currentRevisionId,
  });
}

function artifactChangeIdentity(ref) {
  if (!ref) return null;
  return JSON.stringify([
    ref.kind,
    ref.uri,
    ref.mediaType,
    ref.sha256 || '',
    ref.sizeBytes,
    ref.producerInvocationId || '',
    Boolean(ref.sensitive),
  ]);
}

function digestArtifactView(ref) {
  if (!ref) return null;
  return frozen({
    kind: ref.kind,
    uri: ref.uri,
    mediaType: ref.mediaType,
    sha256: ref.sha256 || '',
    sizeBytes: ref.sizeBytes,
    producerInvocationId: ref.producerInvocationId || '',
    sensitive: Boolean(ref.sensitive),
  });
}

function staleEvidence(state, phase) {
  return state.sources
    .filter(source => source.status !== 'FRESH')
    .map(source => frozen({
      phase,
      sourceId: source.sourceId,
      reasons: source.reasons,
      snapshotRevisionId: source.snapshotRevisionId,
      capsuleRevisionId: source.capsuleRevisionId,
      currentRevisionId: source.currentRevisionId,
    }));
}

function artifactDriftEvidence(state, phase) {
  return state.artifacts
    .filter(artifact => artifact.status !== 'MATCH')
    .map(artifact => frozen({
      phase,
      artifactId: artifact.artifactId,
      status: artifact.status,
    }));
}

export function deriveProjectCurrentStateDigestV1({ baseline, current } = {}) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('baseline must be a project current-state input object');
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('current must be a project current-state input object');
  }

  const baselineSnapshot = normalizeProjectSnapshotV1(baseline.snapshot);
  const baselineCapsule = normalizeContextCapsuleV1(baseline.capsule);
  const currentSnapshot = normalizeProjectSnapshotV1(current.snapshot);
  const currentCapsule = normalizeContextCapsuleV1(current.capsule);

  if (baselineSnapshot.projectId !== currentSnapshot.projectId) {
    throw new Error('baseline and current projectId must match');
  }

  const baselineState = deriveProjectCurrentStateV1({
    snapshot: baselineSnapshot,
    capsule: baselineCapsule,
    currentSourceRefs: baseline.currentSourceRefs,
  });
  const currentState = deriveProjectCurrentStateV1({
    snapshot: currentSnapshot,
    capsule: currentCapsule,
    currentSourceRefs: current.currentSourceRefs,
  });

  const base = {
    schemaVersion: ProjectCurrentStateDigestVersion,
    projectId: currentSnapshot.projectId,
    advisoryOnly: true,
    fromProjectRevisionId: baselineSnapshot.revisionId,
    toProjectRevisionId: currentSnapshot.revisionId,
    fromCapsuleId: baselineCapsule.capsuleId,
    toCapsuleId: currentCapsule.capsuleId,
    projectRevisionChanged: baselineSnapshot.revisionId !== currentSnapshot.revisionId,
    baselineStatus: baselineState.status,
    currentStatus: currentState.status,
  };

  if (baselineState.status !== 'FRESH' || currentState.status !== 'FRESH') {
    return frozen({
      ...base,
      status: 'STALE_INPUT',
      changeViewAvailable: false,
      sourceChanges: [],
      artifactChanges: [],
      staleEvidence: [
        ...staleEvidence(baselineState, 'BASELINE'),
        ...staleEvidence(currentState, 'CURRENT'),
      ],
      artifactDriftEvidence: [
        ...artifactDriftEvidence(baselineState, 'BASELINE'),
        ...artifactDriftEvidence(currentState, 'CURRENT'),
      ],
    });
  }

  const baselineSources = new Map(baselineState.sources.map(source => [source.sourceId, source]));
  const currentSources = new Map(currentState.sources.map(source => [source.sourceId, source]));
  const baselineSourceRefs = new Map(baselineSnapshot.sourceRefs.map(source => [source.sourceId, source]));
  const currentSourceRefs = new Map(currentSnapshot.sourceRefs.map(source => [source.sourceId, source]));
  const sourceIds = [...new Set([...baselineSources.keys(), ...currentSources.keys()])].sort();
  const sourceChanges = [];
  for (const sourceId of sourceIds) {
    const before = baselineSources.get(sourceId) || null;
    const after = currentSources.get(sourceId) || null;
    let change = 'UNCHANGED';
    if (!before) change = 'ADDED';
    else if (!after) change = 'REMOVED';
    else if (
      sourceStateFingerprint(before, baselineSourceRefs.get(sourceId))
      !== sourceStateFingerprint(after, currentSourceRefs.get(sourceId))
    ) change = 'CHANGED';
    if (change === 'UNCHANGED') continue;
    sourceChanges.push(frozen({
      sourceId,
      change,
      before: digestSourceView(before, baselineSourceRefs.get(sourceId)),
      after: digestSourceView(after, currentSourceRefs.get(sourceId)),
    }));
  }

  const baselineArtifacts = new Map(baselineSnapshot.artifactRefs.map(ref => [ref.artifactId, ref]));
  const currentArtifacts = new Map(currentSnapshot.artifactRefs.map(ref => [ref.artifactId, ref]));
  const artifactIds = [...new Set([...baselineArtifacts.keys(), ...currentArtifacts.keys()])].sort();
  const artifactChanges = [];
  for (const artifactId of artifactIds) {
    const before = baselineArtifacts.get(artifactId) || null;
    const after = currentArtifacts.get(artifactId) || null;
    let change = 'UNCHANGED';
    if (!before) change = 'ADDED';
    else if (!after) change = 'REMOVED';
    else if (artifactChangeIdentity(before) !== artifactChangeIdentity(after)) change = 'CHANGED';
    if (change === 'UNCHANGED') continue;
    artifactChanges.push(frozen({
      artifactId,
      change,
      before: digestArtifactView(before),
      after: digestArtifactView(after),
    }));
  }

  return frozen({
    ...base,
    status: base.projectRevisionChanged || sourceChanges.length || artifactChanges.length ? 'CHANGED' : 'UNCHANGED',
    changeViewAvailable: true,
    sourceChanges,
    artifactChanges,
    staleEvidence: [],
    artifactDriftEvidence: [],
  });
}
