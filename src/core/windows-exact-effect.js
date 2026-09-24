import {
  ExactEffectEventType,
  ExactEffectPhase,
  ReconciliationOutcome,
  createExactEffectStateV1,
  normalizeExactEffectStateV1,
  reduceExactEffectV1,
} from './universal-agent-exact-effect.js';
import { WindowsToolId } from './windows-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function requireId(value, label) {
  const out = String(value ?? '').trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
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
  constructor({ provider, store, verify, now = () => Date.now() } = {}) {
    assertProvider(provider);
    assertStore(store);
    if (typeof verify !== 'function') throw new Error('Independent Windows effect verifier is required');
    this.provider = provider;
    this.store = store;
    this.verify = verify;
    this.now = now;
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

      const verification = await this.verify({
        invocation: structuredClone(state.invocation),
        executionId: state.executionId,
        observation: structuredClone(state.observation),
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

  async reconcile({ invocationId, outcome, observation, verification, reasonCode, summary = '' } = {}) {
    const id = requireId(invocationId, 'invocationId');
    const stored = await this.store.load(id);
    if (!stored) throw new Error('Exact-effect state was not found');
    let state = normalizeExactEffectStateV1(stored);
    if (state.phase !== ExactEffectPhase.RECONCILE) throw new Error('Windows effect is not awaiting reconciliation');
    const normalizedOutcome = String(outcome || '').trim().toUpperCase();
    if (!Object.values(ReconciliationOutcome).includes(normalizedOutcome)) throw new Error('Reconciliation outcome is invalid');
    const resolved = reduceExactEffectV1(state, {
      schemaVersion: 1,
      eventId: eventId(state.effectId, `reconcile-${state.attempt}`),
      type: ExactEffectEventType.RESOLVE_RECONCILIATION,
      effectId: state.effectId,
      executionId: state.executionId,
      at: at(this.now),
      outcome: normalizedOutcome,
      observation,
      verification,
      reasonCode: requireId(reasonCode, 'reasonCode'),
      summary,
    });
    state = await this.#save(resolved.state);
    return state;
  }
}
