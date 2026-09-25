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
  GitHubToolId.PULL_REQUEST_MERGE,
  GitHubToolId.PULL_REQUEST_COMMENT_CREATE,
  GitHubToolId.ISSUE_CREATE,
  GitHubToolId.ISSUE_COMMENT_CREATE,
  GitHubToolId.WORKFLOW_DISPATCH,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const RECONCILE_REQUEST_KEYS = new Set(['invocationId', 'outcome', 'reasonCode', 'summary']);
const RECONCILE_PROOF_KEYS = new Set([
  'verifierId', 'verificationAuthorityId', 'effectId', 'executionId', 'attempt',
  'observation', 'verification',
]);

function requireId(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const out = value.trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function exactDataKeys(value, allowed, label) {
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

function requireStore(store) {
  if (!store || typeof store.update !== 'function') {
    throw new Error('Canonical atomic durable exact-effect store is required');
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

  #assertInitialVerificationBinding(state, verification, requestedAtMs, completedAtMs) {
    const verifierId = requireId(verification.verifierId, 'verification.verifierId');
    if ([this.actorId, this.parentActorId, state.invocation.providerId].filter(Boolean).includes(verifierId)) {
      throw new Error('Initial GitHub verifier must be independent from the actor, parent controller, and GitHub provider');
    }
    if (requireId(verification.verificationAuthorityId, 'verification.verificationAuthorityId') !== state.invocation.policyDecisionId
      || requireId(verification.effectId, 'verification.effectId') !== state.effectId
      || requireId(verification.executionId, 'verification.executionId') !== state.executionId
      || typeof verification.attempt !== 'number'
      || !Number.isSafeInteger(verification.attempt)
      || verification.attempt !== state.attempt
      || verification.invocationId !== state.effectId
      || verification.observationId !== state.observation?.observationId) {
      throw new Error('Initial GitHub verification does not match the current exact-effect attempt');
    }

    const observedAt = ms(state.observation.observedAt, 'observation.observedAt');
    const verifiedAt = ms(verification.verifiedAt, 'verification.verifiedAt');
    const earliestObservation = requestedAtMs - MAX_EVIDENCE_AGE_MS;
    if (observedAt < earliestObservation
      || observedAt > requestedAtMs + MAX_CLOCK_SKEW_MS
      || verifiedAt < observedAt
      || verifiedAt < requestedAtMs - MAX_CLOCK_SKEW_MS
      || verifiedAt > completedAtMs + MAX_CLOCK_SKEW_MS) {
      throw new Error('Initial GitHub verification evidence is stale or has invalid chronology');
    }
    return verification;
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

  async #advance(expectedState, expectedPhases, type, suffix, at, fields = {}) {
    const expected = normalizeExactEffectStateV1(expectedState);
    const phases = new Set(expectedPhases);
    return this.#atomic(effectsById => {
      const entry = effectsById[expected.effectId];
      if (!entry?.state) return Object.freeze({ applied: false, state: null, reason: 'MISSING_EFFECT' });
      const current = normalizeExactEffectStateV1(entry.state);
      if (current.executionId !== expected.executionId
        || current.attempt !== expected.attempt
        || canonical(current.invocation) !== canonical(expected.invocation)) {
        return Object.freeze({ applied: false, state: current, reason: 'EXECUTION_CHANGED' });
      }
      if (!phases.has(current.phase)) {
        return Object.freeze({ applied: false, state: current, reason: 'PHASE_CHANGED' });
      }
      const next = event(current, type, suffix, at, fields);
      entry.state = next;
      return Object.freeze({ applied: true, state: next, reason: 'APPLIED' });
    });
  }

  async #declareAmbiguity(state, suffix, reasonCode, summary) {
    const advanced = await this.#advance(
      state,
      [ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED],
      ExactEffectEventType.DECLARE_AMBIGUITY,
      suffix,
      this.#at(),
      { reasonCode, summary },
    );
    return advanced.state || normalizeExactEffectStateV1(state);
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

      if (prior?.state && canonical(state.invocation) !== canonical(invocation)) {
        throw new Error('GitHub exact-effect invocation binding changed');
      }
      if (state.phase === ExactEffectPhase.VERIFIED) {
        return Object.freeze({ status: 'VERIFIED', state });
      }
      if (![ExactEffectPhase.PREPARED, ExactEffectPhase.SAFE_RETRY].includes(state.phase)) {
        return Object.freeze({ status: 'BLOCKED', state });
      }

      state = event(state, ExactEffectEventType.BEGIN_EXECUTION, 'begin', this.#at());
      effectsById[invocationId] = {
        ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}),
        state,
      };
      return Object.freeze({ status: 'EXECUTING', state });
    });
  }

  async #commitVerified(state) {
    if (state.phase !== ExactEffectPhase.VERIFIED) throw new Error('Only a verified GitHub effect may be committed');
    const advanced = await this.#advance(
      state,
      [ExactEffectPhase.VERIFIED],
      ExactEffectEventType.COMMIT,
      'commit',
      this.#at(),
      { commitId: `${state.effectId}:commit` },
    );
    if (advanced.applied) return advanced.state;
    if (advanced.state?.phase === ExactEffectPhase.COMMITTED
      && advanced.state.executionId === state.executionId
      && advanced.state.attempt === state.attempt) {
      return advanced.state;
    }
    const error = new Error('GitHub exact-effect commit was fenced by a newer durable transition');
    error.code = 'GITHUB_EXECUTION_FENCED';
    error.effectState = advanced.state;
    error.safeToRetry = false;
    throw error;
  }

  async invoke({ invocation, policyDecision } = {}) {
    if (!EFFECTFUL_TOOLS.has(invocation?.toolId)) {
      throw new Error('GitHubExactEffectExecutorV1 accepts only effectful GitHub tools');
    }

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
        ? 'GitHub effect requires reconciliation before retry'
        : `GitHub effect cannot execute from ${state.phase}`);
      error.code = state.phase === ExactEffectPhase.RECONCILE ? 'GITHUB_RECONCILE_REQUIRED' : 'GITHUB_EFFECT_NOT_EXECUTABLE';
      error.effectState = state;
      error.safeToRetry = false;
      throw error;
    }

    try {
      const providerResult = await this.provider.invoke({ invocation, policyDecision });
      const observedAt = this.#at();
      const observationAdvance = await this.#advance(
        state,
        [ExactEffectPhase.EXECUTING],
        ExactEffectEventType.RECORD_OBSERVATION,
        'observe',
        observedAt,
        { observation: observationFor(state.effectId, providerResult.result, observedAt) },
      );
      state = observationAdvance.state || state;
      if (!observationAdvance.applied) {
        const error = new Error('GitHub provider completion was fenced by a newer durable exact-effect transition');
        error.code = 'GITHUB_EXECUTION_FENCED';
        error.effectState = state;
        error.safeToRetry = false;
        error.reconcileRequired = state.phase === ExactEffectPhase.RECONCILE;
        throw error;
      }

      const verificationRequestedAtMs = this.now();
      const verification = normalizeVerificationV1(await this.verify({
        invocation: structuredClone(state.invocation),
        effectId: state.effectId,
        executionId: state.executionId,
        attempt: state.attempt,
        policyDecisionId: state.invocation.policyDecisionId,
        observation: structuredClone(state.observation),
        requestedAt: new Date(verificationRequestedAtMs).toISOString(),
      }));
      const verificationCompletedAtMs = this.now();
      this.#assertInitialVerificationBinding(
        state,
        verification,
        verificationRequestedAtMs,
        verificationCompletedAtMs,
      );
      const verificationAdvance = await this.#advance(
        state,
        [ExactEffectPhase.OBSERVED],
        ExactEffectEventType.RECORD_VERIFICATION,
        'verify',
        this.#at(),
        { verification },
      );
      state = verificationAdvance.state || state;
      if (!verificationAdvance.applied) {
        const error = new Error('GitHub verification completion was fenced by a newer durable exact-effect transition');
        error.code = 'GITHUB_EXECUTION_FENCED';
        error.effectState = state;
        error.safeToRetry = false;
        error.reconcileRequired = state.phase === ExactEffectPhase.RECONCILE;
        throw error;
      }
      if (state.phase !== ExactEffectPhase.VERIFIED) {
        const error = new Error('GitHub effect was not independently verified');
        error.code = state.phase === ExactEffectPhase.RECONCILE ? 'GITHUB_RECONCILE_REQUIRED' : 'GITHUB_EFFECT_VERIFICATION_FAILED';
        error.effectState = state;
        error.safeToRetry = false;
        throw error;
      }

      state = await this.#commitVerified(state);
      return Object.freeze({ providerResult, effectState: state, resumedCommit: false });
    } catch (error) {
      if ([ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(state.phase)) {
        state = await this.#declareAmbiguity(
          state,
          'dispatch-ambiguity',
          'GITHUB_DISPATCH_UNCERTAIN',
          'GitHub mutation did not reach a verified committed outcome; reconciliation is required before retry.',
        );
      }
      if (error?.effectState) state = normalizeExactEffectStateV1(error.effectState);
      error.effectState = state;
      error.safeToRetry = false;
      error.reconcileRequired = state.phase === ExactEffectPhase.RECONCILE;
      throw error;
    }
  }

  async recoverInterrupted() {
    return this.#atomic(effectsById => {
      const recovered = [];
      for (const [invocationId, entry] of Object.entries(effectsById)) {
        if (!entry?.state) continue;
        let state = normalizeExactEffectStateV1(entry.state);
        if (state.invocation.providerId !== 'remote/github'
          || ![ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(state.phase)) continue;
        state = event(state, ExactEffectEventType.DECLARE_AMBIGUITY, 'restart-ambiguity', this.#at(), {
          reasonCode: 'GITHUB_DISPATCH_INTERRUPTED',
          summary: 'Interrupted GitHub mutation requires independent reconciliation before any retry.',
        });
        entry.state = state;
        recovered.push(Object.freeze({ invocationId, phase: state.phase }));
      }
      return Object.freeze(recovered);
    });
  }

  async reconcile(request = {}) {
    exactDataKeys(request, RECONCILE_REQUEST_KEYS, 'GitHub reconciliation request');
    const { invocationId, outcome, reasonCode = 'GITHUB_RECONCILED', summary = '' } = request;
    const id = requireId(invocationId, 'invocationId');
    if (typeof summary !== 'string') throw new Error('Reconciliation summary must be text');
    const stored = await this.#loadById(id);
    if (!stored) throw new Error('Exact-effect state was not found');
    let state = stored;
    if (state.phase !== ExactEffectPhase.RECONCILE) throw new Error('GitHub effect is not awaiting reconciliation');

    if (typeof outcome !== 'string') throw new Error('Reconciliation outcome is invalid');
    const normalizedOutcome = outcome.trim().toUpperCase();
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
        priorObservation: state.observation ? structuredClone(state.observation) : null,
        requestedAt: new Date(requestedAtMs).toISOString(),
        expectedOutcome: normalizedOutcome,
      }));
      exactDataKeys(proof, RECONCILE_PROOF_KEYS, 'GitHub reconciliation proof');
      const verifierId = requireId(proof.verifierId, 'verifierId');
      if ([this.actorId, this.parentActorId, state.invocation.providerId].filter(Boolean).includes(verifierId)) {
        throw new Error('Reconciliation verifier must be independent from the actor, parent controller, and GitHub provider');
      }
      if (requireId(proof?.verificationAuthorityId, 'verificationAuthorityId') !== state.invocation.policyDecisionId
        || requireId(proof?.effectId, 'proof.effectId') !== state.effectId
        || requireId(proof?.executionId, 'proof.executionId') !== state.executionId
        || typeof proof?.attempt !== 'number'
        || !Number.isSafeInteger(proof.attempt)
        || proof.attempt !== state.attempt) {
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

    const reconciliationAdvance = await this.#advance(
      state,
      [ExactEffectPhase.RECONCILE],
      ExactEffectEventType.RESOLVE_RECONCILIATION,
      'reconcile',
      this.#at(),
      {
        outcome: normalizedOutcome,
        reasonCode: requireId(reasonCode, 'reasonCode'),
        summary,
        observation,
        verification,
      },
    );
    state = reconciliationAdvance.state || state;
    if (!reconciliationAdvance.applied) {
      if (state.phase === ExactEffectPhase.COMMITTED) return state;
      const error = new Error('GitHub reconciliation was fenced by a newer durable transition');
      error.code = 'GITHUB_RECONCILIATION_FENCED';
      error.effectState = state;
      error.safeToRetry = false;
      throw error;
    }
    if (state.phase === ExactEffectPhase.VERIFIED) {
      state = await this.#commitVerified(state);
    }
    return state;
  }
}
