import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_VERSIONS_PER_ARTIFACT,
  compareArtifactVersionsV1,
  createArtifactRegistryV1,
  getArtifactVersionV1,
  getCurrentArtifactVersionV1,
  listArtifactVersionsV1,
  normalizeArtifactRegistryV1,
  putArtifactVersionV1,
} from '../src/core/artifact-registry.js';

const hash = char => char.repeat(64);
const at = second => `2026-09-25T05:00:${String(second).padStart(2, '0')}.000Z`;

function artifact({
  artifactId = 'report',
  sha256 = hash('a'),
  sizeBytes = 10,
  createdAt = at(1),
  uri = 'project://artifact/report',
  kind = 'DOCUMENT',
  mediaType = 'text/markdown',
  producerInvocationId = 'invoke-1',
  sensitive = false,
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind,
    uri,
    mediaType,
    sha256,
    sizeBytes,
    createdAt,
    producerInvocationId,
    sensitive,
  };
}

function provenance(artifactRef, {
  projectId = 'project-a',
  sourceId = 'github-main',
  revisionId = 'commit-a',
  contentSha256 = hash('c'),
  inputArtifactIds = [],
  createdAt = at(2),
} = {}) {
  return {
    schemaVersion: 1,
    projectId,
    artifactRef,
    sourceBindings: [{ sourceId, revisionId, contentSha256 }],
    inputArtifactIds,
    createdAt,
  };
}

function version({
  projectId = 'project-a',
  versionId = 'v1',
  parentVersionId = null,
  artifactRef = artifact(),
  provenanceRef = provenance(artifactRef),
  registeredAt = at(3),
} = {}) {
  return {
    schemaVersion: 1,
    projectId,
    versionId,
    parentVersionId,
    artifactRef,
    provenance: provenanceRef,
    registeredAt,
  };
}

test('artifact registry builds immutable linear versions and deterministic metadata diff', () => {
  const empty = createArtifactRegistryV1('project-a');
  const v1 = version();
  const r1 = putArtifactVersionV1(empty, v1);
  const a2 = artifact({ sha256: hash('b'), sizeBytes: 25, createdAt: at(4) });
  const v2 = version({
    versionId: 'v2',
    parentVersionId: 'v1',
    artifactRef: a2,
    provenanceRef: provenance(a2, { revisionId: 'commit-b', contentSha256: hash('d'), createdAt: at(5) }),
    registeredAt: at(6),
  });
  const r2 = putArtifactVersionV1(r1, v2);

  assert.equal(r2.revision, 2);
  assert.equal(r2.artifacts.length, 1);
  assert.equal(r2.artifacts[0].currentVersionId, 'v2');
  assert.deepEqual(listArtifactVersionsV1(r2, 'report').map(item => item.versionId), ['v1', 'v2']);
  assert.equal(getCurrentArtifactVersionV1(r2, 'report').versionId, 'v2');
  assert.equal(getArtifactVersionV1(r2, 'report', 'v1').artifactRef.sha256, hash('a'));
  assert.equal(Object.isFrozen(r2), true);
  assert.equal(Object.isFrozen(r2.artifacts[0].versions), true);

  const diff = compareArtifactVersionsV1(v1, v2);
  assert.equal(diff.contentChanged, true);
  assert.equal(diff.sizeDeltaBytes, 15);
  assert.equal(diff.sourceBindingsChanged, true);
  assert.equal(diff.provenanceChanged, true);
  assert.equal(diff.advisoryOnly, true);
  assert.equal(diff.executionAuthorized, false);
  assert.deepEqual(diff.changedFields, ['sha256', 'sizeBytes', 'createdAt']);
});

test('exact replay is idempotent but divergent reuse of versionId fails closed', () => {
  const r1 = putArtifactVersionV1(createArtifactRegistryV1('project-a'), version());
  const replay = putArtifactVersionV1(r1, version());
  assert.equal(replay.revision, 1);
  assert.deepEqual(replay, r1);

  const divergentArtifact = artifact({ sha256: hash('b') });
  const divergent = version({
    artifactRef: divergentArtifact,
    provenanceRef: provenance(divergentArtifact),
  });
  assert.throws(
    () => putArtifactVersionV1(r1, divergent),
    /Divergent artifact version collision/,
  );
});

test('new versions must extend the current version and first versions cannot invent a parent', () => {
  const r1 = putArtifactVersionV1(createArtifactRegistryV1('project-a'), version());
  const a2 = artifact({ sha256: hash('b'), createdAt: at(4) });
  const badParent = version({
    versionId: 'v2',
    parentVersionId: 'missing',
    artifactRef: a2,
    provenanceRef: provenance(a2, { createdAt: at(5) }),
    registeredAt: at(6),
  });
  assert.throws(() => putArtifactVersionV1(r1, badParent), /parent must match currentVersionId/);

  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ versionId: 'v2', parentVersionId: 'v1' }),
    ),
    /First artifact version must not have a parent/,
  );
});

