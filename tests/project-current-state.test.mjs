import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveProjectCurrentStateDigestV1, deriveProjectCurrentStateV1 } from '../src/core/project-current-state.js';

const AT = '2026-09-20T19:37:00.000Z';

function source(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: 'github-main',
    projectId: 'autopilot',
    kind: 'github-repository',
    uri: 'github://Oleksii-debug/autopilot/main',
    revisionId: 'commit-1',
    contentSha256: 'a'.repeat(64),
    observedAt: AT,
    authority: 'CANONICAL',
    metadata: {},
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'report',
    kind: 'report',
    uri: 'artifact://report',
    mediaType: 'text/plain',
    sha256: 'b'.repeat(64),
    sizeBytes: 10,
    createdAt: AT,
    producerInvocationId: 'invoke-1',
    sensitive: false,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'autopilot',
    revisionId: 'project-rev-1',
    title: 'Autopilot',
    sourceRefs: [source()],
    artifactRefs: [artifact()],
    createdAt: AT,
    ...overrides,
  };
}

function capsule(overrides = {}) {
  return {
    schemaVersion: 1,
    capsuleId: 'capsule-1',
    projectId: 'autopilot',
    projectRevisionId: 'project-rev-1',
    summary: 'Current bounded context.',
    sourceBindings: [{ sourceId: 'github-main', revisionId: 'commit-1', contentSha256: 'a'.repeat(64) }],
    artifactRefs: [artifact()],
    createdAt: AT,
    ...overrides,
  };
}

test('fresh snapshot, capsule and current source derive FRESH state', () => {
  const state = deriveProjectCurrentStateV1({ snapshot: snapshot(), capsule: capsule(), currentSourceRefs: [source()] });
  assert.equal(state.status, 'FRESH');
  assert.equal(state.staleSourceCount, 0);
  assert.equal(state.artifactDriftCount, 0);
  assert.equal(state.sources[0].status, 'FRESH');
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.sources), true);
});

test('missing current source is owner-visible stale evidence rather than silently accepted freshness', () => {
  const state = deriveProjectCurrentStateV1({ snapshot: snapshot(), capsule: capsule(), currentSourceRefs: [] });
  assert.equal(state.status, 'STALE');
  assert.deepEqual(state.sources[0].reasons, ['CURRENT_SOURCE_MISSING']);
});

test('revision and content drift are distinguished against snapshot and capsule truth', () => {
  const state = deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule(),
    currentSourceRefs: [source({ revisionId: 'commit-2', contentSha256: 'c'.repeat(64) })],
  });
  assert.equal(state.status, 'STALE');
  assert.deepEqual(state.sources[0].reasons, [
    'CURRENT_REVISION_DIFFERS_FROM_SNAPSHOT',
    'CURRENT_HASH_DIFFERS_FROM_SNAPSHOT',
    'CURRENT_REVISION_DIFFERS_FROM_CAPSULE',
    'CURRENT_HASH_DIFFERS_FROM_CAPSULE',
  ]);
});

test('capsule cannot be evaluated against a different project snapshot revision', () => {
  assert.throws(() => deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule({ projectRevisionId: 'project-rev-other' }),
    currentSourceRefs: [source()],
  }), /projectRevisionId does not match/);
});

test('current sources from another project fail closed', () => {
  assert.throws(() => deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule(),
    currentSourceRefs: [source({ projectId: 'other-project' })],
  }), /projectId mismatch/);
});

test('artifact digest/size drift is surfaced without creating artifact storage authority', () => {
  const state = deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule({ artifactRefs: [artifact({ sha256: 'd'.repeat(64) })] }),
    currentSourceRefs: [source()],
  });
  assert.equal(state.status, 'STALE');
  assert.equal(state.artifactDriftCount, 1);
  assert.deepEqual(state.artifacts, [{ artifactId: 'report', status: 'IDENTITY_DRIFT' }]);
});

test('snapshot-only and capsule-only artifacts are explicit drift states', () => {
  const snapshotOnly = deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule({ artifactRefs: [] }),
    currentSourceRefs: [source()],
  });
  assert.deepEqual(snapshotOnly.artifacts, [{ artifactId: 'report', status: 'SNAPSHOT_ONLY' }]);

  const capsuleOnly = deriveProjectCurrentStateV1({
    snapshot: snapshot({ artifactRefs: [] }),
    capsule: capsule(),
    currentSourceRefs: [source()],
  });
  assert.deepEqual(capsuleOnly.artifacts, [{ artifactId: 'report', status: 'CAPSULE_ONLY' }]);
});

