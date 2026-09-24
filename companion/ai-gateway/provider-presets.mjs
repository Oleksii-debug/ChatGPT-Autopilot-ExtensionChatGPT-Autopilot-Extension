import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MISTRAL_ENDPOINT_PRESET = Object.freeze({
  endpointId: 'mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  apiKeyEnv: 'MISTRAL_API_KEY',
});

const MAX_COMPATIBLE_ENDPOINTS = 16;

function settingsObject(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway settings must be a JSON object');
  }
  return value;
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

  const source = settings.compatibleEndpoints ?? [];
  if (!Array.isArray(source)) throw new Error('Gateway compatibleEndpoints must be an array');
  const compatibleEndpoints = source.filter(item => String(item?.endpointId || '').trim() !== endpointId);
  compatibleEndpoints.push({ endpointId, baseUrl, apiKeyEnv });
  if (compatibleEndpoints.length > MAX_COMPATIBLE_ENDPOINTS) {
    throw new Error(`Gateway supports at most ${MAX_COMPATIBLE_ENDPOINTS} OpenAI-compatible endpoints`);
  }
  return { ...settings, compatibleEndpoints };
}

export function writeCompatibleEndpointPreset(configFile, preset = MISTRAL_ENDPOINT_PRESET) {
  const requestedPath = String(configFile || '').trim();
  if (!requestedPath) throw new Error('Gateway settings path is required');
  const target = path.resolve(requestedPath);
  let existing = {};
  try {
    const text = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
    existing = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Could not read gateway settings: ${error?.message || error}`);
  }
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
  if (argv[0] !== '--apply-mistral' || !argv[1] || argv.length !== 2) {
    throw new Error('Usage: node provider-presets.mjs --apply-mistral <gateway-settings.json>');
  }
  const settings = writeCompatibleEndpointPreset(argv[1], MISTRAL_ENDPOINT_PRESET);
  const endpoint = settings.compatibleEndpoints.find(item => item.endpointId === MISTRAL_ENDPOINT_PRESET.endpointId);
  process.stdout.write(`${JSON.stringify(endpoint)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
