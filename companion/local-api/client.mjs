import { normalizeArtifactRefV1 } from '../../src/core/universal-agent-contracts.js';
import { normalizeAutopilotProgrammaticRequestV1 } from '../../src/core/autopilot-programmatic-control.js';

/**
 * Opt-in SDK client for local authenticated Native Companion API.
 * The client does not implement scheduling, policy, retry or effect recovery.
 * Ambiguous network results MUST be reconciled by canonical job identity.
 */
const DISPATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function canonicalUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

const ARTIFACT_FIELDS = Object.freeze([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);

/**
 * A successful transport must not carry undeclared fields, secrets, getters,
 * symbol keys or non-data properties inside payload provenance. Validating
 * only the ten known fields would otherwise accept a forged extra field and
 * pass the unfiltered response to SDK callers as authoritative.
 */
function exactTransportArtifactShape(received) {
  if (!received || typeof received !== 'object' || Array.isArray(received)) return false;
  let prototype, descriptors;
  try {
    prototype = Object.getPrototypeOf(received);
    descriptors = Object.getOwnPropertyDescriptors(received);
  } catch {
    return false;
  }
  if (prototype !== Object.prototype && prototype !== null
    || Reflect.ownKeys(descriptors).length !== ARTIFACT_FIELDS.length) return false;
  return ARTIFACT_FIELDS.every(field => {
    const descriptor = descriptors[field];
    return descriptor?.enumerable === true
      && Object.hasOwn(descriptor, 'value');
  });
}


/**
 * Transport RECEIVED is only a scoped acknowledgement, never permission to
 * run effects. Do not return attacker-defined extension fields in its JSON
 * envelope as if they came from the canonical Core contract. All nested
 * records must have the exact own enumerable data-field shape of Core V1.
 */
const RESPONSE_FIELDS = Object.freeze(['schemaVersion', 'status', 'result']);
const RESULT_FIELDS = Object.freeze([
  'schemaVersion', 'request', 'scopeProof', 'receipt', 'assessedAt', 'dispatchAt',
  'completedAt', 'readOnly', 'downstreamAuthorityRequired',
  'adapterGrantsAuthority', 'executionAuthorized', 'policyDecisionAuthorized',
  'storeMutationAuthority', 'schedulerAuthority', 'exactEffectAuthority',
]);
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'requestId', 'principalId', 'projectId', 'operation',
  'targetId', 'payloadArtifactRef', 'requestedAt',
]);
const SCOPE_FIELDS = Object.freeze([
  'schemaVersion', 'scopeRevisionId', 'requestId', 'principalId', 'projectId',
  'operation', 'targetId', 'payloadArtifactId', 'payloadSha256', 'allowed',
  'verifiedAt', 'validThrough',
]);
const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion', 'requestId', 'projectId', 'operation', 'dispatchId',
  'status', 'resultArtifactRef', 'observedAt',
]);
function exactTransportRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let prototype, descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { return false; }
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === fields.length && keys.every(key => (
    typeof key === 'string' && fields.includes(key)
    && descriptors[key].enumerable === true
    && Object.hasOwn(descriptors[key], 'value')
  ));
}

function matchesArtifact(received, requested) {
  if (requested === null) return received === null;
  if (!requested || !exactTransportArtifactShape(received)) return false;
  return ARTIFACT_FIELDS.every(field =>
    Object.prototype.hasOwnProperty.call(requested, field)
    && Object.is(requested[field], received[field]));
}


/**
 * A transport response can supply a forged result artifact independently of
 * the request artifact. Reuse Core's exact ArtifactRef normalizer; a transport
 * acknowledgement must not be accepted with unknown/malformed provenance.
 */
function matchesResultArtifact(received, observedAt) {
  if (received === null) return true;
  if (!received || !canonicalUtcTimestamp(observedAt)) return false;
  try {
    const canonical = normalizeArtifactRefV1(received);
    return ARTIFACT_FIELDS.every(field =>
      Object.prototype.hasOwnProperty.call(received, field)
      && Object.is(received[field], canonical[field]))
      && Date.parse(canonical.createdAt) <= Date.parse(observedAt);
  } catch {
    return false;
  }
}


/**
 * The transport may be a stale or forged responder. A RECEIVED wrapper must
 * carry the same Core scope proof and causal timestamps as the serialized wire
 * request. This validates evidence; it never grants policy/effect authority.
 */
function validBoundScopeAndChronology(result, sentRequest) {
  const proof = result?.scopeProof;
  const receipt = result?.receipt;
  if (proof?.schemaVersion !== 1
    || typeof proof.scopeRevisionId !== 'string'
    || !DISPATCH_ID.test(proof.scopeRevisionId)
    || proof.allowed !== true
    || proof.requestId !== sentRequest.requestId
    || proof.principalId !== sentRequest.principalId
    || proof.projectId !== sentRequest.projectId
    || proof.operation !== sentRequest.operation
    || proof.targetId !== sentRequest.targetId
    || proof.payloadArtifactId !== (sentRequest.payloadArtifactRef?.artifactId ?? null)
    || proof.payloadSha256 !== (sentRequest.payloadArtifactRef?.sha256 ?? null)) {
    return false;
  }
  const chronology = [
    sentRequest.requestedAt, proof.verifiedAt, result.assessedAt,
    result.dispatchAt, receipt?.observedAt, result.completedAt,
    proof.validThrough,
  ];
  if (!chronology.every(canonicalUtcTimestamp)) return false;
  const [requested, verified, assessed, dispatched, observed, completed, validThrough] =
    chronology.map(value => Date.parse(value));
  return requested <= verified && verified <= assessed
    && assessed <= dispatched && dispatched <= observed
    && observed <= completed && dispatched <= validThrough;
}

