export const LocalAiProviderType = Object.freeze({
  OLLAMA: 'ollama',
  OPENAI_COMPATIBLE: 'openai-compatible',
});

export const DEFAULT_LOCAL_AI_SETTINGS = Object.freeze({
  enabled: false,
  providerType: LocalAiProviderType.OLLAMA,
  baseUrl: 'http://127.0.0.1:11434',
  model: '',
  timeoutSeconds: 90,
});

const MAX_PROMPT_LENGTH = 200_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 600;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const PROVIDER_TYPES = new Set(Object.values(LocalAiProviderType));

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function snapshotSettingsRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Local AI settings must be a plain data object');
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(raw); } catch {
    throw new Error('Local AI settings must be a plain data object');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Local AI settings must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new Error('Local AI settings cannot contain symbol fields');
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Local AI settings fields must be enumerable own data properties');
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

export function normalizeLocalAiBaseUrl(value, providerType = DEFAULT_LOCAL_AI_SETTINGS.providerType) {
  if (!PROVIDER_TYPES.has(providerType)) {
    throw new Error('Local AI provider type must be ollama or openai-compatible');
  }
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('Local AI server URL must be text when supplied');
  }
  const raw = nonEmptyString(value) || (providerType === LocalAiProviderType.OPENAI_COMPATIBLE
    ? 'http://127.0.0.1:1234/v1'
    : DEFAULT_LOCAL_AI_SETTINGS.baseUrl);
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Local AI server must use http:// or https://');
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error('Local AI server must use localhost or 127.0.0.1');
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in the Local AI server URL');
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeLocalAiSettings(raw = {}) {
  const source = snapshotSettingsRecord(raw);
  const providerType = source.providerType === undefined
    ? DEFAULT_LOCAL_AI_SETTINGS.providerType
    : source.providerType;
  if (!PROVIDER_TYPES.has(providerType)) {
    throw new Error('Local AI provider type must be ollama or openai-compatible');
  }
  if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
    throw new Error('Local AI enabled must be boolean when supplied');
  }
  if (source.baseUrl !== undefined && typeof source.baseUrl !== 'string') {
    throw new Error('Local AI server URL must be text when supplied');
  }
  if (source.model !== undefined && typeof source.model !== 'string') {
    throw new Error('Local AI model must be text when supplied');
  }
  const timeoutSeconds = source.timeoutSeconds ?? DEFAULT_LOCAL_AI_SETTINGS.timeoutSeconds;
  if (typeof timeoutSeconds !== 'number'
      || !Number.isInteger(timeoutSeconds)
      || timeoutSeconds < MIN_TIMEOUT_SECONDS
      || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Local AI timeout must be a whole number from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const model = nonEmptyString(source.model);
  if (model.length > 300) throw new Error('Local AI model name is too long');
  return {
    enabled: source.enabled === true,
    providerType,
    baseUrl: normalizeLocalAiBaseUrl(source.baseUrl, providerType),
    model,
    timeoutSeconds,
  };
}

function snapshotCompletionOptions(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Local AI completion options must be a plain data object');
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(raw); } catch {
    throw new Error('Local AI completion options must be a plain data object');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Local AI completion options must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key !== 'systemPrompt') {
      throw new Error(`Local AI completion options contain unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Local AI completion options fields must be enumerable own data properties');
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function endpointFor(settings, kind) {
  const base = new URL(settings.baseUrl);
  let path = base.pathname.replace(/\/+$/, '');
  if (settings.providerType === LocalAiProviderType.OLLAMA) {
    if (path.endsWith('/api')) path = path.slice(0, -4);
    base.pathname = `${path}/${kind === 'models' ? 'api/tags' : 'api/chat'}`.replace(/\/{2,}/g, '/');
    return base.toString();
  }
  if (!path.endsWith('/v1')) path = `${path}/v1`;
  base.pathname = `${path}/${kind === 'models' ? 'models' : 'chat/completions'}`.replace(/\/{2,}/g, '/');
  return base.toString();
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Best-effort transport cleanup only; the size guard remains authoritative.
  }
}

function declaredResponseBytes(response) {
  const raw = response?.headers?.get?.('content-length');
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

async function readResponseTextBounded(response) {
  const declaredBytes = declaredResponseBytes(response);
  if (declaredBytes != null && declaredBytes > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error('Local AI response is too large');
  }

  const readable = response?.body;
  if (readable && typeof readable.getReader === 'function') {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          try {
            await reader.cancel();
          } catch {
            // Best-effort cleanup; fail closed regardless of cancel outcome.
          }
          throw new Error('Local AI server returned an invalid response stream');
        }
        const chunk = value;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Best-effort cleanup; fail closed regardless of cancel outcome.
          }
          throw new Error('Local AI response is too large');
        }
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // A released/cancelled reader needs no further cleanup.
      }
    }
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('Local AI response is too large');
  }
  return text;
}

async function readJsonResponse(response) {
  const text = await readResponseTextBounded(response);
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Local AI server returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const detail = nonEmptyString(body?.error?.message) || nonEmptyString(body?.error) || nonEmptyString(body?.message);
    throw new Error(detail ? `Local AI server error ${response.status}: ${detail}` : `Local AI server error ${response.status}`);
  }
  return body;
}

function modelNamesFromResponse(settings, body) {
  if (settings.providerType === LocalAiProviderType.OLLAMA) {
    return Array.isArray(body?.models)
      ? body.models.map(item => nonEmptyString(item?.name || item?.model)).filter(Boolean)
      : [];
  }
  return Array.isArray(body?.data)
    ? body.data.map(item => nonEmptyString(item?.id)).filter(Boolean)
    : [];
}

function extractAssistantText(settings, body) {
  if (settings.providerType === LocalAiProviderType.OLLAMA) {
    return nonEmptyString(body?.message?.content) || nonEmptyString(body?.response);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : (part?.type === 'text' ? part?.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

export class LocalAiClient {
  constructor({
    fetchFn = globalThis.fetch,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  } = {}) {
    if (typeof fetchFn !== 'function') throw new Error('Local AI fetch is unavailable');
    if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
      throw new Error('Local AI timer functions are unavailable');
    }
    this.fetchFn = fetchFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
  }

  async request(settings, url, init = {}, consumeResponse = null) {
    const normalized = normalizeLocalAiSettings(settings);
    const controller = new AbortController();
    const timer = this.setTimeoutFn(() => controller.abort(), normalized.timeoutSeconds * 1000);
    let responseReceived = false;
    try {
      const response = await this.fetchFn(url, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
      });
      responseReceived = true;
      return typeof consumeResponse === 'function'
        ? await consumeResponse(response)
        : response;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new Error(`Local AI request timed out after ${normalized.timeoutSeconds} seconds`);
      }
      if (responseReceived) throw error;
      throw new Error(`Could not reach Local AI server: ${error?.message || 'network error'}`);
    } finally {
      this.clearTimeoutFn(timer);
    }
  }

  async listModels(rawSettings) {
    const settings = normalizeLocalAiSettings(rawSettings);
    const body = await this.request(settings, endpointFor(settings, 'models'), {}, readJsonResponse);
    const models = [...new Set(modelNamesFromResponse(settings, body))].sort((a, b) => a.localeCompare(b));
    return {
      ok: true,
      providerType: settings.providerType,
      baseUrl: settings.baseUrl,
      models,
      configuredModel: settings.model,
      configuredModelAvailable: settings.model ? models.includes(settings.model) : null,
    };
  }

  async complete(rawSettings, prompt, rawOptions = {}) {
    const settings = normalizeLocalAiSettings(rawSettings);
    if (!settings.enabled) throw new Error('Local AI is disabled');
    if (!settings.model) throw new Error('Select a Local AI model first');
    const userPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!userPrompt) throw new Error('Local AI prompt is empty');
    if (userPrompt.length > MAX_PROMPT_LENGTH) throw new Error(`Local AI prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
    const options = snapshotCompletionOptions(rawOptions);
    const systemPrompt = options.systemPrompt ?? '';
    if (typeof systemPrompt !== 'string') throw new Error('Local AI system prompt must be text when supplied');
    const normalizedSystemPrompt = systemPrompt.trim();
    if (normalizedSystemPrompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`Local AI system prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
    }
    const messages = [];
    if (normalizedSystemPrompt) messages.push({ role: 'system', content: normalizedSystemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const payload = settings.providerType === LocalAiProviderType.OLLAMA
      ? { model: settings.model, messages, stream: false, think: false }
      : { model: settings.model, messages, stream: false };
    const body = await this.request(settings, endpointFor(settings, 'chat'), {
      method: 'POST',
      body: JSON.stringify(payload),
    }, readJsonResponse);
    const text = extractAssistantText(settings, body);
    if (!text) throw new Error('Local AI server returned no assistant text');
    return {
      ok: true,
      providerType: settings.providerType,
      model: settings.model,
      text,
    };
  }
}

export { MAX_PROMPT_LENGTH, MAX_RESPONSE_BYTES, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS };
