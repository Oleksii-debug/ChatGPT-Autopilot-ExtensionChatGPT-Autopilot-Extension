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

const AT = '2026-09-20T18:36:00.000Z';

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


test('Project/Context contracts reject type-coerced identities, versions and authority', () => {
  assert.throws(() => normalizeProjectSourceRefV1(source({ schemaVersion: '1' })), /schemaVersion/);
  assert.throws(() => normalizeProjectSourceRefV1(source({ schemaVersion: true })), /schemaVersion/);
  assert.throws(() => normalizeProjectSourceRefV1(source({ sourceId: 1 })), /sourceId must be text/);
  assert.throws(() => normalizeProjectSourceRefV1(source({ projectId: true })), /projectId must be text/);
  assert.throws(() => normalizeProjectSourceRefV1(source({ revisionId: 1 })), /revisionId must be text/);
  assert.throws(() => normalizeProjectSourceRefV1(source({ authority: 1 })), /authority must be text/);
  assert.throws(() => normalizeProjectSourceRefV1(source({ contentSha256: 1 })), /contentSha256 must be text/);
  assert.throws(() => normalizeContextCapsuleV1(capsule({ schemaVersion: '1' })), /schemaVersion/);
});

test('Project/Context provenance requires exact canonical primitive representations', () => {
  assert.throws(
    () => normalizeProjectSourceRefV1(source({ sourceId: ' github-main' })),
    /sourceId is invalid/,
  );
  assert.throws(
    () => normalizeProjectSourceRefV1(source({ revisionId: 'commit-7249c934 ' })),
    /revisionId is invalid/,
  );
  assert.throws(
    () => normalizeProjectSourceRefV1(source({ contentSha256: 'A'.repeat(64) })),
    /contentSha256 is invalid/,
  );
  assert.throws(
    () => normalizeProjectSourceRefV1(source({ authority: 'canonical' })),
    /authority is invalid/,
  );
  assert.throws(
    () => normalizeProjectSourceRefV1(source({ observedAt: '2026-09-20T18:36:00Z' })),
    /canonical ISO-8601 UTC representation/,
  );

  assert.throws(
    () => normalizeProjectSnapshotV1({
      schemaVersion: 1,
      projectId: 'autopilot ',
      revisionId: 'project-rev-1',
      title: 'ChatGPT Autopilot Extension',
      sourceRefs: [source()],
      artifactRefs: [artifact()],
      createdAt: AT,
    }),
    /projectId is invalid/,
  );

  assert.throws(
    () => normalizeContextCapsuleV1(capsule({ projectRevisionId: 'project-rev-1 ' })),
    /projectRevisionId is invalid/,
  );
  assert.throws(
    () => normalizeContextCapsuleV1(capsule({ createdAt: '2026-09-20T18:36:00Z' })),
    /canonical ISO-8601 UTC representation/,
  );

  const exact = normalizeProjectSourceRefV1(source());
  assert.equal(exact.sourceId, 'github-main');
  assert.equal(exact.contentSha256, 'a'.repeat(64));
  assert.equal(exact.authority, SourceAuthorityKind.CANONICAL);
  assert.equal(exact.observedAt, AT);
});

test('Project/Context contracts reject exotic prototype authority and identity inheritance', () => {
  const inherited = Object.create(source());
  assert.throws(() => normalizeProjectSourceRefV1(inherited), /plain object/);

  const inheritedCapsule = Object.create(capsule());
  assert.throws(() => normalizeContextCapsuleV1(inheritedCapsule), /plain object/);

  const nullPrototype = Object.assign(Object.create(null), source());
  const normalized = normalizeProjectSourceRefV1(nullPrototype);
  assert.equal(normalized.sourceId, 'github-main');
  assert.equal(normalized.authority, 'CANONICAL');
});


