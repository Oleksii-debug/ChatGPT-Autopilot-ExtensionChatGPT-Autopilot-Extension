import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const HOST_NAME = 'org.chatgpt_autopilot.companion';
export const PROTOCOL_VERSION = 1;
export const HOST_VERSION = '0.1.0';
export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;

export const RequestType = Object.freeze({
  HELLO: 'hello',
  HEALTH: 'health',
  CAPABILITIES: 'capabilities',
  FILESYSTEM_READ_TEXT: 'filesystem.readText',
});

const REQUEST_TYPES = new Set(Object.values(RequestType));
const REQUEST_KEYS = new Set(['protocolVersion', 'requestId', 'type', 'payload']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function clean(value, max = 4096) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw companionError('INVALID_REQUEST', `${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw companionError('INVALID_REQUEST', `${label} contains unknown field: ${key}`);
}

function companionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeId(value, label) {
  const out = clean(value, 128);
  if (!ID.test(out)) throw companionError('INVALID_REQUEST', `${label} is invalid`);
  return out;
}

function normalizeRequest(input) {
  exactKeys(input, REQUEST_KEYS, 'request');
  if (Number(input.protocolVersion) !== PROTOCOL_VERSION) throw companionError('PROTOCOL_MISMATCH', `Native Companion requires protocolVersion ${PROTOCOL_VERSION}`);
  const type = clean(input.type, 80);
  if (!REQUEST_TYPES.has(type)) throw companionError('UNSUPPORTED_REQUEST', `Unsupported Native Companion request: ${type || '(empty)'}`);
  const payload = input.payload == null ? {} : input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw companionError('INVALID_REQUEST', 'payload must be an object');
  if (JSON.stringify(payload).length > 256_000) throw companionError('INVALID_REQUEST', 'payload is too large');
  return { protocolVersion: 1, requestId: normalizeId(input.requestId, 'requestId'), type, payload };
}

function normalizeAllowedOrigin(value) {
  const origin = clean(value, 300);
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/u.test(origin)) throw companionError('CONFIG_INVALID', 'allowedOrigin must be one exact Chrome extension origin');
  return origin;
}

function normalizeRoot(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw companionError('CONFIG_INVALID', `roots[${index}] must be an object`);
  const keys = Object.keys(raw);
  if (keys.some(key => !['rootId', 'path'].includes(key))) throw companionError('CONFIG_INVALID', `roots[${index}] contains unknown field`);
  const rootId = normalizeId(raw.rootId, `roots[${index}].rootId`);
  const rootPath = clean(raw.path, 32000);
  if (!rootPath || !path.isAbsolute(rootPath)) throw companionError('CONFIG_INVALID', `roots[${index}].path must be absolute`);
  return { rootId, path: path.resolve(rootPath) };
}

export function normalizeNativeCompanionConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw companionError('CONFIG_INVALID', 'Native Companion config must be an object');
  for (const key of Object.keys(raw)) if (!['schemaVersion', 'allowedOrigin', 'roots'].includes(key)) throw companionError('CONFIG_INVALID', `Native Companion config contains unknown field: ${key}`);
  if (Number(raw.schemaVersion) !== 1) throw companionError('CONFIG_INVALID', 'Native Companion config schemaVersion must be 1');
  if (!Array.isArray(raw.roots) || raw.roots.length > 64) throw companionError('CONFIG_INVALID', 'roots must be a bounded array');
  const roots = raw.roots.map(normalizeRoot);
  if (new Set(roots.map(item => item.rootId)).size !== roots.length) throw companionError('CONFIG_INVALID', 'rootId values must be unique');
  return Object.freeze({ schemaVersion: 1, allowedOrigin: normalizeAllowedOrigin(raw.allowedOrigin), roots: Object.freeze(roots) });
}

function response(request, result) {
  return { protocolVersion: 1, requestId: request.requestId, type: request.type, ok: true, result };
}

function failureEnvelope(input, error) {
  const requestId = input && typeof input === 'object' && ID.test(clean(input.requestId, 128)) ? clean(input.requestId, 128) : 'invalid-request';
  const type = input && typeof input === 'object' && REQUEST_TYPES.has(clean(input.type, 80)) ? clean(input.type, 80) : RequestType.HEALTH;
  return {
    protocolVersion: 1,
    requestId,
    type,
    ok: false,
    error: {
      code: clean(error?.code, 120) || 'NATIVE_COMPANION_ERROR',
      message: clean(error?.message || error, 4000) || 'Native Companion request failed',
    },
  };
}

function ensureCaller(config, callerOrigin) {
  if (clean(callerOrigin, 300) !== config.allowedOrigin) throw companionError('CALLER_NOT_ALLOWED', 'Native Companion caller origin is not allowed');
}

function requireString(value, label, max = 32000) {
  if (typeof value !== 'string') throw companionError('INVALID_REQUEST', `${label} must be text`);
  const out = value.trim();
  if (!out || out.length > max) throw companionError('INVALID_REQUEST', `${label} is invalid`);
  return out;
}

function requireReadLimit(value) {
  const n = value == null ? 262144 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_READ_BYTES) throw companionError('INVALID_REQUEST', `maxBytes must be 1..${MAX_READ_BYTES}`);
  return n;
}

async function readScopedText(payload, config, fsApi) {
  const rootId = normalizeId(payload.rootId, 'rootId');
  const relativePath = requireString(payload.relativePath, 'relativePath');
  if (path.isAbsolute(relativePath)) throw companionError('PATH_OUTSIDE_SCOPE', 'relativePath must not be absolute');
  const segments = relativePath.replace(/\\/gu, '/').split('/');
  if (segments.some(segment => segment === '..' || segment === '')) throw companionError('PATH_OUTSIDE_SCOPE', 'relativePath contains an invalid path segment');
  const root = config.roots.find(item => item.rootId === rootId);
  if (!root) throw companionError('ROOT_NOT_ALLOWED', 'Requested filesystem root is not configured');
  const maxBytes = requireReadLimit(payload.maxBytes);

  let rootReal;
  let fileReal;
  try {
    rootReal = await fsApi.realpath(root.path);
    fileReal = await fsApi.realpath(path.resolve(root.path, relativePath));
  } catch {
    throw companionError('FILE_NOT_FOUND', 'Requested file is unavailable');
  }
  const rel = path.relative(rootReal, fileReal);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw companionError('PATH_OUTSIDE_SCOPE', 'Requested file escapes the configured root');

  const stat = await fsApi.stat(fileReal);
  if (!stat.isFile()) throw companionError('NOT_A_FILE', 'Requested path is not a file');
  if (stat.size > maxBytes) throw companionError('FILE_TOO_LARGE', `Requested file exceeds maxBytes (${stat.size} > ${maxBytes})`);
  const bytes = await fsApi.readFile(fileReal);
  if (bytes.byteLength > maxBytes) throw companionError('FILE_TOO_LARGE', 'Requested file grew beyond maxBytes during read');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw companionError('UNSUPPORTED_ENCODING', 'Only valid UTF-8 text files are supported by filesystem.readText V1'); }
  return {
    rootId,
    relativePath: rel.replace(/\\/gu, '/'),
    sizeBytes: bytes.byteLength,
    text,
  };
}

export async function handleNativeCompanionRequest(input, { config, callerOrigin, fsApi = fs, now = () => Date.now() } = {}) {
  let request;
  try {
    const normalizedConfig = normalizeNativeCompanionConfig(config);
    ensureCaller(normalizedConfig, callerOrigin);
    request = normalizeRequest(input);
    if (request.type === RequestType.HELLO) {
      return response(request, {
        hostName: HOST_NAME,
        hostVersion: HOST_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        callerOrigin: normalizedConfig.allowedOrigin,
      });
    }
    if (request.type === RequestType.HEALTH) {
      return response(request, { status: 'ok', hostVersion: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, now: new Date(now()).toISOString() });
    }
    if (request.type === RequestType.CAPABILITIES) {
      return response(request, {
        capabilities: [
          { capabilityId: 'native.health', readOnly: true },
          { capabilityId: 'filesystem.readText', readOnly: true, scoped: true, maxBytes: MAX_READ_BYTES },
        ],
        roots: normalizedConfig.roots.map(item => ({ rootId: item.rootId })),
      });
    }
    if (request.type === RequestType.FILESYSTEM_READ_TEXT) {
      return response(request, await readScopedText(request.payload, normalizedConfig, fsApi));
    }
    throw companionError('UNSUPPORTED_REQUEST', 'Unsupported Native Companion request');
  } catch (error) {
    return failureEnvelope(request || input, error);
  }
}

export function encodeNativeMessage(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) throw companionError('MESSAGE_TOO_LARGE', 'Native Companion response exceeds 1 MiB');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class NativeMessageDecoder {
  constructor({ maxBytes = MAX_NATIVE_MESSAGE_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length < 2 || length > this.maxBytes) throw companionError('MESSAGE_TOO_LARGE', 'Invalid Native Companion message length');
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let parsed;
      try { parsed = JSON.parse(payload.toString('utf8')); }
      catch { throw companionError('INVALID_JSON', 'Native Companion received invalid JSON'); }
      messages.push(parsed);
    }
    return messages;
  }
}
