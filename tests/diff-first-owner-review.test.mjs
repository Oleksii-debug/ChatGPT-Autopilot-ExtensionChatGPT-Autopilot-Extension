import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DiffReviewChangeKind,
  DiffReviewRiskSeverity,
  DiffReviewRollbackKind,
  buildDiffFirstOwnerReviewV1,
} from '../src/core/diff-first-owner-review.js';

const GENERATED_AT = '2026-09-25T00:10:00.000Z';
const EVIDENCE_AT = '2026-09-25T00:05:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function artifact(artifactId = 'artifact-diff', overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'report',
    uri: `artifact://${artifactId}`,
    mediaType: 'application/json',
    sha256: SHA_A,
    sizeBytes: 123,
    createdAt: EVIDENCE_AT,
    producerInvocationId: 'invoke-1',
    sensitive: false,
    ...overrides,
  };
}

function verification(verificationId = 'verify-1', overrides = {}) {
  return {
    schemaVersion: 1,
    verificationId,
    invocationId: 'invoke-1',
    observationId: 'observe-1',
    status: 'VERIFIED',
    reasonCode: 'POSTCONDITION_OK',
    summary: 'Focused verification passed.',
    evidenceArtifactIds: ['artifact-diff'],
    verifiedAt: EVIDENCE_AT,
    verifierId: 'verifier-core',
    verificationAuthorityId: null,
    effectId: 'effect-1',
    executionId: 'invoke-1:attempt:1',
    attempt: 1,
    ...overrides,
  };
}

function change(changeId = 'change-1', overrides = {}) {
  return {
    changeId,
    kind: DiffReviewChangeKind.FILE,
    target: 'src/core/example.js',
    summary: 'Hardened the deterministic boundary.',
    rationale: 'The prior boundary could consume ambiguous representation.',
    artifactIds: ['artifact-diff'],
    effectIds: ['effect-1'],
    ...overrides,
  };
}

function risk(riskId = 'risk-1', overrides = {}) {
  return {
    riskId,
    severity: DiffReviewRiskSeverity.HIGH,
    summary: 'Physical Windows/NVDA behavior is not yet human-verified.',
    evidenceArtifactIds: ['artifact-diff'],
    ...overrides,
  };
}

function decision(decisionId = 'decision-1', overrides = {}) {
  return {
    decisionId,
    question: 'Approve physical owner-device qualification after CI?',
    options: ['QUALIFY_NOW', 'DEFER'],
    evidenceArtifactIds: ['artifact-diff'],
    ...overrides,
  };
}

function rollback(rollbackId = 'rollback-1', overrides = {}) {
  return {
    rollbackId,
    kind: DiffReviewRollbackKind.COMPENSATE,
    summary: 'Use the predeclared compensation invocation if the owner chooses rollback.',
    referenceId: 'invoke-rollback-1',
    evidenceArtifactIds: ['artifact-diff'],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    schemaVersion: 1,
    reviewId: 'review-1',
    projectId: 'project-1',
    subjectId: 'run-1',
    subjectRevisionId: 'revision-1',
    generatedAt: GENERATED_AT,
    summary: 'One bounded contract changed and was independently verified.',
    changes: [change()],
    artifactRefs: [artifact()],
    verificationRefs: [verification()],
    effectIds: ['effect-1'],
    risks: [risk()],
    decisions: [decision()],
    rollbackOptions: [rollback()],
    ...overrides,
  };
}

test('builds a complete deterministic text-first owner review without granting authority', () => {
  const result = buildDiffFirstOwnerReviewV1(input());

  assert.equal(result.advisoryOnly, true);
  assert.equal(result.approvalAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.rollbackAuthorized, false);
  assert.equal(result.requiresOwnerAttention, true);
  assert.deepEqual(result.attentionReasons, ['DECISIONS', 'HIGH_RISK']);
  assert.deepEqual(result.counts, {
    changes: 1,
    artifacts: 1,
    effects: 1,
    verifications: 1,
    risks: 1,
    decisions: 1,
    rollbackOptions: 1,
  });

  for (const heading of [
    'What changed (1)',
    'Artifacts (1)',
    'Effects changed (1)',
    'Verification results (1)',
    'Unresolved risks (1)',
    'Decisions needing attention (1)',
    'Rollback or compensating options (1)',
    'Authority: advisory/read-only review projection',
  ]) {
    assert.equal(result.plainText.includes(heading), true);
  }

  assert.match(result.plainText, /Hardened the deterministic boundary/);
  assert.match(result.plainText, /POSTCONDITION_OK/);
  assert.match(result.plainText, /effect-1/);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.changes), true);
  assert.equal(Object.isFrozen(result.changes[0]), true);
});

