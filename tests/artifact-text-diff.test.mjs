import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createArtifactRegistryV1,
  putArtifactVersionV1,
} from '../src/core/artifact-registry.js';
import {
  ARTIFACT_TEXT_DIFF_VERSION,
  ArtifactTextDiffOperation,
  MAX_ARTIFACT_TEXT_DIFF_LINES,
  buildArtifactTextDiffV1,
} from '../src/core/artifact-text-diff.js';
import { createSha256FingerprintV1 } from '../src/core/fingerprint.js';

const hash = char => char.repeat(64);
const at = second => `2026-09-25T10:40:${String(second).padStart(2, '0')}.000Z`;

async function artifactForText(text, {
  artifactId = 'report',
  mediaType = 'text/markdown',
  sensitive = false,
  createdAt = at(1),
  uri = 'project://artifact/report',
  sizeBytes = null,
} = {}) {
  const digest = await createSha256FingerprintV1(text);
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'DOCUMENT',
    uri,
    mediaType,
    sha256: digest.slice('sha256:'.length),
    sizeBytes: sizeBytes ?? new TextEncoder().encode(text).byteLength,
    createdAt,
    producerInvocationId: 'invoke-1',
    sensitive,
  };
}

function provenance(artifactRef, {
  projectId = 'project-a',
  revisionId = 'source-revision-1',
  contentSha256 = hash('c'),
  createdAt = at(2),
} = {}) {
  return {
    schemaVersion: 1,
    projectId,
    artifactRef,
    sourceBindings: [{
      sourceId: 'source-main',
      revisionId,
      contentSha256,
    }],
    inputArtifactIds: [],
    inputArtifactBindings: [],
    createdAt,
  };
}

function version({
  projectId = 'project-a',
  versionId,
  parentVersionId,
  artifactRef,
  provenanceRef,
  registeredAt,
}) {
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

async function registryFor(fromText, toText, {
  fromSensitive = false,
  toSensitive = false,
  fromMediaType = 'text/markdown',
  toMediaType = 'text/markdown',
  fromSizeBytes = null,
  toSizeBytes = null,
} = {}) {
  const fromRef = await artifactForText(fromText, {
    sensitive: fromSensitive,
    mediaType: fromMediaType,
    sizeBytes: fromSizeBytes,
    createdAt: at(1),
  });
  const toRef = await artifactForText(toText, {
    sensitive: toSensitive,
    mediaType: toMediaType,
    sizeBytes: toSizeBytes,
    createdAt: at(4),
  });
  const v1 = version({
    versionId: 'v1',
    parentVersionId: null,
    artifactRef: fromRef,
    provenanceRef: provenance(fromRef, {
      revisionId: 'source-revision-1',
      contentSha256: hash('c'),
      createdAt: at(2),
    }),
    registeredAt: at(3),
  });
  const v2 = version({
    versionId: 'v2',
    parentVersionId: 'v1',
    artifactRef: toRef,
    provenanceRef: provenance(toRef, {
      revisionId: 'source-revision-2',
      contentSha256: hash('d'),
      createdAt: at(5),
    }),
    registeredAt: at(6),
  });
  let registry = createArtifactRegistryV1('project-a');
  registry = putArtifactVersionV1(registry, v1);
  registry = putArtifactVersionV1(registry, v2);
  return registry;
}

function request(registry, fromText, toText, overrides = {}) {
  return {
    schemaVersion: ARTIFACT_TEXT_DIFF_VERSION,
    registry,
    artifactId: 'report',
    fromVersionId: 'v1',
    toVersionId: 'v2',
    fromText,
    toText,
    ...overrides,
  };
}

test('material diff verifies immutable bytes and returns deterministic multi-block line operations', async () => {
  const fromText = 'alpha\nbeta\ngamma\ndelta\nomega';
  const toText = 'alpha\nBETA\ngamma\ndelta\nzeta\nomega';
  const registry = await registryFor(fromText, toText);

  const out = await buildArtifactTextDiffV1(request(registry, fromText, toText));

  assert.equal(out.projectId, 'project-a');
  assert.equal(out.artifactId, 'report');
  assert.equal(out.fromVersionId, 'v1');
  assert.equal(out.toVersionId, 'v2');
  assert.equal(out.materialIdentitiesVerified, true);
  assert.equal(out.metadataDiff.contentChanged, true);
  assert.deepEqual(out.stats, {
    addedLines: 2,
    removedLines: 1,
    unchangedLines: 4,
    changeBlocks: 2,
    changed: true,
  });
  assert.deepEqual(
    out.operations.map(item => [item.type, item.leftLine, item.rightLine, item.text]),
    [
      [ArtifactTextDiffOperation.EQUAL, 1, 1, 'alpha'],
      [ArtifactTextDiffOperation.REMOVE, 2, null, 'beta'],
      [ArtifactTextDiffOperation.ADD, null, 2, 'BETA'],
      [ArtifactTextDiffOperation.EQUAL, 3, 3, 'gamma'],
      [ArtifactTextDiffOperation.EQUAL, 4, 4, 'delta'],
      [ArtifactTextDiffOperation.ADD, null, 5, 'zeta'],
      [ArtifactTextDiffOperation.EQUAL, 5, 6, 'omega'],
    ],
  );
  assert.match(out.plainText, /Changes: \+2 -1; unchanged 4; blocks 2/u);
  assert.match(out.plainText, /- L2: "beta"/u);
  assert.match(out.plainText, /\+ R2: "BETA"/u);
  assert.match(out.plainText, /\+ R5: "zeta"/u);
  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.approvalAuthorized, false);
  assert.equal(out.distributionAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.operations), true);

  const repeat = await buildArtifactTextDiffV1(request(registry, fromText, toText));
  assert.deepEqual(repeat, out);
});

