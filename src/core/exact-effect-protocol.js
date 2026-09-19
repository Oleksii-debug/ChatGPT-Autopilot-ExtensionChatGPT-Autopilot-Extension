import {
  VerificationStatus,
  normalizeObservationV1,
  normalizeToolInvocationV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';

export const ExactEffectPhase = Object.freeze({
  PREPARED: 'PREPARED',
  EXECUTING: 'EXECUTING',
  OBSERVED: 'OBSERVED',
  VERIFIED: 'VERIFIED',
  AMBIGUOUS: 'AMBIGUOUS',
  RECONCILING: 'RECONCILING',
  SAFE_RETRY: 'SAFE_RETRY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  COMMITTED: 'COMMITTED',
});

export const ExactEffectEventType = Object.freeze({
  EXECUTION_STARTED: 'EXECUTION_STARTED',
  EFFECT_OBSERVED: 'EFFECT_OBSERVED',
  EXECUTION_UNCERTAIN: 'EXECUTION_UNCERTAIN',
  VERIFICATION_RECORDED: 'VERIFICATION_RECORDED',
  RECONCILE_STARTED: 'RECONCILE_STARTED',
  RECONCILIATION_RESOLVED: 'RECONCILIATION_RESOLVED',
  PRE_EFFECT_ABORTED: 'PRE_EFFECT_ABORTED',
  RETRY_PREPARED: 'RETRY_PREPARED',
  COMMIT: 'COMMIT',
  RUNTIME_RECONCILE: 'RUNTIME_RECONCILE',
});

export const ExactEffectActionType = Object.freeze({
  EXECUTE: 'EXECUTE',
  VERIFY: 'VERIFY',
  RECONCILE: 'RECONCILE',
  PREPARE_SAFE_RETRY: 'PREPARE_SAFE_RETRY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  COMMIT: 'COMMIT',
});

export const ExactEffectResolution = Object.freeze({
  VERIFIED: 'VERIFIED',
  SAFE_RETRY: 'SAFE_RETRY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

const PHASES = new Set(Object.values(ExactEffectPhase));
const EVENTS = new Set(Object.values(ExactEffectEventType));
const RESOLUTIONS = new Set(Object.values(ExactEffectResolution));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_NOTE = 8000;

function clone(value) {
  return structuredClone(value);
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function id(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function optionalId(value, label) {
  if (value == null || value === '') return '';
  return id(value, label);
}

function timestampMs(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} is invalid`);
  return Math.floor(n);
}

function note(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new Error('note must be text');
  const out = value.trim();
  if (out.length > MAX_NOTE) throw new Error('note is too large');
  return out;
}

function attemptId(effectId, generation) {
  return `${effectId}:g${generation}`;
}

function baseAction(type, state, extra = {}) {
  return Object.freeze({
    type,
    effectId: state.effectId,
    invocationId: state.invocationId,
    generation: state.generation,
    executionAttemptId: state.executionAttemptId,
    ...extra,
  });
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function createExactEffectV1({ effectId, invocation, nowMs = Date.now() } = {}) {
  const normalizedInvocation = normalizeToolInvocationV1(invocation);
  const normalizedEffectId = id(effectId, 'effectId');
  const at = timestampMs(nowMs, 'nowMs');
  return freezeDeep({
    schemaVersion: 1,
    effectId: normalizedEffectId,
    invocationId: normalizedInvocation.invocationId,
    toolId: normalizedInvocation.toolId,
    providerId: normalizedInvocation.providerId,
    generation: 1,
    executionAttemptId: attemptId(normalizedEffectId, 1),
    phase: ExactEffectPhase.PREPARED,
    observation: null,
    verification: null,
    reconciliationVerification: null,
    ambiguityReason: '',
    manualReviewReason: '',
    commitRef: '',
    createdAt: at,
    updatedAt: at,
  });
}

export function normalizeExactEffectV1(input) {
  const raw = plain(input, 'ExactEffectV1');
  const allowed = new Set([
    'schemaVersion', 'effectId', 'invocationId', 'toolId', 'providerId',
    'generation', 'executionAttemptId', 'phase', 'observation', 'verification',
    'reconciliationVerification', 'ambiguityReason', 'manualReviewReason',
    'commitRef', 'createdAt', 'updatedAt',
  ]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`ExactEffectV1 contains unknown field: ${key}`);
  if (Number(raw.schemaVersion) !== 1) throw new Error('Unsupported ExactEffectV1 schemaVersion');
  const generation = Number(raw.generation);
  if (!Number.isInteger(generation) || generation < 1 || generation > Number.MAX_SAFE_INTEGER) throw new Error('generation is invalid');
  const phase = String(raw.phase || '').trim().toUpperCase();
  if (!PHASES.has(phase)) throw new Error('phase is invalid');
  const effectId = id(raw.effectId, 'effectId');
  const expectedAttemptId = attemptId(effectId, generation);
  if (id(raw.executionAttemptId, 'executionAttemptId') !== expectedAttemptId) throw new Error('executionAttemptId does not match effect generation');
  const observation = raw.observation == null ? null : normalizeObservationV1(raw.observation);
  const verification = raw.verification == null ? null : normalizeVerificationV1(raw.verification);
  const reconciliationVerification = raw.reconciliationVerification == null ? null : normalizeVerificationV1(raw.reconciliationVerification);
  if (observation && observation.invocationId !== raw.invocationId) throw new Error('observation invocationId does not match effect');
  if (verification && verification.invocationId !== raw.invocationId) throw new Error('verification invocationId does not match effect');
  if (reconciliationVerification && reconciliationVerification.invocationId !== raw.invocationId) throw new Error('reconciliation verification invocationId does not match effect');

  return freezeDeep({
    schemaVersion: 1,
    effectId,
    invocationId: id(raw.invocationId, 'invocationId'),
    toolId: id(raw.toolId, 'toolId'),
    providerId: id(raw.providerId, 'providerId'),
    generation,
    executionAttemptId: expectedAttemptId,
    phase,
    observation,
    verification,
    reconciliationVerification,
    ambiguityReason: note(raw.ambiguityReason),
    manualReviewReason: note(raw.manualReviewReason),
    commitRef: optionalId(raw.commitRef, 'commitRef'),
    createdAt: timestampMs(raw.createdAt, 'createdAt'),
    updatedAt: timestampMs(raw.updatedAt, 'updatedAt'),
  });
}

function validateEvent(input) {
  const raw = plain(input, 'ExactEffect event');
  const type = String(raw.type || '').trim().toUpperCase();
  if (!EVENTS.has(type)) throw new Error('Unsupported ExactEffect event type');
  return {
    ...raw,
    type,
    eventId: id(raw.eventId, 'eventId'),
    generation: Number(raw.generation),
  };
}

function staleGeneration(state, event) {
  return !Number.isInteger(event.generation) || event.generation !== state.generation;
}

function result(state, actions = [], reason = 'NO_CHANGE') {
  return freezeDeep({ state, actions, reason });
}

function withState(state, patch, nowMs) {
  return normalizeExactEffectV1({
    ...clone(state),
    ...patch,
    updatedAt: timestampMs(nowMs, 'nowMs'),
  });
}

export function planExactEffectRecoveryV1(input) {
  const state = normalizeExactEffectV1(input);
  switch (state.phase) {
    case ExactEffectPhase.PREPARED:
      return [baseAction(ExactEffectActionType.EXECUTE, state)];
    case ExactEffectPhase.EXECUTING:
    case ExactEffectPhase.AMBIGUOUS:
    case ExactEffectPhase.RECONCILING:
      return [baseAction(ExactEffectActionType.RECONCILE, state)];
    case ExactEffectPhase.OBSERVED:
      return [baseAction(ExactEffectActionType.VERIFY, state, { observationId: state.observation?.observationId || '' })];
    case ExactEffectPhase.VERIFIED:
      return [baseAction(ExactEffectActionType.COMMIT, state, { verificationId: state.verification?.verificationId || state.reconciliationVerification?.verificationId || '' })];
    case ExactEffectPhase.SAFE_RETRY:
      return [baseAction(ExactEffectActionType.PREPARE_SAFE_RETRY, state)];
    case ExactEffectPhase.MANUAL_REVIEW:
      return [baseAction(ExactEffectActionType.MANUAL_REVIEW, state, { reason: state.manualReviewReason })];
    case ExactEffectPhase.COMMITTED:
    default:
      return [];
  }
}

export function reduceExactEffectV1(stateInput, eventInput, { nowMs = Date.now() } = {}) {
  const state = normalizeExactEffectV1(stateInput);
  const event = validateEvent(eventInput);

  if (staleGeneration(state, event)) {
    return result(state, [], 'STALE_GENERATION');
  }
  if (state.phase === ExactEffectPhase.COMMITTED) {
    return result(state, [], 'ALREADY_COMMITTED');
  }

  if (event.type === ExactEffectEventType.RUNTIME_RECONCILE) {
    if (state.phase === ExactEffectPhase.EXECUTING) {
      const next = withState(state, {
        phase: ExactEffectPhase.AMBIGUOUS,
        ambiguityReason: 'Runtime restarted or reconciled while physical effect was executing.',
      }, nowMs);
      return result(next, planExactEffectRecoveryV1(next), 'EXECUTION_BECAME_AMBIGUOUS');
    }
    return result(state, planExactEffectRecoveryV1(state), 'RECOVERY_PLANNED');
  }

  if (event.type === ExactEffectEventType.EXECUTION_STARTED) {
    if (state.phase !== ExactEffectPhase.PREPARED) return result(state, planExactEffectRecoveryV1(state), 'EXECUTION_NOT_ALLOWED');
    const next = withState(state, { phase: ExactEffectPhase.EXECUTING }, nowMs);
    return result(next, [], 'EXECUTION_STARTED');
  }

  if (event.type === ExactEffectEventType.PRE_EFFECT_ABORTED) {
    if (state.phase !== ExactEffectPhase.PREPARED) return result(state, planExactEffectRecoveryV1(state), 'PRE_EFFECT_ABORT_NOT_ALLOWED');
    const next = withState(state, {
      phase: ExactEffectPhase.SAFE_RETRY,
      ambiguityReason: '',
      manualReviewReason: '',
    }, nowMs);
    return result(next, planExactEffectRecoveryV1(next), 'SAFE_RETRY_PRE_EFFECT');
  }

  if (event.type === ExactEffectEventType.EFFECT_OBSERVED) {
    if (state.phase !== ExactEffectPhase.EXECUTING) return result(state, planExactEffectRecoveryV1(state), 'OBSERVATION_NOT_ALLOWED');
    const observation = normalizeObservationV1(event.observation);
    if (observation.invocationId !== state.invocationId) throw new Error('observation invocationId does not match effect');
    const next = withState(state, {
      phase: ExactEffectPhase.OBSERVED,
      observation,
      ambiguityReason: '',
    }, nowMs);
    return result(next, planExactEffectRecoveryV1(next), 'EFFECT_OBSERVED');
  }

  if (event.type === ExactEffectEventType.EXECUTION_UNCERTAIN) {
    if (state.phase !== ExactEffectPhase.EXECUTING) return result(state, planExactEffectRecoveryV1(state), 'UNCERTAINTY_NOT_ALLOWED');
    const reason = note(event.reason) || 'Physical effect outcome is uncertain.';
    const next = withState(state, {
      phase: ExactEffectPhase.AMBIGUOUS,
      ambiguityReason: reason,
    }, nowMs);
    return result(next, planExactEffectRecoveryV1(next), 'EXECUTION_AMBIGUOUS');
  }

  if (event.type === ExactEffectEventType.VERIFICATION_RECORDED) {
    if (state.phase !== ExactEffectPhase.OBSERVED) return result(state, planExactEffectRecoveryV1(state), 'VERIFICATION_NOT_ALLOWED');
    const verification = normalizeVerificationV1(event.verification);
    if (verification.invocationId !== state.invocationId) throw new Error('verification invocationId does not match effect');
    if (verification.observationId !== state.observation?.observationId) throw new Error('verification observationId does not match effect observation');
    if (verification.status === VerificationStatus.VERIFIED) {
      const next = withState(state, {
        phase: ExactEffectPhase.VERIFIED,
        verification,
      }, nowMs);
      return result(next, planExactEffectRecoveryV1(next), 'EFFECT_VERIFIED');
    }
    if (verification.status === VerificationStatus.AMBIGUOUS) {
      const next = withState(state, {
        phase: ExactEffectPhase.AMBIGUOUS,
        verification,
        ambiguityReason: verification.summary || verification.reasonCode,
      }, nowMs);
      return result(next, planExactEffectRecoveryV1(next), 'VERIFICATION_AMBIGUOUS');
    }
    const next = withState(state, {
      phase: ExactEffectPhase.MANUAL_REVIEW,
      verification,
      manualReviewReason: verification.summary || verification.reasonCode || 'Effect verification failed.',
    }, nowMs);
    return result(next, planExactEffectRecoveryV1(next), 'VERIFICATION_FAILED_MANUAL_REVIEW');
  }

  if (event.type === ExactEffectEventType.RECONCILE_STARTED) {
    if (![ExactEffectPhase.AMBIGUOUS, ExactEffectPhase.EXECUTING].includes(state.phase)) {
      return result(state, planExactEffectRecoveryV1(state), 'RECONCILE_NOT_ALLOWED');
    }
    const next = withState(state, {
      phase: ExactEffectPhase.RECONCILING,
      ambiguityReason: state.ambiguityReason || 'Effect requires reconciliation.',
    }, nowMs);
    return result(next, [], 'RECONCILE_STARTED');
  }

  if (event.type === ExactEffectEventType.RECONCILIATION_RESOLVED) {
    if (state.phase !== ExactEffectPhase.RECONCILING) return result(state, planExactEffectRecoveryV1(state), 'RECONCILIATION_RESULT_NOT_ALLOWED');
    const resolution = String(event.resolution || '').trim().toUpperCase();
    if (!RESOLUTIONS.has(resolution)) throw new Error('resolution is invalid');
    const verification = normalizeVerificationV1(event.verification);
    if (verification.invocationId !== state.invocationId) throw new Error('reconciliation verification invocationId does not match effect');
    if (verification.status !== VerificationStatus.VERIFIED) {
      throw new Error('reconciliation resolution requires VERIFIED proof');
    }

    if (resolution === ExactEffectResolution.VERIFIED) {
      const next = withState(state, {
        phase: ExactEffectPhase.VERIFIED,
        reconciliationVerification: verification,
        ambiguityReason: '',
      }, nowMs);
      return result(next, planExactEffectRecoveryV1(next), 'RECONCILED_VERIFIED');
    }
    if (resolution === ExactEffectResolution.SAFE_RETRY) {
      const next = withState(state, {
        phase: ExactEffectPhase.SAFE_RETRY,
        reconciliationVerification: verification,
        ambiguityReason: '',
      }, nowMs);
      return result(next, planExactEffectRecoveryV1(next), 'RECONCILED_SAFE_RETRY');
    }
    const next = withState(state, {
      phase: ExactEffectPhase.MANUAL_REVIEW,
      reconciliationVerification: verification,
      manualReviewReason: note(event.reason) || verification.summary || verification.reasonCode,
    }, nowMs);
    return result(next, planExactEffectRecoveryV1(next), 'RECONCILED_MANUAL_REVIEW');
  }

  if (event.type === ExactEffectEventType.RETRY_PREPARED) {
    if (state.phase !== ExactEffectPhase.SAFE_RETRY) return result(state, planExactEffectRecoveryV1(state), 'RETRY_NOT_ALLOWED');
    const nextGeneration = state.generation + 1;
    const next = normalizeExactEffectV1({
      ...clone(state),
      generation: nextGeneration,
      executionAttemptId: attemptId(state.effectId, nextGeneration),
      phase: ExactEffectPhase.PREPARED,
      observation: null,
      verification: null,
      reconciliationVerification: state.reconciliationVerification,
      ambiguityReason: '',
      manualReviewReason: '',
      commitRef: '',
      updatedAt: timestampMs(nowMs, 'nowMs'),
    });
    return result(next, planExactEffectRecoveryV1(next), 'SAFE_RETRY_PREPARED');
  }

  if (event.type === ExactEffectEventType.COMMIT) {
    if (state.phase !== ExactEffectPhase.VERIFIED) return result(state, planExactEffectRecoveryV1(state), 'COMMIT_NOT_ALLOWED');
    const commitRef = id(event.commitRef, 'commitRef');
    const next = withState(state, {
      phase: ExactEffectPhase.COMMITTED,
      commitRef,
    }, nowMs);
    return result(next, [], 'COMMITTED');
  }

  throw new Error('Unhandled ExactEffect event');
}
