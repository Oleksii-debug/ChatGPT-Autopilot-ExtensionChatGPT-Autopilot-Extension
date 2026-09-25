import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
} from './project-context-artifact.js';

export const ProjectCurrentStateVersion = 1;
export const ProjectCurrentStateDigestVersion = 1;

const MAX_SOURCES = 128;
const MAX_ARTIFACTS = 128;

const CURRENT_STATE_REQUEST_KEYS = new Set(['snapshot', 'capsule', 'currentSourceRefs']);
const CURRENT_STATE_DIGEST_REQUEST_KEYS = new Set(['baseline', 'current', 'allowedSourceIds']);

function strictRecord(input, allowedKeys, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const values = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function denseArray(input, label, max) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be an explicit bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be an explicit bounded array`);
  }
  const result = new Array(lengthDescriptor.value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains an invalid array property`);
    }
    const index = Number(key);
    if (index >= lengthDescriptor.value) {
      throw new Error(`${label} contains an out-of-range array property`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} items must be enumerable own data properties`);
    }
    result[index] = descriptor.value;
  }
  for (let index = 0; index < result.length; index += 1) {
    if (!Object.hasOwn(result, index)) throw new Error(`${label} must be a dense array`);
  }
  return result;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function bounded(value, label, max, normalize) {
  return denseArray(value, label, max).map((item, index) => {
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

function boundedVisibilityIds(value, label = 'allowedSourceIds') {
  const ids = denseArray(value, label, MAX_SOURCES).map(item => {
    if (typeof item !== 'string') throw new Error(`${label} must contain string ids`);
    if (!item || item !== item.trim()) {
      throw new Error(`${label} must contain exact non-empty ids`);
    }
    return item;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} must contain unique non-empty ids`);
  }
  return new Set(ids);
}

function artifactIdentity(ref) {
  return `${ref.artifactId}:${ref.sha256 || ''}:${ref.sizeBytes}`;
}

export function deriveProjectCurrentStateV1(input = {}) {
  const request = strictRecord(input, CURRENT_STATE_REQUEST_KEYS, 'ProjectCurrentStateV1 request');
  const snapshot = request.snapshot;
  const capsule = request.capsule;
  const currentSourceRefs = request.currentSourceRefs === undefined ? [] : request.currentSourceRefs;
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
  if (ref.sensitive) {
    return frozen({
      sensitive: true,
      redacted: true,
    });
  }
  return frozen({
    kind: ref.kind,
    mediaType: ref.mediaType,
    sha256: ref.sha256 || '',
    sizeBytes: ref.sizeBytes,
    sensitive: false,
    redacted: false,
  });
}

function staleEvidence(state, phase, allowedSourceIds) {
  return state.sources
    .filter(source => source.status !== 'FRESH' && allowedSourceIds.has(source.sourceId))
    .map(source => frozen({
      phase,
      sourceId: source.sourceId,
      reasons: source.reasons,
      snapshotRevisionId: source.snapshotRevisionId,
      capsuleRevisionId: source.capsuleRevisionId,
      currentRevisionId: source.currentRevisionId,
    }));
}

function hiddenStaleSourceCount(state, allowedSourceIds) {
  return state.sources.filter(source => source.status !== 'FRESH' && !allowedSourceIds.has(source.sourceId)).length;
}

function sensitiveArtifactIds(snapshot, capsule) {
  const ids = new Set();
  for (const ref of [...snapshot.artifactRefs, ...capsule.artifactRefs]) {
    if (ref.sensitive) ids.add(ref.artifactId);
  }
  return ids;
}

function artifactDriftEvidence(state, phase, hiddenArtifactIds) {
  return state.artifacts
    .filter(artifact => artifact.status !== 'MATCH' && !hiddenArtifactIds.has(artifact.artifactId))
    .map(artifact => frozen({
      phase,
      artifactId: artifact.artifactId,
      status: artifact.status,
    }));
}

function hiddenArtifactDriftCount(state, hiddenArtifactIds) {
  return state.artifacts.filter(
    artifact => artifact.status !== 'MATCH' && hiddenArtifactIds.has(artifact.artifactId),
  ).length;
}