test('non-semantic collection ordering does not change the normalized review packet', () => {
  const artifact2 = artifact('artifact-log', {
    uri: 'artifact://artifact-log',
    sha256: SHA_B,
    producerInvocationId: 'invoke-2',
  });
  const verification2 = verification('verify-2', {
    invocationId: 'invoke-2',
    observationId: 'observe-2',
    evidenceArtifactIds: ['artifact-log'],
    verifierId: 'verifier-secondary',
    effectId: 'effect-2',
    executionId: 'invoke-2:attempt:1',
  });
  const change2 = change('change-2', {
    target: 'src/core/other.js',
    artifactIds: ['artifact-log'],
    effectIds: ['effect-2'],
  });
  const risk2 = risk('risk-2', {
    severity: DiffReviewRiskSeverity.LOW,
    evidenceArtifactIds: ['artifact-log'],
  });
  const decision2 = decision('decision-2', {
    question: 'Choose the follow-up owner checkpoint.',
    options: ['A', 'B'],
    evidenceArtifactIds: ['artifact-log'],
  });
  const rollback2 = rollback('rollback-2', {
    referenceId: 'invoke-rollback-2',
    evidenceArtifactIds: ['artifact-log'],
  });

  const first = buildDiffFirstOwnerReviewV1(input({
    artifactRefs: [artifact(), artifact2],
    verificationRefs: [verification(), verification2],
    changes: [change(), change2],
    effectIds: ['effect-1', 'effect-2'],
    risks: [risk(), risk2],
    decisions: [decision(), decision2],
    rollbackOptions: [rollback(), rollback2],
  }));
  const second = buildDiffFirstOwnerReviewV1(input({
    artifactRefs: [artifact2, artifact()],
    verificationRefs: [verification2, verification()],
    changes: [change2, change()],
    effectIds: ['effect-2', 'effect-1'],
    risks: [risk2, risk()],
    decisions: [decision2, decision()],
    rollbackOptions: [rollback2, rollback()],
  }));

  assert.deepEqual(second, first);
});

test('all artifact and effect cross-references must resolve exactly', () => {
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      changes: [change('change-bad-artifact', { artifactIds: ['missing-artifact'] })],
    })),
    /unknown identity: missing-artifact/,
  );

  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      changes: [change('change-bad-effect', { effectIds: ['missing-effect'] })],
    })),
    /unknown identity: missing-effect/,
  );

  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      verificationRefs: [verification('verify-bad-evidence', {
        evidenceArtifactIds: ['missing-artifact'],
      })],
    })),
    /unknown identity: missing-artifact/,
  );

  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      verificationRefs: [verification('verify-bad-effect', { effectId: 'missing-effect' })],
    })),
    /unknown effectId: missing-effect/,
  );
});

test('review consumes exact canonical ArtifactRef and Verification representations only', () => {
  const missingArtifactField = artifact();
  delete missingArtifactField.mediaType;
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({ artifactRefs: [missingArtifactField] })),
    /ArtifactRefV1 is missing field: mediaType/,
  );

  const missingVerificationField = verification();
  delete missingVerificationField.verifierId;
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({ verificationRefs: [missingVerificationField] })),
    /VerificationV1 is missing field: verifierId/,
  );

  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      verificationRefs: [verification('verify-no-verifier', {
        verifierId: null,
        verificationAuthorityId: null,
      })],
    })),
    /must identify verifierId or verificationAuthorityId/,
  );

  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      verificationRefs: [verification('verify-no-evidence', { evidenceArtifactIds: [] })],
    })),
    /between 1 and 128 items/,
  );
});

test('verification evidence cannot come from the future relative to the review packet', () => {
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      verificationRefs: [verification('verify-future', {
        verifiedAt: '2026-09-25T00:10:00.001Z',
      })],
    })),
    /verifiedAt is after review generatedAt/,
  );
});

test('artifact and verification evidence chronology cannot point into the future', () => {
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      artifactRefs: [artifact('artifact-diff', {
        createdAt: '2026-09-25T00:10:00.001Z',
      })],
    })),
    /artifact artifact-diff createdAt is after review generatedAt/,
  );

  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      artifactRefs: [artifact('artifact-diff', {
        createdAt: '2026-09-25T00:05:00.001Z',
      })],
      verificationRefs: [verification('verify-before-evidence', {
        verifiedAt: '2026-09-25T00:05:00.000Z',
      })],
    })),
    /references evidence created after verifiedAt: artifact-diff/,
  );
});

test('failed or ambiguous verification exceptions require owner attention deterministically', () => {
  const failed = buildDiffFirstOwnerReviewV1(input({
    risks: [],
    decisions: [],
    verificationRefs: [verification('verify-failed', {
      status: 'FAILED',
      reasonCode: 'POSTCONDITION_FAILED',
      summary: 'Expected postcondition was not observed.',
    })],
  }));
  assert.equal(failed.requiresOwnerAttention, true);
  assert.deepEqual(failed.attentionReasons, ['VERIFICATION_EXCEPTION']);

  const clean = buildDiffFirstOwnerReviewV1(input({
    risks: [],
    decisions: [],
  }));
  assert.equal(clean.requiresOwnerAttention, false);
  assert.deepEqual(clean.attentionReasons, []);
});

