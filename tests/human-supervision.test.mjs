import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HUMAN_SUPERVISION_SCHEMA_VERSION,
  HumanSupervisionKind,
  HumanSupervisionState,
  normalizeHumanSupervisionRequestV1,
  normalizePolicyApprovalAttestationV1,
  normalizeClarificationResponseV1,
  projectHumanSupervisionV1,
  resolveClarificationV1,
} from '../src/core/human-supervision.js';

const CREATED = '2026-09-24T22:00:00.000Z';
const FIRST_EXPIRES = '2026-09-24T22:10:00.000Z';
const SECOND_EXPIRES = '2026-09-24T22:20:00.000Z';

function approvalRequest(overrides = {}) {
  return {
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: 'supervision-1',
    jobId: 'job-1',
    stepId: 'step-7',
    kind: HumanSupervisionKind.POLICY_APPROVAL,
    question: 'Review the exact approval ticket.',
    createdAt: CREATED,
    approvalId: 'approval-1',
    reviewStages: [
      {
        stageId: 'owner',
        reviewerIds: ['reviewer-owner'],
        expiresAt: FIRST_EXPIRES,
      },
      {
        stageId: 'backup',
        reviewerIds: ['reviewer-backup'],
        expiresAt: SECOND_EXPIRES,
      },
    ],
    choices: [],
    allowFreeText: false,
    requiredEvidenceArtifactIds: ['artifact-before', 'artifact-policy'],
    ...overrides,
  };
}

function approvalAttestation(overrides = {}) {
  return {
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    responseId: 'attestation-1',
    supervisionId: 'supervision-1',
    jobId: 'job-1',
    stepId: 'step-7',
    responderId: 'reviewer-owner',
    respondedAt: '2026-09-24T22:05:00.000Z',
    reasonCode: 'OWNER_REVIEWED',
    evidenceArtifactIds: ['artifact-policy', 'artifact-before'],
    approvalId: 'approval-1',
    approvalResolutionId: 'resolution-1',
    ...overrides,
  };
}

function clarificationRequest(overrides = {}) {
  return {
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: 'clarification-1',
    jobId: 'job-2',
    stepId: 'step-3',
    kind: HumanSupervisionKind.CLARIFICATION,
    question: 'Which output format should be used?',
    createdAt: CREATED,
    approvalId: '',
    reviewStages: [
      {
        stageId: 'owner',
        reviewerIds: ['reviewer-owner'],
        expiresAt: SECOND_EXPIRES,
      },
    ],
    choices: [
      { choiceId: 'docx', label: 'DOCX document' },
      { choiceId: 'pdf', label: 'PDF document' },
    ],
    allowFreeText: true,
    requiredEvidenceArtifactIds: [],
    ...overrides,
  };
}

function clarificationResponse(overrides = {}) {
  return {
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    responseId: 'clarification-response-1',
    supervisionId: 'clarification-1',
    jobId: 'job-2',
    stepId: 'step-3',
    responderId: 'reviewer-owner',
    respondedAt: '2026-09-24T22:05:00.000Z',
    reasonCode: 'OWNER_SELECTED_FORMAT',
    evidenceArtifactIds: [],
    selectedChoiceId: 'pdf',
    clarificationText: '',
    ...overrides,
  };
}

test('policy approval routing projects deterministic reviewer escalation without granting approval', () => {
  const request = approvalRequest();

  const first = projectHumanSupervisionV1(request, CREATED);
  assert.equal(first.state, HumanSupervisionState.WAITING_APPROVAL);
  assert.equal(first.activeStageId, 'owner');
  assert.deepEqual(first.authorizedReviewerIds, ['reviewer-owner']);
  assert.equal(first.nextEscalationAt, FIRST_EXPIRES);
  assert.equal(first.escalationPending, true);

  const boundary = projectHumanSupervisionV1(request, FIRST_EXPIRES);
  assert.equal(boundary.state, HumanSupervisionState.WAITING_APPROVAL);
  assert.equal(boundary.activeStageId, 'backup');
  assert.deepEqual(boundary.authorizedReviewerIds, ['reviewer-backup']);
  assert.equal(boundary.nextEscalationAt, SECOND_EXPIRES);
  assert.equal(boundary.escalationPending, false);

  const timedOut = projectHumanSupervisionV1(request, SECOND_EXPIRES);
  assert.equal(timedOut.state, HumanSupervisionState.TIMED_OUT);
  assert.equal(timedOut.activeStageId, '');
  assert.deepEqual(timedOut.authorizedReviewerIds, []);
});

