import {
  normalizeObservationV1,
  normalizeVerificationV1,
  VerificationStatus,
} from './universal-agent-contracts.js';

export const HUMAN_TAKEOVER_VERSION = 1;

export const HumanTakeoverPhase = Object.freeze({
  REQUESTED: 'REQUESTED',
  OWNER_IN_CONTROL: 'OWNER_IN_CONTROL',
  HANDBACK_PENDING: 'HANDBACK_PENDING',
  REOBSERVED: 'REOBSERVED',
  RECONCILED: 'RECONCILED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

const PHASES = new Set(Object.values(HumanTakeoverPhase));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_REASON = 4_000;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 8_192;
const MAX_ARRAY_ITEMS = 512;
const MAX_RECORD_FIELDS = 256;

const TAKEOVER_KEYS = new Set([
  'schemaVersion',
  'takeoverId',
  'jobId',
  'planId',
  'nodeId',
  'resourceId',
  'effectId',
  'agentId',
  'humanPrincipalId',
  'verificationAuthorityId',
  'reason',
  'phase',
  'quiescenceEvidenceId',
  'reobservationInvocationId',
  'preTakeoverObservation',
  'postTakeoverObservation',
  'handbackVerification',
  'requestedAt',
  'controlStartedAt',
  'handbackRequestedAt',
  'reobservedAt',
  'reconciledAt',
  'revision',
  'advisoryOnly',
  'resumeAuthorized',
  'requiresCanonicalResumeGate',
]);

function strictRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function strictRecordKeys(value, allowed, label) {
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_RECORD_FIELDS) throw new Error(`${label} has too many fields`);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
  }
}

function ownValue(value, key, label, { optional = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (optional) return undefined;
    throw new Error(`${label} must provide ${key} as an own field`);
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`${label} field ${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function exactId(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be an exact id`);
  }
  return value;
}