test('duplicate current source identity fails closed', () => {
  assert.throws(() => deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule(),
    currentSourceRefs: [source(), source()],
  }), /duplicate sourceId/);
});


function stateInput({ snapshotValue = snapshot(), capsuleValue = capsule(), currentSources = [source()] } = {}) {
  return { snapshot: snapshotValue, capsule: capsuleValue, currentSourceRefs: currentSources };
}

function deriveDigest(args, allowedSourceIds = ['github-main']) {
  return deriveProjectCurrentStateDigestV1({ allowedSourceIds, ...args });
}

test('current-state rejects substituted source provenance even when revision and hash match', () => {
  const state = deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule(),
    currentSourceRefs: [source({ uri: 'github://attacker/substituted', authority: 'ADVISORY' })],
  });
  assert.equal(state.status, 'STALE');
  assert.deepEqual(state.sources[0].reasons, [
    'CURRENT_URI_DIFFERS_FROM_SNAPSHOT',
    'CURRENT_AUTHORITY_DIFFERS_FROM_SNAPSHOT',
  ]);
});

test('digest is deterministic and unchanged for the same fresh provenance-bound state', () => {
  const input = stateInput();
  const digest = deriveDigest({ baseline: input, current: input });
  assert.equal(digest.status, 'UNCHANGED');
  assert.equal(digest.changeViewAvailable, true);
  assert.equal(digest.advisoryOnly, true);
  assert.equal(digest.projectRevisionChanged, false);
  assert.deepEqual(digest.sourceChanges, []);
  assert.deepEqual(digest.artifactChanges, []);
  assert.deepEqual(digest.staleEvidence, []);
  assert.deepEqual(digest.artifactDriftEvidence, []);
  assert.equal(Object.isFrozen(digest), true);
  assert.equal(Object.isFrozen(digest.sourceChanges), true);
});

test('digest reports source revision movement across fresh project revisions', () => {
  const nextSource = source({ revisionId: 'commit-2', contentSha256: 'c'.repeat(64) });
  const nextSnapshot = snapshot({
    revisionId: 'project-rev-2',
    sourceRefs: [nextSource],
  });
  const nextCapsule = capsule({
    capsuleId: 'capsule-2',
    projectRevisionId: 'project-rev-2',
    sourceBindings: [{
      sourceId: 'github-main',
      revisionId: 'commit-2',
      contentSha256: 'c'.repeat(64),
    }],
  });

  const digest = deriveDigest({
    baseline: stateInput(),
    current: stateInput({
      snapshotValue: nextSnapshot,
      capsuleValue: nextCapsule,
      currentSources: [nextSource],
    }),
  });

  assert.equal(digest.status, 'CHANGED');
  assert.equal(digest.projectRevisionChanged, true);
  assert.deepEqual(digest.sourceChanges, [{
    sourceId: 'github-main',
    change: 'CHANGED',
    before: {
      status: 'FRESH',
      kind: 'github-repository',
      uri: 'github://Oleksii-debug/autopilot/main',
      authority: 'CANONICAL',
      contentSha256: 'a'.repeat(64),
      snapshotRevisionId: 'commit-1',
      capsuleRevisionId: 'commit-1',
      currentRevisionId: 'commit-1',
    },
    after: {
      status: 'FRESH',
      kind: 'github-repository',
      uri: 'github://Oleksii-debug/autopilot/main',
      authority: 'CANONICAL',
      contentSha256: 'c'.repeat(64),
      snapshotRevisionId: 'commit-2',
      capsuleRevisionId: 'commit-2',
      currentRevisionId: 'commit-2',
    },
  }]);
});

test('digest reports artifact identity changes while both endpoint states remain fresh', () => {
  const nextArtifact = artifact({
    sha256: 'd'.repeat(64),
    sizeBytes: 12,
    producerInvocationId: 'invoke-2',
  });
  const nextSnapshot = snapshot({
    revisionId: 'project-rev-2',
    artifactRefs: [nextArtifact],
  });
  const nextCapsule = capsule({
    capsuleId: 'capsule-2',
    projectRevisionId: 'project-rev-2',
    artifactRefs: [nextArtifact],
  });

  const digest = deriveDigest({
    baseline: stateInput(),
    current: stateInput({
      snapshotValue: nextSnapshot,
      capsuleValue: nextCapsule,
    }),
  });

  assert.equal(digest.status, 'CHANGED');
  assert.equal(digest.sourceChanges.length, 0);
  assert.deepEqual(digest.artifactChanges, [{
    artifactId: 'report',
    change: 'CHANGED',
    before: {
      kind: 'report',
      mediaType: 'text/plain',
      sha256: 'b'.repeat(64),
      sizeBytes: 10,
      sensitive: false,
      redacted: false,
    },
    after: {
      kind: 'report',
      mediaType: 'text/plain',
      sha256: 'd'.repeat(64),
      sizeBytes: 12,
      sensitive: false,
      redacted: false,
    },
  }]);
});