export function createAutopilotLocalClientV1({ token, port, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
    throw new Error('A trusted local API token is required');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Valid loopback port required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Invalid bounded timeout');
  }
  if (typeof fetchImpl !== 'function') throw new Error('A fetch transport is required');
  return Object.freeze({
    async control(request) {
      // Canonical Core preflight snapshots own data descriptors before any
      // JSON serialization. No getter, noncanonical date, extra credential
      // field or malformed ArtifactRef may execute or cross the loopback.
      // Validation must complete before a potentially effectful transport.
      const sentRequest = normalizeAutopilotProgrammaticRequestV1(request);
      // JSON request bodies only; no automatic retry of ambiguous mutations.
      const body = JSON.stringify(sentRequest);
      if (Buffer.byteLength(body, 'utf8') > 65_536) throw new Error('Local API request exceeds limit');
      let res;
      try {
        res = await fetchImpl('http://127.0.0.1:' + port + '/v1/control', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store',
          redirect: 'error',
        });
      } catch {
        return Object.freeze({
          schemaVersion: 1, status: 'UNKNOWN_NETWORK_RESULT',
          instruction: 'Reconcile the exact requestId with canonical job state before retrying.',
        });
      }
      if (!res.ok) {
        // An authenticated server may have dispatched the physical operation
        // before receipt validation or a transport failure. HTTP failure is
        // never proof of zero effect; require reconciliation, no blind retry.
        return Object.freeze({
          schemaVersion: 1, status: 'UNKNOWN_NETWORK_RESULT',
          httpStatus: Number.isInteger(res.status) ? res.status : null,
          instruction: 'Reconcile the exact requestId with canonical job state before retrying.',
        });
      }
      try {
        const value = await res.json();
        // Check own field descriptors before touching any nested transport
        // object: hostile accessors must never execute, including when a
        // test transport supplies a non-JSON JavaScript object.
        if (!exactTransportRecord(value, RESPONSE_FIELDS)
          || !exactTransportRecord(value.result, RESULT_FIELDS)
          || !exactTransportRecord(value.result.request, REQUEST_FIELDS)
          || !exactTransportRecord(value.result.scopeProof, SCOPE_FIELDS)
          || !exactTransportRecord(value.result.receipt, RECEIPT_FIELDS)) {
          throw new Error('Untrusted response descriptors');
        }
        const received = value.result.request;
        const receipt = value.result.receipt;
        // Bind the response to the complete canonical request, not a reusable
        // requestId alone. A transport receipt is not proof of an external effect.
        if (value.schemaVersion !== 1 || value.status !== 'RECEIVED'
          || received?.schemaVersion !== 1
          || received?.requestId !== sentRequest.requestId
          || received?.principalId !== sentRequest.principalId
          || received?.projectId !== sentRequest.projectId
          || received?.operation !== sentRequest.operation
          || received?.targetId !== sentRequest.targetId
          || received?.requestedAt !== sentRequest.requestedAt
          || !matchesArtifact(received?.payloadArtifactRef, sentRequest.payloadArtifactRef)
          || !matchesResultArtifact(receipt?.resultArtifactRef, receipt?.observedAt)
          || !validBoundScopeAndChronology(value?.result, sentRequest)
          || receipt?.schemaVersion !== 1
          || receipt?.requestId !== sentRequest.requestId
          || receipt?.projectId !== sentRequest.projectId
          || receipt?.operation !== sentRequest.operation
          || !['ACCEPTED', 'COMPLETED', 'REJECTED'].includes(receipt?.status)
          || typeof receipt?.dispatchId !== 'string'
          || !DISPATCH_ID.test(receipt.dispatchId)
          || !canonicalUtcTimestamp(receipt?.observedAt)
          || !canonicalUtcTimestamp(sentRequest.requestedAt)
          || Date.parse(receipt.observedAt) < Date.parse(sentRequest.requestedAt)
          || value?.result?.adapterGrantsAuthority !== false
          || value?.result?.executionAuthorized !== false
          || value?.result?.schedulerAuthority !== false
          || value?.result?.policyDecisionAuthorized !== false
          || value?.result?.exactEffectAuthority !== false
          || value?.result?.storeMutationAuthority !== false) {
          throw new Error('Unbound response');
        }
        return value;
      } catch {
        return Object.freeze({
          schemaVersion: 1, status: 'UNKNOWN_NETWORK_RESULT',
          instruction: 'Reconcile the exact requestId with canonical job state before retrying.',
        });
      }
    },
  });
}
