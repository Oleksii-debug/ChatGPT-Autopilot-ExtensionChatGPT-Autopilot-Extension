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
  const parsed = new URL(clean(value) || DEFAULT_GATEWAY_URL);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AI Gateway must use http:// or https://');
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error('AI Gateway must use localhost or 127.0.0.1');
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in the AI Gateway URL');
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
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
  const text = await readResponseTextBounded(response, controller);
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`AI Gateway returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) {
    const detail = clean(body?.error?.message) || clean(body?.error) || clean(body?.message);
    const error = new Error(detail ? `AI Gateway error ${response.status}: ${detail}` : `AI Gateway error ${response.status}`);
    error.status = response.status;
    if (clean(body?.code)) error.code = clean(body.code);
    throw error;
  }
  return body;
}

export class AiGatewayClient {
  constructor({ fetchFn = globalThis.fetch } = {}) {
    if (typeof fetchFn !== 'function') throw new Error('AI Gateway fetch is unavailable');
    this.fetchFn = fetchFn;
  }

  async request(gatewayUrl, timeoutSeconds, path, init = {}) {
    const base = normalizeGatewayUrl(gatewayUrl);
    const timeout = timeoutSeconds;
    if (typeof timeout !== 'number'
        || !Number.isInteger(timeout)
        || timeout < MIN_TIMEOUT_SECONDS
        || timeout > MAX_TIMEOUT_SECONDS) {
      throw new Error(`AI Gateway timeout must be ${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS} seconds`);
    }
    if (init.body != null && typeof init.body !== 'string') throw invalidRequestBodyError();
    if (typeof init.body === 'string' && new TextEncoder().encode(init.body).byteLength > MAX_REQUEST_BYTES) {
      throw requestTooLargeError();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await this.fetchFn(`${base}${path}`, {
        ...init,
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
      });
      return await parseJson(response, controller);
    } catch (error) {
      if (error?.code === 'AI_GATEWAY_RESPONSE_TOO_LARGE' || error?.code === 'AI_GATEWAY_INVALID_RESPONSE') throw error;
      if (error?.name === 'AbortError') throw new Error(`AI Gateway request timed out after ${timeout} seconds`);
      if (/^AI Gateway (?:error|returned)/.test(error?.message || '')) throw error;
      throw new Error(`Could not reach AI Gateway: ${error?.message || 'network error'}`);
    } finally {
      clearTimeout(timer);
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
    if (request.maxOutputTokens !== undefined
        && (typeof maxOutputTokens !== 'number' || !Number.isFinite(maxOutputTokens))) {
      throw new Error('AI Gateway maxOutputTokens must be a number');
    }
    if (maxOutputTokens < 0 || (maxOutputTokens > 0 && maxOutputTokens < 1)) {
      throw new Error('AI Gateway maxOutputTokens must be 0 or at least 1');
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
        ...(maxOutputTokens > 0 ? { maxOutputTokens: Math.floor(maxOutputTokens) } : {}),
        ...(clean(imageDataUrl) ? { imageDataUrl: clean(imageDataUrl) } : {}),
      }),
    });
  }

}

export { DEFAULT_GATEWAY_URL, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_RESPONSE_CHUNKS };