test('byte material must match immutable size and SHA-256 before any diff is emitted', async () => {
  const fromText = 'alpha\nbeta';
  const toText = 'alpha\ngamma';
  const registry = await registryFor(fromText, toText);

  await assert.rejects(
    buildArtifactTextDiffV1(request(registry, 'Alpha\nbeta', toText)),
    /SHA-256 does not match immutable ArtifactRef/u,
  );

  const wrongSizeRegistry = await registryFor(fromText, toText, {
    fromSizeBytes: new TextEncoder().encode(fromText).byteLength + 1,
  });
  await assert.rejects(
    buildArtifactTextDiffV1(request(wrongSizeRegistry, fromText, toText)),
    /byte length does not match immutable ArtifactRef/u,
  );
});

test('sensitive and non-text artifacts fail closed instead of exposing material', async () => {
  const fromText = 'private';
  const toText = 'still private';
  const sensitiveRegistry = await registryFor(fromText, toText, {
    fromSensitive: true,
    toSensitive: true,
  });

  await assert.rejects(
    buildArtifactTextDiffV1(
      request(sensitiveRegistry, fromText, toText),
      { cryptoApi: { subtle: { digest() { throw new Error('hash must not run'); } } } },
    ),
    /sensitive artifact material is not admitted/u,
  );

  const binaryRegistry = await registryFor('PDF-A', 'PDF-B', {
    fromMediaType: 'application/pdf',
    toMediaType: 'application/pdf',
  });
  await assert.rejects(
    buildArtifactTextDiffV1(request(binaryRegistry, 'PDF-A', 'PDF-B')),
    /mediaType is not admitted for text diff/u,
  );
});

test('registry identity remains canonical and unknown artifact or version cannot be diffed', async () => {
  const fromText = 'a';
  const toText = 'b';
  const registry = await registryFor(fromText, toText);

  await assert.rejects(
    buildArtifactTextDiffV1(request(registry, fromText, toText, { artifactId: 'other' })),
    /Artifact not found/u,
  );
  await assert.rejects(
    buildArtifactTextDiffV1(request(registry, fromText, toText, { toVersionId: 'v999' })),
    /Artifact version not found/u,
  );
});

test('top-level descriptor boundary rejects accessors and unknown fields without getter execution', async () => {
  const fromText = 'a';
  const toText = 'b';
  const registry = await registryFor(fromText, toText);
  let getterCalls = 0;
  const hostile = request(registry, fromText, toText);
  Object.defineProperty(hostile, 'toText', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return toText;
    },
  });

  await assert.rejects(
    buildArtifactTextDiffV1(hostile),
    /field toText must be an enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);

  await assert.rejects(
    buildArtifactTextDiffV1({
      ...request(registry, fromText, toText),
      approvalAuthorized: true,
    }),
    /unknown field: approvalAuthorized/u,
  );
});

test('line bounds fail explicitly; diff never silently truncates a complete material comparison', async () => {
  const tooManyLines = Array.from(
    { length: MAX_ARTIFACT_TEXT_DIFF_LINES + 1 },
    (_, index) => `line-${index}`,
  ).join('\n');
  const target = 'short';
  const registry = await registryFor(tooManyLines, target);

  await assert.rejects(
    buildArtifactTextDiffV1(request(registry, tooManyLines, target)),
    new RegExp(`exceeds ${MAX_ARTIFACT_TEXT_DIFF_LINES} lines`, 'u'),
  );
});

test('identical bytes produce an explicit no-change material result even across two metadata versions', async () => {
  const text = 'same\nmaterial';
  const registry = await registryFor(text, text);
  const out = await buildArtifactTextDiffV1(request(registry, text, text));

  assert.equal(out.stats.changed, false);
  assert.equal(out.stats.addedLines, 0);
  assert.equal(out.stats.removedLines, 0);
  assert.equal(out.stats.unchangedLines, 2);
  assert.equal(out.metadataDiff.contentChanged, false);
  assert.match(out.plainText, /No material line changes\./u);
});
