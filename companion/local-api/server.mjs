/**
 * Optional Native Companion LOCAL HTTP transport for canonical Autopilot control.
 * This server has no own scheduler, state, policy, credential broker or effects.
 * The trusted Companion owner injects real canonical scope/dispatch dependencies.
 * It may also inject its current owner-managed bearer token via tokenProvider.
 * It NEVER starts a listener as a side effect of import.
 */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  executeAutopilotProgrammaticControlV1,
  normalizeAutopilotProgrammaticRequestV1,
} from '../../src/core/autopilot-programmatic-control.js';

const MAX_BODY_BYTES = 65_536;
const OWNER_TOKEN_RESOLVE_TIMEOUT_MS = 2_000;
const AUTH_FAILURE = Object.freeze({ schemaVersion: 1, status: 'DENIED' });
const FAILURE = Object.freeze({ schemaVersion: 1, status: 'UNAVAILABLE' });

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function send(res, code, data) {
  if (res.headersSent) return;
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Connection': 'close',
  });
  res.end(JSON.stringify(data));
}

function reject(res, code = 403) { send(res, code, AUTH_FAILURE); }

// Credential resolution is advisory to HTTP authentication, not a gate allowed
// to stall this Companion indefinitely. A stalled or failed owner resolver
// cannot leave a local socket waiting or use a cached old credential.
async function boundedOwnerToken(provider) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owner token unavailable')), OWNER_TOKEN_RESOLVE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function headerString(raw) {
  return typeof raw === 'string' ? raw : '';
}

function exactToken(input, label) {
  if (typeof input !== 'string' || input.length < 32 || input.length > 512 || /[^\x21-\x7e]/u.test(input)) {
    throw new Error(label + ' must be an explicit high-entropy ASCII secret (32–512 characters)');
  }
  return input;
}

/**
 * Activation must occur in a trusted Native Companion lifecycle:
 *   server.listen(port, '127.0.0.1')
 * Never pass a remote address or pass an untrusted resolver/dispatcher.
 */
export function createAutopilotLocalApiServerV1({ token, tokenProvider, dependencies } = {}) {
  // The trusted Companion may inject an owner-managed current-token resolver.
  // This transport does not create, store, rotate, or authorize credentials.
  // Never silently fall back to a stale static token after a rotation failure.
  if (tokenProvider !== undefined && (typeof tokenProvider !== 'function' || token !== undefined)) {
    throw new Error('Use either a static token or a trusted tokenProvider, never both');
  }
  const staticExpected = tokenProvider === undefined
    ? digest(exactToken(token, 'Local API token')) : null;
  if (!dependencies || typeof dependencies.resolveTrustedScope !== 'function'
    || typeof dependencies.dispatchCanonicalControl !== 'function'
    || typeof dependencies.now !== 'function') {
    throw new Error('Trusted canonical control dependencies must be provided');
  }
  // Transport-only admission fence. Core must still own durable request/effect
  // deduplication and reconciliation across processes and restarts.
  // Keep the transport's overlapping request population strictly bounded.
  const inFlight = new Set();
  const MAX_IN_FLIGHT = 256;
  const server = createServer(async (req, res) => {
    try {
      // Remote peers are rejected even if a caller improperly rebinds the server.
      if (req.socket.remoteAddress !== '127.0.0.1') return reject(res);
      const expectedHost = '127.0.0.1:' + server.address()?.port;
      if (headerString(req.headers.host) !== expectedHost) return reject(res);
      // Cross-origin and browser-driven requests are always denied, including
      // attempts to induce local requests from arbitrary websites.
      if (req.headers.origin !== undefined || req.headers['access-control-request-method'] !== undefined) {
        return reject(res);
      }
      const authorization = headerString(req.headers.authorization);
      const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      // Do not invoke the credential broker on malformed anonymous requests.
      // In particular, remote sites cannot make an Origin-denied request
      // trigger owner credential operations.
      if (candidate.length < 32 || candidate.length > 512 || /[^!-~]/u.test(candidate)) {
        return reject(res, 401);
      }
      const candidateDigest = digest(candidate);
      let activeExpected = staticExpected;
      if (tokenProvider !== undefined) {
        try {
          // Resolve afresh per request; a retired token must not authenticate.
          // Resolver errors or missing/weak tokens fail closed, no last-good
          // credential cache and no sensitive diagnostics sent to the client.
          activeExpected = digest(exactToken(await boundedOwnerToken(tokenProvider), 'Local API token'));
        } catch {
          return reject(res, 401);
        }
      }
      if (!timingSafeEqual(candidateDigest, activeExpected)) return reject(res, 401);
      if (req.method !== 'POST' || req.url !== '/v1/control') {
        return send(res, 404, { schemaVersion: 1, status: 'NOT_FOUND' });
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headerString(req.headers['content-type']))) {
        return send(res, 415, { schemaVersion: 1, status: 'UNSUPPORTED_MEDIA_TYPE' });
      }
      const len = req.headers['content-length'];
      if (len !== undefined && (!/^\d+$/u.test(len) || Number(len) > MAX_BODY_BYTES)) {
        return send(res, 413, { schemaVersion: 1, status: 'TOO_LARGE' });
      }
      let chunks = [], total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) return send(res, 413, { schemaVersion: 1, status: 'TOO_LARGE' });
        chunks.push(chunk);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Reuse the exact Core request schema before touching request identities.
      // A second authenticated SDK/CLI instance must not race the same
      // request into canonical dispatch while its first transport is pending.
      const normalized = normalizeAutopilotProgrammaticRequestV1(parsed);
      const requestKey = JSON.stringify([
        normalized.principalId, normalized.projectId, normalized.requestId,
      ]);
      if (inFlight.has(requestKey)) {
        // This does NOT prove whether the first request had an external effect.
        // The client treats 409 as UNKNOWN and must reconcile with Core.
        return send(res, 409, { schemaVersion: 1, status: 'IN_FLIGHT' });
      }
      if (inFlight.size >= MAX_IN_FLIGHT) {
        return send(res, 503, { schemaVersion: 1, status: 'UNAVAILABLE' });
      }
      inFlight.add(requestKey);
      try {
        // Input carries only request identities, not credentials or policy.
        // Canonical control rechecks trusted scope and downstream authority.
        const result = await executeAutopilotProgrammaticControlV1(normalized, dependencies);
        return send(res, 200, { schemaVersion: 1, status: 'RECEIVED', result });
      } finally {
        inFlight.delete(requestKey);
      }
    } catch {
      // Do not echo payloads, caller credentials, provider errors, or stack traces.
      return send(res, 422, FAILURE);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 1;
  return server;
}

export async function startAutopilotLocalApiLoopbackV1(options, port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local API port');
  const server = createAutopilotLocalApiServerV1(options);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}
