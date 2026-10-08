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

function matchesArtifact(received, requested) {
  if (requested === null) return received === null;
  if (!requested || !received || typeof received !== 'object') return false;
  return ARTIFACT_FIELDS.every(field =>
    Object.prototype.hasOwnProperty.call(requested, field)
    && Object.prototype.hasOwnProperty.call(received, field)
    && Object.is(requested[field], received[field]));
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
      // JSON request bodies only; no automatic retry of ambiguous mutations.
      const body = JSON.stringify(request);
      // Bind response identities to the bytes sent on the wire. The caller
      // may mutate their original object while fetch is in flight.
      const sentRequest = JSON.parse(body);
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
        const received = value?.result?.request;
        const receipt = value?.result?.receipt;
        // Bind the response to the complete canonical request, not a reusable
        // requestId alone. A transport receipt is not proof of an external effect.
        if (value?.schemaVersion !== 1 || value?.status !== 'RECEIVED'
          || received?.schemaVersion !== 1
          || received?.requestId !== sentRequest.requestId
          || received?.principalId !== sentRequest.principalId
          || received?.projectId !== sentRequest.projectId
          || received?.operation !== sentRequest.operation
          || received?.targetId !== sentRequest.targetId
          || received?.requestedAt !== sentRequest.requestedAt
          || !matchesArtifact(received?.payloadArtifactRef, sentRequest.payloadArtifactRef)
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
