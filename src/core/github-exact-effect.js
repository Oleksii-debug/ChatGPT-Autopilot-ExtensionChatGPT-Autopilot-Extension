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
import { GitHubToolId } from './github-agent-provider.js';

const EFFECTFUL_TOOLS = new Set([
  GitHubToolId.BRANCH_CREATE,
  GitHubToolId.FILE_PUT,
  GitHubToolId.FILE_DELETE,
  GitHubToolId.PULL_REQUEST_CREATE,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

function requireId(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function requireStore(store) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new Error('Canonical exact-effect state store adapter is required');
  }
}

function requireProvider(provider) {
  if (!provider || typeof provider.authorize !== 'function' || typeof provider.invoke !== 'function') {
    throw new Error('GitHub provider with side-effect-free authorization preflight is required');
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function event(state, type, suffix, at, fields = {}) {
  const reduced = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: `${state.effectId}:${suffix}-${state.attempt || 0}`,
    type,
    effectId: state.effectId,
    executionId: state.executionId || undefined,
    at,
    ...fields,
  });
  if (!reduced.accepted || reduced.deduplicated) {
    throw new Error(`GitHub exact-effect transition rejected: ${reduced.reason}`);
  }
  return reduced.state;
}

function observationFor(invocationId, result, observedAt) {
  return normalizeObservationV1({
    schemaVersion: 1,
    observationId: `${invocationId}:observation`,
    invocationId,
    status: 'OK',
    summary: 'GitHub provider returned a bounded mutation result.',
    data: structuredClone(result ?? {}),
    artifactRefs: [],
    observedAt,
  });
}

function ms(value, label) {
  const out = Date.parse(value);
  if (!Number.isFinite(out)) throw new Error(`${label} must be a timestamp`);
  return out;
}

export class GitHubExactEffectExecutorV1 {
  constructor({
    provider,
    store,
    verify,
    reconcileVerify = null,
    actorId = 'github-exact-effect-executor',
    parentActorId = null,
    maxReconciliationEvidenceAgeMs = MAX_EVIDENCE_AGE_MS,
    now = () => Date.now(),
  } = {}) {
    requireProvider(provider);
    requireStore(store);
    if (typeof verify !== 'function') throw new Error('Independent GitHub effect verifier is required');
    if (!Number.isInteger(maxReconciliationEvidenceAgeMs) || maxReconciliationEvidenceAgeMs < 1) {
      throw new Error('maxReconciliationEvidenceAgeMs is invalid');
    }
    this.provider = provider;
    this.store = store;
    this.verify = verify;
    this.reconcileVerify = reconcileVerify;
    this.actorId = requireId(actorId, 'actorId');
    this.parentActorId = parentActorId == null ? null : requireId(parentActorId, 'parentActorId');
    this.maxReconciliationEvidenceAgeMs = maxReconciliationEvidenceAgeMs;
    this.now = now;
  }

  #at() { return new Date(this.now()).toISOString(); }

  async #save(state) {
    const normalized = normalizeExactEffectStateV1(state);
    await this.store.save(normalized.effectId, normalized);
    return normalized;
  }

  async #loadAuthorized(invocation) {
    const invocationId = requireId(invocation?.invocationId, 'invocationId');
    const stored = await this.store.load(invocationId);
    if (!stored) return this.#save(createExactEffectStateV1(invocation, { createdAt: invocation.createdAt }));
    const state = normalizeExactEffectStateV1(stored);
    if (canonical(state.invocation) !== canonical(invocation)) {
      throw new Error('GitHub exact-effect invocation binding changed');
    }
    return state;
  }

  async #moveInterruptedToReconcile(state) {
    if (![ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(state.phase)) return state;
    const next = event(state, ExactEffectEventType.DECLARE_AMBIGUITY, 'restart-ambiguity', this.#at(), {
      reasonCode: 'GITHUB_DISPATCH_INTERRUPTED',
      summary: 'Interrupted GitHub mutation requires independent reconciliation before any retry.',
    });
    return this.#save(next);
  }

  async invoke({ invocation, policyDecision } = {}) {
    if (!EFFECTFUL_TOOLS.has(invocation?.toolId)) {
      throw new Error('GitHubExactEffectExecutorV1 accepts only effectful GitHub tools');
    }

    const authorized = this.provider.authorize({ invocation, policyDecision });
    invocation = authorized.invocation;
    policyDecision = authorized.policyDecision;

    let state = await this.#loadAuthorized(invocation);
    state = await this.#moveInterruptedToReconcile(state);
    if (![ExactEffectPhase.PREPARED, ExactEffectPhase.SAFE_RETRY].includes(state.phase)) {
      const error = new Error(state.phase === ExactEffectPhase.RECONCILE
        ? 'GitHub effect requires reconciliation before retry'
        : `GitHub effect cannot execute from ${state.phase}`);
      error.code = state.phase === ExactEffectPhase.RECONCILE ? 'GITHUB_RECONCILE_REQUIRED' : 'GITHUB_EFFECT_NOT_EXECUTABLE';
      error.effectState = state;
      error.safeToRetry = false;
      throw error;
    }

    state = await this.#save(event(state, ExactEffectEventType.BEGIN_EXECUTION, 'begin', this.#at()));

    try {
      const providerResult = await this.provider.invoke({ invocation, policyDecision });
      const observedAt = this.#at();
      state = await this.#save(event(state, ExactEffectEventType.RECORD_OBSERVATION, 'observe', observedAt, {
        observation: observationFor(state.effectId, providerResult.result, observedAt),
      }));

      const verification = normalizeVerificationV1(await this.verify({
        invocation: structuredClone(state.invocation),
        effectId: state.effectId,
        executionId: state.executionId,
        attempt: state.attempt,
        observation: structuredClone(state.observation),
      }));
      state = await this.#save(event(state, ExactEffectEventType.RECORD_VERIFICATION, 'verify', this.#at(), { verification }));
      if (state.phase !== ExactEffectPhase.VERIFIED) {
        const error = new Error('GitHub effect was not independently verified');
        error.code = state.phase === ExactEffectPhase.RECONCILE ? 'GITHUB_RECONCILE_REQUIRED' : 'GITHUB_EFFECT_VERIFICATION_FAILED';
        error.effectState = state;
        error.safeToRetry = false;
        throw error;
      }

      state = await this.#save(event(state, ExactEffectEventType.COMMIT, 'commit', this.#at(), {
        commitId: `${state.effectId}:commit`,
      }));
      return Object.freeze({ providerResult, effectState: state });
    } catch (error) {
      if ([ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(state.phase)) {
        state = await this.#save(event(state, ExactEffectEventType.DECLARE_AMBIGUITY, 'dispatch-ambiguity', this.#at(), {
          reasonCode: 'GITHUB_DISPATCH_UNCERTAIN',
          summary: 'GitHub mutation did not reach a verified committed outcome; reconciliation is required before retry.',
        }));
      }
      error.effectState = state;
      error.safeToRetry = false;
      error.reconcileRequired = state.phase === ExactEffectPhase.RECONCILE;
      throw error;
    }
  }

  async reconcile({ invocationId, outcome, reasonCode = 'GITHUB_RECONCILED', summary = '' } = {}) {
    const id = requireId(invocationId, 'invocationId');
    const stored = await this.store.load(id);
    if (!stored) throw new Error('Exact-effect state was not found');
    let state = normalizeExactEffectStateV1(stored);
    state = await this.#moveInterruptedToReconcile(state);
    if (state.phase !== ExactEffectPhase.RECONCILE) throw new Error('GitHub effect is not awaiting reconciliation');

    const normalizedOutcome = String(outcome || '').trim().toUpperCase();
    if (!Object.values(ReconciliationOutcome).includes(normalizedOutcome)) throw new Error('Reconciliation outcome is invalid');

    let observation;
    let verification;
    if (normalizedOutcome !== ReconciliationOutcome.MANUAL_REVIEW) {
      if (typeof this.reconcileVerify !== 'function') {
        throw new Error(`${normalizedOutcome} requires the canonical independent GitHub reconciliation verifier`);
      }
      const requestedAtMs = this.now();
      const proof = await this.reconcileVerify(Object.freeze({
        invocation: structuredClone(state.invocation),
        effectId: state.effectId,
        executionId: state.executionId,
        attempt: state.attempt,
        policyDecisionId: state.invocation.policyDecisionId,
        ambiguityDeclaredAt: state.ambiguity.declaredAt,
        requestedAt: new Date(requestedAtMs).toISOString(),
        expectedOutcome: normalizedOutcome,
      }));
      const verifierId = requireId(proof?.verifierId, 'verifierId');
      if ([this.actorId, this.parentActorId, state.invocation.providerId].filter(Boolean).includes(verifierId)) {
        throw new Error('Reconciliation verifier must be independent from the actor, parent controller, and GitHub provider');
      }
      if (requireId(proof?.verificationAuthorityId, 'verificationAuthorityId') !== state.invocation.policyDecisionId
        || requireId(proof?.effectId, 'proof.effectId') !== state.effectId
        || requireId(proof?.executionId, 'proof.executionId') !== state.executionId
        || Number(proof?.attempt) !== state.attempt) {
        throw new Error('GitHub reconciliation proof does not match the current exact-effect attempt');
      }
      observation = normalizeObservationV1(proof.observation);
      verification = normalizeVerificationV1(proof.verification);
      if (observation.invocationId !== state.effectId
        || verification.invocationId !== state.effectId
        || verification.observationId !== observation.observationId
        || verification.verifierId !== verifierId
        || verification.verificationAuthorityId !== state.invocation.policyDecisionId
        || verification.effectId !== state.effectId
        || verification.executionId !== state.executionId
        || verification.attempt !== state.attempt) {
        throw new Error('GitHub reconciliation evidence binding is invalid');
      }
      const ambiguityAt = ms(state.ambiguity.declaredAt, 'ambiguity.declaredAt');
      const observedAt = ms(observation.observedAt, 'observation.observedAt');
      const verifiedAt = ms(verification.verifiedAt, 'verification.verifiedAt');
      const earliest = Math.max(ambiguityAt, requestedAtMs - this.maxReconciliationEvidenceAgeMs);
      if (observedAt < earliest || verifiedAt < observedAt
        || observedAt > requestedAtMs + MAX_CLOCK_SKEW_MS || verifiedAt > requestedAtMs + MAX_CLOCK_SKEW_MS) {
        throw new Error('GitHub reconciliation evidence is stale or has invalid chronology');
      }
      if (normalizedOutcome === ReconciliationOutcome.SAFE_RETRY) {
        if (observation.data?.committed !== false
          || verification.status !== VerificationStatus.FAILED
          || verification.reasonCode !== 'NO_COMMITTED_EFFECT') {
          throw new Error('SAFE_RETRY requires fresh independent proof of no committed GitHub effect');
        }
      } else if (![VerificationStatus.VERIFIED, VerificationStatus.NOT_APPLICABLE].includes(verification.status)) {
        throw new Error('VERIFIED reconciliation requires fresh independently verified GitHub evidence');
      }
    }

    state = await this.#save(event(state, ExactEffectEventType.RESOLVE_RECONCILIATION, 'reconcile', this.#at(), {
      outcome: normalizedOutcome,
      reasonCode: requireId(reasonCode, 'reasonCode'),
      summary,
      observation,
      verification,
    }));
    if (state.phase === ExactEffectPhase.VERIFIED) {
      state = await this.#save(event(state, ExactEffectEventType.COMMIT, 'reconcile-commit', this.#at(), {
        commitId: `${state.effectId}:commit`,
      }));
    }
    return state;
  }
}
