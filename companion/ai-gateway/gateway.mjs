import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL, pathToFileURL, fileURLToPath } from 'node:url';

const GATEWAY_VERSION = '0.7.0';
const HOST = '127.0.0.1';
const PORT = Number(process.env.AUTOPILOT_AI_GATEWAY_PORT || 17621);
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const COMPATIBLE_BASE_URL = normalizeCompatibleBaseUrl(process.env.COMPATIBLE_BASE_URL || 'http://127.0.0.1:1234/v1');
const MAX_BODY_BYTES = 4_000_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = Math.min(900_000, Math.max(5_000, Number(process.env.AUTOPILOT_UPSTREAM_TIMEOUT_MS || 180_000)));
const STATUS_PROBE_TIMEOUT_MS = Math.min(15_000, Math.max(1_000, Number(process.env.AUTOPILOT_STATUS_TIMEOUT_MS || 3_000)));
const DEFAULT_MAX_PENDING_INFERENCE = Math.min(256, Math.max(1, Number(process.env.AUTOPILOT_AI_MAX_PENDING || 32)));
const PROVIDERS = new Set(['ollama', 'openai', 'openai-compatible']);
const GATEWAY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PID_DIR = path.join(GATEWAY_DIR, 'runtime-state');
const PID_FILE = path.join(PID_DIR, 'gateway.pid');
const CONFIG_DIR = path.join(GATEWAY_DIR, 'config');
const EXTENSION_PAIRING_FILE = path.join(CONFIG_DIR, 'extension-origin.json');
const PAIRING_WINDOW_FILE = path.join(CONFIG_DIR, 'pairing-window.json');
const DEFAULT_PAIRING_WINDOW_MS = 5 * 60_000;

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }

function isLoopbackHostname(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(clean(hostname).toLowerCase());
}

export function normalizeCompatibleBaseUrl(value) {
  const raw = clean(value);
  if (!raw) throw gatewayError('OpenAI-compatible base URL is required', 400, 'INVALID_COMPATIBLE_BASE_URL');
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { throw gatewayError('OpenAI-compatible base URL is not a valid absolute URL', 400, 'INVALID_COMPATIBLE_BASE_URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw gatewayError('OpenAI-compatible base URL must use http:// or https://', 400, 'INVALID_COMPATIBLE_BASE_URL');
  }
  if (parsed.username || parsed.password) {
    throw gatewayError('OpenAI-compatible base URL must not contain embedded credentials', 400, 'INVALID_COMPATIBLE_BASE_URL');
  }
  if (parsed.search || parsed.hash) {
    throw gatewayError('OpenAI-compatible base URL must not contain a query string or fragment', 400, 'INVALID_COMPATIBLE_BASE_URL');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw gatewayError('Remote OpenAI-compatible API endpoints must use HTTPS; plain HTTP is allowed only for localhost/loopback', 400, 'INSECURE_COMPATIBLE_BASE_URL');
  }
  return raw.replace(/\/+$/, '');
}

function gatewayError(message, statusCode = 400, code = '') {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

export function createInferenceQueue({ maxPending = DEFAULT_MAX_PENDING_INFERENCE } = {}) {
  const limit = Math.min(256, Math.max(1, Number(maxPending) || DEFAULT_MAX_PENDING_INFERENCE));
  const pending = [];
  let active = false;

  const snapshot = () => ({
    active: active ? 1 : 0,
    pending: pending.length,
    maxPending: limit,
  });

  const drain = () => {
    if (active || pending.length === 0) return;
    const item = pending.shift();
    active = true;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        active = false;
        queueMicrotask(drain);
      });
  };

  const run = task => {
    if (typeof task !== 'function') return Promise.reject(gatewayError('Inference queue task must be a function'));
    if (active && pending.length >= limit) {
      return Promise.reject(gatewayError(
        `AI inference queue is full (${limit} pending request${limit === 1 ? '' : 's'})`,
        429,
        'AI_INFERENCE_QUEUE_FULL',
      ));
    }
    return new Promise((resolve, reject) => {
      pending.push({ task, resolve, reject });
      drain();
    });
  };

  return { run, snapshot };
}


export function normalizeExtensionOrigin(value) {
  const raw = clean(value).toLowerCase();
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(raw);
  return match ? `chrome-extension://${match[1]}` : '';
}

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { exists: true, value: JSON.parse(text) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: null };
    return { exists: true, value: null, error };
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

