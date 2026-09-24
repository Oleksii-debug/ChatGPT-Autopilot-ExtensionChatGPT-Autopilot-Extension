import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPortableContextCapsuleV1,
  normalizeContextCapsuleDisclosureV1,
} from '../src/core/project-context-capsule.js';
import { assertContextCapsuleFreshV1 } from '../src/core/project-context-artifact.js';
import {
  addProjectSnapshot,
  createProjectWorkspace,
  projectCurrentState,
  putProjectContextCapsule,
} from '../src/core/project-workspace.js';

const AT = '2026-09-24T20:00:00.000Z';

function source(id = 'source-main', overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: id,
    projectId: 'project-1',
    kind: 'github-repository',
    uri: `github://example/${id}`,
    revisionId: `${id}-revision-1`,
    contentSha256: 'a'.repeat(64),
    observedAt: AT,
    authority: 'CANONICAL',
    metadata: {},
    ...overrides,
  };
}

function artifact(id = 'artifact-public', overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: id,
    kind: 'report',
    uri: `artifact://${id}`,
    mediaType: 'text/plain',
    sha256: 'b'.repeat(64),
    sizeBytes: 42,
    createdAt: AT,
    producerInvocationId: 'invocation-1',
    sensitive: false,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    revisionId: 'project-revision-1',
    title: 'Project One',
    sourceRefs: [source()],
    artifactRefs: [artifact()],
    createdAt: AT,
    ...overrides,
  };
}

function disclosure(overrides = {}) {
  return {
    schemaVersion: 1,
    allowedSourceIds: ['source-main'],
    allowedArtifactIds: ['artifact-public'],
    allowedSensitiveArtifactIds: [],
    maxSources: 8,
    maxArtifacts: 8,
    maxSummaryChars: 2_000,
    maxSerializedBytes: 32_000,
    ...overrides,
  };
}

function build(overrides = {}) {
  return createPortableContextCapsuleV1({
    capsuleId: 'capsule-1',
    snapshot: snapshot(),
    summary: 'Bounded current project context.',
    disclosure: disclosure(),
    createdAt: AT,
    ...overrides,
  });
}

test('portable capsule composes with existing freshness and ProjectWorkspace authorities', () => {
  const snap = snapshot();
  const capsule = build({ snapshot: snap });

  assert.equal(capsule.projectId, snap.projectId);
  assert.equal(capsule.projectRevisionId, snap.revisionId);
  assert.deepEqual(capsule.sourceBindings.map(item => item.sourceId), ['source-main']);
  assert.deepEqual(capsule.artifactRefs.map(item => item.artifactId), ['artifact-public']);
  assert.equal(Object.isFrozen(capsule), true);

  const freshness = assertContextCapsuleFreshV1(capsule, snap.sourceRefs);
  assert.equal(freshness.fresh, true);

  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snap, { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule, { nowMs: 3 });
  const current = projectCurrentState(workspace, snap.projectId, capsule.capsuleId, snap.sourceRefs);
  assert.equal(current.status, 'FRESH');
  assert.equal(current.staleSourceCount, 0);
});

test('portable capsule ordering is deterministic regardless of snapshot and disclosure order', () => {
  const sourceA = source('source-a', { contentSha256: 'c'.repeat(64) });
  const sourceZ = source('source-z', { contentSha256: 'd'.repeat(64) });
  const artifactA = artifact('artifact-a', { sha256: 'e'.repeat(64) });
  const artifactZ = artifact('artifact-z', { sha256: 'f'.repeat(64) });

  const firstSnapshot = snapshot({
    sourceRefs: [sourceZ, sourceA],
    artifactRefs: [artifactZ, artifactA],
  });
  const secondSnapshot = snapshot({
    sourceRefs: [sourceA, sourceZ],
    artifactRefs: [artifactA, artifactZ],
  });
  const firstDisclosure = disclosure({
    allowedSourceIds: ['source-z', 'source-a'],
    allowedArtifactIds: ['artifact-z', 'artifact-a'],
  });
  const secondDisclosure = disclosure({
    allowedSourceIds: ['source-a', 'source-z'],
    allowedArtifactIds: ['artifact-a', 'artifact-z'],
  });

  const first = build({ snapshot: firstSnapshot, disclosure: firstDisclosure });
  const second = build({ snapshot: secondSnapshot, disclosure: secondDisclosure });

  assert.deepEqual(first, second);
  assert.deepEqual(first.sourceBindings.map(item => item.sourceId), ['source-a', 'source-z']);
  assert.deepEqual(first.artifactRefs.map(item => item.artifactId), ['artifact-a', 'artifact-z']);
});