test('effect state/phase cannot be smuggled into the read-only review contract', () => {
  const raw = input();
  raw.effectStates = [{ effectId: 'effect-1', phase: 'COMMITTED' }];
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(raw),
    /unknown field: effectStates/,
  );

  const changed = change();
  changed.phase = 'COMMITTED';
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({ changes: [changed] })),
    /unknown field: phase/,
  );
});

test('accessors at record and array authority boundaries are rejected without executing getters', () => {
  let reads = 0;

  const raw = input();
  Object.defineProperty(raw, 'summary', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'must not execute';
    },
  });
  assert.throws(() => buildDiffFirstOwnerReviewV1(raw), /enumerable own data property/);
  assert.equal(reads, 0);

  const artifactWithGetter = artifact();
  Object.defineProperty(artifactWithGetter, 'sha256', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return SHA_A;
    },
  });
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({ artifactRefs: [artifactWithGetter] })),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const effects = ['effect-1'];
  Object.defineProperty(effects, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'effect-1';
    },
  });
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({ effectIds: effects })),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('hidden, symbol, inherited and non-canonical array authority fail closed', () => {
  const hidden = input();
  Object.defineProperty(hidden, 'summary', {
    enumerable: false,
    configurable: true,
    value: hidden.summary,
  });
  assert.throws(() => buildDiffFirstOwnerReviewV1(hidden), /enumerable own data property/);

  const symbolic = input();
  symbolic[Symbol('approval')] = true;
  assert.throws(() => buildDiffFirstOwnerReviewV1(symbolic), /unknown field/);

  const inherited = Object.create({ projectId: 'project-1' });
  Object.assign(inherited, input());
  delete inherited.projectId;
  assert.throws(() => buildDiffFirstOwnerReviewV1(inherited), /plain or null-prototype object/);

  const effects = ['effect-1'];
  Object.defineProperty(effects, 'authority', {
    enumerable: false,
    configurable: true,
    value: 'APPROVE',
  });
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({ effectIds: effects })),
    /non-canonical array fields/,
  );
});

test('sensitive artifact URI is not duplicated into the complete plain-text review surface', () => {
  const secretUri = 'file:///C:/private/owner-secret.txt';
  const sensitive = artifact('artifact-sensitive', {
    uri: secretUri,
    sha256: SHA_B,
    sensitive: true,
  });
  const result = buildDiffFirstOwnerReviewV1(input({
    artifactRefs: [artifact(), sensitive],
  }));

  assert.equal(result.artifactRefs.find(item => item.artifactId === 'artifact-sensitive').uri, secretUri);
  assert.equal(result.plainText.includes(secretUri), false);
  assert.match(result.plainText, /artifact-sensitive: report; sha256=/);
  assert.match(result.plainText, /sensitive=yes/);
});

test('rollback and compensation references remain opaque and never become execution authority', () => {
  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      rollbackOptions: [rollback('rollback-missing-ref', { referenceId: null })],
    })),
    /requires an opaque referenceId/,
  );

  assert.throws(
    () => buildDiffFirstOwnerReviewV1(input({
      rollbackOptions: [rollback('rollback-none-with-ref', {
        kind: DiffReviewRollbackKind.NONE,
        referenceId: 'invoke-should-not-exist',
      })],
    })),
    /must not carry a referenceId/,
  );

  const none = buildDiffFirstOwnerReviewV1(input({
    rollbackOptions: [rollback('rollback-none', {
      kind: DiffReviewRollbackKind.NONE,
      referenceId: null,
      summary: 'No automatic rollback is declared; owner review is required.',
    })],
  }));
  assert.equal(none.rollbackOptions[0].referenceId, null);
  assert.equal('executeRollback' in none, false);
  assert.equal('approve' in none, false);
});

test('risk projection prioritizes critical/high exceptions without changing declared facts', () => {
  const result = buildDiffFirstOwnerReviewV1(input({
    risks: [
      risk('risk-low', { severity: DiffReviewRiskSeverity.LOW }),
      risk('risk-critical', { severity: DiffReviewRiskSeverity.CRITICAL }),
      risk('risk-medium', { severity: DiffReviewRiskSeverity.MEDIUM }),
      risk('risk-high', { severity: DiffReviewRiskSeverity.HIGH }),
    ],
  }));
  assert.deepEqual(
    result.risks.map(item => item.riskId),
    ['risk-critical', 'risk-high', 'risk-medium', 'risk-low'],
  );
  assert.deepEqual(result.attentionReasons, ['DECISIONS', 'HIGH_RISK']);
});
