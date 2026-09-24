export const HUMAN_SUPERVISION_SCHEMA_VERSION = 1;

export const HumanSupervisionKind = Object.freeze({
  POLICY_APPROVAL: 'POLICY_APPROVAL',
  CLARIFICATION: 'CLARIFICATION',
});

export const HumanSupervisionState = Object.freeze({
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  WAITING_CLARIFICATION: 'WAITING_CLARIFICATION',
  TIMED_OUT: 'TIMED_OUT',
  RESOLVED: 'RESOLVED',
});

const KINDS = new Set(Object.values(HumanSupervisionKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_TEXT = 8_000;
const MAX_STAGES = 8;
const MAX_REVIEWERS = 32;
const MAX_CHOICES = 64;
const MAX_EVIDENCE = 128;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'supervisionId',
  'jobId',
  'stepId',
  'kind',
  'question',
  'createdAt',
  'approvalId',
  'reviewStages',
  'choices',
  'allowFreeText',
  'requiredEvidenceArtifactIds',
]);

const STAGE_KEYS = new Set([
  'stageId',
  'reviewerIds',
  'expiresAt',
]);

const CHOICE_KEYS = new Set([
  'choiceId',
  'label',
]);

const RESPONSE_COMMON_KEYS = [
  'schemaVersion',
  'responseId',
  'supervisionId',
  'jobId',
  'stepId',
  'responderId',
  'respondedAt',
  'reasonCode',
  'evidenceArtifactIds',
];

const APPROVAL_ATTESTATION_KEYS = new Set([
  ...RESPONSE_COMMON_KEYS,
  'approvalId',
  'approvalResolutionId',
]);

const CLARIFICATION_RESPONSE_KEYS = new Set([
  ...RESPONSE_COMMON_KEYS,
  'selectedChoiceId',
  'clarificationText',
]);

const CLARIFICATION_RESPONSE_BINDING_KEYS = new Set([
  'responseId', 'responderId', 'reasonCode', 'evidenceArtifactIds',
  'respondedAt', 'selectedChoiceId', 'clarificationText',
]);
const CLARIFICATION_RESUME_KEYS = new Set([
  'schemaVersion', 'supervisionId', 'responseId', 'jobId', 'stepId',
  'resumeStepId', 'resolvedAt', 'responseBinding',
]);
const RESOLVED_CLARIFICATION_KEYS = new Set([
  'schemaVersion', 'supervisionId', 'jobId', 'stepId', 'state', 'responseId',
  'responderId', 'reasonCode', 'evidenceArtifactIds', 'resolvedAt',
  'selectedChoiceId', 'clarificationText', 'resume',
]);

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error(`${label} must contain enumerable data properties only`);
    }
  }
  for (const key of allowed) {
    if (key in input && !Object.prototype.hasOwnProperty.call(input, key)) {
      throw new Error(`${label} contains inherited field: ${key}`);
    }
  }
  return input;
}

function strictArray(input, label, { min = 0, max } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be a plain array`);
  }
  if (!Number.isInteger(max) || input.length < min || input.length > max) {
    throw new Error(`${label} must contain ${min}-${max} items`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index field`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= input.length) {
      throw new Error(`${label} contains invalid index`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  const out = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function id(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} must be bounded canonical text`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function normalizeIdList(input, label, { min = 0, max = MAX_EVIDENCE } = {}) {
  const raw = strictArray(input, label, { min, max });
  const values = raw.map((value, index) => id(value, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate IDs`);
  values.sort(asciiCompare);
  return Object.freeze(values);
}

function normalizeStage(input, index) {
  const label = `reviewStages[${index}]`;
  const raw = strictRecord(input, STAGE_KEYS, label);
  return freezeDeep({
    stageId: id(raw.stageId, `${label}.stageId`),
    reviewerIds: normalizeIdList(raw.reviewerIds, `${label}.reviewerIds`, {
      min: 1,
      max: MAX_REVIEWERS,
    }),
    expiresAt: timestamp(raw.expiresAt, `${label}.expiresAt`),
  });
}

