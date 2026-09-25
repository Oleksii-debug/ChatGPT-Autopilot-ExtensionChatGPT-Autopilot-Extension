import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JOB_ARTIFACT_BUNDLE_REQUIRED_PATHS,
  JobArtifactCategory,
  buildJobArtifactBundleV1,
} from '../src/core/job-artifact-bundle.js';
import { normalizeArtifactRefV1 } from '../src/core/universal-agent-contracts.js';

const AT = '2026-09-24T21:33:00.000Z';

function artifactRef(id, hashChar, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: id,
    kind: 'job-output',
    uri: 'artifact://job-1/' + id,
    mediaType: 'application/octet-stream',
    sha256: hashChar.repeat(64),
    sizeBytes: 10,
    createdAt: AT,
    producerInvocationId: 'invoke-1',
    sensitive: false,
    ...overrides,
  };
}

function entry(path, category, id, hashChar, overrides = {}) {
  return {
    path,
    category,
    artifactRef: artifactRef(id, hashChar, overrides),
  };
}

function validInput() {
  return {
    schemaVersion: 1,
    bundleId: 'bundle-1',
    jobId: 'job-1',
    planId: 'plan-1',
    projectId: 'project-1',
    createdAt: AT,
    entries: [
      entry('timeline.jsonl', JobArtifactCategory.CONTROL, 'timeline', 'c', { mediaType: 'application/x-ndjson' }),
      entry('SUMMARY.md', JobArtifactCategory.CONTROL, 'summary', 'a', { mediaType: 'text/markdown' }),
      entry('REPORT.json', JobArtifactCategory.CONTROL, 'report', 'b', { mediaType: 'application/json' }),
      entry('artifacts/result.json', JobArtifactCategory.ARTIFACT, 'result', 'd', { mediaType: 'application/json' }),
      entry('evidence/verification.json', JobArtifactCategory.EVIDENCE, 'evidence-1', 'e', { sensitive: true, mediaType: 'application/json' }),
      entry('diagnostics/Журнал.txt', JobArtifactCategory.DIAGNOSTIC, 'diag-1', 'f', { mediaType: 'text/plain' }),
    ],
    sensitiveDisclosureRequest: {
      requestedSensitiveArtifactIds: ['evidence-1'],
    },
  };
}

test('builds deterministic Windows-safe job artifact bundle and derived checksums', () => {
  const bundle = buildJobArtifactBundleV1(validInput());

  assert.equal(bundle.bundleId, 'bundle-1');
  assert.deepEqual(JOB_ARTIFACT_BUNDLE_REQUIRED_PATHS, [
    'SUMMARY.md',
    'REPORT.json',
    'timeline.jsonl',
    'checksums.txt',
  ]);
  assert.deepEqual(bundle.entries.map((item) => item.path), [
    'artifacts/result.json',
    'diagnostics/Журнал.txt',
    'evidence/verification.json',
    'REPORT.json',
    'SUMMARY.md',
    'timeline.jsonl',
  ]);
  assert.deepEqual(bundle.bundlePaths, [
    'artifacts/result.json',
    'diagnostics/Журнал.txt',
    'evidence/verification.json',
    'REPORT.json',
    'SUMMARY.md',
    'timeline.jsonl',
    'checksums.txt',
  ]);

  const expected = bundle.entries
    .map((item) => item.artifactRef.sha256 + '  ' + item.path)
    .join('\n') + '\n';
  assert.equal(bundle.checksumFile.content, expected);
  assert.deepEqual(bundle.checksumFile.coversPaths, bundle.entries.map((item) => item.path));
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.entries), true);
  assert.equal(Object.isFrozen(bundle.entries[0]), true);
  assert.equal(Object.isFrozen(bundle.entries[0].artifactRef), true);
  assert.equal(Object.isFrozen(bundle.checksumFile), true);
  assert.equal(bundle.disclosureAuthorized, false);
  assert.equal(bundle.distributionAuthorized, false);
  assert.equal(bundle.requiresCanonicalDisclosureAuthorization, true);
  assert.deepEqual(bundle.sensitiveArtifactIds, ['evidence-1']);
});