test('disclosure is explicit, strict and rejects aliases, inherited fields and unknown fields', () => {
  assert.throws(
    () => normalizeContextCapsuleDisclosureV1({ schemaVersion: 1 }),
    /allowedSourceIds must be a bounded array/,
  );
  assert.throws(
    () => normalizeContextCapsuleDisclosureV1(disclosure({ schemaVersion: '1' })),
    /Unsupported .* schemaVersion/,
  );
  assert.throws(
    () => normalizeContextCapsuleDisclosureV1({ ...disclosure(), extraAuthority: 'ALLOW' }),
    /unknown field/,
  );

  const inherited = Object.create(disclosure());
  assert.throws(
    () => normalizeContextCapsuleDisclosureV1(inherited),
    /plain object/,
  );
});

test('duplicate, whitespace-aliased and unknown source or artifact identities fail closed', () => {
  assert.throws(
    () => build({ disclosure: disclosure({ allowedSourceIds: ['source-main', 'source-main'] }) }),
    /duplicate ids/,
  );
  assert.throws(
    () => build({ disclosure: disclosure({ allowedSourceIds: [' source-main'] }) }),
    /exact non-empty string id/,
  );
  assert.throws(
    () => build({ disclosure: disclosure({ allowedSourceIds: ['missing-source'] }) }),
    /unknown sourceId/,
  );
  assert.throws(
    () => build({ disclosure: disclosure({ allowedArtifactIds: ['missing-artifact'] }) }),
    /unknown artifactId/,
  );
});

test('sensitive artifacts require a second exact allowlist and never inherit ordinary disclosure', () => {
  const secret = artifact('artifact-secret', {
    uri: 'artifact://private/secret',
    sensitive: true,
    sha256: '9'.repeat(64),
  });
  const snap = snapshot({ artifactRefs: [secret] });

  assert.throws(
    () => build({
      snapshot: snap,
      disclosure: disclosure({
        allowedArtifactIds: ['artifact-secret'],
        allowedSensitiveArtifactIds: [],
      }),
    }),
    /requires explicit sensitive allowlist admission/,
  );

  const capsule = build({
    snapshot: snap,
    disclosure: disclosure({
      allowedArtifactIds: ['artifact-secret'],
      allowedSensitiveArtifactIds: ['artifact-secret'],
    }),
  });
  assert.deepEqual(capsule.artifactRefs.map(item => item.artifactId), ['artifact-secret']);
  assert.equal(capsule.artifactRefs[0].sensitive, true);
});

test('sensitive allowlist must be a subset and may not mark a public artifact as sensitive', () => {
  assert.throws(
    () => normalizeContextCapsuleDisclosureV1(disclosure({
      allowedSensitiveArtifactIds: ['artifact-secret'],
    })),
    /not a subset/,
  );
  assert.throws(
    () => build({
      disclosure: disclosure({
        allowedSensitiveArtifactIds: ['artifact-public'],
      }),
    }),
    /non-sensitive artifact/,
  );
});

test('source, artifact, summary and serialized-byte budgets are enforced', () => {
  assert.throws(
    () => build({ disclosure: disclosure({ maxSources: 0 }) }),
    /source count exceeds maxSources/,
  );
  assert.throws(
    () => build({ disclosure: disclosure({ maxArtifacts: 0 }) }),
    /artifact count exceeds maxArtifacts/,
  );
  assert.throws(
    () => build({
      summary: '12345',
      disclosure: disclosure({ maxSummaryChars: 4 }),
    }),
    /summary exceeds disclosure maxSummaryChars/,
  );
  assert.throws(
    () => build({ disclosure: disclosure({ maxSerializedBytes: 1 }) }),
    /exceeds maxSerializedBytes/,
  );
});

test('serialized budget measures UTF-8 bytes instead of JavaScript character count', () => {
  const summary = 'ї'.repeat(30);
  const roomy = build({
    summary,
    disclosure: disclosure({ maxSummaryChars: 30, maxSerializedBytes: 32_000 }),
  });
  const exactBytes = new TextEncoder().encode(JSON.stringify(roomy)).byteLength;

  assert.throws(
    () => build({
      summary,
      disclosure: disclosure({
        maxSummaryChars: 30,
        maxSerializedBytes: exactBytes - 1,
      }),
    }),
    /exceeds maxSerializedBytes/,
  );
});

test('a portable capsule cannot be an ungrounded summary with zero disclosed provenance', () => {
  assert.throws(
    () => build({
      snapshot: snapshot({ sourceRefs: [], artifactRefs: [] }),
      disclosure: disclosure({
        allowedSourceIds: [],
        allowedArtifactIds: [],
        allowedSensitiveArtifactIds: [],
      }),
    }),
    /must disclose at least one provenance-bound source or artifact/,
  );
});

test('build envelope rejects exotic objects, unknown fields and non-string capsule ids', () => {
  const inherited = Object.create({
    capsuleId: 'capsule-1',
    snapshot: snapshot(),
    summary: 'hidden inherited input',
    disclosure: disclosure(),
    createdAt: AT,
  });
  assert.throws(
    () => createPortableContextCapsuleV1(inherited),
    /plain object/,
  );
  assert.throws(
    () => build({ unexpected: true }),
    /unknown field/,
  );
  assert.throws(
    () => build({ capsuleId: 1 }),
    /capsuleId must be an exact non-empty string id/,
  );
});
