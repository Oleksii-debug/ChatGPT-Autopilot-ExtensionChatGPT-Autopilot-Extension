import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SourceAuthorityKind,
  assertContextCapsuleFreshV1,
  normalizeArtifactProvenanceV1,
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
  sourceBindingFromRefV1,
} from '../src/core/project-context-artifact.js';

const AT = '2026-09-20T18:36:00Z';

function source(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: 'github-main',
    projectId: 'autopilot',
    kind: 'github-repository',
    uri: 'github://Oleksii-debug/autopilot/main',
    revisionId: 'commit-7249c934',
    contentSha256: 'a'.repeat(64),
    observedAt: AT,
    authority: SourceAuthorityKind.CANONICAL,
    metadata: { branch: 'main' },
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'artifact-report',
    kind: 'report',
    uri: 'artifact://autopilot/report.json',
    mediaType: 'application/json',
    sha256: 'b'.repeat(64),
    sizeBytes: 123,
    createdAt: AT,
    producerInvocationId: 'invoke-1',
    sensitive: false,
    ...overrides,
  };
}

function capsule(overrides = {}) {
  return {
    schemaVersion: 1,
    capsuleId: 'capsule-1',
    projectId: 'autopilot',
    projectRevisionId: 'project-rev-1',
    summary: 'Bounded project continuation context.',
    sourceBindings: [sourceBindingFromRefV1(source())],
    artifactRefs: [artifact()],
    createdAt: AT,
    ...overrides,
  };
}

test('ProjectSourceRefV1 binds source identity to exact observed revision and authority', () => {
  const value = normalizeProjectSourceRefV1(source());
  assert.equal(value.revisionId, 'commit-7249c934');
  assert.equal(value.authority, 'CANONICAL');
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.metadata), true);

  assert.throws(() => normalizeProjectSourceRefV1(source({ authority: 'OWNERISH' })), /authority/);
  assert.throws(() => normalizeProjectSourceRefV1(source({ contentSha256: 'bad' })), /contentSha256/);
  assert.throws(() => normalizeProjectSourceRefV1({ ...source(), token: 'secret' }), /unknown field/);
});

test('ProjectSnapshotV1 rejects cross-project and duplicate source identity', () => {
  const value = normalizeProjectSnapshotV1({
    schemaVersion: 1,
    projectId: 'autopilot',
    revisionId: 'project-rev-1',
    title: 'ChatGPT Autopilot Extension',
    sourceRefs: [source()],
    artifactRefs: [artifact()],
    createdAt: AT,
  });
  assert.equal(value.sourceRefs.length, 1);
  assert.equal(value.artifactRefs[0].artifactId, 'artifact-report');

  assert.throws(() => normalizeProjectSnapshotV1({
    ...value,
    sourceRefs: [source(), source({ revisionId: 'commit-other' })],
  }), /duplicate sourceId/);

  assert.throws(() => normalizeProjectSnapshotV1({
    ...value,
    sourceRefs: [source({ projectId: 'other-project' })],
  }), /projectId mismatch/);
});

test('ContextCapsuleV1 contains bounded revision bindings instead of implicit fresh truth', () => {
  const value = normalizeContextCapsuleV1(capsule());
  assert.equal(value.sourceBindings[0].sourceId, 'github-main');
  assert.equal(value.sourceBindings[0].revisionId, 'commit-7249c934');
  assert.equal(Object.isFrozen(value.sourceBindings), true);

  assert.throws(() => normalizeContextCapsuleV1(capsule({
    sourceBindings: [
      { sourceId: 'github-main', revisionId: 'r1', contentSha256: 'a'.repeat(64) },
      { sourceId: 'github-main', revisionId: 'r2', contentSha256: 'a'.repeat(64) },
    ],
  })), /duplicate sourceId/);
});

test('Context capsule freshness requires exact current source revision and optional content hash', () => {
  const value = capsule();
  assert.equal(
    assertContextCapsuleFreshV1(value, [source()]).capsuleId,
    'capsule-1',
  );

  assert.throws(() => assertContextCapsuleFreshV1(value, [
    source({ revisionId: 'commit-newer' }),
  ]), /stale for sources: github-main/);

  assert.throws(() => assertContextCapsuleFreshV1(value, [
    source({ contentSha256: 'c'.repeat(64) }),
  ]), /stale for sources: github-main/);

  assert.throws(() => assertContextCapsuleFreshV1(value, []), /stale for sources: github-main/);
});

test('ArtifactProvenanceV1 preserves source-revision lineage and input artifact identity', () => {
  const value = normalizeArtifactProvenanceV1({
    schemaVersion: 1,
    projectId: 'autopilot',
    artifactRef: artifact(),
    sourceBindings: [sourceBindingFromRefV1(source())],
    inputArtifactIds: ['artifact-input-1', 'artifact-input-2'],
    createdAt: AT,
  });
  assert.equal(value.artifactRef.artifactId, 'artifact-report');
  assert.deepEqual(value.inputArtifactIds, ['artifact-input-1', 'artifact-input-2']);
  assert.equal(Object.isFrozen(value.artifactRef), true);

  assert.throws(() => normalizeArtifactProvenanceV1({
    ...value,
    inputArtifactIds: ['artifact-input-1', 'artifact-input-1'],
  }), /duplicates/);
});

test('sourceBindingFromRefV1 strips source metadata and authority down to immutable revision truth', () => {
  const binding = sourceBindingFromRefV1(source({
    metadata: { branch: 'main', noisy: 'not copied' },
    authority: SourceAuthorityKind.ADVISORY,
  }));
  assert.deepEqual(Object.keys(binding), ['sourceId', 'revisionId', 'contentSha256']);
  assert.equal(binding.sourceId, 'github-main');
  assert.equal(binding.contentSha256, 'a'.repeat(64));
});