test('Project/Context optional list fields reject falsy type aliases instead of erasing caller intent', () => {
  const snapshotBase = {
    schemaVersion: 1,
    projectId: 'autopilot',
    revisionId: 'project-rev-1',
    title: 'ChatGPT Autopilot Extension',
    sourceRefs: [source()],
    createdAt: AT,
  };
  for (const bad of [false, 0, '']) {
    assert.throws(
      () => normalizeProjectSnapshotV1({ ...snapshotBase, artifactRefs: bad }),
      /bounded plain array/,
    );
    assert.throws(
      () => normalizeContextCapsuleV1(capsule({ artifactRefs: bad })),
      /bounded plain array/,
    );
    assert.throws(
      () => normalizeArtifactProvenanceV1({
        schemaVersion: 1,
        projectId: 'autopilot',
        artifactRef: artifact(),
        sourceBindings: bad,
        inputArtifactIds: [],
        createdAt: AT,
      }),
      /bounded plain array/,
    );
    assert.throws(
      () => normalizeArtifactProvenanceV1({
        schemaVersion: 1,
        projectId: 'autopilot',
        artifactRef: artifact(),
        sourceBindings: [],
        inputArtifactIds: bad,
        createdAt: AT,
      }),
      /bounded plain array/,
    );
  }

  assert.doesNotThrow(() => normalizeProjectSnapshotV1(snapshotBase));
  assert.doesNotThrow(() => normalizeProjectSnapshotV1({ ...snapshotBase, artifactRefs: null }));
  assert.doesNotThrow(() => normalizeContextCapsuleV1(capsule({ artifactRefs: null })));
  assert.doesNotThrow(() => normalizeArtifactProvenanceV1({
    schemaVersion: 1,
    projectId: 'autopilot',
    artifactRef: artifact(),
    createdAt: AT,
  }));
});

test('Project/Context record accessors are rejected without executing getter authority', () => {
  let reads = 0;
  const raw = source();
  Object.defineProperty(raw, 'authority', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return SourceAuthorityKind.CANONICAL;
    },
  });

  assert.throws(
    () => normalizeProjectSourceRefV1(raw),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);
});

test('Project/Context hidden and symbol fields fail closed even when the field name is otherwise allowed', () => {
  const hidden = source();
  Object.defineProperty(hidden, 'authority', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: SourceAuthorityKind.CANONICAL,
  });
  assert.throws(
    () => normalizeProjectSourceRefV1(hidden),
    /enumerable own data properties/,
  );

  const symbolic = source();
  symbolic[Symbol('authority')] = SourceAuthorityKind.CANONICAL;
  assert.throws(
    () => normalizeProjectSourceRefV1(symbolic),
    /unknown field/,
  );
});

test('Project/Context arrays reject accessor indices and side fields without executing getters', () => {
  let reads = 0;
  const refs = [source()];
  Object.defineProperty(refs, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return source();
    },
  });
  assert.throws(
    () => normalizeProjectSnapshotV1({
      schemaVersion: 1,
      projectId: 'autopilot',
      revisionId: 'project-rev-1',
      title: 'ChatGPT Autopilot Extension',
      sourceRefs: refs,
      artifactRefs: [],
      createdAt: AT,
    }),
    /data properties/,
  );
  assert.equal(reads, 0);

  const withSideField = [source()];
  Object.defineProperty(withSideField, 'authority', {
    enumerable: false,
    configurable: true,
    value: 'ALLOW',
  });
  assert.throws(
    () => normalizeProjectSnapshotV1({
      schemaVersion: 1,
      projectId: 'autopilot',
      revisionId: 'project-rev-1',
      title: 'ChatGPT Autopilot Extension',
      sourceRefs: withSideField,
      artifactRefs: [],
      createdAt: AT,
    }),
    /non-index field/,
  );
});

test('Project source metadata recursively rejects accessors without executing them', () => {
  let reads = 0;
  const nested = {};
  Object.defineProperty(nested, 'secret', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'must-not-run';
    },
  });
  const raw = source({ metadata: { nested } });
  assert.throws(
    () => normalizeProjectSourceRefV1(raw),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);
});

test('nested ArtifactRef is descriptor-snapshotted before canonical normalization', () => {
  let reads = 0;
  const ref = artifact();
  Object.defineProperty(ref, 'sensitive', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return false;
    },
  });
  assert.throws(
    () => normalizeContextCapsuleV1(capsule({ artifactRefs: [ref] })),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);
});
