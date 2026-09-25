import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MISTRAL_ENDPOINT_PRESET = Object.freeze({
  endpointId: 'mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  apiKeyEnv: 'MISTRAL_API_KEY',
});

export const OPENROUTER_ENDPOINT_PRESET = Object.freeze({
  endpointId: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
});

export const PINNED_COMPATIBLE_CREDENTIAL_BINDINGS = Object.freeze({
  MISTRAL_API_KEY: Object.freeze({
    endpointId: MISTRAL_ENDPOINT_PRESET.endpointId,
    origin: 'https://api.mistral.ai',
  }),
  OPENROUTER_API_KEY: Object.freeze({
    endpointId: OPENROUTER_ENDPOINT_PRESET.endpointId,
    origin: 'https://openrouter.ai',
  }),
});

const MAX_COMPATIBLE_ENDPOINTS = 16;

function settingsObject(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway settings must be a JSON object');
  }
  return value;
}

function readSettingsFile(configFile) {
  const requestedPath = String(configFile || '').trim();
  if (!requestedPath) throw new Error('Gateway settings path is required');
  const target = path.resolve(requestedPath);
  try {
    const text = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
    return { target, settings: text.trim() ? JSON.parse(text) : {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { target, settings: {} };
    throw new Error(`Could not read gateway settings: ${error?.message || error}`);
  }
}

export function buildNamedProviderCredentialPlan(
  rawSettings = {},
  {
    providerKeysDir,
    credentialFileExists = fs.existsSync,
  } = {},
) {
  const settings = settingsObject(rawSettings);
  const requestedDir = String(providerKeysDir || '').trim();
  if (!requestedDir) throw new Error('Named provider credential directory is required');
  if (typeof credentialFileExists !== 'function') throw new Error('credentialFileExists must be a function');

  const endpoints = settings.compatibleEndpoints ?? [];
  if (!Array.isArray(endpoints)) throw new Error('Gateway compatibleEndpoints must be an array');

  const root = path.resolve(requestedDir);
  const plan = [];
  const seenCredentialRefs = new Set();

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
      throw new Error(`Gateway compatible endpoint ${index + 1} must be an object`);
    }

    const apiKeyEnv = String(endpoint.apiKeyEnv ?? '').trim();
    if (!apiKeyEnv || apiKeyEnv === 'COMPATIBLE_API_KEY') continue;
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) {
      throw new Error(`Gateway compatible endpoint ${index + 1} has an invalid apiKeyEnv`);
    }

    const keyFile = path.join(root, `${apiKeyEnv}.dpapi`);
    if (!credentialFileExists(keyFile)) continue;

    const binding = PINNED_COMPATIBLE_CREDENTIAL_BINDINGS[apiKeyEnv];
    if (!binding) {
      throw new Error(`Stored named credential ${apiKeyEnv} has no authorized provider binding`);
    }
    if (seenCredentialRefs.has(apiKeyEnv)) {
      throw new Error(`Stored named credential ${apiKeyEnv} is referenced more than once`);
    }

    const endpointId = String(endpoint.endpointId ?? '').trim();
    const rawBaseUrl = String(endpoint.baseUrl ?? '').trim().replace(/\/+$/, '');
    let origin = '';
    try {
      const parsed = new URL(rawBaseUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('invalid remote provider URL');
      }
      origin = parsed.origin;
    } catch (_) {
      throw new Error(`Stored named credential ${apiKeyEnv} is bound to an invalid provider URL`);
    }

    if (endpointId !== binding.endpointId || origin !== binding.origin) {
      throw new Error(
        `Stored named credential ${apiKeyEnv} is pinned to endpoint ${binding.endpointId} at ${binding.origin}`,
      );
    }

    seenCredentialRefs.add(apiKeyEnv);
    plan.push(Object.freeze({
      apiKeyEnv,
      endpointId,
      origin,
      keyFile,
    }));
  }

  return Object.freeze(plan);
}

export function loadNamedProviderCredentialPlan(configFile, providerKeysDir) {
  const { settings } = readSettingsFile(configFile);
  return buildNamedProviderCredentialPlan(settings, { providerKeysDir });
}