test('digest fails closed instead of producing a what-changed view from stale substituted sources', () => {
  const digest = deriveDigest({
    baseline: stateInput(),
    current: stateInput({
      currentSources: [source({ uri: 'github://attacker/substituted' })],
    }),
  });

  assert.equal(digest.status, 'STALE_INPUT');
  assert.equal(digest.changeViewAvailable, false);
  assert.deepEqual(digest.sourceChanges, []);
  assert.deepEqual(digest.artifactChanges, []);
  assert.deepEqual(digest.staleEvidence, [{
    phase: 'CURRENT',
    sourceId: 'github-main',
    reasons: ['CURRENT_URI_DIFFERS_FROM_SNAPSHOT'],
    snapshotRevisionId: 'commit-1',
    capsuleRevisionId: 'commit-1',
    currentRevisionId: 'commit-1',
  }]);
});

test('digest refuses cross-project comparison', () => {
  const otherSource = source({ projectId: 'other-project' });
  assert.throws(() => deriveDigest({
    baseline: stateInput(),
    current: stateInput({
      snapshotValue: snapshot({ projectId: 'other-project', sourceRefs: [otherSource] }),
      capsuleValue: capsule({ projectId: 'other-project' }),
      currentSources: [otherSource],
    }),
  }), /projectId must match/);
});


test('digest reports aligned source provenance changes even when revision and hash stay the same', () => {
  const movedSource = source({
    uri: 'github://Oleksii-debug/autopilot/renamed-main',
    authority: 'DERIVED',
  });
  const movedSnapshot = snapshot({
    revisionId: 'project-rev-2',
    sourceRefs: [movedSource],
  });
  const movedCapsule = capsule({
    capsuleId: 'capsule-2',
    projectRevisionId: 'project-rev-2',
  });

  const digest = deriveDigest({
    baseline: stateInput(),
    current: stateInput({
      snapshotValue: movedSnapshot,
      capsuleValue: movedCapsule,
      currentSources: [movedSource],
    }),
  });

  assert.equal(digest.status, 'CHANGED');
  assert.equal(digest.changeViewAvailable, true);
  assert.equal(digest.sourceChanges.length, 1);
  assert.equal(digest.sourceChanges[0].change, 'CHANGED');
  assert.equal(digest.sourceChanges[0].before.uri, 'github://Oleksii-debug/autopilot/main');
  assert.equal(digest.sourceChanges[0].after.uri, 'github://Oleksii-debug/autopilot/renamed-main');
  assert.equal(digest.sourceChanges[0].before.authority, 'CANONICAL');
  assert.equal(digest.sourceChanges[0].after.authority, 'DERIVED');
});

test('stale artifact identity suppresses what-changed and exposes explicit drift evidence', () => {
  const digest = deriveDigest({
    baseline: stateInput(),
    current: stateInput({
      capsuleValue: capsule({ artifactRefs: [artifact({ sha256: 'd'.repeat(64) })] }),
    }),
  });

  assert.equal(digest.status, 'STALE_INPUT');
  assert.equal(digest.changeViewAvailable, false);
  assert.deepEqual(digest.artifactChanges, []);
  assert.deepEqual(digest.artifactDriftEvidence, [{
    phase: 'CURRENT',
    artifactId: 'report',
    status: 'IDENTITY_DRIFT',
  }]);
});


test('digest requires an explicit source visibility envelope', () => {
  const input = stateInput();
  assert.throws(() => deriveProjectCurrentStateDigestV1({
    baseline: input,
    current: input,
  }), /allowedSourceIds must be an explicit bounded array/);
});

test('unadmitted source provenance changes are classified without disclosing source identity or location', () => {
  const baselineSource = source({
    sourceId: 'private-source',
    uri: 'github://private.example/secret-old',
  });
  const currentSource = source({
    sourceId: 'private-source',
    uri: 'github://private.example/secret-new',
  });
  const baselineInput = stateInput({
    snapshotValue: snapshot({ sourceRefs: [baselineSource] }),
    capsuleValue: capsule({
      sourceBindings: [{
        sourceId: 'private-source',
        revisionId: 'commit-1',
        contentSha256: 'a'.repeat(64),
      }],
    }),
    currentSources: [baselineSource],
  });
  const currentInput = stateInput({
    snapshotValue: snapshot({ revisionId: 'project-rev-2', sourceRefs: [currentSource] }),
    capsuleValue: capsule({
      capsuleId: 'capsule-2',
      projectRevisionId: 'project-rev-2',
      sourceBindings: [{
        sourceId: 'private-source',
        revisionId: 'commit-1',
        contentSha256: 'a'.repeat(64),
      }],
    }),
    currentSources: [currentSource],
  });

  const result = deriveDigest({ baseline: baselineInput, current: currentInput }, []);
  assert.equal(result.status, 'CHANGED');
  assert.equal(result.totalSourceChangeCount, 1);
  assert.equal(result.visibleSourceChangeCount, 0);
  assert.equal(result.hiddenSourceChangeCount, 1);
  assert.deepEqual(result.sourceChanges, []);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('private-source'), false);
  assert.equal(serialized.includes('private.example'), false);
  assert.equal(serialized.includes('secret-old'), false);
  assert.equal(serialized.includes('secret-new'), false);
});

test('sensitive artifact changes never expose identity, location or producer provenance', () => {
  const oldArtifact = artifact({
    artifactId: 'secret-artifact-id',
    uri: 'artifact://secret/location-old',
    producerInvocationId: 'secret-producer-old',
    sensitive: true,
  });
  const newArtifact = artifact({
    artifactId: 'secret-artifact-id',
    uri: 'artifact://secret/location-new',
    producerInvocationId: 'secret-producer-new',
    sha256: 'd'.repeat(64),
    sensitive: true,
  });

  const result = deriveDigest({
    baseline: stateInput({
      snapshotValue: snapshot({ artifactRefs: [oldArtifact] }),
      capsuleValue: capsule({ artifactRefs: [oldArtifact] }),
    }),
    current: stateInput({
      snapshotValue: snapshot({ revisionId: 'project-rev-2', artifactRefs: [newArtifact] }),
      capsuleValue: capsule({
        capsuleId: 'capsule-2',
        projectRevisionId: 'project-rev-2',
        artifactRefs: [newArtifact],
      }),
    }),
  });

  assert.equal(result.status, 'CHANGED');
  assert.equal(result.totalArtifactChangeCount, 1);
  assert.equal(result.visibleArtifactChangeCount, 0);
  assert.equal(result.hiddenSensitiveArtifactChangeCount, 1);
  assert.deepEqual(result.artifactChanges, []);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('secret-artifact-id'), false);
  assert.equal(serialized.includes('artifact://secret'), false);
  assert.equal(serialized.includes('secret-producer'), false);
});

test('unadmitted stale source evidence is hidden while staleness remains owner-visible', () => {
  const result = deriveDigest({
    baseline: stateInput(),
    current: stateInput({
      currentSources: [source({ uri: 'github://private.example/substituted' })],
    }),
  }, []);

  assert.equal(result.status, 'STALE_INPUT');
  assert.equal(result.changeViewAvailable, false);
  assert.deepEqual(result.staleEvidence, []);
  assert.equal(result.hiddenStaleSourceCount, 1);
  assert.equal(JSON.stringify(result).includes('private.example'), false);
});


test('sensitive artifact drift evidence is aggregated without artifact identity disclosure', () => {
  const sensitiveSnapshotArtifact = artifact({
    artifactId: 'secret-drift-artifact',
    uri: 'artifact://secret/drift-snapshot',
    producerInvocationId: 'secret-drift-producer',
    sensitive: true,
  });
  const sensitiveCapsuleArtifact = {
    ...sensitiveSnapshotArtifact,
    sha256: 'e'.repeat(64),
    uri: 'artifact://secret/drift-capsule',
  };

  const result = deriveDigest({
    baseline: stateInput(),
    current: stateInput({
      snapshotValue: snapshot({
        revisionId: 'project-rev-2',
        artifactRefs: [sensitiveSnapshotArtifact],
      }),
      capsuleValue: capsule({
        capsuleId: 'capsule-2',
        projectRevisionId: 'project-rev-2',
        artifactRefs: [sensitiveCapsuleArtifact],
      }),
    }),
  });

  assert.equal(result.status, 'STALE_INPUT');
  assert.equal(result.changeViewAvailable, false);
  assert.deepEqual(result.artifactDriftEvidence, []);
  assert.equal(result.hiddenSensitiveArtifactDriftCount, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('secret-drift-artifact'), false);
  assert.equal(serialized.includes('artifact://secret'), false);
  assert.equal(serialized.includes('secret-drift-producer'), false);
});