test('clarification routing exposes WAITING_CLARIFICATION rather than policy authority', () => {
  const projected = projectHumanSupervisionV1(
    clarificationRequest(),
    '2026-09-24T22:01:00.000Z',
  );
  assert.equal(projected.state, HumanSupervisionState.WAITING_CLARIFICATION);
  assert.equal(projected.activeStageId, 'owner');
  assert.equal(Object.hasOwn(projected, 'approvalId'), false);
});

test('policy approval attestation binds routing identity, evidence and external approval resolution reference', () => {
  const attestation = normalizePolicyApprovalAttestationV1(
    approvalRequest(),
    approvalAttestation(),
  );

  assert.equal(attestation.approvalId, 'approval-1');
  assert.equal(attestation.approvalResolutionId, 'resolution-1');
  assert.equal(attestation.stageId, 'owner');
  assert.deepEqual(attestation.evidenceArtifactIds, ['artifact-before', 'artifact-policy']);
  assert.equal(Object.hasOwn(attestation, 'decision'), false);
  assert.equal(Object.hasOwn(attestation, 'resume'), false);
  assert.equal(Object.isFrozen(attestation), true);
});

test('approval routing cannot mint, carry or imitate approval decision/resume authority', () => {
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({
      choices: [{ choiceId: 'allow', label: 'Allow' }],
    })),
    /cannot declare clarification choices/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({ allowFreeText: true })),
    /cannot enable clarification free text/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({ approvalId: '' })),
    /requires approvalId/,
  );

  assert.throws(
    () => normalizePolicyApprovalAttestationV1(
      approvalRequest(),
      {
        ...approvalAttestation(),
        decision: 'APPROVE',
      },
    ),
    /unknown field/,
  );
  assert.throws(
    () => normalizePolicyApprovalAttestationV1(
      approvalRequest(),
      {
        ...approvalAttestation(),
        resume: { stepId: 'step-7' },
      },
    ),
    /unknown field/,
  );
});

test('active-stage reviewer authorization is exact and late attestations fail closed', () => {
  assert.throws(
    () => normalizePolicyApprovalAttestationV1(
      approvalRequest(),
      approvalAttestation({
        responderId: 'reviewer-owner',
        respondedAt: '2026-09-24T22:15:00.000Z',
      }),
    ),
    /not authorized/,
  );

  const escalated = normalizePolicyApprovalAttestationV1(
    approvalRequest(),
    approvalAttestation({
      responseId: 'attestation-backup',
      responderId: 'reviewer-backup',
      respondedAt: '2026-09-24T22:15:00.000Z',
    }),
  );
  assert.equal(escalated.stageId, 'backup');

  assert.throws(
    () => normalizePolicyApprovalAttestationV1(
      approvalRequest(),
      approvalAttestation({
        responderId: 'reviewer-backup',
        respondedAt: SECOND_EXPIRES,
      }),
    ),
    /timed out/,
  );
});

test('required evidence and exact job/step/supervision/approval identity cannot be bypassed', () => {
  assert.throws(
    () => normalizePolicyApprovalAttestationV1(
      approvalRequest(),
      approvalAttestation({ evidenceArtifactIds: ['artifact-before'] }),
    ),
    /missing required evidence artifact: artifact-policy/,
  );

  for (const [field, value, expected] of [
    ['supervisionId', 'supervision-other', /supervisionId mismatch/],
    ['jobId', 'job-other', /jobId mismatch/],
    ['stepId', 'step-other', /stepId mismatch/],
    ['approvalId', 'approval-other', /approvalId mismatch/],
  ]) {
    assert.throws(
      () => normalizePolicyApprovalAttestationV1(
        approvalRequest(),
        approvalAttestation({ [field]: value }),
      ),
      expected,
    );
  }
});

test('CLARIFICATION cannot carry approval authority and resolves to same-step answer resume only', () => {
  const selected = resolveClarificationV1({
    request: clarificationRequest(),
    response: clarificationResponse(),
  });
  assert.equal(selected.state, HumanSupervisionState.RESOLVED);
  assert.equal(selected.selectedChoiceId, 'pdf');
  assert.equal(selected.clarificationText, '');
  assert.equal(Object.hasOwn(selected, 'approvalId'), false);
  assert.deepEqual(selected.resume, {
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: 'clarification-1',
    responseId: 'clarification-response-1',
    jobId: 'job-2',
    stepId: 'step-3',
    resumeStepId: 'step-3',
    resolvedAt: '2026-09-24T22:05:00.000Z',
  });

  assert.throws(
    () => normalizeHumanSupervisionRequestV1(clarificationRequest({
      approvalId: 'approval-evil',
    })),
    /cannot carry approvalId/,
  );

  assert.throws(
    () => normalizeClarificationResponseV1(
      clarificationRequest(),
      {
        ...clarificationResponse(),
        approvalResolutionId: 'resolution-evil',
      },
    ),
    /unknown field/,
  );
});

