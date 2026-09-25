import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArtifactWorkspacePreflightStatus,
  buildArtifactWorkspaceDeliveryPreflightV1,
} from '../src/core/artifact-workspace-preflight.js';
import {
  createArtifactRegistryV1,
  putArtifactVersionV1,
} from '../src/core/artifact-registry.js';

const hash = char => char.repeat(64);
const at = second => `2026-09-25T07:20:${String(second).padStart(2, '0')}.000Z`;

function artifact({
  artifactId = 'report',
  kind = 'DOCUMENT',
  uri = `project://artifact/${artifactId}`,
  mediaType = 'text/markdown',
  sha256 = hash('a'),
  sizeBytes = 10,
  createdAt = at(1),
  producerInvocationId = 'build-report',
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
  revisionId = 'source-r1',
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
  versionId = 'v1',
  parentVersionId = null,
  artifactRef = artifact(),
  provenanceRef = provenance(artifactRef, { projectId }),
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

function registryFixture() {
  const firstRef = artifact({ sha256: hash('a'), sizeBytes: 10, createdAt: at(1) });
  const first = version({
    versionId: 'v1',
    artifactRef: firstRef,
    provenanceRef: provenance(firstRef, { createdAt: at(2) }),
    registeredAt: at(3),
  });
  let registry = putArtifactVersionV1(createArtifactRegistryV1('project-a'), first);

  const currentRef = artifact({
    sha256: hash('b'),
    sizeBytes: 25,
    createdAt: at(4),
    producerInvocationId: 'build-report-v2',
  });
  const current = version({
    versionId: 'v2',
    parentVersionId: 'v1',
    artifactRef: currentRef,
    provenanceRef: provenance(currentRef, {
      revisionId: 'source-r2',
      contentSha256: hash('d'),
      createdAt: at(5),
    }),
    registeredAt: at(6),
  });
  registry = putArtifactVersionV1(registry, current);
  return { registry, firstRef, currentRef };
}

function verification({
  status = 'VERIFIED',
  verifiedAt = at(8),
  evidenceArtifactId = 'validation-log',
} = {}) {
  return {
    schemaVersion: 1,
    verificationId: 'verify-report-v2',
    invocationId: 'verify-invocation',
    observationId: 'verify-observation',
    status,
    reasonCode: status === 'VERIFIED' ? 'ARTIFACT_VALID' : 'ARTIFACT_INVALID',
    summary: 'Artifact validation result.',
    evidenceArtifactIds: [evidenceArtifactId],
    verifiedAt,
    verifierId: 'artifact-verifier',
    verificationAuthorityId: null,
    effectId: null,
    executionId: null,
    attempt: 1,
  };
}

function reviewFixture(currentRef, {
  validation = verification(),
  generatedAt = at(9),
  decisions = [],
  risks = [],
} = {}) {
  const validationLog = artifact({
    artifactId: 'validation-log',
    kind: 'EVIDENCE',
    uri: 'project://evidence/validation-log',
    mediaType: 'application/json',
    sha256: hash('e'),
    sizeBytes: 40,
    createdAt: at(7),
    producerInvocationId: 'verify-invocation',
  });
  const ownerReview = {
    schemaVersion: 1,
    reviewId: 'review-report-v2',
    projectId: 'project-a',
    subjectId: 'report',
    subjectRevisionId: 'v2',
    generatedAt,
    summary: 'Review the current report artifact.',
    changes: [{
      changeId: 'change-report',
      kind: 'ARTIFACT',
      target: 'report',
      summary: 'Report content changed.',
      rationale: 'Current source material was incorporated.',
      artifactIds: ['report'],
      effectIds: [],
    }],
    artifactRefs: [currentRef, validationLog],
    verificationRefs: [validation],
    effectIds: [],
    risks,
    decisions,
    rollbackOptions: [],
  };
  const trustedEvidence = {
    schemaVersion: 1,
    projectId: 'project-a',
    subjectId: 'report',
    subjectRevisionId: 'v2',
    artifactRefs: [currentRef, validationLog],
    verificationRefs: [validation],
    effectIds: [],
  };
  return { ownerReview, trustedEvidence, validationLog };
}

function controlArtifact(path, {
  artifactId,
  mediaType,
  createdAt = at(7),
} = {}) {
  return artifact({
    artifactId,
    kind: 'CONTROL',
    uri: `job://bundle/${path}`,
    mediaType,
    sha256: hash(artifactId[0]),
    sizeBytes: 12,
    createdAt,
    producerInvocationId: 'bundle-control',
  });
}

function bundleFixture(currentRef, {
  projectId = 'project-a',
  reportRef = currentRef,
  createdAt = at(10),
} = {}) {
  return {
    schemaVersion: 1,
    bundleId: 'bundle-report-v2',
    jobId: 'job-report',
    planId: 'plan-report',
    projectId,
    createdAt,
    sensitiveDisclosureRequest: { requestedSensitiveArtifactIds: [] },
    entries: [
      {
        path: 'SUMMARY.md',
        category: 'CONTROL',
        artifactRef: controlArtifact('SUMMARY.md', {
          artifactId: 'summary-control',
          mediaType: 'text/markdown',
        }),
      },
      {
        path: 'REPORT.json',
        category: 'CONTROL',
        artifactRef: controlArtifact('REPORT.json', {
          artifactId: 'report-control',
          mediaType: 'application/json',
        }),
      },
      {
        path: 'timeline.jsonl',
        category: 'CONTROL',
        artifactRef: controlArtifact('timeline.jsonl', {
          artifactId: 'timeline-control',
          mediaType: 'application/x-ndjson',
        }),
      },
      {
        path: 'artifacts/report.md',
        category: 'ARTIFACT',
        artifactRef: reportRef,
      },
    ],
  };
}

function preflightFixture({
  validationStatus = 'VERIFIED',
  verificationAt = at(8),
  reviewDecisions = [],
  reviewRisks = [],
  bundleProjectId = 'project-a',
  bundleReportRef = null,
} = {}) {
  const { registry, firstRef, currentRef } = registryFixture();
  const selectedVerification = verification({
    status: validationStatus,
    verifiedAt: verificationAt,
  });
  const { ownerReview, trustedEvidence } = reviewFixture(currentRef, {
    validation: selectedVerification,
    decisions: reviewDecisions,
    risks: reviewRisks,
  });
  const finalBundle = bundleFixture(currentRef, {
    projectId: bundleProjectId,
    reportRef: bundleReportRef || currentRef,
  });
  return {
    firstRef,
    currentRef,
    trustedEvidence,
    input: {
      schemaVersion: 1,
      preflightId: 'preflight-report-v2',
      projectId: 'project-a',
      artifactId: 'report',
      versionId: 'v2',
      generatedAt: at(11),
      registry,
      ownerReview,
      validationVerificationIds: ['verify-report-v2'],
      finalBundle,
    },
  };
}

function runFixture(fixture) {
  return buildArtifactWorkspaceDeliveryPreflightV1(fixture.input, {
    resolveSubjectEvidence: () => fixture.trustedEvidence,
  });
}

test('artifact workspace preflight composes current version, diff, validation, review, and final bundle without granting authority', () => {
  const fixture = preflightFixture();
  const result = runFixture(fixture);

  assert.equal(result.status, ArtifactWorkspacePreflightStatus.EVIDENCE_READY_FOR_OWNER_REVIEW);
  assert.equal(result.currentArtifactRef.sha256, hash('b'));
  assert.equal(result.version.parentDiff.contentChanged, true);
  assert.equal(result.version.parentDiff.sizeDeltaBytes, 15);
  assert.equal(result.validation.evidenceReady, true);
  assert.deepEqual(result.validation.verificationIds, ['verify-report-v2']);
  assert.equal(result.ownerReview.subjectEvidenceBound, true);
  assert.equal(result.ownerReview.requiresOwnerAttention, false);
  assert.equal(result.finalBundle.bundleId, 'bundle-report-v2');
  assert.equal(result.finalBundle.path, 'artifacts/report.md');
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.approvalAuthorized, false);
  assert.equal(result.distributionAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.requiresCanonicalOwnerApproval, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.validation), true);
});

