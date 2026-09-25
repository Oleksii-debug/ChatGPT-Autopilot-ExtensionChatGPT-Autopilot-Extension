import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SkillEntrypointKind,
  assessSkillPackDriftV1,
  normalizeSkillPackManifestV1,
} from '../src/core/skill-pack-contract.js';

const T1 = '2026-09-25T00:00:00.000Z';
const sha = char => char.repeat(64);

function artifact({
  id,
  digest,
  kind = 'skill.asset',
  uri,
  mediaType = 'application/octet-stream',
  producerInvocationId = 'invoke-skill-1',
} = {}) {
  return {
    schemaVersion: 1,
    artifactId: id,
    kind,
    uri: uri || `artifact://${id}`,
    mediaType,
    sha256: digest,
    sizeBytes: 123,
    createdAt: T1,
    producerInvocationId,
    sensitive: false,
  };
}

function manifest(overrides = {}) {
  const source = artifact({
    id: 'skill-source',
    digest: sha('a'),
    kind: 'skill.bundle',
    mediaType: 'application/zip',
  });
  const entry = artifact({
    id: 'skill-entry',
    digest: sha('b'),
    kind: 'skill.module',
    mediaType: 'text/javascript',
  });
  const signature = artifact({
    id: 'skill-signature',
    digest: sha('c'),
    kind: 'skill.signature',
    mediaType: 'application/octet-stream',
  });
  return {
    schemaVersion: 1,
    skillPackId: 'skill.accessible-review',
    version: '1.2.3',
    displayName: 'Accessible Review',
    description: 'Portable deterministic review skill.',
    artifactRefs: [signature, entry, source],
    sourceArtifactId: 'skill-source',
    entrypoints: [{
      entrypointId: 'review',
      kind: 'WORKFLOW',
      artifactId: 'skill-entry',
      exportName: 'review',
      readOnly: true,
      requiredCapabilityIds: ['artifact.read'],
      requiredPermissionIds: ['project.read'],
    }],
    dependencies: [{
      skillPackId: 'skill.base',
      version: '2.0.0',
      sourceSha256: sha('d'),
    }],
    requiredCapabilityIds: ['artifact.read'],
    requiredPermissionIds: ['project.read'],
    evaluationRequirements: [{
      evaluationRequirementId: 'eval.accessible-review',
      suiteId: 'suite.accessibility',
      suiteRevisionId: 'suite-r3',
      subjectSha256: sha('a'),
      requiredEvidenceKinds: ['artifact', 'verification'],
    }],
    signatureRefs: [{
      signatureId: 'sig-1',
      scheme: 'ed25519',
      keyId: 'owner-key-1',
      signatureArtifactId: 'skill-signature',
      signedSha256: sha('a'),
      trustState: 'UNVERIFIED_REFERENCE',
    }],
    publishedAt: T1,
    admissionAuthorized: false,
    executionAuthorized: false,
    trustAuthority: 'UNVERIFIED_REFERENCES',
    ...overrides,
  };
}

test('skill pack normalizes deterministic portable manifest without granting authority', () => {
  const normalized = normalizeSkillPackManifestV1(manifest());
  assert.equal(normalized.skillPackId, 'skill.accessible-review');
  assert.equal(normalized.version, '1.2.3');
  assert.equal(normalized.entrypoints[0].kind, SkillEntrypointKind.WORKFLOW);
  assert.deepEqual(normalized.artifactRefs.map(item => item.artifactId), [
    'skill-entry',
    'skill-signature',
    'skill-source',
  ]);
  assert.equal(normalized.admissionAuthorized, false);
  assert.equal(normalized.executionAuthorized, false);
  assert.equal(normalized.trustAuthority, 'UNVERIFIED_REFERENCES');
  assert(Object.isFrozen(normalized));
  assert(Object.isFrozen(normalized.entrypoints));
});

test('descriptor-safe manifest and arrays reject accessors, hidden fields, symbols and sparse aliases without reads', () => {
  let reads = 0;
  const accessor = manifest();
  Object.defineProperty(accessor, 'skillPackId', {
    enumerable: true,
    get() { reads += 1; return 'skill.evil'; },
  });
  assert.throws(() => normalizeSkillPackManifestV1(accessor), /enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = manifest();
  Object.defineProperty(hidden, 'executionAuthorized', {
    enumerable: false,
    value: false,
  });
  assert.throws(() => normalizeSkillPackManifestV1(hidden), /enumerable own data property/);

  const symbol = manifest();
  symbol[Symbol('permission')] = 'ALLOW';
  assert.throws(() => normalizeSkillPackManifestV1(symbol), /symbol fields/);

  const sparse = manifest();
  sparse.entrypoints = new Array(1);
  assert.throws(() => normalizeSkillPackManifestV1(sparse), /enumerable own data item/);

  const indexAccessor = manifest();
  Object.defineProperty(indexAccessor.artifactRefs, '0', {
    enumerable: true,
    get() { reads += 1; return artifact({ id: 'x', digest: sha('f') }); },
  });
  assert.throws(() => normalizeSkillPackManifestV1(indexAccessor), /enumerable own data item/);
  assert.equal(reads, 0);
});

test('strict ArtifactRef pre-boundary rejects coercive aliases before canonical normalizer', () => {
  const stringVersion = manifest();
  stringVersion.artifactRefs[0].schemaVersion = '1';
  assert.throws(() => normalizeSkillPackManifestV1(stringVersion), /schemaVersion must be 1/);

  const numericId = manifest();
  numericId.artifactRefs[0].artifactId = 7;
  assert.throws(() => normalizeSkillPackManifestV1(numericId), /artifactId is invalid/);

  const upperDigest = manifest();
  upperDigest.artifactRefs[0].sha256 = sha('A');
  assert.throws(() => normalizeSkillPackManifestV1(upperDigest), /sha256 is invalid/);

  const missingSensitive = manifest();
  delete missingSensitive.artifactRefs[0].sensitive;
  assert.throws(() => normalizeSkillPackManifestV1(missingSensitive), /sensitive is required/);

  const nonCanonicalTime = manifest();
  nonCanonicalTime.artifactRefs[0].createdAt = '2026-09-25T00:00:00Z';
  assert.throws(() => normalizeSkillPackManifestV1(nonCanonicalTime), /canonical timestamp/);
});

test('published pack cannot causally predate any materialized artifact', () => {
  const future = manifest();
  future.artifactRefs[1].createdAt = '2026-09-25T00:00:01.000Z';
  assert.throws(
    () => normalizeSkillPackManifestV1(future),
    /cannot be published before artifact creation/,
  );
});

test('entrypoint artifacts and requirement subsets are exact-bound to pack declarations', () => {
  const missingArtifact = manifest();
  missingArtifact.entrypoints[0].artifactId = 'not-in-pack';
  assert.throws(() => normalizeSkillPackManifestV1(missingArtifact), /entrypoint artifact is not in skill pack/);

  const capabilityEscalation = manifest();
  capabilityEscalation.entrypoints[0].requiredCapabilityIds = ['filesystem.write'];
  assert.throws(() => normalizeSkillPackManifestV1(capabilityEscalation), /capability is not declared/);

  const permissionEscalation = manifest();
  permissionEscalation.entrypoints[0].requiredPermissionIds = ['admin.all'];
  assert.throws(() => normalizeSkillPackManifestV1(permissionEscalation), /permission is not declared/);
});

test('dependencies are exact version/hash references and cannot self-reference', () => {
  const self = manifest();
  self.dependencies[0].skillPackId = 'skill.accessible-review';
  assert.throws(() => normalizeSkillPackManifestV1(self), /cannot depend on itself/);

  const range = manifest();
  range.dependencies[0].version = '^2.0.0';
  assert.throws(() => normalizeSkillPackManifestV1(range), /canonical semantic version/);

  const duplicate = manifest();
  duplicate.dependencies.push(structuredClone(duplicate.dependencies[0]));
  assert.throws(() => normalizeSkillPackManifestV1(duplicate), /duplicate skillPackId/);
});

test('skill pack and dependency identities use bounded canonical SemVer 2.0 syntax', () => {
  for (const validVersion of [
    '1.2.3+windows.x64.001',
    '1.2.3-alpha.1+build.5',
    '1.2.3-rc.01a+build.7',
  ]) {
    const input = manifest({ version: validVersion });
    assert.equal(normalizeSkillPackManifestV1(input).version, validVersion);
  }

  for (const invalidVersion of [
    '1.2.3-01',
    '1.2.3-alpha.01',
    '1.2.3-',
    '1.2.3+',
    '1.2.3+build..5',
    '01.2.3',
    '1.2.3+' + 'a'.repeat(300),
  ]) {
    const input = manifest({ version: invalidVersion });
    assert.throws(
      () => normalizeSkillPackManifestV1(input),
      /canonical semantic version/,
      invalidVersion,
    );
  }

  const dependencyBuild = manifest();
  dependencyBuild.dependencies[0].version = '2.0.0-rc.1+sha.abc123';
  assert.equal(
    normalizeSkillPackManifestV1(dependencyBuild).dependencies[0].version,
    '2.0.0-rc.1+sha.abc123',
  );

  const invalidDependency = manifest();
  invalidDependency.dependencies[0].version = '2.0.0-00';
  assert.throws(
    () => normalizeSkillPackManifestV1(invalidDependency),
    /canonical semantic version/,
  );
});

test('eval and signature references bind exact source bytes but never assert trusted PASS/signature authority', () => {
  const emptyEvidence = manifest();
  emptyEvidence.evaluationRequirements[0].requiredEvidenceKinds = [];
  assert.throws(() => normalizeSkillPackManifestV1(emptyEvidence), /length must be 1-32/);

  const badEval = manifest();
  badEval.evaluationRequirements[0].subjectSha256 = sha('e');
  assert.throws(() => normalizeSkillPackManifestV1(badEval), /subjectSha256 must bind source artifact/);

  const badSigDigest = manifest();
  badSigDigest.signatureRefs[0].signedSha256 = sha('e');
  assert.throws(() => normalizeSkillPackManifestV1(badSigDigest), /signedSha256 must bind source artifact/);

  const fakeTrust = manifest();
  fakeTrust.signatureRefs[0].trustState = 'VERIFIED';
  assert.throws(() => normalizeSkillPackManifestV1(fakeTrust), /UNVERIFIED_REFERENCE/);

  const missingSigArtifact = manifest();
  missingSigArtifact.signatureRefs[0].signatureArtifactId = 'missing-signature';
  assert.throws(() => normalizeSkillPackManifestV1(missingSigArtifact), /signature artifact is not in skill pack/);

  const authorityInjection = manifest({ admissionAuthorized: true });
  assert.throws(() => normalizeSkillPackManifestV1(authorityInjection), /cannot authorize admission/);
});

test('drift is deterministic and same-version semantic mutation is an explicit conflict', () => {
  const baseline = manifest();
  const same = structuredClone(baseline);
  const unchanged = assessSkillPackDriftV1(baseline, same);
  assert.equal(unchanged.status, 'UNCHANGED');
  assert.deepEqual(unchanged.signals, []);

  const artifactConflict = structuredClone(baseline);
  artifactConflict.artifactRefs.find(item => item.artifactId === 'skill-entry').sha256 = sha('f');
  const artifactConflictState = assessSkillPackDriftV1(baseline, artifactConflict);
  assert.equal(artifactConflictState.status, 'VERSION_CONFLICT');
  assert.deepEqual(artifactConflictState.signals, ['ARTIFACTS_CHANGED']);

  const conflict = structuredClone(baseline);
  conflict.entrypoints[0].exportName = 'differentExport';
  const conflictState = assessSkillPackDriftV1(baseline, conflict);
  assert.equal(conflictState.status, 'VERSION_CONFLICT');
  assert.equal(conflictState.sameVersionConflict, true);
  assert.deepEqual(conflictState.signals, ['ENTRYPOINTS_CHANGED']);

  const next = structuredClone(conflict);
  next.version = '1.2.4';
  const drift = assessSkillPackDriftV1(baseline, next);
  assert.equal(drift.status, 'DRIFTED');
  assert.equal(drift.sameVersionConflict, false);
  assert.deepEqual(drift.signals, ['VERSION_CHANGED', 'ENTRYPOINTS_CHANGED']);
});

test('valid null-prototype manifest is supported and unknown authority fields fail closed', () => {
  const raw = Object.assign(Object.create(null), manifest());
  assert.doesNotThrow(() => normalizeSkillPackManifestV1(raw));

  const unknown = manifest();
  unknown.permissionGranted = true;
  assert.throws(() => normalizeSkillPackManifestV1(unknown), /unknown field: permissionGranted/);
});
