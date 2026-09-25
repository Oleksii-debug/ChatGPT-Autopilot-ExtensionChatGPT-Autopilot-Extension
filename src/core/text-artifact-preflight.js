import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const TEXT_ARTIFACT_PREFLIGHT_VERSION = 1;
export const MAX_TEXT_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_TEXT_ARTIFACT_LINES = 50_000;
export const MAX_TEXT_ARTIFACT_LINE_CODE_UNITS = 64 * 1024;

const REQUEST_KEYS = new Set(['schemaVersion', 'artifactRef', 'contentBase64']);
const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactId',
  'kind',
  'uri',
  'mediaType',
  'sha256',
  'sizeBytes',
  'createdAt',
  'producerInvocationId',
  'sensitive',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const TEXT_APPLICATION_TYPES = new Set([
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/yaml',
  'application/x-yaml',
  'application/markdown',
  'application/sql',
  'application/graphql',
]);
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      throw new Error(label + ' is missing field: ' + key);
    }
  }
  return out;
}

function isTextMediaType(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value === value.toLowerCase()
    && !value.includes(';')
    && (value.startsWith('text/') || TEXT_APPLICATION_TYPES.has(value));
}

function exactArtifactRef(value) {
  const raw = snapshotRecord(value, ARTIFACT_KEYS, 'Text ArtifactRefV1');
  const normalized = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.is(raw[key], normalized[key])) {
      throw new Error('Text ArtifactRefV1 is not already canonical: ' + key);
    }
  }
  if (!SHA256.test(normalized.sha256)) {
    throw new Error('Text ArtifactRefV1 requires an exact lowercase SHA-256 digest');
  }
  if (!Number.isSafeInteger(normalized.sizeBytes)
      || Object.is(normalized.sizeBytes, -0)
      || normalized.sizeBytes < 0
      || normalized.sizeBytes > MAX_TEXT_ARTIFACT_BYTES) {
    throw new Error('Text ArtifactRefV1 sizeBytes is outside the admitted bound');
  }
  if (!isTextMediaType(normalized.mediaType)) {
    throw new Error('Text ArtifactRefV1 mediaType is not an admitted canonical text media type');
  }
  return normalized;
}

