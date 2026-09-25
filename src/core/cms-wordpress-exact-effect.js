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
import { CMS_WORDPRESS_PROVIDER_ID, CmsWordPressToolId } from './cms-wordpress-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const RECONCILE_REQUEST_KEYS = new Set(['invocationId', 'outcome', 'reasonCode', 'summary']);
const RECONCILE_PROOF_KEYS = new Set([
  'verifierId', 'verificationAuthorityId', 'effectId', 'executionId', 'attempt',
  'observation', 'verification',
]);
const DEFAULT_MAX_RECONCILIATION_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

function requireId(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable data property`);
    }
  }
  for (const key of allowed) {
    if (key in value && !Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} contains inherited field: ${key}`);
    }
  }
}

function requireAttempt(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error('Reconciliation proof attempt is invalid');
  }
  return value;
}

function requireReconciliationOutcome(value) {
  if (typeof value !== 'string') throw new Error('Reconciliation outcome must be text');
  const outcome = value.trim().toUpperCase();
  if (!Object.values(ReconciliationOutcome).includes(outcome)) throw new Error('Reconciliation outcome is invalid');
  return outcome;
}

function timestampMs(value, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return ms;
}

function at(now) { return new Date(now()).toISOString(); }
function eventId(invocationId, suffix) { return `${invocationId}:${suffix}`; }

function assertStore(store) {
  if (!store || typeof store.update !== 'function') {
    throw new Error('Canonical atomic durable exact-effect store is required');
  }
}

function assertProvider(provider) {
  if (!provider || typeof provider.invoke !== 'function' || typeof provider.authorize !== 'function') {
    throw new Error('WordPress provider with side-effect-free authorization preflight is required');
  }
}

function observationFor(invocationId, result, observedAt) {
  return {
    schemaVersion: 1,
    observationId: `${invocationId}:observation`,
    invocationId,
    status: 'OK',
    summary: 'WordPress Native Companion returned a bounded mutation result.',
    data: structuredClone(result),
    artifactRefs: [],
    observedAt,
  };
}

/**
 * WordPress-specific transport binding over the one canonical UniversalExactEffectV1
 * reducer and the caller-supplied canonical durable store. This module intentionally
 * owns no scheduler, persistence implementation, retry ledger, recovery engine, or
 * policy authority; it only binds the effectful WordPress tool to those authorities.
 */
