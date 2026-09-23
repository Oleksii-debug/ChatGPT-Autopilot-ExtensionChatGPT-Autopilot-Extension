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
  url.username = '';
  url.password = '';
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

function verifyPostcondition({ invocationId, observation, expected, now }) {
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

export function createDeterministicWebProviderV1({ transport, readLease = () => null, writeLease = () => {}, now = () => new Date().toISOString(), leaseId = () => `web-${Date.now()}` } = {}) {
  if (!transport || typeof transport.execute !== 'function' || typeof transport.observe !== 'function') throw new Error('deterministic web transport is required');
  return Object.freeze({
    id: PROVIDER_ID,
    async invoke({ invocation, policyDecision, toolDescriptor, grantedCapabilityIds, targetId, action, postcondition }) {
      const authorized = assertToolInvocationAuthorizedV1({ invocation, policyDecision, toolDescriptor, grantedCapabilityIds });
      if (authorized.invocation.providerId !== PROVIDER_ID) throw new Error('invocation provider is not deterministic-web');
      const invocationId = authorized.invocation.invocationId;
      const current = await readLease(targetId);
      const acquired = acquireBrowserTargetLeaseV1({ current, targetId, ownerInvocationId: invocationId, leaseId: leaseId(), now: now() });
      if (acquired.status === 'CONFLICT') return Object.freeze({ status: 'TARGET_CONFLICT', lease: acquired.lease });
      await writeLease(targetId, acquired.lease);
      const normalizedAction = normalizeDeterministicWebActionV1(action);
      let effectObserved = false;
      try {
        await transport.execute({ targetId, action: normalizedAction, invocationId });
        effectObserved = true;
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
        const verification = verifyPostcondition({ invocationId, observation, expected: postcondition || {}, now: now() });
        return Object.freeze({ status: verification.status, observation, verification });
      } catch (error) {
        if (effectObserved) return Object.freeze({ status: 'AMBIGUOUS', reconcileRequired: true, error: String(error?.message || error) });
        throw error;
      } finally {
        const released = releaseBrowserTargetLeaseV1(acquired.lease, { ownerInvocationId: invocationId, leaseId: acquired.lease.leaseId });
        await writeLease(targetId, released.lease);
      }
    },
  });
}
