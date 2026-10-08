/**
 * Opt-in SDK client for local authenticated Native Companion API.
 * The client does not implement scheduling, policy, retry or effect recovery.
 * Ambiguous network results MUST be reconciled by canonical job identity.
 */
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
        if (value?.schemaVersion !== 1 || value?.status !== 'RECEIVED'
          || value?.result?.request?.requestId !== request.requestId) {
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
