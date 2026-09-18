const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:17621';
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_RESPONSE_BYTES = 4_000_000;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeGatewayUrl(value) {
  const parsed = new URL(clean(value) || DEFAULT_GATEWAY_URL);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('AI Gateway must use http:// or https://');
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error('AI Gateway must use localhost or 127.0.0.1');
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in the AI Gateway URL');
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

async function parseJson(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('AI Gateway response is too large');
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`AI Gateway returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) {
    const detail = clean(body?.error?.message) || clean(body?.error) || clean(body?.message);
    throw new Error(detail ? `AI Gateway error ${response.status}: ${detail}` : `AI Gateway error ${response.status}`);
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
    const timeout = Number(timeoutSeconds);
    if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_SECONDS || timeout > MAX_TIMEOUT_SECONDS) {
      throw new Error(`AI Gateway timeout must be ${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS} seconds`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const response = await this.fetchFn(`${base}${path}`, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
      });
      return await parseJson(response);
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`AI Gateway request timed out after ${timeout} seconds`);
      if (/^AI Gateway (?:error|returned)/.test(error?.message || '')) throw error;
      throw new Error(`Could not reach AI Gateway: ${error?.message || 'network error'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async health({ gatewayUrl = DEFAULT_GATEWAY_URL, timeoutSeconds = 30 } = {}) {
    return this.request(gatewayUrl, timeoutSeconds, '/health');
  }

  async status({ gatewayUrl = DEFAULT_GATEWAY_URL, timeoutSeconds = 30 } = {}) {
    return this.request(gatewayUrl, timeoutSeconds, '/status');
  }

  async listModels({ gatewayUrl = DEFAULT_GATEWAY_URL, timeoutSeconds = 30, provider }) {
    const p = encodeURIComponent(clean(provider));
    if (!p) throw new Error('AI provider is required');
    return this.request(gatewayUrl, timeoutSeconds, `/models?provider=${p}`);
  }

  async complete({ gatewayUrl = DEFAULT_GATEWAY_URL, timeoutSeconds = 180, provider, model, prompt, systemPrompt = '', maxOutputTokens = 0, imageDataUrl = '' }) {
    const normalizedPrompt = clean(prompt);
    if (!normalizedPrompt) throw new Error('AI prompt is empty');
    if (!clean(provider)) throw new Error('AI provider is required');
    if (!clean(model)) throw new Error('AI model is required');
    return this.request(gatewayUrl, timeoutSeconds, '/complete', {
      method: 'POST',
      body: JSON.stringify({ provider: clean(provider), model: clean(model), prompt: normalizedPrompt, systemPrompt: clean(systemPrompt), ...(Number(maxOutputTokens) > 0 ? { maxOutputTokens: Math.floor(Number(maxOutputTokens)) } : {}), ...(clean(imageDataUrl) ? { imageDataUrl: clean(imageDataUrl) } : {}) }),
    });
  }
}

export { DEFAULT_GATEWAY_URL, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS };
