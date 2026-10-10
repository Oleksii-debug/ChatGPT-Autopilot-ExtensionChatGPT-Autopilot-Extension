import { normalizeArtifactRefV1 } from '../../src/core/universal-agent-contracts.js';
import { normalizeAutopilotProgrammaticRequestV1, isAutopilotProgrammaticOperationReadOnly } from '../../src/core/autopilot-programmatic-control.js';

/**
 * Opt-in SDK client for local authenticated Native Companion API.
 * The client does not implement scheduling, policy, retry or effect recovery.
 * Ambiguous network results MUST be reconciled by canonical job identity.
 */
const DISPATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

// The trusted Companion/owner may rotate its bearer between SDK requests.
// The SDK reads the current token per call, never stores an old fallback.
function validLocalApiToken(candidate) {
  return typeof candidate === 'string'
    && candidate.length >= 32 && candidate.length <= 512
    && !/[^\x21-\x7e]/u.test(candidate);
}

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
function snapshotTransportRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed transport record');
  }
  let prototype, descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new Error('Untrusted transport descriptors'); }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Untrusted transport prototype');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => (
    typeof key !== 'string' || !fields.includes(key)
    || descriptors[key].enumerable !== true
    || !Object.hasOwn(descriptors[key], 'value')
  ))) throw new Error('Untrusted transport fields');
  // Capture descriptor data once. A Proxy can advertise safe descriptors
  // but execute a hostile get trap when an original field is read later.
  const snapshot = Object.create(null);
  for (const field of fields) snapshot[field] = descriptors[field].value;
  return Object.freeze(snapshot);
}
function snapshotTransportArtifact(value) {
  return value === null ? null : snapshotTransportRecord(value, ARTIFACT_FIELDS);
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

export function createAutopilotLocalClientV1({ token, tokenProvider, port, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (tokenProvider !== undefined
    && (typeof tokenProvider !== 'function' || token !== undefined)) {
    throw new Error('Use either a trusted token or owner tokenProvider, never both');
  }
  if (tokenProvider === undefined && !validLocalApiToken(token)) {
    throw new Error('A trusted local API token is required');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Valid loopback port required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Invalid bounded timeout');
  }
  if (typeof fetchImpl !== 'function') throw new Error('A fetch transport is required');
  // This instance-local concurrency fence does not replace Core's durable
  // request/effect deduplication or authorize retry after ambiguity.
  const inFlightRequests = new Set();
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
      // Match the server/Core-scoped identity, not a bare caller-chosen ID.
      // Different principals or projects must not block each other.
      const requestKey = JSON.stringify([
        sentRequest.principalId, sentRequest.projectId, sentRequest.requestId,
      ]);
      if (inFlightRequests.has(requestKey)) {
        return Object.freeze({
          schemaVersion: 1, status: 'UNKNOWN_NETWORK_RESULT',
          instruction: 'An identical requestId is already in flight; reconcile canonical job state before retrying.',
        });
      }
      inFlightRequests.add(requestKey);
      let timeoutHandle;
      try {
      // An owner-issued token is a credential read, not a second authorization
      // authority. Resolve it AFTER canonical preflight and BEFORE transmission.
      // A failed, late or invalid resolver never opens a socket, never falls
      // back to a retired secret and never triggers an automatic effect retry.
      let requestToken = token;
      if (tokenProvider !== undefined) {
        let credentialTimer;
        try {
          requestToken = await Promise.race([
            Promise.resolve().then(() => tokenProvider()),
            new Promise((_, reject) => {
              credentialTimer = setTimeout(
                () => reject(new Error('Owner token resolution deadline')),
                Math.min(timeoutMs, 2_000),
              );
            }),
          ]);
        } catch {
          throw new Error('Trusted local API owner token unavailable before transmission');
        } finally {
          clearTimeout(credentialTimer);
        }
        if (!validLocalApiToken(requestToken)) {
          throw new Error('Trusted local API owner token unavailable before transmission');
        }
      }
      // A custom/mock fetch may ignore AbortSignal and return a late RECEIVED.
      // Enforce one wall-clock deadline across transport AND body parsing.
      // Timeout is always ambiguous, not evidence of zero external effects.
      const abortController = new AbortController();
      const deadline = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          reject(new Error('Local API deadline expired'));
        }, timeoutMs);
      });
      let res;
      try {
        res = await Promise.race([fetchImpl('http://127.0.0.1:' + port + '/v1/control', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + requestToken,
            'Content-Type': 'application/json',
          },
          body,
          signal: abortController.signal,
          cache: 'no-store',
          redirect: 'error',
        }), deadline]);
      } catch {
        return Object.freeze({
          schemaVersion: 1, status: 'UNKNOWN_NETWORK_RESULT',
          instruction: 'Reconcile the exact requestId with canonical job state before retrying.',
        });
      }
      // A malformed/custom transport may throw from response.ok/status after
      // the request was already transmitted. These property reads are NOT
      // evidence that no effect occurred; never expose upstream error text.
      let responseOk, responseStatus = null;
      try {
        // The canonical Companion V1 endpoint acknowledges only with HTTP 200.
        // Custom transports may supply an inconsistent { ok: true, status: 401 }
        // alongside a plausible JSON receipt. Treat the entire response as
        // ambiguous, never as a verified Core acknowledgement or retry signal.
        const observedStatus = res?.status;
        responseStatus = Number.isInteger(observedStatus) ? observedStatus : null;
        responseOk = res?.ok === true && responseStatus === 200;
      } catch {
        return Object.freeze({
          schemaVersion: 1, status: 'UNKNOWN_NETWORK_RESULT',
          instruction: 'Reconcile the exact requestId with canonical job state before retrying.',
        });
      }
      if (!responseOk) {
        // HTTP failure is not proof of no external effect. No blind retry.
        return Object.freeze({
          schemaVersion: 1, status: 'UNKNOWN_NETWORK_RESULT',
          httpStatus: responseStatus,
          instruction: 'Reconcile the exact requestId with canonical job state before retrying.',
        });
      }
      try {
        // Validate and return only immutable snapshots, never original Proxies.
        const body = await Promise.race([res.json(), deadline]);
        if (abortController.signal.aborted) throw new Error('Late Local API response');
        const envelope = snapshotTransportRecord(body, RESPONSE_FIELDS);
        const outer = snapshotTransportRecord(envelope.result, RESULT_FIELDS);
        const requestSnapshot = snapshotTransportRecord(outer.request, REQUEST_FIELDS);
        const receiptSnapshot = snapshotTransportRecord(outer.receipt, RECEIPT_FIELDS);
        const value = Object.freeze({
          ...envelope,
          result: Object.freeze({
            ...outer,
            request: Object.freeze({
              ...requestSnapshot,
              payloadArtifactRef: snapshotTransportArtifact(requestSnapshot.payloadArtifactRef),
            }),
            scopeProof: snapshotTransportRecord(outer.scopeProof, SCOPE_FIELDS),
            receipt: Object.freeze({
              ...receiptSnapshot,
              resultArtifactRef: snapshotTransportArtifact(receiptSnapshot.resultArtifactRef),
            }),
          }),
        });
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
          || value?.result?.readOnly !== isAutopilotProgrammaticOperationReadOnly(sentRequest.operation)
          || value?.result?.downstreamAuthorityRequired !== !isAutopilotProgrammaticOperationReadOnly(sentRequest.operation)
          || value?.result?.adapterGrantsAuthority !== false
          || value?.result?.executionAuthorized !== false
          || value?.result?.schedulerAuthority !== false
          || value?.result?.policyDecisionAuthorized !== false
          || value?.result?.exactEffectAuthority !== false
          || value?.result?.storeMutationAuthority !== false) {
          throw new Error('Unbound response');
        }
        if (abortController.signal.aborted) throw new Error('Late Local API receipt');
        return value;
      } catch {
        return Object.freeze({
          schemaVersion: 1, status: 'UNKNOWN_NETWORK_RESULT',
          instruction: 'Reconcile the exact requestId with canonical job state before retrying.',
        });
      }
      } finally {
        clearTimeout(timeoutHandle);
        inFlightRequests.delete(requestKey);
      }
    },
  });
}