export function deriveProjectCurrentStateDigestV1(input = {}) {
  const request = strictRecord(
    input,
    CURRENT_STATE_DIGEST_REQUEST_KEYS,
    'ProjectCurrentStateDigestV1 request',
  );
  const baseline = strictRecord(request.baseline, CURRENT_STATE_REQUEST_KEYS, 'baseline');
  const current = strictRecord(request.current, CURRENT_STATE_REQUEST_KEYS, 'current');
  const allowedIds = boundedVisibilityIds(request.allowedSourceIds);

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
  const baselineSensitiveArtifacts = sensitiveArtifactIds(baselineSnapshot, baselineCapsule);
  const currentSensitiveArtifacts = sensitiveArtifactIds(currentSnapshot, currentCapsule);

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
    visibilityBound: true,
  };

  if (baselineState.status !== 'FRESH' || currentState.status !== 'FRESH') {
    return frozen({
      ...base,
      status: 'STALE_INPUT',
      changeViewAvailable: false,
      sourceChanges: [],
      artifactChanges: [],
      staleEvidence: [
        ...staleEvidence(baselineState, 'BASELINE', allowedIds),
        ...staleEvidence(currentState, 'CURRENT', allowedIds),
      ],
      hiddenStaleSourceCount:
        hiddenStaleSourceCount(baselineState, allowedIds)
        + hiddenStaleSourceCount(currentState, allowedIds),
      artifactDriftEvidence: [
        ...artifactDriftEvidence(baselineState, 'BASELINE', baselineSensitiveArtifacts),
        ...artifactDriftEvidence(currentState, 'CURRENT', currentSensitiveArtifacts),
      ],
      hiddenSensitiveArtifactDriftCount:
        hiddenArtifactDriftCount(baselineState, baselineSensitiveArtifacts)
        + hiddenArtifactDriftCount(currentState, currentSensitiveArtifacts),
    });
  }

  const baselineSources = new Map(baselineState.sources.map(source => [source.sourceId, source]));
  const currentSources = new Map(currentState.sources.map(source => [source.sourceId, source]));
  const baselineSourceRefs = new Map(baselineSnapshot.sourceRefs.map(source => [source.sourceId, source]));
  const currentSourceRefs = new Map(currentSnapshot.sourceRefs.map(source => [source.sourceId, source]));
  const sourceIds = [...new Set([...baselineSources.keys(), ...currentSources.keys()])].sort();
  const sourceChanges = [];
  let totalSourceChangeCount = 0;
  let hiddenSourceChangeCount = 0;
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
    totalSourceChangeCount += 1;
    if (!allowedIds.has(sourceId)) {
      hiddenSourceChangeCount += 1;
      continue;
    }
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
  let totalArtifactChangeCount = 0;
  let hiddenSensitiveArtifactChangeCount = 0;
  for (const artifactId of artifactIds) {
    const before = baselineArtifacts.get(artifactId) || null;
    const after = currentArtifacts.get(artifactId) || null;
    let change = 'UNCHANGED';
    if (!before) change = 'ADDED';
    else if (!after) change = 'REMOVED';
    else if (artifactChangeIdentity(before) !== artifactChangeIdentity(after)) change = 'CHANGED';
    if (change === 'UNCHANGED') continue;
    totalArtifactChangeCount += 1;
    if (before?.sensitive || after?.sensitive) {
      hiddenSensitiveArtifactChangeCount += 1;
      continue;
    }
    artifactChanges.push(frozen({
      artifactId,
      change,
      before: digestArtifactView(before),
      after: digestArtifactView(after),
    }));
  }

  return frozen({
    ...base,
    status: base.projectRevisionChanged || totalSourceChangeCount || totalArtifactChangeCount ? 'CHANGED' : 'UNCHANGED',
    changeViewAvailable: true,
    totalSourceChangeCount,
    visibleSourceChangeCount: sourceChanges.length,
    hiddenSourceChangeCount,
    sourceChanges,
    totalArtifactChangeCount,
    visibleArtifactChangeCount: artifactChanges.length,
    hiddenSensitiveArtifactChangeCount,
    artifactChanges,
    staleEvidence: [],
    hiddenStaleSourceCount: 0,
    artifactDriftEvidence: [],
    hiddenSensitiveArtifactDriftCount: 0,
  });
}