function exactText(value, label, max = MAX_REASON) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function exactTimestamp(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function exactInteger(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}`);
  }
  return value;
}

function assertAtOrAfter(later, earlier, label) {
  if (Date.parse(later) < Date.parse(earlier)) {
    throw new Error(`${label} violates causal timestamp ordering`);
  }
}

function compareIds(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function cloneDataOnly(value, label, state = { depth: 0, nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) throw new Error(`${label} exceeds data node bound`);
  if (state.depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds data depth bound`);

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} number must be finite`);
    return value;
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`${label} must be a plain array`);
    }
    if (value.length > MAX_ARRAY_ITEMS) throw new Error(`${label} must be a bounded array`);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
        throw new Error(`${label} contains non-index array property`);
      }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
        throw new Error(`${label} contains invalid array index`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${label}[${index}] must be an enumerable data property`);
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${label} must be a dense data array`);
      }
    }
    const childState = { ...state, depth: state.depth + 1 };
    return value.map((item, index) => cloneDataOnly(item, `${label}[${index}]`, childState));
  }

  const raw = strictRecord(value, label);
  const keys = Reflect.ownKeys(raw);
  if (keys.length > MAX_RECORD_FIELDS) throw new Error(`${label} has too many fields`);
  const out = Object.create(null);
  const childState = { ...state, depth: state.depth + 1 };
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
    out[key] = cloneDataOnly(descriptor.value, `${label}.${key}`, childState);
  }
  return out;
}

function canonicalObservation(value, label) {
  return normalizeObservationV1(cloneDataOnly(value, label));
}

function canonicalVerification(value, label) {
  return normalizeVerificationV1(cloneDataOnly(value, label));
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeOptionalObservation(raw, key, label) {
  const value = ownValue(raw, key, 'HumanTakeoverV1', { optional: true });
  if (value == null) return null;
  return canonicalObservation(value, label);
}

function normalizeOptionalVerification(raw, key, label) {
  const value = ownValue(raw, key, 'HumanTakeoverV1', { optional: true });
  if (value == null) return null;
  return canonicalVerification(value, label);
}

function requirePhaseFields(state) {
  const hasControl = Boolean(state.controlStartedAt && state.quiescenceEvidenceId);
  const hasHandback = Boolean(state.handbackRequestedAt && state.reobservationInvocationId);
  const hasObservation = Boolean(state.postTakeoverObservation && state.reobservedAt);
  const hasVerification = Boolean(state.handbackVerification && state.reconciledAt);

  if (state.preTakeoverObservation && Date.parse(state.preTakeoverObservation.observedAt) > Date.parse(state.requestedAt)) {
    throw new Error('pre-takeover observation cannot postdate takeover request');
  }

  if (hasControl) assertAtOrAfter(state.controlStartedAt, state.requestedAt, 'controlStartedAt');
  if (hasHandback) {
    if (!hasControl) throw new Error('handback request requires recorded owner control');
    assertAtOrAfter(state.handbackRequestedAt, state.controlStartedAt, 'handbackRequestedAt');
  }
  if (hasObservation) {
    if (!hasHandback) throw new Error('post-takeover observation requires handback request');
    if (state.postTakeoverObservation.invocationId !== state.reobservationInvocationId) {
      throw new Error('post-takeover observation invocation does not match handback reobservation invocation');
    }
    if (state.reobservedAt !== state.postTakeoverObservation.observedAt) {
      throw new Error('reobservedAt must equal the canonical observation timestamp');
    }
    assertAtOrAfter(state.reobservedAt, state.handbackRequestedAt, 'reobservedAt');
  }
  if (hasVerification) {
    if (!hasObservation) throw new Error('handback verification requires fresh post-takeover observation');
    const verification = state.handbackVerification;
    if (verification.invocationId !== state.postTakeoverObservation.invocationId) {
      throw new Error('handback verification invocation does not match post-takeover observation');
    }
    if (verification.observationId !== state.postTakeoverObservation.observationId) {
      throw new Error('handback verification observation does not match post-takeover observation');
    }
    if (!verification.verifierId || verification.verifierId === state.agentId || verification.verifierId === state.humanPrincipalId) {
      throw new Error('handback verifier must be an independent identified verifier');
    }
    if (verification.verificationAuthorityId !== state.verificationAuthorityId) {
      throw new Error('handback verification authority mismatch');
    }
    if (state.effectId && verification.effectId && verification.effectId !== state.effectId) {
      throw new Error('handback verification effectId mismatch');
    }
    if (state.reconciledAt !== verification.verifiedAt) {
      throw new Error('reconciledAt must equal the canonical verification timestamp');
    }
    assertAtOrAfter(state.reconciledAt, state.reobservedAt, 'reconciledAt');
  }

  const expected = {
    [HumanTakeoverPhase.REQUESTED]: !hasControl && !hasHandback && !hasObservation && !hasVerification,
    [HumanTakeoverPhase.OWNER_IN_CONTROL]: hasControl && !hasHandback && !hasObservation && !hasVerification,
    [HumanTakeoverPhase.HANDBACK_PENDING]: hasControl && hasHandback && !hasObservation && !hasVerification,
    [HumanTakeoverPhase.REOBSERVED]: hasControl && hasHandback && hasObservation && !hasVerification,
    [HumanTakeoverPhase.RECONCILED]: hasControl && hasHandback && hasObservation && hasVerification
      && state.handbackVerification.status === VerificationStatus.VERIFIED
      && state.handbackVerification.evidenceArtifactIds.length > 0,
    [HumanTakeoverPhase.MANUAL_REVIEW]: hasControl && hasHandback && hasObservation && hasVerification
      && state.handbackVerification.status !== VerificationStatus.VERIFIED,
  };

  if (!expected[state.phase]) {
    throw new Error(`HumanTakeoverV1 fields are inconsistent with phase ${state.phase}`);
  }
}

export function normalizeHumanTakeoverV1(input) {
  const raw = strictRecord(input, 'HumanTakeoverV1');
  strictRecordKeys(raw, TAKEOVER_KEYS, 'HumanTakeoverV1');

  if (ownValue(raw, 'schemaVersion', 'HumanTakeoverV1') !== HUMAN_TAKEOVER_VERSION) {
    throw new Error('Unsupported HumanTakeoverV1 schemaVersion');
  }

  const phaseRaw = ownValue(raw, 'phase', 'HumanTakeoverV1');
  if (typeof phaseRaw !== 'string' || !PHASES.has(phaseRaw)) {
    throw new Error('HumanTakeoverV1 phase is invalid');
  }

  const state = {
    schemaVersion: HUMAN_TAKEOVER_VERSION,
    takeoverId: exactId(ownValue(raw, 'takeoverId', 'HumanTakeoverV1'), 'takeoverId'),
    jobId: exactId(ownValue(raw, 'jobId', 'HumanTakeoverV1'), 'jobId'),
    planId: exactId(ownValue(raw, 'planId', 'HumanTakeoverV1'), 'planId'),
    nodeId: exactId(ownValue(raw, 'nodeId', 'HumanTakeoverV1'), 'nodeId'),
    resourceId: exactId(ownValue(raw, 'resourceId', 'HumanTakeoverV1'), 'resourceId'),
    effectId: exactId(ownValue(raw, 'effectId', 'HumanTakeoverV1', { optional: true }), 'effectId', { optional: true }),
    agentId: exactId(ownValue(raw, 'agentId', 'HumanTakeoverV1'), 'agentId'),
    humanPrincipalId: exactId(ownValue(raw, 'humanPrincipalId', 'HumanTakeoverV1'), 'humanPrincipalId'),
    verificationAuthorityId: exactId(ownValue(raw, 'verificationAuthorityId', 'HumanTakeoverV1'), 'verificationAuthorityId'),
    reason: exactText(ownValue(raw, 'reason', 'HumanTakeoverV1'), 'reason'),
    phase: phaseRaw,
    quiescenceEvidenceId: exactId(
      ownValue(raw, 'quiescenceEvidenceId', 'HumanTakeoverV1', { optional: true }),
      'quiescenceEvidenceId',
      { optional: true },
    ),
    reobservationInvocationId: exactId(
      ownValue(raw, 'reobservationInvocationId', 'HumanTakeoverV1', { optional: true }),
      'reobservationInvocationId',
      { optional: true },
    ),
    preTakeoverObservation: normalizeOptionalObservation(raw, 'preTakeoverObservation', 'preTakeoverObservation'),
    postTakeoverObservation: normalizeOptionalObservation(raw, 'postTakeoverObservation', 'postTakeoverObservation'),
    handbackVerification: normalizeOptionalVerification(raw, 'handbackVerification', 'handbackVerification'),
    requestedAt: exactTimestamp(ownValue(raw, 'requestedAt', 'HumanTakeoverV1'), 'requestedAt'),
    controlStartedAt: exactTimestamp(
      ownValue(raw, 'controlStartedAt', 'HumanTakeoverV1', { optional: true }),
      'controlStartedAt',
      { optional: true },
    ),
    handbackRequestedAt: exactTimestamp(
      ownValue(raw, 'handbackRequestedAt', 'HumanTakeoverV1', { optional: true }),
      'handbackRequestedAt',
      { optional: true },
    ),
    reobservedAt: exactTimestamp(
      ownValue(raw, 'reobservedAt', 'HumanTakeoverV1', { optional: true }),
      'reobservedAt',
      { optional: true },
    ),
    reconciledAt: exactTimestamp(
      ownValue(raw, 'reconciledAt', 'HumanTakeoverV1', { optional: true }),
      'reconciledAt',
      { optional: true },
    ),
    revision: exactInteger(ownValue(raw, 'revision', 'HumanTakeoverV1'), 'revision'),
    advisoryOnly: true,
    resumeAuthorized: false,
    requiresCanonicalResumeGate: true,
  };

  if (Object.hasOwn(raw, 'advisoryOnly') && ownValue(raw, 'advisoryOnly', 'HumanTakeoverV1') !== true) {
    throw new Error('HumanTakeoverV1 advisoryOnly must remain true');
  }
  if (Object.hasOwn(raw, 'resumeAuthorized') && ownValue(raw, 'resumeAuthorized', 'HumanTakeoverV1') !== false) {
    throw new Error('HumanTakeoverV1 cannot authorize resume');
  }
  if (Object.hasOwn(raw, 'requiresCanonicalResumeGate')
      && ownValue(raw, 'requiresCanonicalResumeGate', 'HumanTakeoverV1') !== true) {
    throw new Error('HumanTakeoverV1 must require the canonical resume gate');
  }

  requirePhaseFields(state);
  return freezeDeep(state);
}

export function createHumanTakeoverV1({
  takeoverId,
  jobId,
  planId,
  nodeId,
  resourceId,
  effectId = '',
  agentId,
  humanPrincipalId,
  verificationAuthorityId,
  reason,
  preTakeoverObservation = null,
  at,
} = {}) {
  return normalizeHumanTakeoverV1({
    schemaVersion: HUMAN_TAKEOVER_VERSION,
    takeoverId,
    jobId,
    planId,
    nodeId,
    resourceId,
    effectId,
    agentId,
    humanPrincipalId,
    verificationAuthorityId,
    reason,
    phase: HumanTakeoverPhase.REQUESTED,
    quiescenceEvidenceId: '',
    reobservationInvocationId: '',
    preTakeoverObservation,
    postTakeoverObservation: null,
    handbackVerification: null,
    requestedAt: at,
    controlStartedAt: '',
    handbackRequestedAt: '',
    reobservedAt: '',
    reconciledAt: '',
    revision: 1,
    advisoryOnly: true,
    resumeAuthorized: false,
    requiresCanonicalResumeGate: true,
  });
}

function advance(raw, expectedPhase, patch) {
  const current = normalizeHumanTakeoverV1(raw);
  if (current.phase !== expectedPhase) {
    throw new Error(`HumanTakeoverV1 must be ${expectedPhase} for this transition`);
  }
  return normalizeHumanTakeoverV1({
    ...current,
    ...patch,
    revision: current.revision + 1,
  });
}

export function recordHumanTakeoverStartedV1(raw, {
  quiescenceEvidenceId,
  at,
} = {}) {
  const current = normalizeHumanTakeoverV1(raw);
  const startedAt = exactTimestamp(at, 'at');
  assertAtOrAfter(startedAt, current.requestedAt, 'takeover start');
  return advance(current, HumanTakeoverPhase.REQUESTED, {
    phase: HumanTakeoverPhase.OWNER_IN_CONTROL,
    quiescenceEvidenceId: exactId(quiescenceEvidenceId, 'quiescenceEvidenceId'),
    controlStartedAt: startedAt,
  });
}

export function requestHumanHandbackV1(raw, {
  reobservationInvocationId,
  at,
} = {}) {
  const current = normalizeHumanTakeoverV1(raw);
  const requestedAt = exactTimestamp(at, 'at');
  assertAtOrAfter(requestedAt, current.controlStartedAt, 'handback request');
  return advance(current, HumanTakeoverPhase.OWNER_IN_CONTROL, {
    phase: HumanTakeoverPhase.HANDBACK_PENDING,
    reobservationInvocationId: exactId(reobservationInvocationId, 'reobservationInvocationId'),
    handbackRequestedAt: requestedAt,
  });
}

export function recordHumanHandbackObservationV1(raw, {
  observation,
} = {}) {
  const current = normalizeHumanTakeoverV1(raw);
  if (current.phase !== HumanTakeoverPhase.HANDBACK_PENDING) {
    throw new Error('HumanTakeoverV1 must be HANDBACK_PENDING for reobservation');
  }
  const observed = canonicalObservation(observation, 'postTakeoverObservation');
  if (observed.invocationId !== current.reobservationInvocationId) {
    throw new Error('post-takeover observation invocation does not match handback reobservation invocation');
  }
  assertAtOrAfter(observed.observedAt, current.handbackRequestedAt, 'post-takeover observation');
  if (current.preTakeoverObservation
      && observed.observationId === current.preTakeoverObservation.observationId) {
    throw new Error('post-takeover observation must be a fresh observation identity');
  }
  return advance(current, HumanTakeoverPhase.HANDBACK_PENDING, {
    phase: HumanTakeoverPhase.REOBSERVED,
    postTakeoverObservation: observed,
    reobservedAt: observed.observedAt,
  });
}

export function recordHumanHandbackVerificationV1(raw, {
  verification,
} = {}) {
  const current = normalizeHumanTakeoverV1(raw);
  if (current.phase !== HumanTakeoverPhase.REOBSERVED) {
    throw new Error('HumanTakeoverV1 must be REOBSERVED for verification');
  }
  const verified = canonicalVerification(verification, 'handbackVerification');
  if (verified.invocationId !== current.postTakeoverObservation.invocationId) {
    throw new Error('handback verification invocation does not match post-takeover observation');
  }
  if (verified.observationId !== current.postTakeoverObservation.observationId) {
    throw new Error('handback verification observation does not match post-takeover observation');
  }
  if (!verified.verifierId
      || verified.verifierId === current.agentId
      || verified.verifierId === current.humanPrincipalId) {
    throw new Error('handback verifier must be independent from agent and human takeover principal');
  }
  if (verified.verificationAuthorityId !== current.verificationAuthorityId) {
    throw new Error('handback verification authority mismatch');
  }
  if (current.effectId && verified.effectId && verified.effectId !== current.effectId) {
    throw new Error('handback verification effectId mismatch');
  }
  assertAtOrAfter(verified.verifiedAt, current.postTakeoverObservation.observedAt, 'handback verification');

  const resumeCandidate = verified.status === VerificationStatus.VERIFIED
    && verified.evidenceArtifactIds.length > 0;

  return advance(current, HumanTakeoverPhase.REOBSERVED, {
    phase: resumeCandidate ? HumanTakeoverPhase.RECONCILED : HumanTakeoverPhase.MANUAL_REVIEW,
    handbackVerification: verified,
    reconciledAt: verified.verifiedAt,
  });
}

export function buildHumanHandbackResumePacketV1(raw) {
  const current = normalizeHumanTakeoverV1(raw);
  if (current.phase !== HumanTakeoverPhase.RECONCILED) {
    throw new Error('Human handback is not a resume candidate');
  }

  return freezeDeep({
    schemaVersion: HUMAN_TAKEOVER_VERSION,
    takeoverId: current.takeoverId,
    jobId: current.jobId,
    planId: current.planId,
    nodeId: current.nodeId,
    resourceId: current.resourceId,
    effectId: current.effectId,
    agentId: current.agentId,
    humanPrincipalId: current.humanPrincipalId,
    verificationAuthorityId: current.verificationAuthorityId,
    quiescenceEvidenceId: current.quiescenceEvidenceId,
    reobservationInvocationId: current.reobservationInvocationId,
    postTakeoverObservation: current.postTakeoverObservation,
    handbackVerification: current.handbackVerification,
    advisoryOnly: true,
    resumeCandidate: true,
    resumeAuthorized: false,
    requiresCanonicalResumeGate: true,
  });
}

export function humanTakeoverResumeCandidateV1(raw) {
  return normalizeHumanTakeoverV1(raw).phase === HumanTakeoverPhase.RECONCILED;
}

export function compareHumanTakeoverIdentityV1(leftRaw, rightRaw) {
  const left = normalizeHumanTakeoverV1(leftRaw);
  const right = normalizeHumanTakeoverV1(rightRaw);
  return [
    left.takeoverId,
    left.jobId,
    left.planId,
    left.nodeId,
    left.resourceId,
    left.effectId,
  ].map((value, index) => compareIds(value, [
    right.takeoverId,
    right.jobId,
    right.planId,
    right.nodeId,
    right.resourceId,
    right.effectId,
  ][index])).find(result => result !== 0) || 0;
}
