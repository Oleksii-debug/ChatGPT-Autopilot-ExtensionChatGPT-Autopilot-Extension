const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:17621';
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_REQUEST_BYTES = 4_000_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_RESPONSE_CHUNKS = 8_192;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function snapshotDataRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch {
    throw new Error(`${label} must be a plain data object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} cannot contain symbol fields`);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

export function normalizeGatewayUrl(value) {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('AI Gateway URL must be text when supplied');
  }
  if (value !== undefined && !clean(value)) {
    throw new Error('AI Gateway URL cannot be empty when explicitly supplied');
  }
  const parsed = new URL(value === undefined ? DEFAULT_GATEWAY_URL : clean(value));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AI Gateway must use http:// or https://');
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error('AI Gateway must use localhost or 127.0.0.1');
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in the AI Gateway URL');
  if (parsed.search || parsed.hash) throw new Error('AI Gateway URL cannot contain query or fragment');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function gatewayRequestUrl(base, path) {
  if (typeof path !== 'string'
      || !path.startsWith('/')
      || path.startsWith('//')
      || path.includes('\\')
      || path.includes('#')
      || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error('AI Gateway request path must be an exact local API path');
  }
  const admitted = new URL(base);
  const target = new URL(`${base}${path}`);
  if (target.origin !== admitted.origin || target.username || target.password) {
    throw new Error('AI Gateway request URL must remain on the admitted loopback origin');
  }
  return target.toString();
}

function optionalText(value, label) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text when supplied`);
  return value;
}

function invalidRequestBodyError() {
  const error = new Error('AI Gateway request body must be JSON text');
  error.code = 'AI_GATEWAY_INVALID_REQUEST_BODY';
  return error;
}

function requestTooLargeError() {
  const error = new Error('AI Gateway request is too large');
  error.code = 'AI_GATEWAY_REQUEST_TOO_LARGE';
  return error;
}

function responseTooLargeError() {
  const error = new Error('AI Gateway response is too large');
  error.code = 'AI_GATEWAY_RESPONSE_TOO_LARGE';
  return error;
}

function invalidResponseStreamError() {
  const error = new Error('AI Gateway returned an invalid response body stream');
  error.code = 'AI_GATEWAY_INVALID_RESPONSE';
  return error;
}

async function cancelResponse(response, reader, controller) {
  try {
    if (reader?.cancel) await reader.cancel('response byte limit exceeded');
    else if (response?.body?.cancel) await response.body.cancel('response byte limit exceeded');
  } catch (_) {}
  try { controller?.abort(); } catch (_) {}
}

async function readResponseTextBounded(response, controller) {
  const contentLength = clean(response?.headers?.get?.('content-length'));
  if (/^[0-9]+$/u.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await cancelResponse(response, null, controller);
    throw responseTooLargeError();
  }

  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const buffer = new Uint8Array(MAX_RESPONSE_BYTES);
    let bytes = 0;
    let chunks = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          await cancelResponse(response, reader, controller);
          throw invalidResponseStreamError();
        }
        chunks += 1;
        if (chunks > MAX_RESPONSE_CHUNKS) {
          await cancelResponse(response, reader, controller);
          throw invalidResponseStreamError();
        }
        const nextBytes = bytes + value.byteLength;
        if (nextBytes > MAX_RESPONSE_BYTES) {
          await cancelResponse(response, reader, controller);
          throw responseTooLargeError();
        }
        buffer.set(value, bytes);
        bytes = nextBytes;
      }
      return new TextDecoder().decode(buffer.subarray(0, bytes));
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  }

  // Compatibility fallback for deterministic fetch shims. Native browser fetch
  // responses expose a ReadableStream and therefore use the bounded path above.
  const text = typeof response?.text === 'function' ? await response.text() : '';
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    await cancelResponse(response, null, controller);
    throw responseTooLargeError();
  }
  return text;
}

async function parseJson(response, controller) {
  let text;
  try {
    text = await readResponseTextBounded(response, controller);
  } catch (error) {
    // On non-2xx, HTTP status remains the authoritative failure even when
    // an untrusted upstream error stream is oversized or malformed. Never
    // downgrade AUTH/RATE_LIMIT to an untyped response-size error.
    if (response.ok || !['AI_GATEWAY_RESPONSE_TOO_LARGE', 'AI_GATEWAY_INVALID_RESPONSE'].includes(error?.code)) throw error;
    text = '';
  }
  if (!response.ok) {
    // Trust the transport status even when the proxy/server returned HTML or
    // invalid JSON. Never put upstream content, prompts or secrets in errors.
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* HTTP status remains authoritative */ }
    const status = response.status;
    const error = new Error(`AI Gateway error ${status}`);
    error.status = status;
    const sourceCode = body && typeof body === 'object' && !Array.isArray(body)
      ? body.code : null;
    error.code = typeof sourceCode === 'string' && /^AI_[A-Z0-9_]{1,79}$/u.test(sourceCode)
      ? sourceCode : `AI_GATEWAY_HTTP_${status}`;
    error.category = status === 401 || status === 403 ? 'AUTH'
      : status === 429 ? 'RATE_LIMIT'
      : status === 408 || status === 504 ? 'TIMEOUT'
      : status >= 500 ? 'UNAVAILABLE'
      : 'INVALID_REQUEST';
    error.retryable = ['RATE_LIMIT', 'TIMEOUT', 'UNAVAILABLE'].includes(error.category);
    return Promise.reject(error);
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error(`AI Gateway returned invalid JSON (HTTP ${response.status})`); }
}

export class AiGatewayClient {
  constructor({
    fetchFn = globalThis.fetch,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  } = {}) {
    if (typeof fetchFn !== 'function') throw new Error('AI Gateway fetch is unavailable');
    if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
      throw new Error('AI Gateway deadline clock is unavailable');
    }
    this.fetchFn = fetchFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
  }

  async request(gatewayUrl, timeoutSeconds, path, init = {}) {
    // Only existing gateway operations are admissible. This client is not
    // an arbitrary loopback HTTP proxy, credential injector or model authority.
    const allowedDiscoveryPath = /^\/models\?provider=[^&?#]+(?:&endpointId=[^&?#]+)?$/u.test(path);
    const readOnly = path === '/health' || path === '/status' || allowedDiscoveryPath;
    const completion = path === '/complete';
    if (!readOnly && !completion) throw new Error('AI Gateway request path is not an approved model endpoint');
    const safeInit = snapshotDataRecord(init, 'AI Gateway transport options');
    for (const key of Object.keys(safeInit)) {
      if (!['method','body','redirect'].includes(key)) {
        throw new Error('AI Gateway transport option is not permitted');
      }
    }
    if (readOnly && (
      (safeInit.method !== undefined && safeInit.method !== 'GET')
      || safeInit.body !== undefined
    )) throw new Error('AI Gateway read-only endpoint requires GET without a request body');
    if (completion && (safeInit.method !== 'POST' || typeof safeInit.body !== 'string')) {
      throw new Error('AI Gateway completion requires explicit POST JSON');
    }
    if (completion) {
      let payload;
      try { payload = JSON.parse(safeInit.body); } catch { throw invalidRequestBodyError(); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidRequestBodyError();
    }
    const base = normalizeGatewayUrl(gatewayUrl);
    const requestUrl = gatewayRequestUrl(base, path);
    const timeout = timeoutSeconds;
    if (typeof timeout !== 'number'
        || !Number.isInteger(timeout)
        || timeout < MIN_TIMEOUT_SECONDS
        || timeout > MAX_TIMEOUT_SECONDS) {
      throw new Error(`AI Gateway timeout must be ${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS} seconds`);
    }
    if (safeInit.body != null && typeof safeInit.body !== 'string') throw invalidRequestBodyError();
    if (typeof safeInit.body === 'string' && new TextEncoder().encode(safeInit.body).byteLength > MAX_REQUEST_BYTES) {
      throw requestTooLargeError();
    }
    const controller = new AbortController();
    // Only the deadline callback marks timeout. A bounded-body rejection can
    // abort the response separately and must keep its own typed failure.
    let timedOut = false;
    const timer = this.setTimeoutFn(() => {
      timedOut = true;
      controller.abort();
    }, timeout * 1000);
    try {
      const response = await this.fetchFn(requestUrl, {
        ...safeInit,
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(safeInit.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      // Fetch and body readers may ignore AbortSignal, but their late bytes
      // must never be published as a successful model completion.
      if (timedOut) {
        const late = new Error('AI Gateway response arrived after the deadline');
        late.name = 'AbortError';
        throw late;
      }
      const parsed = await parseJson(response, controller);
      if (timedOut) {
        const late = new Error('AI Gateway response body finished after the deadline');
        late.name = 'AbortError';
        throw late;
      }
      return parsed;
    } catch (error) {
      if (timedOut || error?.name === 'AbortError') {
        const timeoutError = new Error(`AI Gateway request timed out after ${timeout} seconds`);
        timeoutError.code = 'AI_GATEWAY_TIMEOUT';
        timeoutError.category = 'TIMEOUT';
        timeoutError.retryable = true;
        throw timeoutError;
      }
      if (error?.code === 'AI_GATEWAY_RESPONSE_TOO_LARGE' || error?.code === 'AI_GATEWAY_INVALID_RESPONSE') throw error;
      if (/^AI Gateway (?:error|returned)/.test(error?.message || '')) throw error;
      const unavailable = new Error('Could not reach AI Gateway');
      unavailable.code = 'AI_GATEWAY_UNAVAILABLE';
      unavailable.category = 'UNAVAILABLE';
      unavailable.retryable = true;
      throw unavailable;
    } finally {
      this.clearTimeoutFn(timer);
    }
  }

  async health(input = {}) {
    const request = snapshotDataRecord(input, 'AI Gateway health request');
    const gatewayUrl = request.gatewayUrl === undefined ? DEFAULT_GATEWAY_URL : request.gatewayUrl;
    const timeoutSeconds = request.timeoutSeconds === undefined ? 30 : request.timeoutSeconds;
    return this.request(gatewayUrl, timeoutSeconds, '/health');
  }

  async status(input = {}) {
    const request = snapshotDataRecord(input, 'AI Gateway status request');
    const gatewayUrl = request.gatewayUrl === undefined ? DEFAULT_GATEWAY_URL : request.gatewayUrl;
    const timeoutSeconds = request.timeoutSeconds === undefined ? 30 : request.timeoutSeconds;
    return this.request(gatewayUrl, timeoutSeconds, '/status');
  }

  async listModels(input = {}) {
    const request = snapshotDataRecord(input, 'AI Gateway model-list request');
    const gatewayUrl = request.gatewayUrl === undefined ? DEFAULT_GATEWAY_URL : request.gatewayUrl;
    const timeoutSeconds = request.timeoutSeconds === undefined ? 30 : request.timeoutSeconds;
    const provider = request.provider;
    const endpointId = optionalText(request.endpointId, 'AI Gateway endpointId');
    const p = encodeURIComponent(clean(provider));
    if (!p) throw new Error('AI provider is required');
    const endpoint = clean(endpointId);
    return this.request(gatewayUrl, timeoutSeconds, `/models?provider=${p}${endpoint ? `&endpointId=${encodeURIComponent(endpoint)}` : ''}`);
  }

  async complete(input = {}) {
    const request = snapshotDataRecord(input, 'AI Gateway completion request');
    const gatewayUrl = request.gatewayUrl === undefined ? DEFAULT_GATEWAY_URL : request.gatewayUrl;
    const timeoutSeconds = request.timeoutSeconds === undefined ? 180 : request.timeoutSeconds;
    const provider = request.provider;
    const model = request.model;
    const endpointId = optionalText(request.endpointId, 'AI Gateway endpointId');
    const prompt = request.prompt;
    const systemPrompt = optionalText(request.systemPrompt, 'AI Gateway systemPrompt');
    const maxOutputTokens = request.maxOutputTokens === undefined ? 0 : request.maxOutputTokens;
    const imageDataUrl = optionalText(request.imageDataUrl, 'AI Gateway imageDataUrl');
    // The budget ceiling is an exact owner-requested integer, never a floating
    // value to round down into a different provider effect or an unsafe integer.
    if (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens)
        || Object.is(maxOutputTokens, -0) || maxOutputTokens < 0) {
      throw new Error('AI Gateway maxOutputTokens must be a non-negative safe integer');
    }
    const normalizedPrompt = clean(prompt);
    if (!normalizedPrompt) throw new Error('AI prompt is empty');
    if (!clean(provider)) throw new Error('AI provider is required');
    if (!clean(model)) throw new Error('AI model is required');
    return this.request(gatewayUrl, timeoutSeconds, '/complete', {
      method: 'POST',
      body: JSON.stringify({
        provider: clean(provider),
        model: clean(model),
        ...(clean(endpointId) ? { endpointId: clean(endpointId) } : {}),
        prompt: normalizedPrompt,
        systemPrompt: clean(systemPrompt),
        ...(maxOutputTokens > 0 ? { maxOutputTokens } : {}),
        ...(clean(imageDataUrl) ? { imageDataUrl: clean(imageDataUrl) } : {}),
      }),
    });
  }

}

export { DEFAULT_GATEWAY_URL, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_RESPONSE_CHUNKS };