test('stale artifact version cannot be presented as current delivery preflight', () => {
  const fixture = preflightFixture();
  fixture.input.versionId = 'v1';
  assert.throws(
    () => runFixture(fixture),
    /requires the current artifact version/,
  );
});

test('bundle must contain the exact current ArtifactRef rather than the same logical artifactId', () => {
  const fixture = preflightFixture();
  fixture.input.finalBundle = bundleFixture(fixture.currentRef, {
    reportRef: fixture.firstRef,
  });
  assert.throws(
    () => runFixture(fixture),
    /does not contain the exact current ArtifactRefV1/,
  );
});

test('foreign bundle project identity fails closed', () => {
  const fixture = preflightFixture({ bundleProjectId: 'project-b' });
  assert.throws(
    () => runFixture(fixture),
    /final bundle projectId does not match/,
  );
});

test('failed and ambiguous selected validation remain explicit blocking states', () => {
  const failed = preflightFixture({ validationStatus: 'FAILED' });
  assert.equal(runFixture(failed).status, ArtifactWorkspacePreflightStatus.VALIDATION_FAILED);
  assert.equal(runFixture(failed).validation.evidenceReady, false);

  const ambiguous = preflightFixture({ validationStatus: 'AMBIGUOUS' });
  assert.equal(runFixture(ambiguous).status, ArtifactWorkspacePreflightStatus.VALIDATION_AMBIGUOUS);
  assert.equal(runFixture(ambiguous).validation.evidenceReady, false);
});

