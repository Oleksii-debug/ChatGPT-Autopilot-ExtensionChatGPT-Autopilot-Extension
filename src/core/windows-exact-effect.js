import {
  ExactEffectEventType,
  ExactEffectPhase,
  ReconciliationOutcome,
  createExactEffectStateV1,
  normalizeExactEffectStateV1,
  reduceExactEffectV1,
} from './universal-agent-exact-effect.js';
import {
  VerificationStatus,
  normalizeObservationV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';
import { WindowsToolId } from './windows-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const RECONCILE_REQUEST_KEYS = new Set(['invocationId', 'outcome', 'reasonCode', 'summary']);
const RECONCILE_PROOF_KEYS = new Set([
  'verifierId', 'verificationAuthorityId', 'effectId', 'executionId', 'attempt',
  'observation', 'verification',
]);
const DEFAULT_MAX_RECONCILIATION_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

function requireId(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function requireAttempt(value) {
  const attempt = Number(value);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('Reconciliation proof attempt is invalid');
  return attempt;
}

function timestampMs(value, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return ms;
}

function at(now) { return new Date(now()).toISOString(); }
function eventId(invocationId, suffix) { return `${invocationId}:${suffix}`; }

function assertStore(store) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new Error('Canonical exact-effect state store adapter is required');
  }
}

function assertProvider(provider) {
  if (!provider || typeof provider.invoke !== 'function' || typeof provider.authorize !== 'function') {
    throw new Error('Windows provider with side-effect-free authorization preflight is required');
  }
}

function observationFor(invocationId, result, observedAt) {
  return {
    schemaVersion: 1,
    observationId: `${invocationId}:observation`,
    invocationId,
    status: 'OK',
    summary: 'Windows Native Companion returned a bounded process result.',
    data: structuredClone(result),
    artifactRefs: [],
    observedAt,
  };
}

/**
 * Thin binding between WIN-001 and the existing UniversalExactEffectV1 state machine.
 * Persistence is deliberately injected: callers must use the canonical durable store.
 * This class owns no scheduler, store, recovery engine, or policy authority.
 */
export class WindowsExactEffectExecutorV1 {
  constructor({
    provider,
    store,
    verify,
    reconcileVerify = null,
    actorId = 'windows-exact-effect-executor',
    parentActorId = null,
    maxReconciliationEvidenceAgeMs = DEFAULT_MAX_RECONCILIATION_EVIDENCE_AGE_MS,
    now = () => Date.now(),
  } = {}) {
    assertProvider(provider);
    assertStore(store);
    if (typeof verify !== 'function') throw new Error('Independent Windows effect verifier is required');
    this.provider = provider;
    this.store = store;
    this.verify = verify;
    this.reconcileVerify = reconcileVerify;
    this.actorId = requireId(actorId, 'actorId');
    this.parentActorId = parentActorId == null ? null : requireId(parentActorId, 'parentActorId');
    if (!Number.isInteger(maxReconciliationEvidenceAgeMs) || maxReconciliationEvidenceAgeMs < 1) {
      throw new Error('maxReconciliationEvidenceAgeMs is invalid');
    }
    this.maxReconciliationEvidenceAgeMs = maxReconciliationEvidenceAgeMs;
    this.now = now;
  }

  async #obtainReconciliationProof(state, outcome, requestedAt) {
    if (typeof this.reconcileVerify !== 'function') {
      throw new Error(`${outcome} requires the canonical independent reconciliation verifier`);
    }
    const raw = await this.reconcileVerify(Object.freeze({
      invocation: structuredClone(state.invocation),
      effectId: state.effectId,
      executionId: state.executionId,
      attempt: state.attempt,
      policyDecisionId: state.invocation.policyDecisionId,
      ambiguityDeclaredAt: state.ambiguity.declaredAt,
      requestedAt: new Date(requestedAt).toISOString(),
      expectedOutcome: outcome,
    }));
    exactKeys(raw, RECONCILE_PROOF_KEYS, 'Reconciliation proof');

    const verifierId = requireId(raw.verifierId, 'verifierId');
    if ([this.actorId, this.parentActorId, state.invocation.providerId].filter(Boolean).includes(verifierId)) {
      throw new Error('Reconciliation verifier must be independent from the actor, parent controller, and effect provider');
    }
    if (requireId(raw.verificationAuthorityId, 'verificationAuthorityId') !== state.invocation.policyDecisionId) {
      throw new Error('Reconciliation verification authority must bind the admitted policy envelope');
    }
    if (requireId(raw.effectId, 'proof.effectId') !== state.effectId
      || requireId(raw.executionId, 'proof.executionId') !== state.executionId
      || requireAttempt(raw.attempt) !== state.attempt) {
      throw new Error('Reconciliation proof does not match the current exact-effect attempt');
    }

