import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectBootstrapBlockerCode,
  ProjectBootstrapStatus,
  buildProjectBootstrapV1,
} from '../src/core/project-bootstrap.js';
import { normalizeArtifactRefV1 } from '../src/core/universal-agent-contracts.js';

const AT = '2026-09-25T00:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function source(sourceId, sha = SHA_A, overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId,
    projectId: 'project-1',
    kind: 'git.repository',
    uri: `https://example.invalid/${sourceId}`,
    revisionId: `rev-${sourceId}`,
    contentSha256: sha,
    observedAt: AT,
    authority: 'CANONICAL',
    metadata: { branch:'main', nested:{ clean:true } },
    ...overrides,
  };
}

function artifact(artifactId, sha = SHA_B, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'application/json',
    uri: `artifact://${artifactId}`,
    mediaType: 'application/json',
    sha256: sha,
    sizeBytes: 12,
    createdAt: AT,
    producerInvocationId: null,
    sensitive: false,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    schemaVersion: 1,
    bootstrapId: 'bootstrap-1',
    projectId: 'project-1',
    revisionId: 'project-rev-1',
    title: 'Project One',
    sourceRefs: [source('repo', SHA_A), source('drive', SHA_C, { kind:'drive.folder', uri:'drive://folder-1' })],
    artifactRefs: [artifact('inventory', SHA_B)],
    requiredSourceIds: ['repo', 'drive'],
    requiredArtifactIds: ['inventory'],
    createdAt: AT,
    ...overrides,
  };
}

test('builds deterministic READY advisory candidate without canonical ProjectSnapshot authority', () => {
  const result = buildProjectBootstrapV1(input({
    sourceRefs: [source('repo', SHA_A), source('drive', SHA_C, { kind:'drive.folder', uri:'drive://folder-1' })].reverse(),
  }));

  assert.equal(result.status, ProjectBootstrapStatus.READY);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.candidate.sourceCandidates.map((item) => item.sourceId), ['drive', 'repo']);
  assert.deepEqual(result.candidate.artifactCandidates.map((item) => item.artifactId), ['inventory']);
  assert.deepEqual(result.requiredSourceIds, ['drive', 'repo']);
  assert.equal(result.candidate.projectId, 'project-1');
  assert.equal(result.candidate.revisionId, 'project-rev-1');
  assert.equal(Object.hasOwn(result, 'snapshot'), false);
  assert.equal(Object.hasOwn(result.candidate.sourceCandidates[0], 'authority'), false);
  assert.equal(Object.hasOwn(result.candidate.sourceCandidates[0], 'schemaVersion'), false);
  assert.equal(Object.hasOwn(result.candidate.artifactCandidates[0], 'schemaVersion'), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidate), true);
});

test('identical canonical inputs produce identical output regardless of input ordering', () => {
  const first = buildProjectBootstrapV1(input());
  const second = buildProjectBootstrapV1(input({
    sourceRefs: [...input().sourceRefs].reverse(),
    artifactRefs: [...input().artifactRefs].reverse(),
    requiredSourceIds: [...input().requiredSourceIds].reverse(),
    requiredArtifactIds: [...input().requiredArtifactIds].reverse(),
  }));
  assert.deepEqual(second, first);
});

test('required sources and artifacts without exact digests produce deterministic BLOCKED result', () => {
  const result = buildProjectBootstrapV1(input({
    sourceRefs: [source('repo', ''), source('drive', SHA_C, { kind:'drive.folder', uri:'drive://folder-1' })],
    artifactRefs: [artifact('inventory', '')],
  }));

  assert.equal(result.status, ProjectBootstrapStatus.BLOCKED);
  assert.deepEqual(result.blockers, [
    {
      code: ProjectBootstrapBlockerCode.REQUIRED_ARTIFACT_DIGEST_MISSING,
      resourceType: 'ARTIFACT',
      resourceId: 'inventory',
    },
    {
      code: ProjectBootstrapBlockerCode.REQUIRED_SOURCE_DIGEST_MISSING,
      resourceType: 'SOURCE',
      resourceId: 'repo',
    },
  ]);

  assert.equal(result.advisoryOnly, true);
  assert.equal(result.admissionAuthorized, false);
  assert.equal(result.requiresTrustedSourceAdmission, true);
});

test('required identities must resolve exactly and duplicates fail closed', () => {
  assert.throws(
    () => buildProjectBootstrapV1(input({ requiredSourceIds:['repo', 'missing'] })),
    /unknown sourceId: missing/,
  );
  assert.throws(
    () => buildProjectBootstrapV1(input({ requiredArtifactIds:['inventory', 'missing'] })),
    /unknown artifactId: missing/,
  );
  assert.throws(
    () => buildProjectBootstrapV1(input({ requiredSourceIds:['repo', 'repo'] })),
    /duplicate identity: repo/,
  );
  assert.throws(
    () => buildProjectBootstrapV1(input({
      sourceRefs:[source('repo'), source('repo')],
      requiredSourceIds:['repo'],
    })),
    /duplicate sourceId/,
  );
});

test('source project identity cannot cross bootstrap project boundary', () => {
  assert.throws(
    () => buildProjectBootstrapV1(input({
      sourceRefs:[source('repo', SHA_A, { projectId:'project-other' })],
      requiredSourceIds:['repo'],
    })),
    /source projectId mismatch: repo/,
  );
});

test('READY bootstrap is advisory-only until trusted source admission is supplied elsewhere', () => {
  const result = buildProjectBootstrapV1(input());
  assert.equal(result.status, ProjectBootstrapStatus.READY);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.admissionAuthorized, false);
  assert.equal(result.requiresTrustedSourceAdmission, true);
  assert.equal(Object.hasOwn(result, 'project'), false);
  assert.equal(Object.hasOwn(result, 'snapshot'), false);
  assert.equal(Object.hasOwn(result.candidate.sourceCandidates[0], 'authority'), false);
});

test('top-level accessor authority is rejected without executing getter', () => {
  let reads = 0;
  const raw = input();
  Object.defineProperty(raw, 'projectId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'project-1';
    },
  });
  assert.throws(() => buildProjectBootstrapV1(raw), /enumerable own data properties/);
  assert.equal(reads, 0);
});

test('array accessors and non-canonical array fields are rejected without executing getter', () => {
  let reads = 0;
  const raw = input();
  const original = raw.sourceRefs[0];
  Object.defineProperty(raw.sourceRefs, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return original;
    },
  });
  assert.throws(() => buildProjectBootstrapV1(raw), /sourceRefs\[0\].*enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = input();
  Object.defineProperty(hidden.requiredSourceIds, 'authority', {
    enumerable: false,
    configurable: true,
    value: 'ALLOW',
  });
  assert.throws(() => buildProjectBootstrapV1(hidden), /non-canonical array fields/);
});

test('source metadata accessors are rejected recursively without executing getter', () => {
  let reads = 0;
  const raw = input();
  Object.defineProperty(raw.sourceRefs[0].metadata.nested, 'clean', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return true;
    },
  });
  assert.throws(() => buildProjectBootstrapV1(raw), /source metadata\.nested fields.*enumerable own data properties/);
  assert.equal(reads, 0);
});

test('symbols, hidden fields and inherited authority fail closed', () => {
  const symbol = input();
  symbol[Symbol('permission')] = 'ALLOW';
  assert.throws(() => buildProjectBootstrapV1(symbol), /symbol fields/);

  const hidden = input();
  Object.defineProperty(hidden, 'title', {
    enumerable: false,
    configurable: true,
    value: 'Project One',
  });
  assert.throws(() => buildProjectBootstrapV1(hidden), /enumerable own data properties/);

  const inherited = Object.create({ projectId:'project-1' });
  Object.assign(inherited, input());
  delete inherited.projectId;
  assert.throws(() => buildProjectBootstrapV1(inherited), /plain or null-prototype object/);
});

test('identity, digest, timestamp and boolean aliases are rejected instead of coerced', () => {
  assert.throws(() => buildProjectBootstrapV1(input({ projectId:1 })), /canonical string identity/);
  assert.throws(() => buildProjectBootstrapV1(input({ createdAt:'2026-09-25T00:00:00Z' })), /canonical ISO timestamp/);
  assert.throws(() => buildProjectBootstrapV1(input({
    sourceRefs:[source('repo', SHA_A.toUpperCase())],
    requiredSourceIds:['repo'],
  })), /canonical lowercase SHA-256/);
  assert.throws(() => buildProjectBootstrapV1(input({
    artifactRefs:[artifact('inventory', SHA_B, { sensitive:'false' })],
  })), /sensitive must be boolean/);
});

test('rejects future source/artifact evidence relative to the bootstrap snapshot', () => {
  const future = '2026-09-25T00:00:01.000Z';
  assert.throws(
    () => buildProjectBootstrapV1(input({
      sourceRefs:[source('repo', SHA_A, { observedAt:future })],
      requiredSourceIds:['repo'],
    })),
    /source observedAt is after bootstrap createdAt: repo/,
  );
  assert.throws(
    () => buildProjectBootstrapV1(input({
      artifactRefs:[artifact('inventory', SHA_B, { createdAt:future })],
    })),
    /artifact createdAt is after bootstrap createdAt: inventory/,
  );
});

test('accepts the exact normalized canonical ArtifactRefV1 representation', () => {
  const canonical = normalizeArtifactRefV1({
    schemaVersion:1,
    artifactId:'inventory',
    kind:'application/json',
    uri:'artifact://inventory',
    sha256:SHA_B,
    sizeBytes:12,
    createdAt:AT,
    sensitive:false,
  });
  assert.equal(canonical.mediaType, '');
  assert.equal(canonical.producerInvocationId, null);
  const result = buildProjectBootstrapV1(input({ artifactRefs:[canonical] }));
  assert.equal(result.status, ProjectBootstrapStatus.READY);
});

test('bootstrap requires at least one required source and at least one source record', () => {
  assert.throws(
    () => buildProjectBootstrapV1(input({ sourceRefs:[], requiredSourceIds:[] })),
    /sourceRefs must contain between 1/,
  );
  assert.throws(
    () => buildProjectBootstrapV1(input({ requiredSourceIds:[] })),
    /requiredSourceIds must contain between 1/,
  );
});
