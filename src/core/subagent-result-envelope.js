import { normalizeSubagentTaskEnvelopeV1 } from './subagent-task-envelope.js';
import {
  ObservationStatus,
  VerificationStatus,
  normalizeArtifactRefV1,
  normalizeObservationV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';

export const SUBAGENT_RESULT_ENVELOPE_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_ARTIFACTS = 256;
const INPUT_KEYS = new Set([
  'resultId',
  'taskEnvelope',
  'observation',
  'verification',
  'evidenceArtifactRefs',
  'completedAt',
]);
const RESULT_KEYS = new Set([
  'schemaVersion',
  'resultId',
  'envelopeId',
  'projectId',
  'parentAgentId',
  'childAgentId',
  'taskId',
  'planId',
  'planRevision',
  'outcomeContractId',
  'outcomeContractRevision',
  'observationId',
  'invocationId',
  'observationStatus',
  'observationSummary',
  'observedAt',
  'verificationId',
  'verificationStatus',
  'verifierId',
  'verificationAuthorityId',
  'verificationReasonCode',
  'verificationSummary',
  'verifiedAt',
  'requiredEvidenceArtifactCount',
  'verificationProvenance',
  'trustedVerificationRequired',
  'resultArtifactRefs',
  'evidenceArtifactRefs',
  'completedAt',
  'executionAuthority',
  'schedulingAuthority',
  'policyAuthority',
  'credentialAuthority',
  'completionAuthority',
]);
const FALSE_AUTHORITY_KEYS = [
  'executionAuthority',
  'schedulingAuthority',
  'policyAuthority',
  'credentialAuthority',
  'completionAuthority',
];

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' contains symbol field');
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(value, key, label) {
  if (!Object.hasOwn(value, key)) throw new Error(label + ' requires ' + key);
  return value[key];
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function text(value, label, max = 8_000) {
  if (value === '') return '';
  if (typeof value !== 'string') throw new Error(label + ' must be text');
  const out = value.trim();
  if (!out || out.length > max) throw new Error(label + ' is invalid');
  return out;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(label + ' must be a timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(label + ' must be a timestamp');
  const canonical = new Date(ms).toISOString();
  if (canonical !== value) throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  return canonical;
}

function integer(value, label, min = 0) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function dataArray(value, label, max = MAX_ARTIFACTS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(label + ' is invalid');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' must be a dense data-only array');
    }
    out.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length) {
      throw new Error(label + ' contains a non-index field');
    }
  }
  return out;
}