test('not-applicable validation is incomplete rather than evidence-ready', () => {
  const fixture = preflightFixture({ validationStatus: 'NOT_APPLICABLE' });
  fixture.input.ownerReview.verificationRefs[0].observationId = null;
  fixture.trustedEvidence.verificationRefs[0].observationId = null;
  fixture.input.ownerReview.verificationRefs[0].evidenceArtifactIds = [];
  fixture.trustedEvidence.verificationRefs[0].evidenceArtifactIds = [];
  assert.equal(runFixture(fixture).status, ArtifactWorkspacePreflightStatus.VALIDATION_INCOMPLETE);
});

test('owner-review attention remains visible even when selected validation passes', () => {
  const fixture = preflightFixture({
    reviewDecisions: [{
      decisionId: 'decision-release-note',
      question: 'Use the shorter release note?',
      options: ['Keep full note', 'Use shorter note'],
      evidenceArtifactIds: ['validation-log'],
    }],
  });
  const result = runFixture(fixture);
  assert.equal(result.status, ArtifactWorkspacePreflightStatus.OWNER_ATTENTION_REQUIRED);
  assert.deepEqual(result.ownerReview.attentionReasons, ['DECISIONS']);
  assert.equal(result.approvalAuthorized, false);
});

test('validation evidence cannot predate artifact registration', () => {
  const fixture = preflightFixture({ verificationAt: at(5) });
  fixture.input.ownerReview.artifactRefs[1] = {
    ...fixture.input.ownerReview.artifactRefs[1],
    createdAt: at(5),
  };
  fixture.trustedEvidence.artifactRefs[1] = fixture.input.ownerReview.artifactRefs[1];
  assert.throws(
    () => runFixture(fixture),
    /validation verification predates artifact registration/,
  );
});

test('owner review must contain the exact current ArtifactRef and exact subject revision', () => {
  const fixture = preflightFixture();
  fixture.input.ownerReview.artifactRefs[0] = fixture.firstRef;
  fixture.trustedEvidence.artifactRefs[0] = fixture.firstRef;
  assert.throws(
    () => runFixture(fixture),
    /owner review does not include the exact current ArtifactRefV1/,
  );

  const staleRevision = preflightFixture();
  staleRevision.input.ownerReview.subjectRevisionId = 'v1';
  staleRevision.trustedEvidence.subjectRevisionId = 'v1';
  assert.throws(
    () => runFixture(staleRevision),
    /owner review does not bind exact preflight project\/artifact\/version/,
  );
});

test('validation IDs must be unique, bound to the review, and descriptor-safe', () => {
  const duplicate = preflightFixture();
  duplicate.input.validationVerificationIds = ['verify-report-v2', 'verify-report-v2'];
  assert.throws(() => runFixture(duplicate), /duplicate identity/);

  const unknown = preflightFixture();
  unknown.input.validationVerificationIds = ['verify-other'];
  assert.throws(() => runFixture(unknown), /not bound to owner review/);

  const sparse = preflightFixture();
  sparse.input.validationVerificationIds = new Array(1);
  assert.throws(() => runFixture(sparse), /enumerable own data property/);
});

test('top-level accessor input fails before getter execution', () => {
  const fixture = preflightFixture();
  let reads = 0;
  const hostile = { ...fixture.input };
  Object.defineProperty(hostile, 'registry', {
    enumerable: true,
    get() {
      reads += 1;
      return fixture.input.registry;
    },
  });
  assert.throws(
    () => buildArtifactWorkspaceDeliveryPreflightV1(hostile, {
      resolveSubjectEvidence: () => fixture.trustedEvidence,
    }),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});