test('accepts a null-prototype top-level record but rejects exotic or symbol-bearing authority shapes', () => {
  const nullProto = Object.assign(Object.create(null), validInput());
  assert.equal(buildJobArtifactBundleV1(nullProto).jobId, 'job-1');

  const exotic = Object.assign(Object.create({ inherited: true }), validInput());
  assert.throws(() => buildJobArtifactBundleV1(exotic), /plain object/);

  const symbolBearing = validInput();
  symbolBearing[Symbol('hidden-authority')] = true;
  assert.throws(() => buildJobArtifactBundleV1(symbolBearing), /symbol fields/);
});

test('rejects traversal, Windows aliases, forbidden characters and non-canonical Unicode paths', () => {
  const invalidPaths = [
    '../secret.txt',
    '/absolute.txt',
    'C:/absolute.txt',
    'artifacts\\backslash.txt',
    'artifacts//empty.txt',
    'artifacts/CON.txt',
    'artifacts/ result.json',
    'diagnostics/COM¹.txt',
    'diagnostics/COM².txt',
    'diagnostics/COM³.txt',
    'diagnostics/LPT¹.txt',
    'diagnostics/LPT².txt',
    'diagnostics/LPT³.txt',
    'artifacts/trailing.',
    'artifacts/bad?.txt',
    'artifacts/Cafe\u0301.txt',
    'artifacts/bidi-\u202Etxt',
  ];

  for (let i = 0; i < invalidPaths.length; i += 1) {
    const input = validInput();
    input.entries.push(entry(invalidPaths[i], JobArtifactCategory.ARTIFACT, 'bad-' + i, '1'));
    assert.throws(() => buildJobArtifactBundleV1(input), /bundle path/);
  }
});

test('rejects case-insensitive path collisions and duplicate artifact identity', () => {
  const caseCollision = validInput();
  caseCollision.entries.push(entry('artifacts/Readme.txt', JobArtifactCategory.ARTIFACT, 'readme-a', '1'));
  caseCollision.entries.push(entry('artifacts/readme.txt', JobArtifactCategory.ARTIFACT, 'readme-b', '2'));
  assert.throws(() => buildJobArtifactBundleV1(caseCollision), /case-insensitive path collision/);

  const duplicateArtifact = validInput();
  duplicateArtifact.entries.push(entry('artifacts/another.json', JobArtifactCategory.ARTIFACT, 'result', '3'));
  assert.throws(() => buildJobArtifactBundleV1(duplicateArtifact), /duplicate artifactId/);
});

test('requires canonical control files and derives checksums.txt instead of accepting caller content', () => {
  const missing = validInput();
  missing.entries = missing.entries.filter((item) => item.path !== 'SUMMARY.md');
  assert.throws(() => buildJobArtifactBundleV1(missing), /missing required control file: SUMMARY\.md/);

  const suppliedChecksum = validInput();
  suppliedChecksum.entries.push(entry('checksums.txt', JobArtifactCategory.CONTROL, 'checksums', '1'));
  assert.throws(() => buildJobArtifactBundleV1(suppliedChecksum), /derived/);

  const extraControl = validInput();
  extraControl.entries.push(entry('README.md', JobArtifactCategory.CONTROL, 'readme', '1'));
  assert.throws(() => buildJobArtifactBundleV1(extraControl), /CONTROL entries are limited/);
});

