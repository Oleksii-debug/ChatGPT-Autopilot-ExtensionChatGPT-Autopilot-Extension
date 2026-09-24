import {
  VerificationStatus,
  assertToolInvocationAuthorizedV1,
  normalizeObservationV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';
import {
  acquireBrowserTargetLeaseV1,
  releaseBrowserTargetLeaseV1,
} from './browser-target-lease.js';
import {
  ExactEffectEventType, ExactEffectPhase, ReconciliationOutcome,
  createExactEffectStateV1, normalizeExactEffectStateV1, reduceExactEffectV1,
} from './universal-agent-exact-effect.js';

const PROVIDER_ID = 'deterministic-web';
const MAX_URL = 4096;
const MAX_SELECTOR = 2000;
const ACTIONS = new Set(['NAVIGATE', 'CLICK', 'FILL']);

function text(value, label, max) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}

function normalizeUrl(value) {
  const raw = text(value, 'url', MAX_URL);
  let url;
  try { url = new URL(raw); } catch { throw new Error('url is invalid'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('url protocol is not allowed');
  if (url.username || url.password) throw new Error('url credentials are not allowed');
  return url.toString();
}

export function normalizeDeterministicWebActionV1(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('web action must be an object');
  const allowed = new Set(['kind', 'url', 'selector', 'value']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`web action contains unknown field: ${key}`);
  const kind = String(input.kind || '').trim().toUpperCase();
  if (!ACTIONS.has(kind)) throw new Error('web action kind is invalid');
  if (kind === 'NAVIGATE') return Object.freeze({ kind, url: normalizeUrl(input.url) });
  const selector = text(input.selector, 'selector', MAX_SELECTOR);
  if (kind === 'CLICK') return Object.freeze({ kind, selector });
  return Object.freeze({ kind, selector, value: text(input.value, 'value', 16_000) });
}

export function verifyDeterministicWebPostconditionV1({ invocationId, observation, expected, now }) {
  const observed = observation.data || {};
  let ok = false;
  let reasonCode = 'POSTCONDITION_FAILED';
  if (expected.url) {
    ok = observed.url === normalizeUrl(expected.url);
    reasonCode = ok ? 'URL_MATCH' : 'URL_MISMATCH';
  } else if (expected.selector) {
    const selector = text(expected.selector, 'expected.selector', MAX_SELECTOR);
    ok = Array.isArray(observed.visibleSelectors) && observed.visibleSelectors.includes(selector);
    reasonCode = ok ? 'SELECTOR_VISIBLE' : 'SELECTOR_NOT_VISIBLE';
  } else {
    throw new Error('independent verifier requires url or selector postcondition');
  }
  return normalizeVerificationV1({
    schemaVersion: 1,
    verificationId: `web-verify-${invocationId}`,
    invocationId,
    observationId: observation.observationId,
    status: ok ? VerificationStatus.VERIFIED : VerificationStatus.FAILED,
    reasonCode,
    summary: ok ? 'Independent browser postcondition verified.' : 'Independent browser postcondition failed.',
    evidenceArtifactIds: observation.artifactRefs.map(ref => ref.artifactId),
    verifiedAt: now,
  });
}

function normalizePostcondition(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('independent verifier requires a postcondition');
  const keys = Object.keys(expected);
  if (keys.length !== 1 || !['url', 'selector'].includes(keys[0])) throw new Error('independent verifier requires exactly one url or selector postcondition');
  return Object.freeze(keys[0] === 'url'
    ? { url: normalizeUrl(expected.url) }
    : { selector: text(expected.selector, 'expected.selector', MAX_SELECTOR) });
}

export function createDeterministicWebProviderV1({ transport, store, reconcileVerify, now = () => new Date().toISOString(), leaseId = () => `web-${Date.now()}` } = {}) {
  if (!transport || typeof transport.execute !== 'function' || typeof transport.observe !== 'function') throw new Error('deterministic web transport is required');
  if (!store || typeof store.update !== 'function') throw new Error('atomic durable exact-effect store is required');
  const event = (state, type, suffix, fields = {}) => {
    const reduced = reduceExactEffectV1(state, {
      schemaVersion: 1, eventId: `${state.effectId}:${suffix}-${state.attempt || 0}`,
      type, effectId: state.effectId, executionId: state.executionId || undefined,
      at: now(), ...fields,
    });
    if (!reduced.accepted || reduced.deduplicated) throw new Error(`web exact-effect transition rejected: ${reduced.reason}`);
    return reduced.state;
  };
  async function atomic(mutator) {
    let result;
    await store.update(draft => {
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('exact-effect store is invalid');
      draft.effectsById ||= {};
      draft.leasesByTargetId ||= {};
      result = mutator(draft);
      return draft;
    });
    return result;
  }
  function release(draft, targetId, invocationId) {
    const lease = draft.leasesByTargetId[targetId];
    if (!lease || lease.ownerInvocationId !== invocationId) throw new Error('web effect target lease ownership changed');
    draft.leasesByTargetId[targetId] = releaseBrowserTargetLeaseV1(lease, {
      ownerInvocationId: invocationId, leaseId: lease.leaseId,
    }).lease;
  }
  return Object.freeze({
    id: PROVIDER_ID,
    async recoverInterrupted() {
      return atomic(draft => {
        const recovered = [];
        for (const [invocationId, entry] of Object.entries(draft.effectsById || {})) {
          if (!entry?.state) continue;
          const state = normalizeExactEffectStateV1(entry.state);
          if (![ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(state.phase)) continue;
          entry.state = event(state, ExactEffectEventType.DECLARE_AMBIGUITY, 'cold-start-ambiguity', {
            reasonCode: 'WEB_DISPATCH_INTERRUPTED',
            summary: 'Interrupted browser dispatch requires independent reconciliation before any retry.',
          });
          recovered.push(Object.freeze({ invocationId, targetId: entry.targetId, phase: entry.state.phase }));
        }
        return Object.freeze(recovered);
      });
    },
    async invoke({ invocation, policyDecision, toolDescriptor, grantedCapabilityIds, targetId, action, postcondition }) {
      const authorized = assertToolInvocationAuthorizedV1({ invocation, policyDecision, toolDescriptor, grantedCapabilityIds });
      if (authorized.invocation.providerId !== PROVIDER_ID) throw new Error('invocation provider is not deterministic-web');
      const invocationId = authorized.invocation.invocationId;
      const normalizedAction = normalizeDeterministicWebActionV1(action);
      const expected = normalizePostcondition(postcondition);
      const binding = JSON.stringify({ targetId, action: normalizedAction, postcondition: expected });
      // The lease and canonical EXECUTING state share ONE atomic durable write.
      // A crashed dispatch remains fenced even when its lease timestamp expires.
      const admitted = await atomic(draft => {
        let entry = draft.effectsById[invocationId];
        if (entry && entry.binding !== binding) throw new Error('web invocation binding changed');
        const current = draft.leasesByTargetId[targetId];
        if (entry && [ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(entry.state.phase)) {
          entry.state = event(normalizeExactEffectStateV1(entry.state), ExactEffectEventType.DECLARE_AMBIGUITY, 'restart-ambiguity', {
            reasonCode: 'WEB_DISPATCH_INTERRUPTED', summary: 'Interrupted browser dispatch requires independent reconciliation.',
          });
        }
        if (entry && ![ExactEffectPhase.PREPARED, ExactEffectPhase.SAFE_RETRY].includes(entry.state.phase)) {
          return {
            status: entry.state.phase === ExactEffectPhase.COMMITTED ? 'ALREADY_COMMITTED'
              : entry.state.phase === ExactEffectPhase.MANUAL_REVIEW ? 'MANUAL_REVIEW' : 'RECONCILE_REQUIRED',
            effectState: entry.state,
          };
        }
        if (current) return { status: 'TARGET_CONFLICT', lease: current };
        const state = entry ? normalizeExactEffectStateV1(entry.state)
          : createExactEffectStateV1(authorized.invocation, { createdAt: authorized.invocation.createdAt });
        const acquired = acquireBrowserTargetLeaseV1({ current: null, targetId, ownerInvocationId: invocationId, leaseId: leaseId(), now: now() });
        const executing = event(state, ExactEffectEventType.BEGIN_EXECUTION, 'begin');
        draft.effectsById[invocationId] = { binding, targetId, state: executing };
        draft.leasesByTargetId[targetId] = acquired.lease;
        return { status: 'EXECUTING', lease: acquired.lease, effectState: executing };
      });
      if (admitted.status !== 'EXECUTING') return Object.freeze(admitted);
      try {
        await transport.execute({ targetId, action: normalizedAction, invocationId });
        const raw = await transport.observe({ targetId, invocationId });
        const observation = normalizeObservationV1({
          schemaVersion: 1,
          observationId: `web-observe-${invocationId}`,
          invocationId,
          status: 'OK',
          summary: 'Independent browser observation captured after action.',
          data: raw?.data || {},
          artifactRefs: raw?.artifactRefs || [],
          observedAt: now(),
        });
        await atomic(draft => {
          const entry = draft.effectsById[invocationId];
          entry.state = event(normalizeExactEffectStateV1(entry.state), ExactEffectEventType.RECORD_OBSERVATION, 'observe', { observation });
        });
        const verification = verifyDeterministicWebPostconditionV1({ invocationId, observation, expected, now: now() });
        if (verification.status !== VerificationStatus.VERIFIED) {
          const effectState = await atomic(draft => {
            const entry = draft.effectsById[invocationId];
            const state = event(normalizeExactEffectStateV1(entry.state), ExactEffectEventType.DECLARE_AMBIGUITY, 'postcondition-ambiguity', {
              reasonCode: verification.reasonCode,
              summary: 'The browser action may have occurred, but its postcondition was not independently verified.',
            });
            entry.state = state;
            return state;
          });
          return Object.freeze({
            status: 'AMBIGUOUS',
            reconcileRequired: true,
            lease: admitted.lease,
            observation,
            verification,
            effectState,
            error: 'WEB_POSTCONDITION_UNCERTAIN',
          });
        }
        const effectState = await atomic(draft => {
          const entry = draft.effectsById[invocationId];
          let state = event(normalizeExactEffectStateV1(entry.state), ExactEffectEventType.RECORD_VERIFICATION, 'verify', { verification });
          if (state.phase === ExactEffectPhase.VERIFIED) {
            state = event(state, ExactEffectEventType.COMMIT, 'commit', { commitId: `${invocationId}:commit` });
          }
          entry.state = state;
          release(draft, targetId, invocationId);
          return state;
        });
        return Object.freeze({ status: verification.status, observation, verification, effectState });
      } catch (error) {
        const effectState = await atomic(draft => {
          const entry = draft.effectsById[invocationId];
          let state = normalizeExactEffectStateV1(entry.state);
          if ([ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED].includes(state.phase)) {
            state = event(state, ExactEffectEventType.DECLARE_AMBIGUITY, 'dispatch-ambiguity', {
              reasonCode: 'WEB_DISPATCH_UNCERTAIN', summary: 'Browser action might have occurred; independent reconciliation is required.',
            });
            entry.state = state;
          }
          return state;
        });
        // Transport errors can contain page text, URLs or credentials. The
        // durable state records only a stable code, never provider output.
        return Object.freeze({ status: 'AMBIGUOUS', reconcileRequired: true, lease: admitted.lease, effectState, error: 'WEB_DISPATCH_UNCERTAIN' });
      }
    },
    async reconcile({ invocationId, outcome, reasonCode = 'WEB_RECONCILED' }) {
      const snapshot = await atomic(draft => {
        const entry = draft.effectsById[invocationId];
        if (!entry || entry.state.phase !== ExactEffectPhase.RECONCILE) throw new Error('web effect is not awaiting reconciliation');
        return structuredClone(entry);
      });
      const normalizedOutcome = String(outcome || '').toUpperCase();
      if (!Object.values(ReconciliationOutcome).includes(normalizedOutcome)) throw new Error('reconciliation outcome is invalid');
      let proof = null;
      if (typeof reconcileVerify !== 'function') throw new Error('independent web reconciliation verifier is required');
      let binding;
      try { binding = JSON.parse(snapshot.binding); } catch { throw new Error('web effect binding is invalid'); }
      proof = await reconcileVerify({
        invocation: snapshot.state.invocation,
        executionId: snapshot.state.executionId,
        attempt: snapshot.state.attempt,
        outcome: normalizedOutcome,
        targetId: snapshot.targetId,
        action: structuredClone(binding.action),
        postcondition: structuredClone(binding.postcondition),
        ambiguity: structuredClone(snapshot.state.ambiguity),
      });
      const observation = normalizeObservationV1(proof?.observation);
      const verification = normalizeVerificationV1(proof?.verification);
      const proofAt = Date.parse(now());
      const observedAt = Date.parse(observation.observedAt);
      const verifiedAt = Date.parse(verification.verifiedAt);
      if (proof?.verifierId === PROVIDER_ID || !proof?.verifierId
        || proof?.targetId !== snapshot.targetId
        || verification.verifierId !== proof.verifierId
        || verification.verificationAuthorityId !== snapshot.state.invocation.policyDecisionId
        || verification.effectId !== invocationId
        || verification.executionId !== snapshot.state.executionId
        || verification.attempt !== snapshot.state.attempt
        || observation.invocationId !== invocationId || verification.invocationId !== invocationId
        || verification.observationId !== observation.observationId
        || observedAt < Math.max(Date.parse(snapshot.state.ambiguity.declaredAt), proofAt - 5 * 60_000)
        || observedAt > proofAt + 60_000 || verifiedAt > proofAt + 60_000
        || verifiedAt < observedAt) {
        throw new Error('independent web reconciliation proof is invalid');
      }
      if (normalizedOutcome === ReconciliationOutcome.SAFE_RETRY
        && (observation.data?.committed !== false || verification.status !== VerificationStatus.FAILED
          || verification.reasonCode !== 'NO_COMMITTED_EFFECT')) throw new Error('SAFE_RETRY requires proof of no committed effect');
      if (normalizedOutcome === ReconciliationOutcome.VERIFIED && verification.status !== VerificationStatus.VERIFIED) {
        throw new Error('VERIFIED requires independent verified evidence');
      }
      // Even manual settlement cannot free a browser target while the
      // original dispatch might still be running in another provider.
      if (normalizedOutcome === ReconciliationOutcome.MANUAL_REVIEW && observation.data?.quiescent !== true) {
        throw new Error('MANUAL_REVIEW requires independent proof that the target is quiescent');
      }
      proof = { observation, verification };
      return atomic(draft => {
        const entry = draft.effectsById[invocationId];
        const state = normalizeExactEffectStateV1(entry?.state);
        if (state.phase !== ExactEffectPhase.RECONCILE || state.executionId !== snapshot.state.executionId) throw new Error('web effect changed during reconciliation');
        let next = event(state, ExactEffectEventType.RESOLVE_RECONCILIATION, 'reconcile', {
          outcome: normalizedOutcome, reasonCode,
          observation: proof?.observation, verification: proof?.verification,
        });
        if (next.phase === ExactEffectPhase.VERIFIED) next = event(next, ExactEffectEventType.COMMIT, 'reconcile-commit', { commitId: `${invocationId}:commit` });
        entry.state = next;
        release(draft, entry.targetId, invocationId);
        return next;
      });
    },
  });
}