function normalizeChoice(input, index) {
  const label = `choices[${index}]`;
  const raw = strictRecord(input, CHOICE_KEYS, label);
  return freezeDeep({
    choiceId: id(raw.choiceId, `${label}.choiceId`),
    label: text(raw.label, `${label}.label`, { max: 500 }),
  });
}

export function normalizeHumanSupervisionRequestV1(input) {
  const raw = strictRecord(input, REQUEST_KEYS, 'HumanSupervisionRequestV1');
  if (raw.schemaVersion !== HUMAN_SUPERVISION_SCHEMA_VERSION) {
    throw new Error('Unsupported HumanSupervisionRequestV1 schemaVersion');
  }

  const kind = id(raw.kind, 'kind');
  if (!KINDS.has(kind)) throw new Error('kind is invalid');

  const createdAt = timestamp(raw.createdAt, 'createdAt');
  const stages = strictArray(raw.reviewStages, 'reviewStages', {
    min: 1,
    max: MAX_STAGES,
  }).map(normalizeStage);

  const stageIds = new Set();
  let previousExpiry = Date.parse(createdAt);
  for (const stage of stages) {
    if (stageIds.has(stage.stageId)) throw new Error(`reviewStages contains duplicate stageId: ${stage.stageId}`);
    stageIds.add(stage.stageId);
    const expires = Date.parse(stage.expiresAt);
    if (expires <= previousExpiry) {
      throw new Error('reviewStages expiresAt values must be strictly increasing after createdAt');
    }
    previousExpiry = expires;
  }

  const choices = strictArray(raw.choices, 'choices', {
    min: 0,
    max: MAX_CHOICES,
  }).map(normalizeChoice);
  const choiceIds = new Set();
  for (const choice of choices) {
    if (choiceIds.has(choice.choiceId)) throw new Error(`choices contains duplicate choiceId: ${choice.choiceId}`);
    choiceIds.add(choice.choiceId);
  }
  choices.sort((a, b) => asciiCompare(a.choiceId, b.choiceId));

  const allowFreeText = bool(raw.allowFreeText, 'allowFreeText');
  const approvalId = id(raw.approvalId, 'approvalId', { optional: true });

  if (kind === HumanSupervisionKind.POLICY_APPROVAL) {
    if (!approvalId) throw new Error('POLICY_APPROVAL requires approvalId from the canonical approval contract');
    if (choices.length) throw new Error('POLICY_APPROVAL cannot declare clarification choices');
    if (allowFreeText) throw new Error('POLICY_APPROVAL cannot enable clarification free text');
  } else {
    if (approvalId) throw new Error('CLARIFICATION cannot carry approvalId');
    if (!choices.length && !allowFreeText) {
      throw new Error('CLARIFICATION requires choices or allowFreeText');
    }
  }

  return freezeDeep({
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: id(raw.supervisionId, 'supervisionId'),
    jobId: id(raw.jobId, 'jobId'),
    stepId: id(raw.stepId, 'stepId'),
    kind,
    question: text(raw.question, 'question'),
    createdAt,
    approvalId,
    reviewStages: Object.freeze(stages),
    choices: Object.freeze(choices),
    allowFreeText,
    requiredEvidenceArtifactIds: normalizeIdList(
      raw.requiredEvidenceArtifactIds,
      'requiredEvidenceArtifactIds',
      { min: 0, max: MAX_EVIDENCE },
    ),
  });
}

function locateStage(request, at) {
  const atMillis = Date.parse(at);
  const createdMillis = Date.parse(request.createdAt);
  if (atMillis < createdMillis) throw new Error('observation time cannot predate supervision creation');
  let startMillis = createdMillis;
  for (let index = 0; index < request.reviewStages.length; index += 1) {
    const stage = request.reviewStages[index];
    const expiry = Date.parse(stage.expiresAt);
    if (atMillis >= startMillis && atMillis < expiry) {
      return { index, stage };
    }
    startMillis = expiry;
  }
  return null;
}

