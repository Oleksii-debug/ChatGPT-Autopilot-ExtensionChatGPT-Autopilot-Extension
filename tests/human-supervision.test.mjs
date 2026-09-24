import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HUMAN_SUPERVISION_SCHEMA_VERSION,
  HumanSupervisionKind,
  HumanSupervisionState,
  PolicyAskDecision,
  normalizeHumanSupervisionRequestV1,
  normalizeHumanSupervisionResponseV1,
  projectHumanSupervisionV1,
  resolveHumanSupervisionV1,
} from '../src/core/human-supervision.js';

const CREATED = '2026-09-24T22:00:00.000Z';
const FIRST_EXPIRES = '2026-09-24T22:10:00.000Z';
const SECOND_EXPIRES = '2026-09-24T22:20:00.000Z';

function policyRequest(overrides = {}) {
  return {
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: 'supervision-1',
    jobId: 'job-1',
    stepId: 'step-7',
    kind: HumanSupervisionKind.POLICY_ASK,
    question: 'Allow the exact requested external action?',
    createdAt: CREATED,
    policyDecisionId: 'policy-decision-1',
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

function policyResponse(overrides = {}) {
  return {
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    responseId: 'response-1',
    supervisionId: 'supervision-1',
    jobId: 'job-1',
    stepId: 'step-7',
    responderId: 'reviewer-owner',
    respondedAt: '2026-09-24T22:05:00.000Z',
    reasonCode: 'OWNER_APPROVED',
    evidenceArtifactIds: ['artifact-policy', 'artifact-before'],
    policyDecision: PolicyAskDecision.ALLOW,
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
    policyDecisionId: '',
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

test('POLICY_ASK projects deterministic reviewer escalation and terminal timeout', () => {
  const request = policyRequest();

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
  assert.equal(timedOut.nextEscalationAt, '');
  assert.equal(timedOut.escalationPending, false);
});

test('POLICY_ASK resolution binds exact request, evidence and same-step resume', () => {
  const result = resolveHumanSupervisionV1({
    request: policyRequest(),
    response: policyResponse(),
  });

  assert.equal(result.state, HumanSupervisionState.RESOLVED);
  assert.equal(result.supervisionId, 'supervision-1');
  assert.equal(result.jobId, 'job-1');
  assert.equal(result.stepId, 'step-7');
  assert.equal(result.responseId, 'response-1');
  assert.equal(result.resolution.kind, HumanSupervisionKind.POLICY_ASK);
  assert.equal(result.resolution.policyDecisionId, 'policy-decision-1');
  assert.equal(result.resolution.policyDecision, PolicyAskDecision.ALLOW);
  assert.deepEqual(result.evidenceArtifactIds, ['artifact-before', 'artifact-policy']);
  assert.deepEqual(result.resume, {
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: 'supervision-1',
    responseId: 'response-1',
    jobId: 'job-1',
    stepId: 'step-7',
    resumeStepId: 'step-7',
    resolvedAt: '2026-09-24T22:05:00.000Z',
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.resume), true);
});

test('active stage authorization is exact and late responses fail closed', () => {
  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      policyRequest(),
      policyResponse({
        responderId: 'reviewer-owner',
        respondedAt: '2026-09-24T22:15:00.000Z',
      }),
    ),
    /not authorized/,
  );

  const escalated = normalizeHumanSupervisionResponseV1(
    policyRequest(),
    policyResponse({
      responseId: 'response-backup',
      responderId: 'reviewer-backup',
      respondedAt: '2026-09-24T22:15:00.000Z',
    }),
  );
  assert.equal(escalated.stageId, 'backup');

  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      policyRequest(),
      policyResponse({
        responderId: 'reviewer-backup',
        respondedAt: SECOND_EXPIRES,
      }),
    ),
    /timed out/,
  );
});

test('required evidence and exact job/step/supervision identity cannot be bypassed', () => {
  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      policyRequest(),
      policyResponse({ evidenceArtifactIds: ['artifact-before'] }),
    ),
    /missing required evidence artifact: artifact-policy/,
  );

  for (const [field, value, expected] of [
    ['supervisionId', 'supervision-other', /supervisionId mismatch/],
    ['jobId', 'job-other', /jobId mismatch/],
    ['stepId', 'step-other', /stepId mismatch/],
  ]) {
    assert.throws(
      () => normalizeHumanSupervisionResponseV1(
        policyRequest(),
        policyResponse({ [field]: value }),
      ),
      expected,
    );
  }
});

test('POLICY_ASK cannot be confused with clarification or nonterminal policy choices', () => {
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({
      choices: [{ choiceId: 'yes', label: 'Yes' }],
    })),
    /cannot declare clarification choices/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({ allowFreeText: true })),
    /cannot enable clarification free text/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({ policyDecisionId: '' })),
    /requires policyDecisionId/,
  );
  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      policyRequest(),
      policyResponse({ policyDecision: 'ASK' }),
    ),
    /must be ALLOW or DENY/,
  );
  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      policyRequest(),
      policyResponse({ clarificationText: 'yes' }),
    ),
    /cannot carry clarification text/,
  );
});