export function createExtensionPairingStore({ configDir = CONFIG_DIR, now = () => Date.now() } = {}) {
  const pairingFile = path.join(configDir, path.basename(EXTENSION_PAIRING_FILE));
  const windowFile = path.join(configDir, path.basename(PAIRING_WINDOW_FILE));

  const readPairing = () => {
    const result = readJsonFile(pairingFile);
    if (!result.exists) return { pairedOrigin: '', corrupt: false };
    const pairedOrigin = normalizeExtensionOrigin(result.value?.origin);
    if (!pairedOrigin) return { pairedOrigin: '', corrupt: true };
    return { pairedOrigin, corrupt: false };
  };

  const readWindow = () => {
    const result = readJsonFile(windowFile);
    if (!result.exists || !result.value) return { open: false, expiresAtUnixMs: 0 };
    const expiresAtUnixMs = Number(result.value?.expiresAtUnixMs || 0);
    if (!Number.isFinite(expiresAtUnixMs) || expiresAtUnixMs <= now()) return { open: false, expiresAtUnixMs: 0 };
    return { open: true, expiresAtUnixMs };
  };

  const snapshot = () => {
    const pairing = readPairing();
    const window = readWindow();
    return {
      paired: Boolean(pairing.pairedOrigin) && !pairing.corrupt,
      pairingStateValid: !pairing.corrupt,
      pairingWindowOpen: window.open,
      pairingWindowExpiresAtUnixMs: window.open ? window.expiresAtUnixMs : 0,
    };
  };

  const openWindow = ({ durationMs = DEFAULT_PAIRING_WINDOW_MS } = {}) => {
    const duration = Math.min(30 * 60_000, Math.max(30_000, Number(durationMs) || DEFAULT_PAIRING_WINDOW_MS));
    const pairing = readPairing();
    if (pairing.corrupt) throw gatewayError('Extension pairing state is invalid; reset pairing before opening a new window', 500, 'GATEWAY_PAIRING_STATE_INVALID');
    if (pairing.pairedOrigin) throw gatewayError('Gateway is already paired; reset pairing before pairing a different extension', 409, 'GATEWAY_ALREADY_PAIRED');
    const expiresAtUnixMs = now() + duration;
    writeJsonAtomic(windowFile, { openedAtUnixMs: now(), expiresAtUnixMs });
    return { pairingWindowOpen: true, expiresAtUnixMs };
  };

  const reset = () => {
    for (const file of [pairingFile, windowFile]) {
      try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  };

  const authorize = (originValue, { allowPair = true } = {}) => {
    const raw = clean(originValue);
    if (!raw) return { allowed: true, corsOrigin: '', mode: 'local-non-browser', pairedNow: false };
    const origin = normalizeExtensionOrigin(raw);
    if (!origin) {
      return { allowed: false, corsOrigin: '', statusCode: 403, code: 'GATEWAY_BROWSER_ORIGIN_NOT_ALLOWED', error: 'Browser origin is not allowed' };
    }
    const pairing = readPairing();
    if (pairing.corrupt) {
      return { allowed: false, corsOrigin: origin, statusCode: 500, code: 'GATEWAY_PAIRING_STATE_INVALID', error: 'Gateway extension pairing state is invalid; run the reset pairing script locally' };
    }
    if (pairing.pairedOrigin) {
      if (pairing.pairedOrigin === origin) return { allowed: true, corsOrigin: origin, mode: 'paired-extension', pairedNow: false };
      return { allowed: false, corsOrigin: origin, statusCode: 403, code: 'GATEWAY_EXTENSION_NOT_PAIRED', error: 'This Chrome extension is not paired with the local AI Gateway' };
    }
    const window = readWindow();
    if (!window.open) {
      return { allowed: false, corsOrigin: origin, statusCode: 428, code: 'GATEWAY_PAIRING_REQUIRED', error: 'Gateway pairing is required. Run the local Chrome-extension pairing script, then retry within 5 minutes.' };
    }
    if (!allowPair) return { allowed: true, corsOrigin: origin, mode: 'pairing-preflight', pairedNow: false };
    writeJsonAtomic(pairingFile, { origin, pairedAtUnixMs: now() });
    try { fs.unlinkSync(windowFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return { allowed: true, corsOrigin: origin, mode: 'paired-extension', pairedNow: true };
  };

  return { authorize, snapshot, openWindow, reset, pairingFile, windowFile };
}

function allowedHostHeader(req) {
  const raw = clean(req?.headers?.host);
  if (!raw) return false;
  try {
    const hostname = new URL(`http://${raw}`).hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  } catch (_) {
    return false;
  }
}

function json(res, status, body, { corsOrigin = '' } = {}) {
  const payload = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (corsOrigin) {
    headers['access-control-allow-origin'] = corsOrigin;
    headers.vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function fetchJson(fetchFn, url, init = {}, { timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text;
  try {
    response = await fetchFn(url, { ...init, signal: controller.signal, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
    text = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw gatewayError(`Upstream request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`, 504, 'AI_PROVIDER_TIMEOUT');
    throw gatewayError(`Upstream provider is unavailable: ${clean(error?.message || error).slice(0, 500) || 'network failure'}`, 503, 'AI_PROVIDER_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw gatewayError(`Upstream returned invalid JSON (HTTP ${response.status})`, 502, 'AI_PROVIDER_INVALID_RESPONSE'); }
  if (!response.ok) {
    const detail = clean(body?.error?.message) || clean(body?.error) || clean(body?.message);
    const message = detail ? `Upstream ${response.status}: ${detail}` : `Upstream ${response.status}`;
    if (response.status === 429) throw gatewayError(message, 429, 'AI_PROVIDER_RATE_LIMITED');
    if ([408, 425].includes(response.status)) throw gatewayError(message, response.status, 'AI_PROVIDER_TIMEOUT');
    if (response.status >= 500) throw gatewayError(message, response.status, 'AI_PROVIDER_UNAVAILABLE');
    if ([401, 403].includes(response.status)) throw gatewayError(message, response.status, 'AI_PROVIDER_AUTH_REJECTED');
    throw gatewayError(message, response.status, 'AI_PROVIDER_REJECTED');
  }
  return body;
}

function openAiHeaders() {
  const key = clean(process.env.OPENAI_API_KEY);
  if (!key) throw new Error('OPENAI_API_KEY is not configured in the local AI Gateway environment');
  return { authorization: `Bearer ${key}` };
}

function compatibleHeaders() {
  const key = clean(process.env.COMPATIBLE_API_KEY);
  return key ? { authorization: `Bearer ${key}` } : {};
}

function normalizeImageDataUrl(value) {
  const source = clean(value);
  if (!source) return '';
  if (source.length > 1_600_000) throw new Error('Vision image is too large');
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(source)) throw new Error('Vision image must be a base64 JPEG, PNG, or WebP data URL');
  return source;
}

function openAiText(body) {
  if (clean(body?.output_text)) return clean(body.output_text);
  const parts = [];
  for (const item of body?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && clean(content?.text)) parts.push(clean(content.text));
    }
  }
  return parts.join('\n').trim();
}

export async function listProviderModels(provider, { fetchFn = globalThis.fetch } = {}) {
  if (!PROVIDERS.has(provider)) throw new Error('Unsupported AI provider');
  if (provider === 'ollama') {
    const body = await fetchJson(fetchFn, `${OLLAMA_BASE_URL}/api/tags`);
    return (body.models || []).map(item => clean(item?.name || item?.model)).filter(Boolean).sort();
  }
  if (provider === 'openai') {
    const body = await fetchJson(fetchFn, `${OPENAI_BASE_URL}/models`, { headers: openAiHeaders() });
    return (body.data || []).map(item => clean(item?.id)).filter(Boolean).sort();
  }
  const body = await fetchJson(fetchFn, `${COMPATIBLE_BASE_URL}/models`, { headers: compatibleHeaders() });
  return (body.data || body.models || []).map(item => clean(item?.id || item?.name || item?.model)).filter(Boolean).sort();
}

export async function completeProvider({ provider, model, prompt, systemPrompt = '', maxOutputTokens = 0, imageDataUrl = '' }, { fetchFn = globalThis.fetch } = {}) {
  if (!PROVIDERS.has(provider)) throw new Error('Unsupported AI provider');
  if (!clean(model)) throw new Error('Model is required');
  if (!clean(prompt)) throw new Error('Prompt is required');
  const visionImage = normalizeImageDataUrl(imageDataUrl);
  if (provider === 'ollama') {
    const messages = [];
    if (clean(systemPrompt)) messages.push({ role: 'system', content: clean(systemPrompt) });
    messages.push({ role: 'user', content: clean(prompt), ...(visionImage ? { images: [visionImage.replace(/^data:image\/(?:jpeg|png|webp);base64,/, '')] } : {}) });
    const tokenLimit = Math.max(0, Math.floor(Number(maxOutputTokens) || 0));
    const body = await fetchJson(fetchFn, `${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: clean(model), messages, stream: false, ...(tokenLimit ? { options: { num_predict: tokenLimit } } : {}) }),
    });
    const text = clean(body?.message?.content) || clean(body?.response);
    if (!text) throw new Error('Ollama returned no assistant text');
    const inputTokens = Math.max(0, Number(body?.prompt_eval_count || 0));
    const outputTokens = Math.max(0, Number(body?.eval_count || 0));
    return { provider, model: clean(model), text, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, modelCalls: 1 } };
  }

  if (provider === 'openai') {
    const payload = { model: clean(model), input: visionImage ? [{ role: 'user', content: [{ type: 'input_text', text: clean(prompt) }, { type: 'input_image', image_url: visionImage }] }] : clean(prompt) };
    if (clean(systemPrompt)) payload.instructions = clean(systemPrompt);
    const tokenLimit = Math.max(0, Math.floor(Number(maxOutputTokens) || 0));
    if (tokenLimit) payload.max_output_tokens = tokenLimit;
    const body = await fetchJson(fetchFn, `${OPENAI_BASE_URL}/responses`, {
      method: 'POST',
      headers: openAiHeaders(),
      body: JSON.stringify(payload),
    });
    const text = openAiText(body);
    if (!text) throw new Error('OpenAI Responses API returned no text output');
    const inputTokens = Math.max(0, Number(body?.usage?.input_tokens || 0));
    const outputTokens = Math.max(0, Number(body?.usage?.output_tokens || 0));
    const totalTokens = Math.max(inputTokens + outputTokens, Number(body?.usage?.total_tokens || 0));
    return { provider, model: clean(model), text, usage: { inputTokens, outputTokens, totalTokens, modelCalls: 1 } };
  }

  const messages = [];
  if (clean(systemPrompt)) messages.push({ role: 'system', content: clean(systemPrompt) });
  messages.push({ role: 'user', content: visionImage ? [{ type: 'text', text: clean(prompt) }, { type: 'image_url', image_url: { url: visionImage } }] : clean(prompt) });
  const tokenLimit = Math.max(0, Math.floor(Number(maxOutputTokens) || 0));
  const body = await fetchJson(fetchFn, `${COMPATIBLE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: compatibleHeaders(),
    body: JSON.stringify({ model: clean(model), messages, stream: false, ...(tokenLimit ? { max_tokens: tokenLimit } : {}) }),
  });
  const text = clean(body?.choices?.[0]?.message?.content) || clean(body?.choices?.[0]?.text);
  if (!text) throw new Error('OpenAI-compatible server returned no assistant text');
  const inputTokens = Math.max(0, Number(body?.usage?.prompt_tokens || 0));
  const outputTokens = Math.max(0, Number(body?.usage?.completion_tokens || 0));
  const totalTokens = Math.max(inputTokens + outputTokens, Number(body?.usage?.total_tokens || 0));
  return { provider, model: clean(model), text, usage: { inputTokens, outputTokens, totalTokens, modelCalls: 1 } };
}


export async function probeProvider(provider, { fetchFn = globalThis.fetch, timeoutMs = STATUS_PROBE_TIMEOUT_MS } = {}) {
  if (!PROVIDERS.has(provider)) throw new Error('Unsupported AI provider');
  if (provider === 'openai' && !clean(process.env.OPENAI_API_KEY)) {
    return { provider, configured: false, ok: false, models: 0, reason: 'api-key-not-configured' };
  }
  try {
    let models;
    if (provider === 'ollama') {
      const body = await fetchJson(fetchFn, `${OLLAMA_BASE_URL}/api/tags`, {}, { timeoutMs });
      models = (body.models || []).map(item => clean(item?.name || item?.model)).filter(Boolean);
    } else if (provider === 'openai') {
      const body = await fetchJson(fetchFn, `${OPENAI_BASE_URL}/models`, { headers: openAiHeaders() }, { timeoutMs });
      models = (body.data || []).map(item => clean(item?.id)).filter(Boolean);
    } else {
      const body = await fetchJson(fetchFn, `${COMPATIBLE_BASE_URL}/models`, { headers: compatibleHeaders() }, { timeoutMs });
      models = (body.data || body.models || []).map(item => clean(item?.id || item?.name || item?.model)).filter(Boolean);
    }
    return { provider, configured: true, ok: true, models: models.length, reason: '' };
  } catch (error) {
    return { provider, configured: true, ok: false, models: 0, reason: clean(error?.message || error).slice(0, 300) };
  }
}

export function createGatewayServer({ fetchFn = globalThis.fetch, inferenceQueue = createInferenceQueue(), pairingStore = createExtensionPairingStore() } = {}) {
  return http.createServer(async (req, res) => {
    let corsOrigin = '';
    try {
      // The Gateway is a localhost companion for the extension, not a general web API.
      // Reject DNS-rebinding style Host headers before considering any browser pairing.
      if (!allowedHostHeader(req)) return json(res, 403, { error: 'Gateway accepts loopback Host only', code: 'GATEWAY_HOST_NOT_ALLOWED' });
      const originAuth = pairingStore.authorize(req?.headers?.origin, { allowPair: req.method !== 'OPTIONS' });
      corsOrigin = originAuth.corsOrigin || '';
      if (!originAuth.allowed) return json(res, originAuth.statusCode || 403, { error: originAuth.error || 'Browser origin is not allowed', ...(originAuth.code ? { code: originAuth.code } : {}) }, { corsOrigin });
      if (req.method === 'OPTIONS') return json(res, 204, {}, { corsOrigin });
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'chatgpt-autopilot-ai-gateway',
          version: GATEWAY_VERSION,
          providers: [...PROVIDERS],
          openaiConfigured: Boolean(clean(process.env.OPENAI_API_KEY)),
          compatibleApiKeyConfigured: Boolean(clean(process.env.COMPATIBLE_API_KEY)),
          compatibleBaseUrl: COMPATIBLE_BASE_URL,
          compatibleTransport: new URL(COMPATIBLE_BASE_URL).protocol.replace(':', ''),
          ollamaBaseUrl: OLLAMA_BASE_URL,
          nodeVersion: process.version,
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          inferenceQueue: inferenceQueue.snapshot(),
          extensionPairing: pairingStore.snapshot(),
        }, { corsOrigin });
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const providerStatus = await Promise.all([...PROVIDERS].map(provider => probeProvider(provider, { fetchFn })));
        return json(res, 200, {
          ok: true,
          service: 'chatgpt-autopilot-ai-gateway',
          version: GATEWAY_VERSION,
          providers: providerStatus,
          inferenceQueue: inferenceQueue.snapshot(),
          extensionPairing: pairingStore.snapshot(),
        }, { corsOrigin });
      }
      if (req.method === 'GET' && url.pathname === '/models') {
        const provider = clean(url.searchParams.get('provider'));
        const models = await listProviderModels(provider, { fetchFn });
        return json(res, 200, { ok: true, provider, models }, { corsOrigin });
      }
      if (req.method === 'POST' && url.pathname === '/complete') {
        const body = await readBody(req);
        const result = await inferenceQueue.run(() => completeProvider(body, { fetchFn }));
        return json(res, 200, { ok: true, ...result }, { corsOrigin });
      }
      return json(res, 404, { error: 'Not found' }, { corsOrigin });
    } catch (error) {
      return json(res, Number(error?.statusCode) || 400, { error: error?.message || 'Gateway request failed', ...(error?.code ? { code: error.code } : {}) }, { corsOrigin: corsOrigin || '' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), { encoding: 'utf8', mode: 0o600 });
  const cleanupPid = () => {
    try {
      if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch (_) {}
  };
  process.once('exit', cleanupPid);
  process.once('SIGINT', () => { cleanupPid(); process.exit(0); });
  process.once('SIGTERM', () => { cleanupPid(); process.exit(0); });

  const server = createGatewayServer();
  server.on('error', error => {
    cleanupPid();
    console.error(`AI Gateway failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`ChatGPT Autopilot AI Gateway ${GATEWAY_VERSION} listening on http://${HOST}:${PORT}`);
    console.log(`Ollama: ${OLLAMA_BASE_URL}`);
    console.log(`OpenAI API: ${clean(process.env.OPENAI_API_KEY) ? 'configured' : 'OPENAI_API_KEY not set'}`);
    console.log(`OpenAI-compatible local: ${COMPATIBLE_BASE_URL}`);
  });
}
