/**
 * Optional Native Companion LOCAL HTTP transport for canonical Autopilot control.
 * This server has no own scheduler, state, policy, credential broker or effects.
 * The trusted Companion owner injects real canonical scope/dispatch dependencies.
 * It NEVER starts a listener as a side effect of import.
 */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { executeAutopilotProgrammaticControlV1 } from '../../src/core/autopilot-programmatic-control.js';

const MAX_BODY_BYTES = 65_536;
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
export function createAutopilotLocalApiServerV1({ token, dependencies } = {}) {
  const expected = digest(exactToken(token, 'Local API token'));
  if (!dependencies || typeof dependencies.resolveTrustedScope !== 'function'
    || typeof dependencies.dispatchCanonicalControl !== 'function'
    || typeof dependencies.now !== 'function') {
    throw new Error('Trusted canonical control dependencies must be provided');
  }
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
      const candidateDigest = digest(candidate);
      if (!timingSafeEqual(candidateDigest, expected)) return reject(res, 401);
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
      // Input carries only request identities, not credentials or policy.
      // Canonical control rechecks a trusted scope and downstream authority.
      const result = await executeAutopilotProgrammaticControlV1(parsed, dependencies);
      return send(res, 200, { schemaVersion: 1, status: 'RECEIVED', result });
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
