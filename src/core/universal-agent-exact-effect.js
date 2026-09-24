import {
  VerificationStatus,
  normalizeObservationV1,
  normalizeToolInvocationV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';

export const UniversalExactEffectVersion = 1;

export const ExactEffectPhase = Object.freeze({
  PREPARED: 'PREPARED',
  EXECUTING: 'EXECUTING',
  OBSERVED: 'OBSERVED',
  RECONCILE: 'RECONCILE',
  VERIFIED: 'VERIFIED',
  SAFE_RETRY: 'SAFE_RETRY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  COMMITTED: 'COMMITTED',
});

export const ExactEffectEventType = Object.freeze({
  BEGIN_EXECUTION: 'BEGIN_EXECUTION',
  RECORD_OBSERVATION: 'RECORD_OBSERVATION',
  DECLARE_AMBIGUITY: 'DECLARE_AMBIGUITY',
  RECORD_VERIFICATION: 'RECORD_VERIFICATION',
  RESOLVE_RECONCILIATION: 'RESOLVE_RECONCILIATION',
  COMMIT: 'COMMIT',
});

export const ReconciliationOutcome = Object.freeze({
  VERIFIED: 'VERIFIED',
  SAFE_RETRY: 'SAFE_RETRY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

const PHASES = new Set(Object.values(ExactEffectPhase));
const EVENTS = new Set(Object.values(ExactEffectEventType));
const RECONCILE_OUTCOMES = new Set(Object.values(ReconciliationOutcome));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_PROCESSED_EVENTS = 1024;
const MAX_ATTEMPTS = 64;

function clone(value) {
  return structuredClone(value);
}

function id(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function optionalText(value, label, max = 8000) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function exactKeys(raw, allowed, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function executionId(effectId, attempt) {
  return `${effectId}:attempt:${attempt}`;
}

function freshAmbiguity() {
  return { reasonCode: '', summary: '', declaredAt: '' };
}

function freshReconciliation() {
  return { outcome: '', reasonCode: '', summary: '', resolvedAt: '' };
}

function assertObservationBinding(observation, state) {
  if (observation.invocationId !== state.invocation.invocationId) {
    throw new Error('Observation invocationId does not match effect invocation');
  }
}

function assertVerificationBinding(verification, state) {
  if (verification.invocationId !== state.invocation.invocationId) {
    throw new Error('Verification invocationId does not match effect invocation');
  }
  if (!state.observation || verification.observationId !== state.observation.observationId) {
    throw new Error('Verification observationId does not match current effect observation');
  }
  if (verification.effectId && verification.effectId !== state.effectId) {
    throw new Error('Verification effectId does not match exact effect');
  }
  if (verification.executionId && verification.executionId !== state.executionId) {
    throw new Error('Verification executionId does not match current exact-effect attempt');
  }
  if (verification.attempt && verification.attempt !== state.attempt) {
    throw new Error('Verification attempt does not match current exact-effect attempt');
  }
}

function normalizedState(raw) {
  exactKeys(raw, new Set([
    'schemaVersion', 'effectId', 'invocation', 'phase', 'attempt',
    'executionId', 'observation', 'verification', 'ambiguity',
    'reconciliation', 'commitId', 'createdAt', 'updatedAt',
    'processedEventIds',
  ]), 'ExactEffectStateV1');

  if (Number(raw.schemaVersion) !== UniversalExactEffectVersion) {
    throw new Error('Unsupported ExactEffectStateV1 schemaVersion');
  }
  const invocation = normalizeToolInvocationV1(raw.invocation);
  const effectId = id(raw.effectId, 'effectId');
  if (effectId !== invocation.invocationId) {
    throw new Error('effectId must equal invocationId');
  }
  const phase = String(raw.phase || '').trim().toUpperCase();
  if (!PHASES.has(phase)) throw new Error('Exact effect phase is invalid');
  const attempt = Number(raw.attempt);
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > MAX_ATTEMPTS) {
    throw new Error('Exact effect attempt is invalid');
  }
  const expectedExecutionId = attempt > 0 ? executionId(effectId, attempt) : '';
  if (String(raw.executionId || '') !== expectedExecutionId) {
    throw new Error('Exact effect executionId is inconsistent');
  }
  const observation = raw.observation == null ? null : normalizeObservationV1(raw.observation);
  if (observation) assertObservationBinding(observation, { invocation });
  const verification = raw.verification == null ? null : normalizeVerificationV1(raw.verification);
  if (verification) {
    if (!observation) throw new Error('Verification requires observation');
    assertVerificationBinding(verification, {
      invocation,
      observation,
      effectId,
      executionId: expectedExecutionId,
      attempt,
    });
  }
  const processedEventIds = Array.isArray(raw.processedEventIds)
    ? raw.processedEventIds.map((value, index) => id(value, `processedEventIds[${index}]`))
    : (() => { throw new Error('processedEventIds must be an array'); })();
  if (processedEventIds.length > MAX_PROCESSED_EVENTS || new Set(processedEventIds).size !== processedEventIds.length) {
    throw new Error('processedEventIds is invalid');
  }

  const ambiguity = raw.ambiguity && typeof raw.ambiguity === 'object'
    ? {
      reasonCode: raw.ambiguity.reasonCode ? id(raw.ambiguity.reasonCode, 'ambiguity.reasonCode') : '',
      summary: optionalText(raw.ambiguity.summary, 'ambiguity.summary'),
      declaredAt: raw.ambiguity.declaredAt ? timestamp(raw.ambiguity.declaredAt, 'ambiguity.declaredAt') : '',
    }
    : freshAmbiguity();

  const reconciliation = raw.reconciliation && typeof raw.reconciliation === 'object'
    ? {
      outcome: raw.reconciliation.outcome ? String(raw.reconciliation.outcome).trim().toUpperCase() : '',
      reasonCode: raw.reconciliation.reasonCode ? id(raw.reconciliation.reasonCode, 'reconciliation.reasonCode') : '',
      summary: optionalText(raw.reconciliation.summary, 'reconciliation.summary'),
      resolvedAt: raw.reconciliation.resolvedAt ? timestamp(raw.reconciliation.resolvedAt, 'reconciliation.resolvedAt') : '',
    }
    : freshReconciliation();
  if (reconciliation.outcome && !RECONCILE_OUTCOMES.has(reconciliation.outcome)) {
    throw new Error('reconciliation.outcome is invalid');
  }

  return freeze({
    schemaVersion: UniversalExactEffectVersion,
    effectId,
    invocation,
    phase,
    attempt,
    executionId: expectedExecutionId,
    observation,
    verification,
    ambiguity,
    reconciliation,
    commitId: raw.commitId ? id(raw.commitId, 'commitId') : '',
    createdAt: timestamp(raw.createdAt, 'createdAt'),
    updatedAt: timestamp(raw.updatedAt, 'updatedAt'),
    processedEventIds,
  });
}

export function createExactEffectStateV1(invocation, { createdAt } = {}) {
  const normalizedInvocation = normalizeToolInvocationV1(invocation);
  const at = timestamp(createdAt || normalizedInvocation.createdAt, 'createdAt');
  return normalizedState({
    schemaVersion: UniversalExactEffectVersion,
    effectId: normalizedInvocation.invocationId,
    invocation: normalizedInvocation,
    phase: ExactEffectPhase.PREPARED,
    attempt: 0,
    executionId: '',
    observation: null,
    verification: null,
    ambiguity: freshAmbiguity(),
    reconciliation: freshReconciliation(),
    commitId: '',
    createdAt: at,
    updatedAt: at,
    processedEventIds: [],
  });
}

export function normalizeExactEffectStateV1(raw) {
  return normalizedState(raw);
}

function normalizeEvent(raw) {
  exactKeys(raw, new Set([
    'schemaVersion', 'eventId', 'type', 'effectId', 'at',
    'observation', 'verification', 'reasonCode', 'summary',
    'outcome', 'commitId', 'executionId',
  ]), 'ExactEffectEventV1');
  if (Number(raw.schemaVersion) !== UniversalExactEffectVersion) {
    throw new Error('Unsupported ExactEffectEventV1 schemaVersion');
  }
  const type = String(raw.type || '').trim().toUpperCase();
  if (!EVENTS.has(type)) throw new Error('Exact effect event type is invalid');
  return {
    schemaVersion: UniversalExactEffectVersion,
    eventId: id(raw.eventId, 'eventId'),
    type,
    effectId: id(raw.effectId, 'event.effectId'),
    at: timestamp(raw.at, 'event.at'),
    observation: raw.observation,
    verification: raw.verification,
    reasonCode: raw.reasonCode,
    summary: raw.summary,
    outcome: raw.outcome,
    commitId: raw.commitId,
    executionId: raw.executionId == null || raw.executionId === '' ? '' : id(raw.executionId, 'event.executionId'),
  };
}

function assertCurrentExecutionEvent(event, state) {
  if (!state.executionId || event.executionId !== state.executionId) {
    throw new Error('Event executionId does not match current exact-effect attempt');
  }
}

function result(state, {
  accepted = true,
  deduplicated = false,
  reason,
  action = 'NONE',
} = {}) {
  return freeze({ state: normalizedState(state), accepted, deduplicated, reason, action });
}

function withEvent(state, event) {
  if (state.processedEventIds.length >= MAX_PROCESSED_EVENTS) {
    throw new Error('Exact effect processed-event capacity exceeded');
  }
  state.processedEventIds.push(event.eventId);
  state.updatedAt = event.at;
}

export function reduceExactEffectV1(stateRaw, eventRaw) {
  const current = normalizedState(stateRaw);
  const event = normalizeEvent(eventRaw);
  if (event.effectId !== current.effectId) throw new Error('Event effectId does not match exact effect');
  if (current.processedEventIds.includes(event.eventId)) {
    return result(current, {
      accepted: true,
      deduplicated: true,
      reason: 'DUPLICATE_EVENT',
    });
  }

  const state = clone(current);
  withEvent(state, event);

  if (event.type === ExactEffectEventType.BEGIN_EXECUTION) {
    if (![ExactEffectPhase.PREPARED, ExactEffectPhase.SAFE_RETRY].includes(current.phase)) {
      return result(state, {
        accepted: false,
        reason: current.phase === ExactEffectPhase.COMMITTED
          ? 'EFFECT_ALREADY_COMMITTED'
          : 'BLIND_REPLAY_BLOCKED',
        action: current.phase === ExactEffectPhase.RECONCILE ? 'RECONCILE' : 'NONE',
      });
    }
    if (current.attempt >= MAX_ATTEMPTS) {
      state.phase = ExactEffectPhase.MANUAL_REVIEW;
      state.reconciliation = {
        outcome: ReconciliationOutcome.MANUAL_REVIEW,
        reasonCode: 'MAX_ATTEMPTS_EXCEEDED',
        summary: 'Exact effect retry budget exhausted.',
        resolvedAt: event.at,
      };
      return result(state, { reason: 'MAX_ATTEMPTS_EXCEEDED', action: 'MANUAL_REVIEW' });
    }
    state.attempt = current.attempt + 1;
    state.executionId = executionId(current.effectId, state.attempt);
    state.phase = ExactEffectPhase.EXECUTING;
    state.observation = null;
    state.verification = null;
    state.ambiguity = freshAmbiguity();
    state.reconciliation = freshReconciliation();
    return result(state, { reason: current.phase === ExactEffectPhase.SAFE_RETRY ? 'SAFE_RETRY_EXECUTION_STARTED' : 'EXECUTION_STARTED', action: 'EXECUTE' });
  }

  if (event.type === ExactEffectEventType.RECORD_OBSERVATION) {
    if (current.phase !== ExactEffectPhase.EXECUTING) {
      return result(state, { accepted: false, reason: 'OBSERVATION_NOT_EXPECTED' });
    }
    assertCurrentExecutionEvent(event, current);
    const observation = normalizeObservationV1(event.observation);
    assertObservationBinding(observation, current);
    state.observation = observation;
    state.phase = ExactEffectPhase.OBSERVED;
    return result(state, { reason: 'OBSERVATION_RECORDED', action: 'VERIFY' });
  }

  if (event.type === ExactEffectEventType.DECLARE_AMBIGUITY) {
    if (![ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(current.phase)) {
      return result(state, { accepted: false, reason: 'AMBIGUITY_NOT_EXPECTED' });
    }
    assertCurrentExecutionEvent(event, current);
    state.phase = ExactEffectPhase.RECONCILE;
    state.ambiguity = {
      reasonCode: id(event.reasonCode, 'reasonCode'),
      summary: optionalText(event.summary, 'summary'),
      declaredAt: event.at,
    };
    return result(state, { reason: 'AMBIGUITY_REQUIRES_RECONCILIATION', action: 'RECONCILE' });
  }

  if (event.type === ExactEffectEventType.RECORD_VERIFICATION) {
    if (current.phase !== ExactEffectPhase.OBSERVED) {
      return result(state, { accepted: false, reason: 'VERIFICATION_NOT_EXPECTED' });
    }
    assertCurrentExecutionEvent(event, current);
    const verification = normalizeVerificationV1(event.verification);
    assertVerificationBinding(verification, current);
    state.verification = verification;
    if ([VerificationStatus.VERIFIED, VerificationStatus.NOT_APPLICABLE].includes(verification.status)) {
      state.phase = ExactEffectPhase.VERIFIED;
      return result(state, { reason: 'EFFECT_VERIFIED', action: 'COMMIT' });
    }
    if (verification.status === VerificationStatus.AMBIGUOUS) {
      state.phase = ExactEffectPhase.RECONCILE;
      state.ambiguity = {
        reasonCode: verification.reasonCode,
        summary: verification.summary,
        declaredAt: verification.verifiedAt,
      };
      return result(state, { reason: 'VERIFICATION_AMBIGUOUS', action: 'RECONCILE' });
    }
    state.phase = ExactEffectPhase.MANUAL_REVIEW;
    state.reconciliation = {
      outcome: ReconciliationOutcome.MANUAL_REVIEW,
      reasonCode: verification.reasonCode,
      summary: verification.summary,
      resolvedAt: verification.verifiedAt,
    };
    return result(state, { reason: 'VERIFICATION_FAILED', action: 'MANUAL_REVIEW' });
  }

  if (event.type === ExactEffectEventType.RESOLVE_RECONCILIATION) {
    if (current.phase !== ExactEffectPhase.RECONCILE) {
      return result(state, { accepted: false, reason: 'RECONCILIATION_NOT_EXPECTED' });
    }
    assertCurrentExecutionEvent(event, current);
    const outcome = String(event.outcome || '').trim().toUpperCase();
    if (!RECONCILE_OUTCOMES.has(outcome)) throw new Error('Reconciliation outcome is invalid');
    const reasonCode = id(event.reasonCode, 'reasonCode');
    const summary = optionalText(event.summary, 'summary');

    let reconciliationObservation = current.observation;
    if (event.observation != null) {
      reconciliationObservation = normalizeObservationV1(event.observation);
      assertObservationBinding(reconciliationObservation, current);
      state.observation = reconciliationObservation;
    }

    if (outcome === ReconciliationOutcome.VERIFIED) {
      if (!reconciliationObservation) throw new Error('VERIFIED reconciliation requires observation evidence');
      const verification = normalizeVerificationV1(event.verification);
      assertVerificationBinding(verification, { ...current, observation: reconciliationObservation });
      if (![VerificationStatus.VERIFIED, VerificationStatus.NOT_APPLICABLE].includes(verification.status)) {
        throw new Error('VERIFIED reconciliation requires a verified verification');
      }
      state.verification = verification;
      state.phase = ExactEffectPhase.VERIFIED;
      state.reconciliation = { outcome, reasonCode, summary, resolvedAt: event.at };
      return result(state, { reason: 'RECONCILIATION_VERIFIED', action: 'COMMIT' });
    }

    if (outcome === ReconciliationOutcome.SAFE_RETRY) {
      if (!reconciliationObservation || event.verification == null) {
        throw new Error('SAFE_RETRY reconciliation requires observation and failed verification evidence');
      }
      const verification = normalizeVerificationV1(event.verification);
      assertVerificationBinding(verification, { ...current, observation: reconciliationObservation });
      if (verification.status !== VerificationStatus.FAILED) {
        throw new Error('SAFE_RETRY reconciliation requires FAILED verification proving no committed effect');
      }
      state.verification = verification;
      state.reconciliation = { outcome, reasonCode, summary, resolvedAt: event.at };
      state.phase = ExactEffectPhase.SAFE_RETRY;
      return result(state, { reason: 'RECONCILIATION_SAFE_RETRY', action: 'SAFE_RETRY' });
    }

    if (event.verification != null) {
      if (!reconciliationObservation) throw new Error('Reconciliation verification requires observation evidence');
      const verification = normalizeVerificationV1(event.verification);
      assertVerificationBinding(verification, { ...current, observation: reconciliationObservation });
      state.verification = verification;
    }
    state.reconciliation = { outcome, reasonCode, summary, resolvedAt: event.at };
    state.phase = ExactEffectPhase.MANUAL_REVIEW;
    return result(state, { reason: 'RECONCILIATION_MANUAL_REVIEW', action: 'MANUAL_REVIEW' });
  }

  if (event.type === ExactEffectEventType.COMMIT) {
    if (current.phase !== ExactEffectPhase.VERIFIED) {
      return result(state, {
        accepted: false,
        reason: current.phase === ExactEffectPhase.COMMITTED ? 'EFFECT_ALREADY_COMMITTED' : 'COMMIT_REQUIRES_VERIFIED_EFFECT',
      });
    }
    state.commitId = id(event.commitId, 'commitId');
    state.phase = ExactEffectPhase.COMMITTED;
    return result(state, { reason: 'EFFECT_COMMITTED', action: 'NONE' });
  }

  throw new Error('Unhandled exact effect event');
}

export function exactEffectCanExecuteV1(stateRaw) {
  const state = normalizedState(stateRaw);
  return [ExactEffectPhase.PREPARED, ExactEffectPhase.SAFE_RETRY].includes(state.phase);
}

export function exactEffectNeedsReconciliationV1(stateRaw) {
  return normalizedState(stateRaw).phase === ExactEffectPhase.RECONCILE;
}