function decodeCanonicalBase64(value) {
  const maxEncodedLength = Math.ceil(MAX_TEXT_ARTIFACT_BYTES / 3) * 4;
  if (typeof value !== 'string'
      || value.length > maxEncodedLength
      || value.length % 4 !== 0
      || /[\r\n\t ]/u.test(value)
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error('contentBase64 must be bounded canonical Base64 text');
  }
  if (typeof globalThis.atob !== 'function' || typeof globalThis.btoa !== 'function') {
    throw new Error('Base64 decoding is unavailable');
  }
  let binary;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new Error('contentBase64 is invalid Base64');
  }
  if (globalThis.btoa(binary) !== value) {
    throw new Error('contentBase64 must use canonical Base64 representation');
  }
  if (binary.length > MAX_TEXT_ARTIFACT_BYTES) {
    throw new Error('decoded text artifact bytes exceed the admitted bound');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeExactUtf8(bytes) {
  if (bytes.length >= 3
      && bytes[0] === 0xef
      && bytes[1] === 0xbb
      && bytes[2] === 0xbf) {
    throw new Error('Text artifact UTF-8 BOM is not admitted');
  }
  if (typeof globalThis.TextDecoder !== 'function'
      || typeof globalThis.TextEncoder !== 'function') {
    throw new Error('UTF-8 codec is unavailable');
  }
  let text;
  try {
    text = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Text artifact bytes must be valid UTF-8');
  }
  const roundTrip = new globalThis.TextEncoder().encode(text);
  if (!bytesEqual(bytes, roundTrip)) {
    throw new Error('Text artifact bytes must round-trip through exact UTF-8');
  }
  return text;
}

function inspectText(text) {
  let lfCount = 0;
  let crlfCount = 0;
  let lineCodeUnits = 0;
  let maxLineCodeUnits = 0;
  let containsTabs = false;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) !== 0x0a) {
        throw new Error('Text artifact contains a lone CR newline/control');
      }
      crlfCount += 1;
      maxLineCodeUnits = Math.max(maxLineCodeUnits, lineCodeUnits);
      lineCodeUnits = 0;
      index += 1;
      continue;
    }
    if (code === 0x0a) {
      lfCount += 1;
      maxLineCodeUnits = Math.max(maxLineCodeUnits, lineCodeUnits);
      lineCodeUnits = 0;
      continue;
    }
    if (code === 0x09) {
      containsTabs = true;
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new Error('Text artifact contains a non-text control character');
    }
    lineCodeUnits += 1;
    if (lineCodeUnits > MAX_TEXT_ARTIFACT_LINE_CODE_UNITS) {
      throw new Error('Text artifact line exceeds the admitted code-unit bound');
    }
  }

  if (lfCount > 0 && crlfCount > 0) {
    throw new Error('Text artifact mixes LF and CRLF newline representations');
  }
  if (BIDI_CONTROLS.test(text)) {
    throw new Error('Text artifact contains bidi override/isolate controls');
  }

  maxLineCodeUnits = Math.max(maxLineCodeUnits, lineCodeUnits);
  const newlineCount = lfCount + crlfCount;
  const trailingNewline = text.endsWith('\n');
  const lineCount = text.length === 0
    ? 0
    : newlineCount + (trailingNewline ? 0 : 1);
  if (lineCount > MAX_TEXT_ARTIFACT_LINES) {
    throw new Error('Text artifact line count exceeds the admitted bound');
  }

  return Object.freeze({
    newlineStyle: crlfCount > 0 ? 'CRLF' : (lfCount > 0 ? 'LF' : 'NONE'),
    lineCount,
    maxLineCodeUnits,
    trailingNewline,
    containsTabs,
  });
}

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes, cryptoImpl) {
  if (!cryptoImpl?.subtle?.digest) throw new Error('Web Crypto SHA-256 is unavailable');
  let digest;
  try {
    digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  } catch {
    throw new Error('Text artifact SHA-256 calculation failed');
  }
  return toHex(new Uint8Array(digest));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Verifies exact UTF-8 text material without treating artifact content as
 * instructions or granting render, execution, distribution, or mutation rights.
 */
export async function preflightTextArtifactV1(input, {
  cryptoImpl = globalThis.crypto,
} = {}) {
  const raw = snapshotRecord(input, REQUEST_KEYS, 'TextArtifactPreflightV1 request');
  if (raw.schemaVersion !== TEXT_ARTIFACT_PREFLIGHT_VERSION) {
    throw new Error('Unsupported TextArtifactPreflightV1 schemaVersion');
  }

  const artifactRef = exactArtifactRef(raw.artifactRef);
  const bytes = decodeCanonicalBase64(raw.contentBase64);
  if (bytes.byteLength !== artifactRef.sizeBytes) {
    throw new Error('Text material byte length does not match immutable ArtifactRefV1');
  }
  const sha256 = await sha256Bytes(bytes, cryptoImpl);
  if (sha256 !== artifactRef.sha256) {
    throw new Error('Text material SHA-256 does not match immutable ArtifactRefV1');
  }

  const text = decodeExactUtf8(bytes);
  const stats = inspectText(text);
  const sensitive = artifactRef.sensitive === true;

  return deepFreeze({
    schemaVersion: TEXT_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef,
    byteLength: bytes.byteLength,
    sha256,
    mediaType: artifactRef.mediaType,
    newlineStyle: stats.newlineStyle,
    lineCount: stats.lineCount,
    maxLineCodeUnits: stats.maxLineCodeUnits,
    trailingNewline: stats.trailingNewline,
    containsTabs: stats.containsTabs,
    contentAvailable: !sensitive,
    content: sensitive ? null : text,
    materialIdentityVerified: true,
    exactUtf8Verified: true,
    sourceTrust: 'UNVERIFIED_INPUT',
    readOnly: true,
    advisoryOnly: true,
    instructionsAuthorized: false,
    renderingAuthorized: false,
    artifactMutationAuthorized: false,
    executionAuthorized: false,
    distributionAuthorized: false,
    externalDisclosureAuthorized: false,
    requiresCanonicalDisclosureAuthorization: sensitive,
  });
}