function artifactRefList(value, label) {
  const refs = dataArray(value, label).map((item, index) => {
    try {
      return normalizeArtifactRefV1(item);
    } catch (error) {
      throw new Error(label + '[' + index + ']: ' + error.message);
    }
  });
  if (new Set(refs.map(item => item.artifactId)).size !== refs.length) {
    throw new Error(label + ' contains duplicate artifactId');
  }
  for (const ref of refs) {
    if (!ref.sha256) {
      throw new Error(label + ' requires sha256 immutable identity: ' + ref.artifactId);
    }
  }
  return refs.sort((left, right) => left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function exactArtifactCoverage(requiredIds, refs, label) {
  const actual = refs.map(item => item.artifactId).sort();
  const expected = [...requiredIds].sort();
  if (actual.length !== expected.length
      || actual.some((artifactId, index) => artifactId !== expected[index])) {
    throw new Error(label + ' must exactly bind VerificationV1 evidenceArtifactIds');
  }
}

function assertArtifactChronology(refs, latestAt, label) {
  const latest = Date.parse(latestAt);
  for (const ref of refs) {
    if (Date.parse(ref.createdAt) > latest) {
      throw new Error(label + ' ArtifactRef cannot postdate its observation: ' + ref.artifactId);
    }
  }
}

function assertArtifactProducerInvocation(refs, invocationId, label) {
  for (const ref of refs) {
    if (!ref.producerInvocationId || ref.producerInvocationId !== invocationId) {
      throw new Error(
        label + ' ArtifactRef producerInvocationId must match child invocation: ' + ref.artifactId,
      );
    }
  }
}

export function normalizeSubagentResultEnvelopeV1(input) {
  const raw = record(input, RESULT_KEYS, 'SubagentResultEnvelopeV1');
  if (own(raw, 'schemaVersion', 'SubagentResultEnvelopeV1') !== SUBAGENT_RESULT_ENVELOPE_VERSION) {
    throw new Error('Unsupported SubagentResultEnvelopeV1 schemaVersion');
  }
  const parentAgentId = id(own(raw, 'parentAgentId', 'SubagentResultEnvelopeV1'), 'parentAgentId');
  const childAgentId = id(own(raw, 'childAgentId', 'SubagentResultEnvelopeV1'), 'childAgentId');
  if (parentAgentId === childAgentId) throw new Error('Subagent result child identity must differ from parent');

  for (const key of FALSE_AUTHORITY_KEYS) {
    if (own(raw, key, 'SubagentResultEnvelopeV1') !== false) {
      throw new Error('SubagentResultEnvelopeV1 cannot grant ' + key);
    }
  }

  const verificationProvenance = own(
    raw,
    'verificationProvenance',
    'SubagentResultEnvelopeV1',
  );
  if (verificationProvenance !== 'UNVERIFIED_INPUT') {
    throw new Error('Subagent result cannot claim trusted verification provenance');
  }
  if (own(raw, 'trustedVerificationRequired', 'SubagentResultEnvelopeV1') !== true) {
    throw new Error('Subagent result must require canonical trusted verification before completion');
  }

  const invocationId = id(
    own(raw, 'invocationId', 'SubagentResultEnvelopeV1'),
    'invocationId',
  );
  const resultArtifactRefs = artifactRefList(
    own(raw, 'resultArtifactRefs', 'SubagentResultEnvelopeV1'),
    'resultArtifactRefs',
  );
  assertArtifactProducerInvocation(resultArtifactRefs, invocationId, 'resultArtifactRefs');
  const evidenceArtifactRefs = artifactRefList(
    own(raw, 'evidenceArtifactRefs', 'SubagentResultEnvelopeV1'),
    'evidenceArtifactRefs',
  );
  const requiredEvidenceArtifactCount = integer(
    own(raw, 'requiredEvidenceArtifactCount', 'SubagentResultEnvelopeV1'),
    'requiredEvidenceArtifactCount',
    1,
  );
  if (evidenceArtifactRefs.length < requiredEvidenceArtifactCount) {
    throw new Error('Subagent result lacks required independent evidence artifacts');
  }

  const observedAt = timestamp(own(raw, 'observedAt', 'SubagentResultEnvelopeV1'), 'observedAt');
  const verifiedAt = timestamp(own(raw, 'verifiedAt', 'SubagentResultEnvelopeV1'), 'verifiedAt');
  const completedAt = timestamp(own(raw, 'completedAt', 'SubagentResultEnvelopeV1'), 'completedAt');
  if (Date.parse(verifiedAt) < Date.parse(observedAt)) {
    throw new Error('Subagent result verification cannot predate observation');
  }
  if (Date.parse(completedAt) < Date.parse(verifiedAt)) {
    throw new Error('Subagent result completion cannot predate verification');
  }
  assertArtifactChronology(resultArtifactRefs, observedAt, 'resultArtifactRefs');
  assertArtifactChronology(evidenceArtifactRefs, verifiedAt, 'evidenceArtifactRefs');

  const observationStatus = id(
    own(raw, 'observationStatus', 'SubagentResultEnvelopeV1'),
    'observationStatus',
  );
  if (!Object.values(ObservationStatus).includes(observationStatus)) {
    throw new Error('Subagent result observationStatus is invalid');
  }
  const verificationStatus = id(
    own(raw, 'verificationStatus', 'SubagentResultEnvelopeV1'),
    'verificationStatus',
  );
  if (verificationStatus !== VerificationStatus.VERIFIED) {
    throw new Error('Subagent result stored verificationStatus must remain VERIFIED');
  }

  return freezeDeep({
    schemaVersion: SUBAGENT_RESULT_ENVELOPE_VERSION,
    resultId: id(own(raw, 'resultId', 'SubagentResultEnvelopeV1'), 'resultId'),
    envelopeId: id(own(raw, 'envelopeId', 'SubagentResultEnvelopeV1'), 'envelopeId'),
    projectId: id(own(raw, 'projectId', 'SubagentResultEnvelopeV1'), 'projectId'),
    parentAgentId,
    childAgentId,
    taskId: id(own(raw, 'taskId', 'SubagentResultEnvelopeV1'), 'taskId'),
    planId: id(own(raw, 'planId', 'SubagentResultEnvelopeV1'), 'planId'),
    planRevision: integer(own(raw, 'planRevision', 'SubagentResultEnvelopeV1'), 'planRevision', 1),
    outcomeContractId: id(
      own(raw, 'outcomeContractId', 'SubagentResultEnvelopeV1'),
      'outcomeContractId',
    ),
    outcomeContractRevision: integer(
      own(raw, 'outcomeContractRevision', 'SubagentResultEnvelopeV1'),
      'outcomeContractRevision',
      1,
    ),
    observationId: id(own(raw, 'observationId', 'SubagentResultEnvelopeV1'), 'observationId'),
    invocationId,
    observationStatus,
    observationSummary: text(
      own(raw, 'observationSummary', 'SubagentResultEnvelopeV1'),
      'observationSummary',
    ),
    observedAt,
    verificationId: id(own(raw, 'verificationId', 'SubagentResultEnvelopeV1'), 'verificationId'),
    verificationStatus,
    verifierId: id(own(raw, 'verifierId', 'SubagentResultEnvelopeV1'), 'verifierId'),
    verificationAuthorityId: id(
      own(raw, 'verificationAuthorityId', 'SubagentResultEnvelopeV1'),
      'verificationAuthorityId',
    ),
    verificationReasonCode: id(
      own(raw, 'verificationReasonCode', 'SubagentResultEnvelopeV1'),
      'verificationReasonCode',
    ),
    verificationSummary: text(
      own(raw, 'verificationSummary', 'SubagentResultEnvelopeV1'),
      'verificationSummary',
    ),
    verifiedAt,
    requiredEvidenceArtifactCount,
    verificationProvenance: 'UNVERIFIED_INPUT',
    trustedVerificationRequired: true,
    resultArtifactRefs,
    evidenceArtifactRefs,
    completedAt,
    executionAuthority: false,
    schedulingAuthority: false,
    policyAuthority: false,
    credentialAuthority: false,
    completionAuthority: false,
  });
}

/**
 * Produce a bounded, immutable-reference handback from one child Agent.
 *
 * The result deliberately excludes ObservationV1.data. No transcript or
 * arbitrary child payload is copied into the parent handback. A raw
 * VerificationV1 is only structurally bound here and remains UNVERIFIED_INPUT.
 * Canonical trusted verification must be resolved by the existing
 * outcome-verification bridge before any completion decision.
 */
export function createSubagentResultEnvelopeV1(input = {}) {
  const raw = record(input, INPUT_KEYS, 'SubagentResultEnvelopeBuildV1');
  const task = normalizeSubagentTaskEnvelopeV1(
    own(raw, 'taskEnvelope', 'SubagentResultEnvelopeBuildV1'),
  );
  const observation = normalizeObservationV1(
    own(raw, 'observation', 'SubagentResultEnvelopeBuildV1'),
  );
  const verification = normalizeVerificationV1(
    own(raw, 'verification', 'SubagentResultEnvelopeBuildV1'),
  );

  if (verification.status !== VerificationStatus.VERIFIED) {
    throw new Error('Subagent result requires VERIFIED VerificationV1');
  }
  if (verification.invocationId !== observation.invocationId) {
    throw new Error('Subagent result verification invocation mismatch');
  }
  if (verification.observationId !== observation.observationId) {
    throw new Error('Subagent result verification observation mismatch');
  }
  if (verification.verifierId !== task.outcome.verifierId) {
    throw new Error('Subagent result verifier does not match task outcome verifier');
  }
  if (!verification.verificationAuthorityId) {
    throw new Error('Subagent result requires independent verificationAuthorityId provenance');
  }
  if (Date.parse(observation.observedAt) < Date.parse(task.createdAt)) {
    throw new Error('Subagent result observation predates task envelope');
  }
  if (Date.parse(verification.verifiedAt) < Date.parse(observation.observedAt)) {
    throw new Error('Subagent result verification predates observation');
  }

  const resultArtifactRefs = artifactRefList(observation.artifactRefs, 'resultArtifactRefs');
  assertArtifactProducerInvocation(
    resultArtifactRefs,
    observation.invocationId,
    'resultArtifactRefs',
  );
  const evidenceArtifactRefs = artifactRefList(
    own(raw, 'evidenceArtifactRefs', 'SubagentResultEnvelopeBuildV1'),
    'evidenceArtifactRefs',
  );
  exactArtifactCoverage(
    verification.evidenceArtifactIds,
    evidenceArtifactRefs,
    'evidenceArtifactRefs',
  );
  if (evidenceArtifactRefs.length < task.outcome.requiredEvidenceArtifactCount) {
    throw new Error('Subagent result lacks task-required independent evidence artifacts');
  }

  const completedAt = timestamp(
    own(raw, 'completedAt', 'SubagentResultEnvelopeBuildV1'),
    'completedAt',
  );
  if (Date.parse(completedAt) < Date.parse(verification.verifiedAt)) {
    throw new Error('Subagent result completion predates verification');
  }
  assertArtifactChronology(resultArtifactRefs, observation.observedAt, 'resultArtifactRefs');
  assertArtifactChronology(evidenceArtifactRefs, verification.verifiedAt, 'evidenceArtifactRefs');

  return normalizeSubagentResultEnvelopeV1({
    schemaVersion: SUBAGENT_RESULT_ENVELOPE_VERSION,
    resultId: id(own(raw, 'resultId', 'SubagentResultEnvelopeBuildV1'), 'resultId'),
    envelopeId: task.envelopeId,
    projectId: task.projectId,
    parentAgentId: task.parentAgentId,
    childAgentId: task.childAgentId,
    taskId: task.taskId,
    planId: task.planId,
    planRevision: task.planRevision,
    outcomeContractId: task.outcome.contractId,
    outcomeContractRevision: task.outcome.contractRevision,
    observationId: observation.observationId,
    invocationId: observation.invocationId,
    observationStatus: observation.status,
    observationSummary: observation.summary,
    observedAt: observation.observedAt,
    verificationId: verification.verificationId,
    verificationStatus: verification.status,
    verifierId: verification.verifierId,
    verificationAuthorityId: verification.verificationAuthorityId,
    verificationReasonCode: verification.reasonCode,
    verificationSummary: verification.summary,
    verifiedAt: verification.verifiedAt,
    requiredEvidenceArtifactCount: task.outcome.requiredEvidenceArtifactCount,
    verificationProvenance: 'UNVERIFIED_INPUT',
    trustedVerificationRequired: true,
    resultArtifactRefs,
    evidenceArtifactRefs,
    completedAt,
    executionAuthority: false,
    schedulingAuthority: false,
    policyAuthority: false,
    credentialAuthority: false,
    completionAuthority: false,
  });
}