export function projectHumanSupervisionV1(requestInput, atInput) {
  const request = normalizeHumanSupervisionRequestV1(requestInput);
  const at = timestamp(atInput, 'at');
  const active = locateStage(request, at);
  if (!active) {
    return freezeDeep({
      schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
      supervisionId: request.supervisionId,
      jobId: request.jobId,
      stepId: request.stepId,
      state: HumanSupervisionState.TIMED_OUT,
      activeStageId: '',
      authorizedReviewerIds: Object.freeze([]),
      nextEscalationAt: '',
      escalationPending: false,
    });
  }
  return freezeDeep({
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: request.supervisionId,
    jobId: request.jobId,
    stepId: request.stepId,
    state: request.kind === HumanSupervisionKind.POLICY_APPROVAL
      ? HumanSupervisionState.WAITING_APPROVAL
      : HumanSupervisionState.WAITING_CLARIFICATION,
    activeStageId: active.stage.stageId,
    authorizedReviewerIds: active.stage.reviewerIds,
    nextEscalationAt: active.stage.expiresAt,
    escalationPending: active.index < request.reviewStages.length - 1,
  });
}

function ensureRequiredEvidence(request, provided) {
  const available = new Set(provided);
  for (const artifactId of request.requiredEvidenceArtifactIds) {
    if (!available.has(artifactId)) {
      throw new Error(`response is missing required evidence artifact: ${artifactId}`);
    }
  }
}

function normalizeResponseCommon(request, raw, label) {
  const supervisionId = id(raw.supervisionId, `${label}.supervisionId`);
  const jobId = id(raw.jobId, `${label}.jobId`);
  const stepId = id(raw.stepId, `${label}.stepId`);
  if (supervisionId !== request.supervisionId) throw new Error(`${label} supervisionId mismatch`);
  if (jobId !== request.jobId) throw new Error(`${label} jobId mismatch`);
  if (stepId !== request.stepId) throw new Error(`${label} stepId mismatch`);

  const respondedAt = timestamp(raw.respondedAt, `${label}.respondedAt`);
  const active = locateStage(request, respondedAt);
  if (!active) throw new Error(`${label} arrived after supervision timed out`);

  const responderId = id(raw.responderId, `${label}.responderId`);
  if (!active.stage.reviewerIds.includes(responderId)) {
    throw new Error(`${label} responder is not authorized for the active supervision stage`);
  }

  const evidenceArtifactIds = normalizeIdList(
    raw.evidenceArtifactIds,
    `${label}.evidenceArtifactIds`,
    { min: 0, max: MAX_EVIDENCE },
  );
  ensureRequiredEvidence(request, evidenceArtifactIds);

  return freezeDeep({
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    responseId: id(raw.responseId, `${label}.responseId`),
    supervisionId,
    jobId,
    stepId,
    responderId,
    respondedAt,
    reasonCode: id(raw.reasonCode, `${label}.reasonCode`),
    evidenceArtifactIds,
    stageId: active.stage.stageId,
  });
}

export function normalizePolicyApprovalAttestationV1(requestInput, input) {
  const request = normalizeHumanSupervisionRequestV1(requestInput);
  if (request.kind !== HumanSupervisionKind.POLICY_APPROVAL) {
    throw new Error('approval attestation requires POLICY_APPROVAL supervision');
  }
  const raw = strictRecord(input, APPROVAL_ATTESTATION_KEYS, 'PolicyApprovalAttestationV1');
  if (raw.schemaVersion !== HUMAN_SUPERVISION_SCHEMA_VERSION) {
    throw new Error('Unsupported PolicyApprovalAttestationV1 schemaVersion');
  }
  const common = normalizeResponseCommon(request, raw, 'approval attestation');
  const approvalId = id(raw.approvalId, 'approval attestation.approvalId');
  if (approvalId !== request.approvalId) throw new Error('approval attestation approvalId mismatch');

  return freezeDeep({
    ...common,
    approvalId,
    approvalResolutionId: id(
      raw.approvalResolutionId,
      'approval attestation.approvalResolutionId',
    ),
  });
}

export function normalizeClarificationResponseV1(requestInput, input) {
  const request = normalizeHumanSupervisionRequestV1(requestInput);
  if (request.kind !== HumanSupervisionKind.CLARIFICATION) {
    throw new Error('clarification response requires CLARIFICATION supervision');
  }
  const raw = strictRecord(input, CLARIFICATION_RESPONSE_KEYS, 'ClarificationResponseV1');
  if (raw.schemaVersion !== HUMAN_SUPERVISION_SCHEMA_VERSION) {
    throw new Error('Unsupported ClarificationResponseV1 schemaVersion');
  }
  const common = normalizeResponseCommon(request, raw, 'clarification response');

  const selectedChoiceId = id(
    raw.selectedChoiceId,
    'clarification response.selectedChoiceId',
    { optional: true },
  );
  const clarificationText = text(
    raw.clarificationText,
    'clarification response.clarificationText',
    { optional: true, max: MAX_TEXT },
  );

  if (Boolean(selectedChoiceId) === Boolean(clarificationText)) {
    throw new Error('CLARIFICATION response must provide exactly one choice or text answer');
  }
  if (selectedChoiceId && !request.choices.some((choice) => choice.choiceId === selectedChoiceId)) {
    throw new Error('CLARIFICATION selectedChoiceId is not declared by the request');
  }
  if (clarificationText && !request.allowFreeText) {
    throw new Error('CLARIFICATION free text is not allowed');
  }

  return freezeDeep({
    ...common,
    selectedChoiceId,
    clarificationText,
  });
}

function clarificationResponseBindingV1(response) {
  return freezeDeep({
    responseId: response.responseId,
    responderId: response.responderId,
    reasonCode: response.reasonCode,
    evidenceArtifactIds: [...response.evidenceArtifactIds],
    respondedAt: response.respondedAt,
    selectedChoiceId: response.selectedChoiceId,
    clarificationText: response.clarificationText,
  });
}

export function resolveClarificationV1({ request: requestInput, response: responseInput } = {}) {
  const request = normalizeHumanSupervisionRequestV1(requestInput);
  if (request.kind !== HumanSupervisionKind.CLARIFICATION) {
    throw new Error('resolveClarificationV1 requires CLARIFICATION supervision');
  }
  const response = normalizeClarificationResponseV1(request, responseInput);
  const responseBinding = clarificationResponseBindingV1(response);
  return freezeDeep({
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: request.supervisionId,
    jobId: request.jobId,
    stepId: request.stepId,
    state: HumanSupervisionState.RESOLVED,
    responseId: response.responseId,
    responderId: response.responderId,
    reasonCode: response.reasonCode,
    evidenceArtifactIds: response.evidenceArtifactIds,
    resolvedAt: response.respondedAt,
    selectedChoiceId: response.selectedChoiceId,
    clarificationText: response.clarificationText,
    resume: freezeDeep({
      schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
      supervisionId: request.supervisionId,
      responseId: response.responseId,
      jobId: request.jobId,
      stepId: request.stepId,
      resumeStepId: request.stepId,
      resolvedAt: response.respondedAt,
      responseBinding,
    }),
  });
}

function normalizeClarificationResponseBindingV1(input) {
  const raw = strictRecord(input, CLARIFICATION_RESPONSE_BINDING_KEYS, 'ClarificationResumeV1.responseBinding');
  const selectedChoiceId = id(raw.selectedChoiceId, 'ClarificationResumeV1.responseBinding.selectedChoiceId', { optional: true });
  const clarificationText = text(raw.clarificationText, 'ClarificationResumeV1.responseBinding.clarificationText', { optional: true, max: MAX_TEXT });
  if (Boolean(selectedChoiceId) === Boolean(clarificationText)) {
    throw new Error('ClarificationResumeV1.responseBinding must contain exactly one answer');
  }
  return freezeDeep({
    responseId: id(raw.responseId, 'ClarificationResumeV1.responseBinding.responseId'),
    responderId: id(raw.responderId, 'ClarificationResumeV1.responseBinding.responderId'),
    reasonCode: id(raw.reasonCode, 'ClarificationResumeV1.responseBinding.reasonCode'),
    evidenceArtifactIds: normalizeIdList(raw.evidenceArtifactIds, 'ClarificationResumeV1.responseBinding.evidenceArtifactIds', { min: 0, max: MAX_EVIDENCE }),
    respondedAt: timestamp(raw.respondedAt, 'ClarificationResumeV1.responseBinding.respondedAt'),
    selectedChoiceId,
    clarificationText,
  });
}

export function assertClarificationResumeBindingV1(input) {
  const raw = strictRecord(input, RESOLVED_CLARIFICATION_KEYS, 'ResolvedClarificationV1');
  if (raw.schemaVersion !== HUMAN_SUPERVISION_SCHEMA_VERSION) throw new Error('Unsupported ResolvedClarificationV1 schemaVersion');
  if (raw.state !== HumanSupervisionState.RESOLVED) throw new Error('ResolvedClarificationV1 state must be RESOLVED');
  const resolved = freezeDeep({
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: id(raw.supervisionId, 'ResolvedClarificationV1.supervisionId'),
    jobId: id(raw.jobId, 'ResolvedClarificationV1.jobId'),
    stepId: id(raw.stepId, 'ResolvedClarificationV1.stepId'),
    state: HumanSupervisionState.RESOLVED,
    responseId: id(raw.responseId, 'ResolvedClarificationV1.responseId'),
    responderId: id(raw.responderId, 'ResolvedClarificationV1.responderId'),
    reasonCode: id(raw.reasonCode, 'ResolvedClarificationV1.reasonCode'),
    evidenceArtifactIds: normalizeIdList(raw.evidenceArtifactIds, 'ResolvedClarificationV1.evidenceArtifactIds', { min: 0, max: MAX_EVIDENCE }),
    resolvedAt: timestamp(raw.resolvedAt, 'ResolvedClarificationV1.resolvedAt'),
    selectedChoiceId: id(raw.selectedChoiceId, 'ResolvedClarificationV1.selectedChoiceId', { optional: true }),
    clarificationText: text(raw.clarificationText, 'ResolvedClarificationV1.clarificationText', { optional: true, max: MAX_TEXT }),
  });
  if (Boolean(resolved.selectedChoiceId) === Boolean(resolved.clarificationText)) {
    throw new Error('ResolvedClarificationV1 must contain exactly one answer');
  }
  const resumeRaw = strictRecord(raw.resume, CLARIFICATION_RESUME_KEYS, 'ClarificationResumeV1');
  if (resumeRaw.schemaVersion !== HUMAN_SUPERVISION_SCHEMA_VERSION) throw new Error('Unsupported ClarificationResumeV1 schemaVersion');
  const resume = freezeDeep({
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    supervisionId: id(resumeRaw.supervisionId, 'ClarificationResumeV1.supervisionId'),
    responseId: id(resumeRaw.responseId, 'ClarificationResumeV1.responseId'),
    jobId: id(resumeRaw.jobId, 'ClarificationResumeV1.jobId'),
    stepId: id(resumeRaw.stepId, 'ClarificationResumeV1.stepId'),
    resumeStepId: id(resumeRaw.resumeStepId, 'ClarificationResumeV1.resumeStepId'),
    resolvedAt: timestamp(resumeRaw.resolvedAt, 'ClarificationResumeV1.resolvedAt'),
    responseBinding: normalizeClarificationResponseBindingV1(resumeRaw.responseBinding),
  });
  if (resume.supervisionId !== resolved.supervisionId
      || resume.responseId !== resolved.responseId
      || resume.jobId !== resolved.jobId
      || resume.stepId !== resolved.stepId
      || resume.resumeStepId !== resolved.stepId
      || resume.resolvedAt !== resolved.resolvedAt) {
    throw new Error('clarification resume identity does not match resolved clarification');
  }
  const expected = {
    responseId: resolved.responseId,
    responderId: resolved.responderId,
    reasonCode: resolved.reasonCode,
    evidenceArtifactIds: [...resolved.evidenceArtifactIds],
    respondedAt: resolved.resolvedAt,
    selectedChoiceId: resolved.selectedChoiceId,
    clarificationText: resolved.clarificationText,
  };
  if (JSON.stringify(resume.responseBinding) !== JSON.stringify(expected)) {
    throw new Error('clarification resume response binding mismatch');
  }
  return resume;
}