test('registry keeps artifacts deterministically ordered independent of insertion order', () => {
  const z = artifact({ artifactId: 'zeta', uri: 'project://artifact/zeta' });
  const a = artifact({ artifactId: 'alpha', uri: 'project://artifact/alpha', sha256: hash('b') });
  let registry = createArtifactRegistryV1('project-a');
  registry = putArtifactVersionV1(registry, version({
    versionId: 'z1',
    artifactRef: z,
    provenanceRef: provenance(z),
  }));
  registry = putArtifactVersionV1(registry, version({
    versionId: 'a1',
    artifactRef: a,
    provenanceRef: provenance(a),
  }));
  assert.deepEqual(registry.artifacts.map(item => item.artifactId), ['alpha', 'zeta']);
  assert.deepEqual(normalizeArtifactRegistryV1(registry), registry);
});

test('artifact version requires exact project and exact provenance artifact binding', () => {
  const ref = artifact();
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ projectId: 'project-b', provenanceRef: provenance(ref, { projectId: 'project-b' }) }),
    ),
    /projectId mismatch/,
  );

  const changedUri = artifact({ uri: 'project://artifact/other' });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: ref, provenanceRef: provenance(changedUri) }),
    ),
    /exact artifact ref/,
  );

  const changedSensitivity = artifact({ sensitive: true });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: ref, provenanceRef: provenance(changedSensitivity) }),
    ),
    /exact artifact ref/,
  );
});

test('materialization, provenance, registration and parent chronology cannot regress', () => {
  const ref = artifact({ createdAt: at(3) });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: ref, provenanceRef: provenance(ref, { createdAt: at(2) }), registeredAt: at(4) }),
    ),
    /provenance cannot predate/,
  );

  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: ref, provenanceRef: provenance(ref, { createdAt: at(4) }), registeredAt: at(3) }),
    ),
    /registration cannot predate/,
  );

  const r1 = putArtifactVersionV1(createArtifactRegistryV1('project-a'), version({ registeredAt: at(8) }));
  const ref2 = artifact({ sha256: hash('b'), createdAt: at(4) });
  assert.throws(
    () => putArtifactVersionV1(r1, version({
      versionId: 'v2',
      parentVersionId: 'v1',
      artifactRef: ref2,
      provenanceRef: provenance(ref2, { createdAt: at(5) }),
      registeredAt: at(7),
    })),
    /registration time cannot regress/,
  );
});

test('registry rejects coercive identity, digest and timestamp aliases', () => {
  assert.throws(() => createArtifactRegistryV1(' project-a'), /exact canonical identity/);

  const upperDigest = artifact({ sha256: 'A'.repeat(64) });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: upperDigest, provenanceRef: provenance(upperDigest) }),
    ),
    /lowercase SHA-256/,
  );

  const paddedId = artifact({ artifactId: 'report ' });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: paddedId, provenanceRef: provenance(paddedId) }),
    ),
    /exact canonical identity/,
  );

  const nonCanonicalTime = artifact({ createdAt: '2026-09-25T05:00:01Z' });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({
        artifactRef: nonCanonicalTime,
        provenanceRef: provenance(nonCanonicalTime),
      }),
    ),
    /canonical ISO-8601/,
  );

  const negativeZeroSize = artifact({ sizeBytes: -0 });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: negativeZeroSize, provenanceRef: provenance(negativeZeroSize) }),
    ),
    /integer in range/,
  );

  assert.throws(
    () => normalizeArtifactRegistryV1({
      schemaVersion: 1,
      projectId: 'project-a',
      revision: -0,
      artifacts: [],
    }),
    /integer in range/,
  );
});

test('registered artifacts must be materialized with a SHA-256 digest', () => {
  const ref = artifact({ sha256: '' });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: ref, provenanceRef: provenance(ref) }),
    ),
    /lowercase SHA-256/,
  );
});