test('CLARIFICATION remains data-only and cannot grant policy authority', () => {
  const selected = resolveHumanSupervisionV1({
    request: clarificationRequest(),
    response: clarificationResponse(),
  });
  assert.equal(selected.resolution.kind, HumanSupervisionKind.CLARIFICATION);
  assert.equal(selected.resolution.selectedChoiceId, 'pdf');
  assert.equal(selected.resolution.clarificationText, '');
  assert.equal(Object.hasOwn(selected.resolution, 'policyDecision'), false);

  const textAnswer = normalizeHumanSupervisionResponseV1(
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
    () => normalizeHumanSupervisionRequestV1(clarificationRequest({
      policyDecisionId: 'policy-decision-evil',
    })),
    /cannot carry policyDecisionId/,
  );
  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      clarificationRequest(),
      clarificationResponse({ policyDecision: PolicyAskDecision.ALLOW }),
    ),
    /cannot grant policy authority/,
  );
  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      clarificationRequest(),
      clarificationResponse({ selectedChoiceId: 'unknown' }),
    ),
    /not declared/,
  );
  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      clarificationRequest(),
      clarificationResponse({ clarificationText: 'also text' }),
    ),
    /exactly one choice or text answer/,
  );
});

test('CLARIFICATION request requires an answer surface and respects free-text policy', () => {
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(clarificationRequest({
      choices: [],
      allowFreeText: false,
    })),
    /requires choices or allowFreeText/,
  );

  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      clarificationRequest({ allowFreeText: false }),
      clarificationResponse({
        selectedChoiceId: '',
        clarificationText: 'free form',
      }),
    ),
    /free text is not allowed/,
  );
});

test('stage deadlines are canonical, strictly increasing and after creation', () => {
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({
      reviewStages: [
        { stageId: 'owner', reviewerIds: ['reviewer-owner'], expiresAt: CREATED },
      ],
    })),
    /strictly increasing/,
  );

  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({
      reviewStages: [
        { stageId: 'owner', reviewerIds: ['reviewer-owner'], expiresAt: SECOND_EXPIRES },
        { stageId: 'backup', reviewerIds: ['reviewer-backup'], expiresAt: FIRST_EXPIRES },
      ],
    })),
    /strictly increasing/,
  );

  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({
      createdAt: '2026-09-24T22:00:00Z',
    })),
    /canonical ISO timestamp/,
  );

  assert.throws(
    () => projectHumanSupervisionV1(policyRequest(), '2026-09-24T21:59:59.999Z'),
    /cannot predate/,
  );
});

test('request and response contracts reject coercion, exotic objects, symbols and sparse arrays', () => {
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({ schemaVersion: '1' })),
    /schemaVersion/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({ allowFreeText: 0 })),
    /must be boolean/,
  );
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({ supervisionId: 1 })),
    /supervisionId is invalid/,
  );

  const exotic = Object.create({ policyDecisionId: 'policy-inherited' });
  Object.assign(exotic, policyRequest());
  delete exotic.policyDecisionId;
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(exotic),
    /plain object/,
  );

  const symbol = policyRequest();
  symbol[Symbol('authority')] = PolicyAskDecision.ALLOW;
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(symbol),
    /unknown field/,
  );

  const accessor = policyRequest();
  Object.defineProperty(accessor, 'question', {
    enumerable: true,
    get() {
      throw new Error('getter must never execute');
    },
  });
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(accessor),
    /data properties only/,
  );

  const sparseStages = new Array(2);
  sparseStages[0] = {
    stageId: 'owner',
    reviewerIds: ['reviewer-owner'],
    expiresAt: FIRST_EXPIRES,
  };
  assert.throws(
    () => normalizeHumanSupervisionRequestV1(policyRequest({ reviewStages: sparseStages })),
    /must not be sparse/,
  );

  assert.throws(
    () => normalizeHumanSupervisionResponseV1(
      policyRequest(),
      policyResponse({ reasonCode: { toString: () => 'OWNER_APPROVED' } }),
    ),
    /reasonCode is invalid/,
  );
});

test('null-prototype records are accepted without widening authority', () => {
  const request = Object.assign(Object.create(null), policyRequest());
  request.reviewStages = policyRequest().reviewStages.map((stage) => (
    Object.assign(Object.create(null), stage)
  ));
  request.choices = [];

  const normalized = normalizeHumanSupervisionRequestV1(request);
  assert.equal(normalized.kind, HumanSupervisionKind.POLICY_ASK);
  assert.equal(normalized.policyDecisionId, 'policy-decision-1');
  assert.deepEqual(normalized.requiredEvidenceArtifactIds, ['artifact-before', 'artifact-policy']);
});
