import path from 'node:path';

export const CREDENTIAL_BROKER_ID = 'native-companion';
export const CREDENTIAL_METADATA_SCHEMA_VERSION = 1;
export const CredentialKind = Object.freeze({
  USERNAME_PASSWORD: 'username-password',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const META_KEYS = new Set(['credentialId', 'kind', 'scope', 'username', 'secretFile', 'enabled', 'expiresAt']);
const STORE_KEYS = new Set(['schemaVersion', 'credentials']);

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clean(value, max = 4096) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw brokerError('CREDENTIAL_CONFIG_INVALID', `${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw brokerError('CREDENTIAL_CONFIG_INVALID', `${label} contains unknown field: ${key}`);
}

function id(value, label) {
  const out = clean(value, 128);
  if (!ID.test(out)) throw brokerError('CREDENTIAL_CONFIG_INVALID', `${label} is invalid`);
  return out;
}

function normalizeTargetOrigin(value) {
  let parsed;
  try { parsed = new URL(clean(value, 2048)); } catch { throw brokerError('CREDENTIAL_SCOPE_INVALID', 'Credential targetOrigin is invalid'); }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.pathname = '/';
  parsed.search = '';
  if (parsed.protocol === 'https:') return parsed.origin;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && local) return parsed.origin;
  throw brokerError('CREDENTIAL_SCOPE_INVALID', 'Credential targetOrigin must use HTTPS except localhost development');
}

function normalizeScopeEntry(value) {
  const source = clean(value, 2048).toLowerCase();
  if (!source) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Credential scope entry is empty');
  const wildcard = source.match(/^(https:|http:)\/\/\*\.([^/:?#]+)(?::(\d+))?$/u);
  if (wildcard) {
    const protocol = wildcard[1];
    const hostname = wildcard[2];
    const port = wildcard[3] || '';
    if (protocol !== 'https:') throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Wildcard credential scopes require HTTPS');
    if (!hostname.includes('.') || hostname.includes('*')) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Credential wildcard scope is invalid');
    return `${protocol}//*.${hostname}${port ? `:${port}` : ''}`;
  }
  const origin = normalizeTargetOrigin(source);
  if (new URL(origin).pathname !== '/') throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Credential scope must be an origin');
  return origin.toLowerCase();
}

function scopeMatches(scope, targetOrigin) {
  const target = new URL(normalizeTargetOrigin(targetOrigin));
  for (const entry of scope) {
    if (!entry.includes('*.')) {
      if (entry === target.origin.toLowerCase()) return true;
      continue;
    }
    const match = entry.match(/^(https:)\/\/\*\.([^/:?#]+)(?::(\d+))?$/u);
    if (!match || target.protocol !== match[1]) continue;
    const suffix = match[2];
    const port = match[3] || '';
    const targetPort = target.port || '';
    if (port !== targetPort) continue;
    const host = target.hostname.toLowerCase();
    if (host.endsWith(`.${suffix}`) && host !== suffix) return true;
  }
  return false;
}

function normalizeExpiry(value) {
  const source = clean(value, 120);
  if (!source) return null;
  const date = new Date(source);
  if (!Number.isFinite(date.getTime())) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Credential expiresAt is invalid');
  return date.toISOString();
}

function normalizeCredentialMeta(raw, index) {
  exactKeys(raw, META_KEYS, `credentials[${index}]`);
  const credentialId = id(raw.credentialId, `credentials[${index}].credentialId`);
  const kind = clean(raw.kind, 80);
  if (kind !== CredentialKind.USERNAME_PASSWORD) throw brokerError('CREDENTIAL_CONFIG_INVALID', `Unsupported credential kind: ${kind || '(empty)'}`);
  if (!Array.isArray(raw.scope) || !raw.scope.length || raw.scope.length > 64) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Credential scope must be a non-empty bounded array');
  const scope = [...new Set(raw.scope.map(normalizeScopeEntry))];
  const username = typeof raw.username === 'string' ? raw.username.slice(0, 5000) : '';
  const secretFile = clean(raw.secretFile, 260);
  if (!secretFile || path.isAbsolute(secretFile) || secretFile.includes('/') || secretFile.includes('\\') || secretFile === '.' || secretFile === '..') {
    throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Credential secretFile must be one local filename');
  }
  return Object.freeze({
    credentialId,
    kind,
    scope: Object.freeze(scope),
    username,
    secretFile,
    enabled: raw.enabled !== false,
    expiresAt: normalizeExpiry(raw.expiresAt),
  });
}

export function normalizeCredentialStore(raw) {
  exactKeys(raw, STORE_KEYS, 'Credential store');
  if (Number(raw.schemaVersion) !== CREDENTIAL_METADATA_SCHEMA_VERSION) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Credential store schemaVersion must be 1');
  if (!Array.isArray(raw.credentials) || raw.credentials.length > 256) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'credentials must be a bounded array');
  const credentials = raw.credentials.map(normalizeCredentialMeta);
  if (new Set(credentials.map(item => item.credentialId)).size !== credentials.length) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'credentialId values must be unique');
  return Object.freeze({ schemaVersion: 1, credentials: Object.freeze(credentials) });
}

function credentialRef(meta) {
  return Object.freeze({
    schemaVersion: 1,
    credentialId: meta.credentialId,
    brokerId: CREDENTIAL_BROKER_ID,
    kind: meta.kind,
    scope: [...meta.scope],
    expiresAt: meta.expiresAt,
  });
}

function available(meta, nowMs) {
  return meta.enabled && (!meta.expiresAt || new Date(meta.expiresAt).getTime() > nowMs);
}

export function createCredentialBroker({ store, credentialsDir, decryptSecret, now = () => Date.now() } = {}) {
  const normalized = normalizeCredentialStore(store || { schemaVersion: 1, credentials: [] });
  const baseDir = path.resolve(String(credentialsDir || ''));
  if (!baseDir || !path.isAbsolute(baseDir)) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'credentialsDir must be absolute');
  if (typeof decryptSecret !== 'function') throw brokerError('CREDENTIAL_CONFIG_INVALID', 'decryptSecret function is required');

  return Object.freeze({
    list(targetOrigin) {
      const origin = normalizeTargetOrigin(targetOrigin);
      const nowMs = now();
      return normalized.credentials
        .filter(meta => available(meta, nowMs) && scopeMatches(meta.scope, origin))
        .map(credentialRef);
    },

    async resolve({ credentialId, targetOrigin } = {}) {
      const requestedId = id(credentialId, 'credentialId');
      const origin = normalizeTargetOrigin(targetOrigin);
      const meta = normalized.credentials.find(item => item.credentialId === requestedId);
      if (!meta || !available(meta, now())) throw brokerError('CREDENTIAL_NOT_AVAILABLE', 'Credential is unavailable');
      if (!scopeMatches(meta.scope, origin)) throw brokerError('CREDENTIAL_SCOPE_DENIED', 'Credential is not allowed for this target origin');
      const secretPath = path.resolve(baseDir, meta.secretFile);
      const relative = path.relative(baseDir, secretPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw brokerError('CREDENTIAL_CONFIG_INVALID', 'Credential secret path escapes credentials directory');
      const secret = await decryptSecret(secretPath);
      if (typeof secret !== 'string' || !secret.length || secret.length > 100_000) throw brokerError('CREDENTIAL_DECRYPT_FAILED', 'Credential secret could not be decrypted');
      return {
        credentialId: meta.credentialId,
        kind: meta.kind,
        targetOrigin: origin,
        username: meta.username,
        secret,
      };
    },
  });
}

export function credentialScopeMatches(scope, targetOrigin) {
  if (!Array.isArray(scope)) return false;
  try { return scopeMatches(scope.map(normalizeScopeEntry), targetOrigin); } catch { return false; }
}
