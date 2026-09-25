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

export function normalizeLocalAiBaseUrl(value, providerType = DEFAULT_LOCAL_AI_SETTINGS.providerType) {
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
  const providerType = PROVIDER_TYPES.has(raw.providerType) ? raw.providerType : DEFAULT_LOCAL_AI_SETTINGS.providerType;
  const timeoutSeconds = Number(raw.timeoutSeconds ?? DEFAULT_LOCAL_AI_SETTINGS.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < MIN_TIMEOUT_SECONDS || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Local AI timeout must be a whole number from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const model = nonEmptyString(raw.model);
  if (model.length > 300) throw new Error('Local AI model name is too long');
  return {
    enabled: raw.enabled === true,
    providerType,
    baseUrl: normalizeLocalAiBaseUrl(raw.baseUrl, providerType),
    model,
    timeoutSeconds,
  };
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

async function readJsonResponse(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('Local AI response is too large');
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
  constructor({ fetchFn = globalThis.fetch } = {}) {
    if (typeof fetchFn !== 'function') throw new Error('Local AI fetch is unavailable');
    this.fetchFn = fetchFn;
  }

  async request(settings, url, init = {}) {
    const normalized = normalizeLocalAiSettings(settings);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), normalized.timeoutSeconds * 1000);
    try {
      return await this.fetchFn(url, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Local AI request timed out after ${normalized.timeoutSeconds} seconds`);
      throw new Error(`Could not reach Local AI server: ${error?.message || 'network error'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(rawSettings) {
    const settings = normalizeLocalAiSettings(rawSettings);
    const response = await this.request(settings, endpointFor(settings, 'models'));
    const body = await readJsonResponse(response);
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

  async complete(rawSettings, prompt, { systemPrompt = '' } = {}) {
    const settings = normalizeLocalAiSettings(rawSettings);
    if (!settings.enabled) throw new Error('Local AI is disabled');
    if (!settings.model) throw new Error('Select a Local AI model first');
    const userPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!userPrompt) throw new Error('Local AI prompt is empty');
    if (userPrompt.length > MAX_PROMPT_LENGTH) throw new Error(`Local AI prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
    const messages = [];
    if (typeof systemPrompt === 'string' && systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
    messages.push({ role: 'user', content: userPrompt });

    const payload = settings.providerType === LocalAiProviderType.OLLAMA
      ? { model: settings.model, messages, stream: false }
      : { model: settings.model, messages, stream: false };
    const response = await this.request(settings, endpointFor(settings, 'chat'), {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const body = await readJsonResponse(response);
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

export { MAX_PROMPT_LENGTH, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS };
