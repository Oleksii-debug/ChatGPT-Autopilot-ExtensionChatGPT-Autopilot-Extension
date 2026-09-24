export const HUMAN_SUPERVISION_SCHEMA_VERSION = 1;

export const HumanSupervisionKind = Object.freeze({
  POLICY_ASK: 'POLICY_ASK',
  CLARIFICATION: 'CLARIFICATION',
});

export const HumanSupervisionState = Object.freeze({
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  TIMED_OUT: 'TIMED_OUT',
  RESOLVED: 'RESOLVED',
});

export const PolicyAskDecision = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
});

const KINDS = new Set(Object.values(HumanSupervisionKind));
const POLICY_DECISIONS = new Set(Object.values(PolicyAskDecision));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_TEXT = 8_000;
const MAX_REASON = 1_000;
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
  'policyDecisionId',
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

const RESPONSE_KEYS = new Set([
  'schemaVersion',
  'responseId',
  'supervisionId',
  'jobId',
  'stepId',
  'responderId',
  'respondedAt',
  'reasonCode',
  'evidenceArtifactIds',
  'policyDecision',
  'selectedChoiceId',
  'clarificationText',
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
  const policyDecisionId = id(raw.policyDecisionId, 'policyDecisionId', { optional: true });

  if (kind === HumanSupervisionKind.POLICY_ASK) {
    if (!policyDecisionId) throw new Error('POLICY_ASK requires policyDecisionId');
    if (choices.length) throw new Error('POLICY_ASK cannot declare clarification choices');
    if (allowFreeText) throw new Error('POLICY_ASK cannot enable clarification free text');
  } else {
    if (policyDecisionId) throw new Error('CLARIFICATION cannot carry policyDecisionId');
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
    policyDecisionId,
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
    state: HumanSupervisionState.WAITING_APPROVAL,
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

export function normalizeHumanSupervisionResponseV1(requestInput, responseInput) {
  const request = normalizeHumanSupervisionRequestV1(requestInput);
  const raw = strictRecord(responseInput, RESPONSE_KEYS, 'HumanSupervisionResponseV1');
  if (raw.schemaVersion !== HUMAN_SUPERVISION_SCHEMA_VERSION) {
    throw new Error('Unsupported HumanSupervisionResponseV1 schemaVersion');
  }

  const supervisionId = id(raw.supervisionId, 'response.supervisionId');
  const jobId = id(raw.jobId, 'response.jobId');
  const stepId = id(raw.stepId, 'response.stepId');
  if (supervisionId !== request.supervisionId) throw new Error('response supervisionId mismatch');
  if (jobId !== request.jobId) throw new Error('response jobId mismatch');
  if (stepId !== request.stepId) throw new Error('response stepId mismatch');

  const respondedAt = timestamp(raw.respondedAt, 'respondedAt');
  const active = locateStage(request, respondedAt);
  if (!active) throw new Error('response arrived after supervision timed out');

  const responderId = id(raw.responderId, 'responderId');
  if (!active.stage.reviewerIds.includes(responderId)) {
    throw new Error('responder is not authorized for the active supervision stage');
  }

  const evidenceArtifactIds = normalizeIdList(
    raw.evidenceArtifactIds,
    'evidenceArtifactIds',
    { min: 0, max: MAX_EVIDENCE },
  );
  ensureRequiredEvidence(request, evidenceArtifactIds);

  const reasonCode = id(raw.reasonCode, 'reasonCode');
  let policyDecision = '';
  let selectedChoiceId = '';
  let clarificationText = '';

  if (request.kind === HumanSupervisionKind.POLICY_ASK) {
    policyDecision = id(raw.policyDecision, 'policyDecision');
    if (!POLICY_DECISIONS.has(policyDecision)) {
      throw new Error('POLICY_ASK response must be ALLOW or DENY');
    }
    if (raw.selectedChoiceId != null && raw.selectedChoiceId !== '') {
      throw new Error('POLICY_ASK response cannot select a clarification choice');
    }
    if (raw.clarificationText != null && raw.clarificationText !== '') {
      throw new Error('POLICY_ASK response cannot carry clarification text');
    }
  } else {
    if (raw.policyDecision != null && raw.policyDecision !== '') {
      throw new Error('CLARIFICATION response cannot grant policy authority');
    }
    selectedChoiceId = id(raw.selectedChoiceId, 'selectedChoiceId', { optional: true });
    clarificationText = text(raw.clarificationText, 'clarificationText', {
      optional: true,
      max: MAX_TEXT,
    });
    if (Boolean(selectedChoiceId) === Boolean(clarificationText)) {
      throw new Error('CLARIFICATION response must provide exactly one choice or text answer');
    }
    if (selectedChoiceId && !request.choices.some((choice) => choice.choiceId === selectedChoiceId)) {
      throw new Error('CLARIFICATION selectedChoiceId is not declared by the request');
    }
    if (clarificationText && !request.allowFreeText) {
      throw new Error('CLARIFICATION free text is not allowed');
    }
  }

  return freezeDeep({
    schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
    responseId: id(raw.responseId, 'responseId'),
    supervisionId,
    jobId,
    stepId,
    responderId,
    respondedAt,
    reasonCode,
    evidenceArtifactIds,
    policyDecision,
    selectedChoiceId,
    clarificationText,
    stageId: active.stage.stageId,
  });
}

export function resolveHumanSupervisionV1({ request: requestInput, response: responseInput } = {}) {
  const request = normalizeHumanSupervisionRequestV1(requestInput);
  const response = normalizeHumanSupervisionResponseV1(request, responseInput);
  const resolution = request.kind === HumanSupervisionKind.POLICY_ASK
    ? freezeDeep({
      kind: request.kind,
      policyDecisionId: request.policyDecisionId,
      policyDecision: response.policyDecision,
    })
    : freezeDeep({
      kind: request.kind,
      selectedChoiceId: response.selectedChoiceId,
      clarificationText: response.clarificationText,
    });

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
    resolution,
    resume: freezeDeep({
      schemaVersion: HUMAN_SUPERVISION_SCHEMA_VERSION,
      supervisionId: request.supervisionId,
      responseId: response.responseId,
      jobId: request.jobId,
      stepId: request.stepId,
      resumeStepId: request.stepId,
      resolvedAt: response.respondedAt,
    }),
  });
}