test('current-state visibility envelope rejects type-coerced source identities', () => {
  const input = stateInput();
  assert.throws(() => deriveProjectCurrentStateDigestV1({
    baseline: input,
    current: input,
    allowedSourceIds: [1],
  }), /string ids/);
  assert.throws(() => deriveProjectCurrentStateDigestV1({
    baseline: input,
    current: input,
    allowedSourceIds: [true],
  }), /string ids/);
});


test('visibility envelope requires exact source-id spelling instead of trimming aliases', () => {
  const input = stateInput();
  assert.throws(() => deriveProjectCurrentStateDigestV1({
    baseline: input,
    current: input,
    allowedSourceIds: [' github-main'],
  }), /exact non-empty ids/);
  assert.throws(() => deriveProjectCurrentStateDigestV1({
    baseline: input,
    current: input,
    allowedSourceIds: ['github-main '],
  }), /exact non-empty ids/);
});

test('current-state request rejects accessor, hidden, symbol and exotic fields before value getters run', () => {
  let getterCalls = 0;
  const accessorRequest = {
    capsule: capsule(),
    currentSourceRefs: [source()],
  };
  Object.defineProperty(accessorRequest, 'snapshot', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return snapshot();
    },
  });
  assert.throws(
    () => deriveProjectCurrentStateV1(accessorRequest),
    /enumerable own data properties/,
  );
  assert.equal(getterCalls, 0);

  const hidden = { snapshot: snapshot(), capsule: capsule(), currentSourceRefs: [source()] };
  Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true });
  assert.throws(() => deriveProjectCurrentStateV1(hidden), /unknown field/);

  const symbol = { snapshot: snapshot(), capsule: capsule(), currentSourceRefs: [source()] };
  symbol[Symbol('authority')] = true;
  assert.throws(() => deriveProjectCurrentStateV1(symbol), /unknown field/);

  const exotic = Object.create({ inherited: true });
  Object.assign(exotic, { snapshot: snapshot(), capsule: capsule(), currentSourceRefs: [source()] });
  assert.throws(() => deriveProjectCurrentStateV1(exotic), /plain record/);
});

test('current-state and visibility arrays reject sparse or accessor-backed items without executing getters', () => {
  const sparseSources = new Array(1);
  assert.throws(() => deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule(),
    currentSourceRefs: sparseSources,
  }), /dense array/);

  let sourceGetterCalls = 0;
  const accessorSources = [];
  Object.defineProperty(accessorSources, '0', {
    enumerable: true,
    configurable: true,
    get() {
      sourceGetterCalls += 1;
      return source();
    },
  });
  accessorSources.length = 1;
  assert.throws(() => deriveProjectCurrentStateV1({
    snapshot: snapshot(),
    capsule: capsule(),
    currentSourceRefs: accessorSources,
  }), /enumerable own data properties/);
  assert.equal(sourceGetterCalls, 0);

  let visibilityGetterCalls = 0;
  const accessorVisibility = [];
  Object.defineProperty(accessorVisibility, '0', {
    enumerable: true,
    configurable: true,
    get() {
      visibilityGetterCalls += 1;
      return 'github-main';
    },
  });
  accessorVisibility.length = 1;
  const input = stateInput();
  assert.throws(() => deriveProjectCurrentStateDigestV1({
    baseline: input,
    current: input,
    allowedSourceIds: accessorVisibility,
  }), /enumerable own data properties/);
  assert.equal(visibilityGetterCalls, 0);
});

test('digest snapshots outer and nested state-input records before reading fields', () => {
  const input = stateInput();
  let outerGetterCalls = 0;
  const request = {
    baseline: input,
    current: input,
  };
  Object.defineProperty(request, 'allowedSourceIds', {
    enumerable: true,
    get() {
      outerGetterCalls += 1;
      return ['github-main'];
    },
  });
  assert.throws(
    () => deriveProjectCurrentStateDigestV1(request),
    /enumerable own data properties/,
  );
  assert.equal(outerGetterCalls, 0);

  let nestedGetterCalls = 0;
  const hostileBaseline = {
    snapshot: snapshot(),
    currentSourceRefs: [source()],
  };
  Object.defineProperty(hostileBaseline, 'capsule', {
    enumerable: true,
    get() {
      nestedGetterCalls += 1;
      return capsule();
    },
  });
  assert.throws(() => deriveProjectCurrentStateDigestV1({
    baseline: hostileBaseline,
    current: input,
    allowedSourceIds: ['github-main'],
  }), /enumerable own data properties/);
  assert.equal(nestedGetterCalls, 0);
});