test('binds entry category to canonical bundle directory', () => {
  const wrongEvidence = validInput();
  wrongEvidence.entries.push(entry('artifacts/proof.json', JobArtifactCategory.EVIDENCE, 'proof-1', '1'));
  assert.throws(() => buildJobArtifactBundleV1(wrongEvidence), /must live under evidence\//);

  const wrongControl = validInput();
  const report = wrongControl.entries.find((item) => item.path === 'REPORT.json');
  report.category = JobArtifactCategory.ARTIFACT;
  assert.throws(() => buildJobArtifactBundleV1(wrongControl), /wrong category/);
});

test('sensitive disclosure request is exact metadata but never authorization', () => {
  const missingRequest = validInput();
  missingRequest.sensitiveDisclosureRequest.requestedSensitiveArtifactIds = [];
  assert.throws(() => buildJobArtifactBundleV1(missingRequest), /missing from disclosure request: evidence-1/);

  const staleRequest = validInput();
  staleRequest.sensitiveDisclosureRequest.requestedSensitiveArtifactIds.push('result');
  assert.throws(() => buildJobArtifactBundleV1(staleRequest), /request does not match a sensitive bundle artifact: result/);

  const duplicateRequest = validInput();
  duplicateRequest.sensitiveDisclosureRequest.requestedSensitiveArtifactIds.push('evidence-1');
  assert.throws(() => buildJobArtifactBundleV1(duplicateRequest), /duplicate artifactId/);

  const bundle = buildJobArtifactBundleV1(validInput());
  assert.deepEqual(bundle.sensitiveArtifactIds, ['evidence-1']);
  assert.deepEqual(bundle.sensitiveDisclosureRequest.requestedSensitiveArtifactIds, ['evidence-1']);
  assert.equal(bundle.disclosureAuthorized, false);
  assert.equal(bundle.distributionAuthorized, false);
  assert.equal(bundle.requiresCanonicalDisclosureAuthorization, true);
  assert.equal(Object.hasOwn(bundle, 'disclosure'), false);
});

test('fails closed on coerced bundle, disclosure, entry and ArtifactRef field types', () => {
  const wrongVersion = validInput();
  wrongVersion.schemaVersion = '1';
  assert.throws(() => buildJobArtifactBundleV1(wrongVersion), /schemaVersion/);

  const numericId = validInput();
  numericId.bundleId = 1;
  assert.throws(() => buildJobArtifactBundleV1(numericId), /bundleId/);

  const numericGrant = validInput();
  numericGrant.sensitiveDisclosureRequest.requestedSensitiveArtifactIds = [1];
  assert.throws(() => buildJobArtifactBundleV1(numericGrant), /requestedSensitiveArtifactId/);

  const numericCategory = validInput();
  numericCategory.entries[0].category = 1;
  assert.throws(() => buildJobArtifactBundleV1(numericCategory), /category/);

  const stringSize = validInput();
  stringSize.entries[0].artifactRef.sizeBytes = '10';
  assert.throws(() => buildJobArtifactBundleV1(stringSize), /sizeBytes/);

  const stringSensitive = validInput();
  stringSensitive.entries[0].artifactRef.sensitive = 'false';
  assert.throws(() => buildJobArtifactBundleV1(stringSensitive), /sensitive/);

  const missingDigest = validInput();
  missingDigest.entries[0].artifactRef.sha256 = '';
  assert.throws(() => buildJobArtifactBundleV1(missingDigest), /sha256 is required/);
});

test('permission-like disclosure aliases fail closed instead of minting authority', () => {
  const topLevel = validInput();
  topLevel.disclosure = { allowedSensitiveArtifactIds: ['evidence-1'] };
  assert.throws(() => buildJobArtifactBundleV1(topLevel), /unknown field: disclosure/);

  const nested = validInput();
  nested.sensitiveDisclosureRequest.allowedSensitiveArtifactIds = ['evidence-1'];
  assert.throws(() => buildJobArtifactBundleV1(nested), /unknown field: allowedSensitiveArtifactIds/);

  const noSensitive = validInput();
  noSensitive.entries.find((item) => item.artifactRef.artifactId === 'evidence-1').artifactRef.sensitive = false;
  noSensitive.sensitiveDisclosureRequest.requestedSensitiveArtifactIds = [];
  const bundle = buildJobArtifactBundleV1(noSensitive);
  assert.deepEqual(bundle.sensitiveArtifactIds, []);
  assert.equal(bundle.disclosureAuthorized, false);
  assert.equal(bundle.distributionAuthorized, false);
  assert.equal(bundle.requiresCanonicalDisclosureAuthorization, false);
});

test('requires canonical ISO timestamps and exact known fields', () => {
  const looseTime = validInput();
  looseTime.createdAt = '2026-09-24T21:33:00Z';
  assert.throws(() => buildJobArtifactBundleV1(looseTime), /canonical ISO timestamp/);

  const unknown = validInput();
  unknown.untrustedPolicy = 'ALLOW';
  assert.throws(() => buildJobArtifactBundleV1(unknown), /unknown field/);

  const entryUnknown = validInput();
  entryUnknown.entries[0].permission = 'ALLOW';
  assert.throws(() => buildJobArtifactBundleV1(entryUnknown), /unknown field/);
});


test('rejects accessor and hidden non-enumerable contract fields', () => {
  const accessor = validInput();
  Object.defineProperty(accessor, 'bundleId', {
    enumerable: true,
    configurable: true,
    get() { return 'bundle-1'; },
  });
  assert.throws(() => buildJobArtifactBundleV1(accessor), /data properties only/);

  const hiddenUnknown = validInput();
  Object.defineProperty(hiddenUnknown, 'hiddenPolicy', {
    enumerable: false,
    configurable: true,
    value: 'ALLOW',
  });
  assert.throws(() => buildJobArtifactBundleV1(hiddenUnknown), /unknown field: hiddenPolicy/);

  const artifactAccessor = validInput();
  Object.defineProperty(artifactAccessor.entries[0].artifactRef, 'sha256', {
    enumerable: true,
    configurable: true,
    get() { return 'c'.repeat(64); },
  });
  assert.throws(() => buildJobArtifactBundleV1(artifactAccessor), /data properties only/);
});

test('requires exact canonical ArtifactRef identity, digest, URI and timestamp fields', () => {
  const upperDigest = validInput();
  upperDigest.entries[0].artifactRef.sha256 = 'C'.repeat(64);
  assert.throws(() => buildJobArtifactBundleV1(upperDigest), /canonical lowercase SHA-256/);

  const looseArtifactTime = validInput();
  looseArtifactTime.entries[0].artifactRef.createdAt = '2026-09-24T21:33:00Z';
  assert.throws(() => buildJobArtifactBundleV1(looseArtifactTime), /canonical ISO timestamp/);

  const spacedId = validInput();
  spacedId.entries[0].artifactRef.artifactId = ' summary ';
  assert.throws(() => buildJobArtifactBundleV1(spacedId), /artifactId is invalid/);

  const spacedUri = validInput();
  spacedUri.entries[0].artifactRef.uri = ' artifact://job-1/timeline ';
  assert.throws(() => buildJobArtifactBundleV1(spacedUri), /uri must be canonical bounded text/);

  const unknownArtifactField = validInput();
  Object.defineProperty(unknownArtifactField.entries[0].artifactRef, 'permission', {
    enumerable: false,
    configurable: true,
    value: 'ALLOW',
  });
  assert.throws(() => buildJobArtifactBundleV1(unknownArtifactField), /unknown field: permission/);
});

test('rejects sparse entry and disclosure-request arrays instead of silently skipping holes', () => {
  const sparseEntries = validInput();
  delete sparseEntries.entries[1];
  assert.throws(() => buildJobArtifactBundleV1(sparseEntries), /entries must not be sparse/);

  const sparseDisclosure = validInput();
  sparseDisclosure.sensitiveDisclosureRequest.requestedSensitiveArtifactIds.length = 2;
  assert.throws(() => buildJobArtifactBundleV1(sparseDisclosure), /requestedSensitiveArtifactIds must not be sparse/);
});


test('accepts the exact canonical ArtifactRefV1 optional-field representation', () => {
  const canonical = normalizeArtifactRefV1({
    schemaVersion:1,
    artifactId:'canonical-optional',
    kind:'job-output',
    uri:'artifact://job-1/canonical-optional',
    sha256:'9'.repeat(64),
    sizeBytes:0,
    createdAt:AT,
    sensitive:false,
  });
  assert.equal(canonical.mediaType, '');
  assert.equal(canonical.producerInvocationId, null);

  const input = validInput();
  input.entries.push({
    path:'artifacts/canonical-optional.bin',
    category:JobArtifactCategory.ARTIFACT,
    artifactRef:canonical,
  });
  const bundle = buildJobArtifactBundleV1(input);
  const accepted = bundle.entries.find((item) => item.artifactRef.artifactId === 'canonical-optional');
  assert.equal(accepted.artifactRef.mediaType, '');
  assert.equal(accepted.artifactRef.producerInvocationId, null);
});

test('canonical control paths are bound to their semantic media type', () => {
  for (const [path, wrongMedia] of [
    ['SUMMARY.md', 'application/json'],
    ['REPORT.json', 'text/markdown'],
    ['timeline.jsonl', 'application/json'],
  ]) {
    const input = validInput();
    input.entries.find((item) => item.path === path).artifactRef.mediaType = wrongMedia;
    assert.throws(() => buildJobArtifactBundleV1(input), new RegExp(path.replace('.', '\\.') + ' requires mediaType'));
  }

  const withParameter = validInput();
  withParameter.entries.find((item) => item.path === 'SUMMARY.md').artifactRef.mediaType = 'text/markdown; charset=utf-8';
  assert.equal(buildJobArtifactBundleV1(withParameter).bundleId, 'bundle-1');
});

test('bundle collection boundaries reject accessor-backed entries and disclosure request without executing getters', () => {
  let entryReads = 0;
  const input = validInput();
  const hostileEntries = [...input.entries];
  Object.defineProperty(hostileEntries, 0, {
    enumerable:true,
    configurable:true,
    get() {
      entryReads += 1;
      return input.entries[0];
    },
  });
  input.entries = hostileEntries;
  assert.throws(() => buildJobArtifactBundleV1(input), /entries\[0\] must be an enumerable data property/);
  assert.equal(entryReads, 0, 'entry getter must never execute');

  let disclosureReads = 0;
  const disclosureInput = validInput();
  const hostileDisclosure = [];
  Object.defineProperty(hostileDisclosure, 0, {
    enumerable:true,
    configurable:true,
    get() {
      disclosureReads += 1;
      return 'evidence-1';
    },
  });
  disclosureInput.sensitiveDisclosureRequest.requestedSensitiveArtifactIds = hostileDisclosure;
  assert.throws(
    () => buildJobArtifactBundleV1(disclosureInput),
    /requestedSensitiveArtifactIds\[0\] must be an enumerable data property/,
  );
  assert.equal(disclosureReads, 0, 'sensitive-disclosure-request getter must never execute');
});

test('bundle collection boundaries reject hidden, custom, symbol and exotic array data', () => {
  const hidden = validInput();
  Object.defineProperty(hidden.entries, 0, {
    enumerable:false,
    configurable:true,
    writable:true,
    value:hidden.entries[0],
  });
  assert.throws(() => buildJobArtifactBundleV1(hidden), /entries\[0\] must be an enumerable data property/);

  const custom = validInput();
  custom.entries.metadata = 'authority';
  assert.throws(() => buildJobArtifactBundleV1(custom), /entries contains non-index array data/);

  const symbolic = validInput();
  symbolic.sensitiveDisclosureRequest.requestedSensitiveArtifactIds[Symbol('authority')] = 'result';
  assert.throws(() => buildJobArtifactBundleV1(symbolic), /requestedSensitiveArtifactIds contains non-index array data/);

  const exotic = validInput();
  Object.setPrototypeOf(exotic.entries, null);
  assert.throws(() => buildJobArtifactBundleV1(exotic), /entries must be a bounded plain array/);
});

test('hidden schema-valid bundle and ArtifactRef fields fail closed', () => {
  const hiddenBundleId = validInput();
  Object.defineProperty(hiddenBundleId, 'bundleId', {
    enumerable:false,
    configurable:true,
    writable:true,
    value:'bundle-hidden',
  });
  assert.throws(() => buildJobArtifactBundleV1(hiddenBundleId), /non-enumerable field: bundleId/);

  const hiddenDigest = validInput();
  Object.defineProperty(hiddenDigest.entries[0].artifactRef, 'sha256', {
    enumerable:false,
    configurable:true,
    writable:true,
    value:'c'.repeat(64),
  });
  assert.throws(() => buildJobArtifactBundleV1(hiddenDigest), /non-enumerable field: sha256/);

  const hiddenSensitive = validInput();
  Object.defineProperty(hiddenSensitive.entries[0].artifactRef, 'sensitive', {
    enumerable:false,
    configurable:true,
    writable:true,
    value:true,
  });
  assert.throws(() => buildJobArtifactBundleV1(hiddenSensitive), /non-enumerable field: sensitive/);
});


test('bundle creation cannot predate contained artifacts', () => {
  const futureArtifact = validInput();
  futureArtifact.entries[0].artifactRef.createdAt = '2026-09-24T21:33:00.001Z';
  assert.throws(
    () => buildJobArtifactBundleV1(futureArtifact),
    /bundle createdAt cannot predate artifact: timeline/,
  );

  const sameInstant = validInput();
  assert.equal(buildJobArtifactBundleV1(sameInstant).createdAt, AT);
});