test('CLARIFICATION supports one declared choice or allowed free text, never both', () => {
  const textAnswer = normalizeClarificationResponseV1(
    clarificationRequest(),
    clarificationResponse({
      responseId: 'clarification-response-2',
      selectedChoiceId: '',
      clarificationText: 'Use the existing project template.',
    }),
  );
  assert.equal(textAnswer.selectedChoiceId, '');
  assert.equal(textAnswer.clarificationText, 'Use the existing project template.');

  assert.throws(
    () => normalizeClarificationResponseV1(
      clarificationRequest(),
      clarificationResponse({ selectedChoiceId: 'unknown' }),
    ),
    /not declared/,
  );
  assert.throws(
    () => normalizeClarificationResponseV1(
      clarificationRequest(),
      clarificationResponse({ clarificationText: 'also text' }),
    ),
    /exactly one choice or text answer/,
  );
  assert.throws(
    () => normalizeClarificationResponseV1(
      clarificationRequest({ allowFreeText: false }),
      clarificationResponse({
        selectedChoiceId: '',
        clarificationText: 'free form',
      }),
    ),
    /free text is not allowed/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(clarificationRequest({
      choices: [],
      allowFreeText: false,
    })),
    /requires choices or allowFreeText/,
  );
});

test('stage deadlines are canonical, strictly increasing and after creation', () => {
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({
      reviewStages: [
        { stageId: 'owner', reviewerIds: ['reviewer-owner'], expiresAt: CREATED },
      ],
    })),
    /strictly increasing/,
  );

  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({
      reviewStages: [
        { stageId: 'owner', reviewerIds: ['reviewer-owner'], expiresAt: SECOND_EXPIRES },
        { stageId: 'backup', reviewerIds: ['reviewer-backup'], expiresAt: FIRST_EXPIRES },
      ],
    })),
    /strictly increasing/,
  );

  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({
      createdAt: '2026-09-24T22:00:00Z',
    })),
    /canonical ISO timestamp/,
  );

  assert.throws(
    () => projectHumanSupervisionV1(approvalRequest(), '2026-09-24T21:59:59.999Z'),
    /cannot predate/,
  );
});

test('request and response boundaries reject coercion, exotic objects, symbols and sparse arrays', () => {
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({ schemaVersion: '1' })),
    /schemaVersion/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({ allowFreeText: 0 })),
    /must be boolean/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({ supervisionId: 1 })),
    /supervisionId is invalid/,
  );

  const exotic = Object.create({ approvalId: 'approval-inherited' });
  Object.assign(exotic, approvalRequest());
  delete exotic.approvalId;
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(exotic),
    /plain object/,
  );

  const symbol = approvalRequest();
  symbol[Symbol('authority')] = 'APPROVE';
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(symbol),
    /unknown field/,
  );

  const accessor = approvalRequest();
  let getterExecuted = false;
  Object.defineProperty(accessor, 'question', {
    enumerable: true,
    get() {
      getterExecuted = true;
      throw new Error('getter must never execute');
    },
  });
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(accessor),
    /data properties only/,
  );
  assert.equal(getterExecuted, false);

  const sparseStages = new Array(2);
  sparseStages[0] = {
    stageId: 'owner',
    reviewerIds: ['reviewer-owner'],
    expiresAt: FIRST_EXPIRES,
  };
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(approvalRequest({ reviewStages: sparseStages })),
    /must not be sparse/,
  );

  assert.throws(
    () => normalizePolicyApprovalAttestationV1(
      approvalRequest(),
      approvalAttestation({ reasonCode: { toString: () => 'OWNER_REVIEWED' } }),
    ),
    /reasonCode is invalid/,
  );
});

test('null-prototype records are accepted without widening authority', () => {
  const request = Object.assign(Object.create(null), approvalRequest());
  request.reviewStages = approvalRequest().reviewStages.map((stage) => (
    Object.assign(Object.create(null), stage)
  ));
  request.choices = [];

  const normalized = normalizeHumanSupervisionRequestV1(request);
  assert.equal(normalized.kind, HumanSupervisionKind.POLICY_APPROVAL);
  assert.equal(normalized.approvalId, 'approval-1');
  assert.deepEqual(normalized.requiredEvidenceArtifactIds, ['artifact-before', 'artifact-policy']);
});