    const observation = normalizeObservationV1(raw.observation);
    let verification = normalizeVerificationV1(raw.verification);
    if (observation.invocationId !== state.invocation.invocationId
      || verification.invocationId !== state.invocation.invocationId
      || verification.observationId !== observation.observationId) {
      throw new Error('Reconciliation evidence does not match the effect invocation and observation');
    }
    for (const [label, actual, expected] of [
      ['verifierId', verification.verifierId, verifierId],
      ['verificationAuthorityId', verification.verificationAuthorityId, state.invocation.policyDecisionId],
      ['effectId', verification.effectId, state.effectId],
      ['executionId', verification.executionId, state.executionId],
      ['attempt', verification.attempt, state.attempt],
    ]) {
      if (actual && actual !== expected) throw new Error(`Reconciliation verification ${label} binding is mismatched`);
    }

    const ambiguityAt = timestampMs(state.ambiguity.declaredAt, 'ambiguity.declaredAt');
    const observedAt = timestampMs(observation.observedAt, 'observation.observedAt');
    const verifiedAt = timestampMs(verification.verifiedAt, 'verification.verifiedAt');
    const earliestFreshAt = Math.max(ambiguityAt, requestedAt - this.maxReconciliationEvidenceAgeMs);
    if (observedAt < earliestFreshAt || verifiedAt < observedAt
      || observedAt > requestedAt + MAX_CLOCK_SKEW_MS || verifiedAt > requestedAt + MAX_CLOCK_SKEW_MS) {
      throw new Error('Reconciliation evidence is stale or has an invalid chronology');
    }

    if (outcome === ReconciliationOutcome.SAFE_RETRY) {
      if (observation.data?.committed !== false
        || verification.status !== VerificationStatus.FAILED
        || verification.reasonCode !== 'NO_COMMITTED_EFFECT') {
        throw new Error('SAFE_RETRY requires fresh independent proof of no committed effect');
      }
    } else if (![VerificationStatus.VERIFIED, VerificationStatus.NOT_APPLICABLE].includes(verification.status)) {
      throw new Error('VERIFIED reconciliation requires fresh independent verified evidence');
    }
    verification = normalizeVerificationV1({
      ...verification,
      verifierId,
      verificationAuthorityId: state.invocation.policyDecisionId,
      effectId: state.effectId,
      executionId: state.executionId,
      attempt: state.attempt,
    });
    return { observation, verification };
  }

  async #save(state) {
    const normalized = normalizeExactEffectStateV1(state);
    await this.store.save(normalized.effectId, normalized);
    return normalized;
  }

  async #load(invocation) {
    const invocationId = requireId(invocation?.invocationId, 'invocationId');
    const stored = await this.store.load(invocationId);
    if (stored) return normalizeExactEffectStateV1(stored);
    return this.#save(createExactEffectStateV1(invocation, { createdAt: invocation.createdAt }));
  }

  async invoke({ invocation, policyDecision } = {}) {
    if (invocation?.toolId !== WindowsToolId.EXEC_PINNED) {
      throw new Error('WindowsExactEffectExecutorV1 accepts only effectful process.execPinned invocations');
    }

    // Admission must fail closed before PREPARED/EXECUTING is persisted.  The provider
    // owns the canonical ToolDescriptor/capability/policy binding and this preflight
    // performs no Native Companion dispatch.
    const authorized = this.provider.authorize({ invocation, policyDecision });
    invocation = authorized.invocation;
    policyDecision = authorized.policyDecision;

    let state = await this.#load(invocation);
    if (![ExactEffectPhase.PREPARED, ExactEffectPhase.SAFE_RETRY].includes(state.phase)) {
      const error = new Error(state.phase === ExactEffectPhase.RECONCILE
        ? 'Windows effect requires reconciliation before retry'
        : `Windows effect cannot execute from ${state.phase}`);
      error.code = state.phase === ExactEffectPhase.RECONCILE ? 'WINDOWS_RECONCILE_REQUIRED' : 'WINDOWS_EFFECT_NOT_EXECUTABLE';
      error.effectState = state;
      throw error;
    }

    const startedAt = at(this.now);
    const begin = reduceExactEffectV1(state, {
      schemaVersion: 1,
      eventId: eventId(state.effectId, `begin-${state.attempt + 1}`),
      type: ExactEffectEventType.BEGIN_EXECUTION,
      effectId: state.effectId,
      at: startedAt,
    });
    state = await this.#save(begin.state); // durable EXECUTING before external dispatch

    try {
      const providerResult = await this.provider.invoke({ invocation, policyDecision });
      const observedAt = at(this.now);
      const observed = reduceExactEffectV1(state, {
        schemaVersion: 1,
        eventId: eventId(state.effectId, `observe-${state.attempt}`),
        type: ExactEffectEventType.RECORD_OBSERVATION,
        effectId: state.effectId,
        executionId: state.executionId,
        at: observedAt,
        observation: observationFor(state.effectId, providerResult.result, observedAt),
      });
      state = await this.#save(observed.state);

      let verification = normalizeVerificationV1(await this.verify({
        invocation: structuredClone(state.invocation),
        effectId: state.effectId,
        executionId: state.executionId,
        attempt: state.attempt,
        policyDecisionId: state.invocation.policyDecisionId,
        observation: structuredClone(state.observation),
      }));
      for (const [label, actual, expected] of [
        ['effectId', verification.effectId, state.effectId],
        ['executionId', verification.executionId, state.executionId],
        ['attempt', verification.attempt, state.attempt],
      ]) {
        if (actual && actual !== expected) throw new Error(`Windows verification ${label} binding is mismatched`);
      }
      verification = normalizeVerificationV1({
        ...verification,
        effectId: state.effectId,
        executionId: state.executionId,
        attempt: state.attempt,
      });
      const verified = reduceExactEffectV1(state, {
        schemaVersion: 1,
        eventId: eventId(state.effectId, `verify-${state.attempt}`),
        type: ExactEffectEventType.RECORD_VERIFICATION,
        effectId: state.effectId,
        executionId: state.executionId,
        at: at(this.now),
        verification,
      });
      state = await this.#save(verified.state);
      if (state.phase !== ExactEffectPhase.VERIFIED) {
        const error = new Error('Windows effect was not independently verified');
        error.code = state.phase === ExactEffectPhase.RECONCILE ? 'WINDOWS_RECONCILE_REQUIRED' : 'WINDOWS_EFFECT_VERIFICATION_FAILED';
        error.effectState = state;
        throw error;
      }

      const committed = reduceExactEffectV1(state, {
        schemaVersion: 1,
        eventId: eventId(state.effectId, `commit-${state.attempt}`),
        type: ExactEffectEventType.COMMIT,
        effectId: state.effectId,
        at: at(this.now),
        commitId: `${state.effectId}:commit`,
      });
      state = await this.#save(committed.state);
      return Object.freeze({ providerResult, effectState: state });
    } catch (error) {
      if (state.phase !== ExactEffectPhase.EXECUTING && state.phase !== ExactEffectPhase.OBSERVED) throw error;
      const ambiguous = reduceExactEffectV1(state, {
        schemaVersion: 1,
        eventId: eventId(state.effectId, `ambiguous-${state.attempt}`),
        type: ExactEffectEventType.DECLARE_AMBIGUITY,
        effectId: state.effectId,
        executionId: state.executionId,
        at: at(this.now),
        reasonCode: 'WINDOWS_DISPATCH_UNCERTAIN',
        summary: 'Windows process dispatch did not reach a verified committed outcome; reconciliation is required before retry.',
      });
      state = await this.#save(ambiguous.state);
      error.effectState = state;
      error.safeToRetry = false;
      error.reconcileRequired = true;
      throw error;
    }
  }

  async reconcile(request = {}) {
    exactKeys(request, RECONCILE_REQUEST_KEYS, 'Windows reconciliation request');
    const { invocationId, outcome, reasonCode, summary = '' } = request;
    const id = requireId(invocationId, 'invocationId');
    const stored = await this.store.load(id);
    if (!stored) throw new Error('Exact-effect state was not found');
    let state = normalizeExactEffectStateV1(stored);
    if (state.phase !== ExactEffectPhase.RECONCILE) throw new Error('Windows effect is not awaiting reconciliation');
    const normalizedOutcome = String(outcome || '').trim().toUpperCase();
    if (!Object.values(ReconciliationOutcome).includes(normalizedOutcome)) throw new Error('Reconciliation outcome is invalid');
    const reconciliationAt = this.now();
    const evidence = normalizedOutcome === ReconciliationOutcome.MANUAL_REVIEW
      ? { observation: undefined, verification: undefined }
      : await this.#obtainReconciliationProof(state, normalizedOutcome, reconciliationAt);
    const resolved = reduceExactEffectV1(state, {
      schemaVersion: 1,
      eventId: eventId(state.effectId, `reconcile-${state.attempt}`),
      type: ExactEffectEventType.RESOLVE_RECONCILIATION,
      effectId: state.effectId,
      executionId: state.executionId,
      at: new Date(reconciliationAt).toISOString(),
      outcome: normalizedOutcome,
      observation: evidence.observation,
      verification: evidence.verification,
      reasonCode: requireId(reasonCode, 'reasonCode'),
      summary,
    });
    state = await this.#save(resolved.state);
    return state;
  }
}