test('descriptor snapshots prevent ordinary getter execution across nested version input', () => {
  let gets = 0;
  const noReads = value => new Proxy(value, {
    get(target, property, receiver) {
      gets += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const sourceBinding = noReads({
    sourceId: 'github-main',
    revisionId: 'commit-a',
    contentSha256: hash('c'),
  });
  const sourceBindings = noReads([sourceBinding]);
  const ref = noReads(artifact());
  const prov = noReads({
    schemaVersion: 1,
    projectId: 'project-a',
    artifactRef: ref,
    sourceBindings,
    inputArtifactIds: noReads([]),
    createdAt: at(2),
  });
  const candidate = noReads({
    schemaVersion: 1,
    projectId: 'project-a',
    versionId: 'v1',
    parentVersionId: null,
    artifactRef: ref,
    provenance: prov,
    registeredAt: at(3),
  });

  const registry = putArtifactVersionV1(createArtifactRegistryV1('project-a'), candidate);
  assert.equal(gets, 0);
  assert.equal(registry.artifacts[0].currentVersionId, 'v1');
});

test('accessor, hidden, symbol and sparse authority is rejected without evaluating getters', () => {
  let getterCalls = 0;
  const accessor = version();
  Object.defineProperty(accessor, 'registeredAt', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return at(3);
    },
  });
  assert.throws(
    () => putArtifactVersionV1(createArtifactRegistryV1('project-a'), accessor),
    /enumerable own data properties/,
  );
  assert.equal(getterCalls, 0);

  const hiddenRef = artifact();
  Object.defineProperty(hiddenRef, 'hiddenAuthority', { value: true, enumerable: false });
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: hiddenRef, provenanceRef: provenance(hiddenRef) }),
    ),
    /unknown field|enumerable own data properties/,
  );

  const symbolRef = artifact();
  symbolRef[Symbol('authority')] = true;
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: symbolRef, provenanceRef: provenance(symbolRef) }),
    ),
    /unknown field/,
  );

  const ref = artifact();
  const sparse = new Array(1);
  const prov = provenance(ref);
  prov.sourceBindings = sparse;
  assert.throws(
    () => putArtifactVersionV1(
      createArtifactRegistryV1('project-a'),
      version({ artifactRef: ref, provenanceRef: prov }),
    ),
    /dense data-only array/,
  );
});

test('provenance comparison detects lineage-only changes even when artifact bytes are unchanged', () => {
  const ref = artifact();
  const left = version({ provenanceRef: provenance(ref, { revisionId: 'commit-a' }) });
  const right = version({
    versionId: 'v2',
    parentVersionId: 'v1',
    provenanceRef: provenance(ref, { revisionId: 'commit-b' }),
    registeredAt: at(4),
  });
  const diff = compareArtifactVersionsV1(left, right);
  assert.equal(diff.contentChanged, false);
  assert.equal(diff.provenanceChanged, true);
  assert.equal(diff.sourceBindingsChanged, true);
  assert.deepEqual(diff.changedFields, []);
});

test('version history is explicitly bounded', () => {
  let registry = createArtifactRegistryV1('project-a');
  let parent = null;
  for (let index = 0; index < MAX_VERSIONS_PER_ARTIFACT; index += 1) {
    const versionId = `v${index}`;
    const seconds = index % 60;
    const minutes = Math.floor(index / 60);
    const timestamp = `2026-09-25T05:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.000Z`;
    const ref = artifact({
      sha256: (index % 10).toString().repeat(64),
      createdAt: timestamp,
    });
    registry = putArtifactVersionV1(registry, version({
      versionId,
      parentVersionId: parent,
      artifactRef: ref,
      provenanceRef: provenance(ref, { createdAt: timestamp }),
      registeredAt: timestamp,
    }));
    parent = versionId;
  }
  const overflowRef = artifact({ sha256: hash('f'), createdAt: '2026-09-25T05:03:00.000Z' });
  assert.throws(
    () => putArtifactVersionV1(registry, version({
      versionId: 'overflow',
      parentVersionId: parent,
      artifactRef: overflowRef,
      provenanceRef: provenance(overflowRef, { createdAt: '2026-09-25T05:03:00.000Z' }),
      registeredAt: '2026-09-25T05:03:00.000Z',
    })),
    /version limit exceeded/,
  );
});


test('registry revision must exactly equal immutable version count', () => {
  const registry = putArtifactVersionV1(createArtifactRegistryV1('project-a'), version());
  const forged = { ...registry, revision: 99 };
  assert.throws(
    () => normalizeArtifactRegistryV1(forged),
    /revision must equal immutable version count/,
  );
});

test('versionId is a project-wide durable identity across logical artifacts', () => {
  const firstRef = artifact({ artifactId: 'first', uri: 'project://artifact/first' });
  let registry = putArtifactVersionV1(createArtifactRegistryV1('project-a'), version({
    versionId: 'shared-version',
    artifactRef: firstRef,
    provenanceRef: provenance(firstRef),
  }));
  const secondRef = artifact({
    artifactId: 'second',
    uri: 'project://artifact/second',
    sha256: hash('b'),
  });
  assert.throws(
    () => putArtifactVersionV1(registry, version({
      versionId: 'shared-version',
      artifactRef: secondRef,
      provenanceRef: provenance(secondRef),
    })),
    /already belongs to another artifact/,
  );
});
