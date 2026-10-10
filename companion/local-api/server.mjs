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

/**
 * Node accepts duplicated Authorization and Host fields in raw HTTP/1 headers,
 * but req.headers hides that ambiguity by retaining one value. Reject the
 * entire request before token resolution or canonical Core dispatch: different
 * intermediaries can select different duplicates.
 */
function hasUnambiguousRawHeader(req, name, required = true) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name && ++count > 1) return false;
  }
  return required ? count === 1 : count <= 1;
}

function exactToken(input, label) {
  if (typeof input !== 'string' || input.length < 32 || input.length > 512 || /[^\x21-\x7e]/u.test(input)) {
    throw new Error(label + ' must be an explicit high-entropy ASCII secret (32–512 characters)');
  }
  return input;
}

/**
 * The Companion owner supplies the three canonical Core dependencies exactly
 * once. Pin their callable identities before a listener can accept traffic:
 * a mutable input object or a hostile getter must never hot-swap the scope,
 * dispatcher or trusted clock after authentication. This is NOT a new Core
 * authority, broker, scheduler or effect store.
 */
const CORE_DEPENDENCY_FIELDS = Object.freeze([
  'resolveTrustedScope', 'dispatchCanonicalControl', 'now',
]);
function pinCanonicalCoreDependencies(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Trusted canonical control dependencies must be provided');
  }
  let prototype, descriptors;
  try {
    prototype = Object.getPrototypeOf(input);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new Error('Trusted canonical control dependencies must be plain data');
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== CORE_DEPENDENCY_FIELDS.length) {
    throw new Error('Trusted canonical control dependencies must be exact');
  }
  const pinned = Object.create(null);
  for (const field of CORE_DEPENDENCY_FIELDS) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function') {
      throw new Error('Trusted canonical control dependencies must be callable own data');
    }
    pinned[field] = descriptor.value;
  }
  return Object.freeze(pinned);
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
  const trustedDependencies = pinCanonicalCoreDependencies(dependencies);
  // An owner can rotate a bearer while canonical scope resolution is pending.
  // Recheck immediately before the effect-capable Core dispatch. This is an
  // authentication fence only; Core remains the single policy/effect authority.
  const revokedBeforeDispatch = Symbol('local-api-owner-token-revoked');
  const disconnectedBeforeDispatch = Symbol('local-api-client-disconnected');
  // Transport-only admission fence. Core must still own durable request/effect
  // deduplication and reconciliation across processes and restarts.
  // Keep the transport's overlapping request population strictly bounded.
  const inFlight = new Set();
  const MAX_IN_FLIGHT = 256;
  // Bound admission *before* token resolution, body streaming and Core calls.
  // The per-identity inFlight fence alone cannot limit distinct IDs or slow
  // authenticated uploads. This transport quota never grants Core authority.
  const MAX_ACTIVE_HTTP_REQUESTS = 64;
  let activeHttpRequests = 0;
  const server = createServer(async (req, res) => {
    if (activeHttpRequests >= MAX_ACTIVE_HTTP_REQUESTS) {
      return send(res, 503, FAILURE);
    }
    activeHttpRequests += 1;
    try {
      // Remote peers are rejected even if a caller improperly rebinds the server.
      if (req.socket.remoteAddress !== '127.0.0.1') return reject(res);
      // HTTP/1 duplicate sensitive headers are ambiguous even if Node exposes
      // a seemingly valid normalized first value.
      if (!hasUnambiguousRawHeader(req, 'host')
        || !hasUnambiguousRawHeader(req, 'authorization', false)
        // Node normally discards duplicate Content-Type/Content-Length values.
        // A valid-looking first header must never hide ambiguous body framing,
        // media type or browser provenance before owner-token resolution.
        || !hasUnambiguousRawHeader(req, 'content-type', false)
        || !hasUnambiguousRawHeader(req, 'content-length', false)
        || !hasUnambiguousRawHeader(req, 'transfer-encoding', false)
        || !hasUnambiguousRawHeader(req, 'origin', false)
        || !hasUnambiguousRawHeader(req, 'access-control-request-method', false)) return reject(res);
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
      // The owner may revoke a bearer while a slow HTTP body is streaming.
      // Re-read the Companion-owned current credential after parsing and BEFORE
      // canonical scope/dispatch. Do not cache or accept a token retired after
      // the first admission check; no new token authority is introduced.
      if (tokenProvider !== undefined) {
        let currentExpected;
        try {
          currentExpected = digest(exactToken(
            await boundedOwnerToken(tokenProvider), 'Local API token',
          ));
        } catch {
          return reject(res, 401);
        }
        if (!timingSafeEqual(candidateDigest, currentExpected)) return reject(res, 401);
      }
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
        // An HTTP client disappearing during an asynchronous trusted scope
        // check cannot launch a *new* Core operation after disconnect. Once
        // Core dispatch has begun its own durable effect ledger still owns the
        // ambiguous outcome; transport abort is not a cancellation receipt.
        const scopedDependencies = Object.freeze({
          resolveTrustedScope: trustedDependencies.resolveTrustedScope,
          now: trustedDependencies.now,
          async dispatchCanonicalControl(envelope) {
            if (res.destroyed) throw disconnectedBeforeDispatch;
            if (tokenProvider !== undefined) {
              let currentExpected;
              try {
                currentExpected = digest(exactToken(
                  await boundedOwnerToken(tokenProvider), 'Local API token',
                ));
              } catch {
                throw revokedBeforeDispatch;
              }
              if (!timingSafeEqual(candidateDigest, currentExpected)) {
                throw revokedBeforeDispatch;
              }
            }
            // The owner resolver above can await a remote/store lookup while
            // the socket closes. Recheck at the last synchronous dispatch
            // boundary, including static-token callers.
            if (res.destroyed) throw disconnectedBeforeDispatch;
            // Retain the pinned Core function and its original call semantics.
            return trustedDependencies.dispatchCanonicalControl(envelope);
          },
        });
        const result = await executeAutopilotProgrammaticControlV1(normalized, scopedDependencies);
        return send(res, 200, { schemaVersion: 1, status: 'RECEIVED', result });
      } finally {
        inFlight.delete(requestKey);
      }
    } catch (error) {
      // Revocation after async scope lookup is still an authentication denial,
      // never evidence that Core dispatched or that retry is safe.
      if (error === revokedBeforeDispatch) return reject(res, 401);
      // No response can be delivered to a disconnected client; most
      // importantly, this path has *not* entered canonical dispatch.
      if (error === disconnectedBeforeDispatch) return;
      // Do not echo payloads, caller credentials, provider errors, or stack traces.
      return send(res, 422, FAILURE);
    } finally {
      // A malformed body, early denial, network abort or rejected Core action
      // must not permanently consume capacity for subsequent valid requests.
      activeHttpRequests -= 1;
    }
  });
  // Node's default HTTP/1 behavior automatically sends 100 Continue before
  // the request handler can validate Host, Origin, bearer or trusted Core
  // scope. Refuse the pre-body handshake: no unauthenticated intermediary
  // should be invited to upload a body to this control-plane endpoint.
  // checkContinue suppresses Node's default automatic 100 response, and
  // does not emit the normal request event.
  server.on('checkContinue', (_req, res) => reject(res, 417));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 1;
  // This factory intentionally exposes the Node server for Companion lifecycle
  // control. Restrict even that exposed listen() entry point: relying on a
  // remoteAddress check *after* a TCP listener binds 0.0.0.0/:: is not the
  // same as keeping an authenticated local control service off the network.
  // Use the explicit (port, '127.0.0.1', callback) shape; reject ambiguous
  // Node listen overloads instead of guessing their binding semantics.
  const nodeListen = server.listen.bind(server);
  Object.defineProperty(server, 'listen', {
    configurable: false, enumerable: false, writable: false,
    value: (port, host, ...rest) => {
      if (!Number.isInteger(port) || port < 0 || port > 65_535
          || host !== '127.0.0.1') {
        throw new Error('Local API listener requires explicit 127.0.0.1 TCP binding');
      }
      return nodeListen(port, host, ...rest);
    },
  });
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
