import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveProjectCurrentStateV1 } from '../src/core/project-current-state.js';

const AT = '2026-09-20T19:37:00Z';

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