export function applyCompatibleEndpointPreset(rawSettings = {}, preset = MISTRAL_ENDPOINT_PRESET) {
  const settings = settingsObject(rawSettings);
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new Error('Provider preset must be an object');
  const endpointId = String(preset.endpointId || '').trim();
  const baseUrl = String(preset.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKeyEnv = String(preset.apiKeyEnv || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(endpointId)) throw new Error('Provider preset endpointId is invalid');
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Remote provider preset must use a credential-free HTTPS base URL');
  }
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) throw new Error('Provider preset apiKeyEnv is invalid');

  const legacyBaseUrl = String(settings.compatibleBaseUrl || '').trim().replace(/\/+$/, '');
  const source = settings.compatibleEndpoints ?? (legacyBaseUrl ? [{
    endpointId: 'default',
    baseUrl: legacyBaseUrl,
    apiKeyEnv: 'COMPATIBLE_API_KEY',
  }] : []);
  if (!Array.isArray(source)) throw new Error('Gateway compatibleEndpoints must be an array');
  const compatibleEndpoints = source.filter(item => String(item?.endpointId || '').trim() !== endpointId);
  compatibleEndpoints.push({ endpointId, baseUrl, apiKeyEnv });
  if (compatibleEndpoints.length > MAX_COMPATIBLE_ENDPOINTS) {
    throw new Error(`Gateway supports at most ${MAX_COMPATIBLE_ENDPOINTS} OpenAI-compatible endpoints`);
  }
  return { ...settings, compatibleEndpoints };
}

function normalizeDefaultCompatibleBaseUrl(value) {
  const source = String(value ?? '').trim().replace(/\/+$/, '');
  if (!source) throw new Error('OpenAI-compatible base URL is required');
  let parsed;
  try { parsed = new URL(source); }
  catch (_) { throw new Error('OpenAI-compatible base URL must be an absolute URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error('OpenAI-compatible base URL must be credential-free HTTP(S) without query or fragment');
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('Remote OpenAI-compatible base URL must use HTTPS');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function applyDefaultCompatibleEndpoint(rawSettings = {}, baseUrl) {
  const settings = settingsObject(rawSettings);
  const canonicalBaseUrl = normalizeDefaultCompatibleBaseUrl(baseUrl);
  const source = settings.compatibleEndpoints ?? [];
  if (!Array.isArray(source)) throw new Error('Gateway compatibleEndpoints must be an array');
  const compatibleEndpoints = source.filter(item => String(item?.endpointId || '').trim() !== 'default');
  compatibleEndpoints.unshift({
    endpointId: 'default',
    baseUrl: canonicalBaseUrl,
    apiKeyEnv: 'COMPATIBLE_API_KEY',
  });
  if (compatibleEndpoints.length > MAX_COMPATIBLE_ENDPOINTS) {
    throw new Error(`Gateway supports at most ${MAX_COMPATIBLE_ENDPOINTS} OpenAI-compatible endpoints`);
  }
  return {
    ...settings,
    compatibleBaseUrl: canonicalBaseUrl,
    compatibleEndpoints,
  };
}

export function writeDefaultCompatibleEndpoint(configFile, baseUrl) {
  const { target, settings: existing } = readSettingsFile(configFile);
  const next = applyDefaultCompatibleEndpoint(existing, baseUrl);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    try { fs.chmodSync(target, 0o600); } catch (_) {}
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
  }
  return next;
}

export function writeCompatibleEndpointPreset(configFile, preset = MISTRAL_ENDPOINT_PRESET) {
  const { target, settings: existing } = readSettingsFile(configFile);
  const next = applyCompatibleEndpointPreset(existing, preset);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    try { fs.chmodSync(target, 0o600); } catch (_) {}
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
  }
  return next;
}

function main(argv) {
  if (argv[0] === '--apply-mistral' && argv[1] && argv.length === 2) {
    const settings = writeCompatibleEndpointPreset(argv[1], MISTRAL_ENDPOINT_PRESET);
    const endpoint = settings.compatibleEndpoints.find(item => item.endpointId === MISTRAL_ENDPOINT_PRESET.endpointId);
    process.stdout.write(`${JSON.stringify(endpoint)}\n`);
    return;
  }
  if (argv[0] === '--apply-openrouter' && argv[1] && argv.length === 2) {
    const settings = writeCompatibleEndpointPreset(argv[1], OPENROUTER_ENDPOINT_PRESET);
    const endpoint = settings.compatibleEndpoints.find(item => item.endpointId === OPENROUTER_ENDPOINT_PRESET.endpointId);
    process.stdout.write(`${JSON.stringify(endpoint)}\n`);
    return;
  }
  if (argv[0] === '--apply-default' && argv[1] && argv[2] && argv.length === 3) {
    const settings = writeDefaultCompatibleEndpoint(argv[1], argv[2]);
    const endpoint = settings.compatibleEndpoints.find(item => item.endpointId === 'default');
    process.stdout.write(`${JSON.stringify(endpoint)}\n`);
    return;
  }
  if (argv[0] === '--credential-plan' && argv[1] && argv[2] && argv.length === 3) {
    process.stdout.write(`${JSON.stringify(loadNamedProviderCredentialPlan(argv[1], argv[2]))}\n`);
    return;
  }
  throw new Error(
    'Usage: node provider-presets.mjs --apply-mistral <gateway-settings.json> | --apply-openrouter <gateway-settings.json> | --apply-default <gateway-settings.json> <base-url> | --credential-plan <gateway-settings.json> <provider-keys-dir>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