export class CmsWordPressExactEffectExecutorV1 {
  constructor({
    provider,
    store,
    verify,
    reconcileVerify = null,
    actorId = 'cms-wordpress-exact-effect-executor',
    parentActorId = null,
    maxReconciliationEvidenceAgeMs = DEFAULT_MAX_RECONCILIATION_EVIDENCE_AGE_MS,
    now = () => Date.now(),
  } = {}) {
    assertProvider(provider);
    assertStore(store);
    if (typeof verify !== 'function') throw new Error('Independent WordPress effect verifier is required');
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

  async #atomic(mutator) {
    let result;
    await this.store.update(draft => {
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
        throw new Error('Canonical exact-effect store root is invalid');
      }
      if (draft.effectsById == null) draft.effectsById = {};
      if (!draft.effectsById || typeof draft.effectsById !== 'object' || Array.isArray(draft.effectsById)) {
        throw new Error('Canonical exact-effect store effectsById is invalid');
      }
      result = mutator(draft.effectsById);
      return draft;
    });
    return result;
  }

  async #save(state) {
    const normalized = normalizeExactEffectStateV1(state);
    return this.#atomic(effectsById => {
      const prior = effectsById[normalized.effectId];
      effectsById[normalized.effectId] = {
        ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}),
        state: normalized,
      };
      return normalized;
    });
  }

  async #loadById(invocationId) {
    const id = requireId(invocationId, 'invocationId');
    return this.#atomic(effectsById => {
      const stored = effectsById[id]?.state;
      return stored ? normalizeExactEffectStateV1(stored) : null;
    });
  }

  async #admitExecution(invocation) {
    const invocationId = requireId(invocation?.invocationId, 'invocationId');
    return this.#atomic(effectsById => {
      const prior = effectsById[invocationId];
      let state = prior?.state
        ? normalizeExactEffectStateV1(prior.state)
        : createExactEffectStateV1(invocation, { createdAt: invocation.createdAt });

      if (prior?.state && JSON.stringify(state.invocation) !== JSON.stringify(invocation)) {
        throw new Error('WordPress exact-effect invocation binding changed');
      }
      if (state.phase === ExactEffectPhase.VERIFIED) {
        return Object.freeze({ status: 'VERIFIED', state });
      }
      if (![ExactEffectPhase.PREPARED, ExactEffectPhase.SAFE_RETRY].includes(state.phase)) {
        return Object.freeze({ status: 'BLOCKED', state });
      }

      const startedAt = at(this.now);
      const begin = reduceExactEffectV1(state, {
        schemaVersion: 1,
        eventId: eventId(state.effectId, `begin-${state.attempt + 1}`),
        type: ExactEffectEventType.BEGIN_EXECUTION,
        effectId: state.effectId,
        at: startedAt,
      });
      state = begin.state;
      effectsById[invocationId] = {
        ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}),
        state,
      };
      return Object.freeze({ status: 'EXECUTING', state });
    });
  }

  async #commitVerified(state) {
    if (state.phase !== ExactEffectPhase.VERIFIED) throw new Error('Only a verified WordPress effect may be committed');
    const committed = reduceExactEffectV1(state, {
      schemaVersion: 1,
      eventId: eventId(state.effectId, `commit-${state.attempt}`),
      type: ExactEffectEventType.COMMIT,
      effectId: state.effectId,
      at: at(this.now),
      commitId: `${state.effectId}:commit`,
    });
    return this.#save(committed.state);
  }

  #validateInitialVerification(state, raw, requestedAt, completedAt) {
    const verification = normalizeVerificationV1(raw);
    const verifierId = requireId(verification.verifierId, 'verifierId');
    if ([this.actorId, this.parentActorId, state.invocation.providerId].filter(Boolean).includes(verifierId)) {
      throw new Error('WordPress verifier must be independent from the actor, parent controller, and effect provider');
    }
    if (requireId(verification.verificationAuthorityId, 'verificationAuthorityId') !== state.invocation.policyDecisionId) {
      throw new Error('WordPress verification authority must bind the admitted policy envelope');
    }
    if (requireId(verification.effectId, 'verification.effectId') !== state.effectId
      || requireId(verification.executionId, 'verification.executionId') !== state.executionId
      || requireAttempt(verification.attempt) !== state.attempt) {
      throw new Error('WordPress verification does not match the current exact-effect attempt');
    }
    if (verification.invocationId !== state.invocation.invocationId
      || verification.observationId !== state.observation.observationId) {
      throw new Error('WordPress verification does not match the effect invocation and observation');
    }

    const observedAt = timestampMs(state.observation.observedAt, 'observation.observedAt');
    const verifiedAt = timestampMs(verification.verifiedAt, 'verification.verifiedAt');
    const earliestFreshAt = Math.max(observedAt, requestedAt - this.maxReconciliationEvidenceAgeMs);
    if (verifiedAt < earliestFreshAt
      || observedAt > requestedAt + MAX_CLOCK_SKEW_MS
      || verifiedAt > completedAt + MAX_CLOCK_SKEW_MS) {
      throw new Error('WordPress verification evidence is stale or has an invalid chronology');
    }
    return verification;
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

  async invoke({ invocation, policyDecision } = {}) {
    if (invocation?.toolId !== CmsWordPressToolId.CONTENT_DRAFT_CREATE) {
      throw new Error('CmsCmsWordPressExactEffectExecutorV1 accepts only effectful WordPress draft-create invocations');
    }

    // Policy/capability admission is side-effect-free and happens before a fresh
    // PREPARED/EXECUTING transition. A VERIFIED durable state may only need the
    // non-I/O COMMIT bookkeeping step after a crash; no provider dispatch occurs.
    const authorized = this.provider.authorize({ invocation, policyDecision });
    invocation = authorized.invocation;
    policyDecision = authorized.policyDecision;

    const admitted = await this.#admitExecution(invocation);
    let state = admitted.state;
    if (admitted.status === 'VERIFIED') {
      state = await this.#commitVerified(state);
      return Object.freeze({ providerResult: null, effectState: state, resumedCommit: true });
    }
    if (admitted.status !== 'EXECUTING') {
      const error = new Error(state.phase === ExactEffectPhase.RECONCILE
        ? 'WordPress effect requires reconciliation before retry'
        : `WordPress effect cannot execute from ${state.phase}`);
      error.code = state.phase === ExactEffectPhase.RECONCILE ? 'WORDPRESS_RECONCILE_REQUIRED' : 'WORDPRESS_EFFECT_NOT_EXECUTABLE';
      error.effectState = state;
      throw error;
    }

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

      const verificationRequestedAt = this.now();
      const rawVerification = await this.verify({
        invocation: structuredClone(state.invocation),
        effectId: state.effectId,
        executionId: state.executionId,
        attempt: state.attempt,
        policyDecisionId: state.invocation.policyDecisionId,
        observation: structuredClone(state.observation),
        requestedAt: new Date(verificationRequestedAt).toISOString(),
      });
      const verificationCompletedAt = this.now();
      const verification = this.#validateInitialVerification(
        state,
        rawVerification,
        verificationRequestedAt,
        verificationCompletedAt,
      );
      const verified = reduceExactEffectV1(state, {
        schemaVersion: 1,
        eventId: eventId(state.effectId, `verify-${state.attempt}`),
        type: ExactEffectEventType.RECORD_VERIFICATION,
        effectId: state.effectId,
        executionId: state.executionId,
        at: new Date(verificationCompletedAt).toISOString(),
        verification,
      });
      state = await this.#save(verified.state);
      if (state.phase !== ExactEffectPhase.VERIFIED) {
        const error = new Error('WordPress effect was not independently verified');
        error.code = state.phase === ExactEffectPhase.RECONCILE ? 'WORDPRESS_RECONCILE_REQUIRED' : 'WORDPRESS_EFFECT_VERIFICATION_FAILED';
        error.effectState = state;
        throw error;
      }

      state = await this.#commitVerified(state);
      return Object.freeze({ providerResult, effectState: state, resumedCommit: false });
    } catch (error) {
      if (state.phase !== ExactEffectPhase.EXECUTING && state.phase !== ExactEffectPhase.OBSERVED) throw error;
      const ambiguous = reduceExactEffectV1(state, {
        schemaVersion: 1,
        eventId: eventId(state.effectId, `ambiguous-${state.attempt}`),
        type: ExactEffectEventType.DECLARE_AMBIGUITY,
        effectId: state.effectId,
        executionId: state.executionId,
        at: at(this.now),
        reasonCode: 'WORDPRESS_EFFECT_UNCERTAIN',
        summary: 'WordPress mutation did not reach a verified committed outcome; reconciliation is required before retry.',
      });
      state = await this.#save(ambiguous.state);
      error.effectState = state;
      error.safeToRetry = false;
      error.reconcileRequired = true;
      throw error;
    }
  }

  async recoverInterrupted() {
    return this.#atomic(effectsById => {
      const recovered = [];
      for (const [invocationId, entry] of Object.entries(effectsById)) {
        if (!entry?.state) continue;
        let state = normalizeExactEffectStateV1(entry.state);
        if (state.invocation.providerId !== CMS_WORDPRESS_PROVIDER_ID
            || state.invocation.toolId !== CmsWordPressToolId.CONTENT_DRAFT_CREATE
            || ![ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(state.phase)) {
          continue;
        }
        const interrupted = reduceExactEffectV1(state, {
          schemaVersion: 1,
          eventId: eventId(state.effectId, `restart-ambiguity-${state.attempt}`),
          type: ExactEffectEventType.DECLARE_AMBIGUITY,
          effectId: state.effectId,
          executionId: state.executionId,
          at: at(this.now),
          reasonCode: 'WORDPRESS_DISPATCH_INTERRUPTED',
          summary: 'Interrupted WordPress draft creation requires exact-slug reconciliation before any retry.',
        });
        state = interrupted.state;
        entry.state = state;
        recovered.push(Object.freeze({ invocationId, phase: state.phase }));
      }
      return Object.freeze(recovered);
    });
  }

  async reconcile(request = {}) {
    exactKeys(request, RECONCILE_REQUEST_KEYS, 'WordPress reconciliation request');
    const { invocationId, outcome, reasonCode, summary = '' } = request;
    const id = requireId(invocationId, 'invocationId');
    const normalizedOutcome = requireReconciliationOutcome(outcome);
    if (normalizedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('WordPress draft creation never infers SAFE_RETRY after ambiguous dispatch');
    }
    const stored = await this.#loadById(id);
    if (!stored) throw new Error('Exact-effect state was not found');
    let state = stored;

    // A crash may occur after durable reconciliation verification but before the
    // deterministic COMMIT save. Resuming that commit is safe because it performs
    // no WordPress I/O and its canonical event/commit ids are deterministic.
    if (state.phase === ExactEffectPhase.VERIFIED
      && state.reconciliation.outcome === ReconciliationOutcome.VERIFIED
      && normalizedOutcome === ReconciliationOutcome.VERIFIED) {
      return this.#commitVerified(state);
    }
    if (state.phase !== ExactEffectPhase.RECONCILE) throw new Error('WordPress effect is not awaiting reconciliation');

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
    if (state.phase === ExactEffectPhase.VERIFIED) state = await this.#commitVerified(state);
    return state;
  }
}
