import { createSha256FingerprintV1 } from './fingerprint.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const JSON_ARTIFACT_PREFLIGHT_VERSION = 1;
export const MAX_JSON_ARTIFACT_BYTES = 256 * 1024;
export const MAX_JSON_ARTIFACT_DEPTH = 64;
export const MAX_JSON_ARTIFACT_NODES = 10_000;
export const MAX_JSON_CONTAINER_ITEMS = 4_096;
export const MAX_JSON_STRING_CODE_UNITS = 64 * 1024;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'artifactRef',
  'contentBase64',
]);
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
const JSON_MEDIA_TYPE = /^application\/(?:json|[a-z0-9][a-z0-9.+-]*\+json)$/u;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain or null-prototype object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      throw new Error(`${label} is missing field: ${key}`);
    }
  }
  return out;
}

function exactArtifactRef(value) {
  const raw = snapshotRecord(value, ARTIFACT_KEYS, 'JSON ArtifactRefV1');
  const normalized = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.is(raw[key], normalized[key])) {
      throw new Error(`JSON ArtifactRefV1 is not already canonical: ${key}`);
    }
  }
  if (!SHA256.test(normalized.sha256)) {
    throw new Error('JSON ArtifactRefV1 requires an exact lowercase SHA-256 digest');
  }
  if (!Number.isSafeInteger(normalized.sizeBytes)
      || Object.is(normalized.sizeBytes, -0)
      || normalized.sizeBytes < 1
      || normalized.sizeBytes > MAX_JSON_ARTIFACT_BYTES) {
    throw new Error(
      `JSON ArtifactRefV1 sizeBytes must be 1..${MAX_JSON_ARTIFACT_BYTES}`,
    );
  }
  if (!JSON_MEDIA_TYPE.test(normalized.mediaType)) {
    throw new Error('JSON ArtifactRefV1 mediaType must be application/json or application/*+json');
  }
  return normalized;
}

function decodeCanonicalBase64(value) {
  const maxEncodedLength = Math.ceil(MAX_JSON_ARTIFACT_BYTES / 3) * 4;
  if (typeof value !== 'string'
      || value.length < 4
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
  if (binary.length < 1 || binary.length > MAX_JSON_ARTIFACT_BYTES) {
    throw new Error(
      `contentBase64 decoded bytes must be 1..${MAX_JSON_ARTIFACT_BYTES}`,
    );
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
    throw new Error('JSON artifact UTF-8 BOM is not admitted');
  }
  if (typeof globalThis.TextDecoder !== 'function'
      || typeof globalThis.TextEncoder !== 'function') {
    throw new Error('UTF-8 codec is unavailable');
  }
  let text;
  try {
    text = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('JSON artifact bytes must be valid UTF-8');
  }
  const roundTrip = new globalThis.TextEncoder().encode(text);
  if (!bytesEqual(bytes, roundTrip)) {
    throw new Error('JSON artifact bytes must round-trip through exact UTF-8');
  }
  return text;
}

function assertWellFormedUnicode(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${label} contains an unpaired Unicode surrogate`);
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${label} contains an unpaired Unicode surrogate`);
    }
  }
}

function parseBoundedJson(text) {
  let index = 0;
  const stats = {
    nodeCount: 0,
    objectCount: 0,
    arrayCount: 0,
    propertyCount: 0,
    stringCount: 0,
    numberCount: 0,
    booleanCount: 0,
    nullCount: 0,
    maxDepth: 0,
  };

  function skipWhitespace() {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        index += 1;
      } else {
        break;
      }
    }
  }

  function parseString(label) {
    if (text[index] !== '"') throw new Error(`${label} must be a JSON string`);
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        const token = text.slice(start, index);
        let value;
        try {
          value = JSON.parse(token);
        } catch {
          throw new Error(`${label} contains invalid JSON string syntax`);
        }
        if (value.length > MAX_JSON_STRING_CODE_UNITS) {
          throw new Error(
            `${label} exceeds ${MAX_JSON_STRING_CODE_UNITS} UTF-16 code units`,
          );
        }
        assertWellFormedUnicode(value, label);
        stats.stringCount += 1;
        return value;
      }
      if (code < 0x20) {
        throw new Error(`${label} contains an unescaped JSON control character`);
      }
      if (code === 0x5c) {
        index += 1;
        if (index >= text.length) throw new Error(`${label} has an incomplete escape`);
        const escape = text[index];
        if (escape === 'u') {
          if (index + 4 >= text.length
              || !/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) {
            throw new Error(`${label} has an invalid Unicode escape`);
          }
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) {
          throw new Error(`${label} has an invalid escape`);
        }
        index += 1;
        continue;
      }
      index += 1;
    }
    throw new Error(`${label} is unterminated`);
  }

  function registerNode(depth) {
    if (depth > MAX_JSON_ARTIFACT_DEPTH) {
      throw new Error(`JSON artifact exceeds maximum depth ${MAX_JSON_ARTIFACT_DEPTH}`);
    }
    stats.nodeCount += 1;
    if (stats.nodeCount > MAX_JSON_ARTIFACT_NODES) {
      throw new Error(`JSON artifact exceeds maximum node count ${MAX_JSON_ARTIFACT_NODES}`);
    }
    if (depth > stats.maxDepth) stats.maxDepth = depth;
  }

  function parseArray(depth) {
    stats.arrayCount += 1;
    index += 1;
    skipWhitespace();
    const out = [];
    if (text[index] === ']') {
      index += 1;
      return out;
    }
    while (true) {
      if (out.length >= MAX_JSON_CONTAINER_ITEMS) {
        throw new Error(
          `JSON array exceeds maximum item count ${MAX_JSON_CONTAINER_ITEMS}`,
        );
      }
      out.push(parseValue(depth + 1));
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return out;
      }
      if (text[index] !== ',') throw new Error('JSON array requires comma or closing bracket');
      index += 1;
      skipWhitespace();
      if (text[index] === ']') throw new Error('JSON array must not have a trailing comma');
    }
  }

  function parseObject(depth) {
    stats.objectCount += 1;
    index += 1;
    skipWhitespace();
    const out = Object.create(null);
    const keys = new Set();
    let count = 0;
    if (text[index] === '}') {
      index += 1;
      return out;
    }
    while (true) {
      if (count >= MAX_JSON_CONTAINER_ITEMS) {
        throw new Error(
          `JSON object exceeds maximum property count ${MAX_JSON_CONTAINER_ITEMS}`,
        );
      }
      if (text[index] !== '"') throw new Error('JSON object property name must be a string');
      const key = parseString('JSON object property name');
      if (keys.has(key)) {
        throw new Error(`JSON object contains duplicate property name: ${JSON.stringify(key)}`);
      }
      keys.add(key);
      count += 1;
      stats.propertyCount += 1;
      skipWhitespace();
      if (text[index] !== ':') throw new Error('JSON object property requires colon');
      index += 1;
      skipWhitespace();
      const value = parseValue(depth + 1);
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return out;
      }
      if (text[index] !== ',') throw new Error('JSON object requires comma or closing brace');
      index += 1;
      skipWhitespace();
      if (text[index] === '}') throw new Error('JSON object must not have a trailing comma');
    }
  }

  function parseNumber() {
    NUMBER.lastIndex = index;
    const match = NUMBER.exec(text);
    if (!match) throw new Error('JSON number syntax is invalid');
    index = NUMBER.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new Error('JSON number must remain finite in JavaScript representation');
    }
    stats.numberCount += 1;
    return value;
  }

  function parseLiteral(literal, value, counter) {
    if (text.slice(index, index + literal.length) !== literal) {
      throw new Error('JSON literal is invalid');
    }
    index += literal.length;
    stats[counter] += 1;
    return value;
  }

  function parseValue(depth) {
    skipWhitespace();
    registerNode(depth);
    const char = text[index];
    if (char === '{') return parseObject(depth);
    if (char === '[') return parseArray(depth);
    if (char === '"') return parseString('JSON string');
    if (char === 't') return parseLiteral('true', true, 'booleanCount');
    if (char === 'f') return parseLiteral('false', false, 'booleanCount');
    if (char === 'n') return parseLiteral('null', null, 'nullCount');
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    if (char == null) throw new Error('JSON artifact is empty or incomplete');
    throw new Error(`JSON value begins with invalid token at offset ${index}`);
  }

  skipWhitespace();
  if (index >= text.length) throw new Error('JSON artifact must contain one JSON value');
  const value = parseValue(0);
  skipWhitespace();
  if (index !== text.length) {
    throw new Error(`JSON artifact contains trailing material at offset ${index}`);
  }
  return { value, stats };
}

function typeOfJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Verifies immutable JSON material and returns a bounded, read-only structural
 * projection. This function never writes artifacts, authorizes disclosure,
 * grants policy, executes providers, or mutates the Artifact Workspace.
 */
export async function preflightJsonArtifactV1(input, {
  cryptoImpl = globalThis.crypto,
} = {}) {
  const raw = snapshotRecord(input, REQUEST_KEYS, 'JsonArtifactPreflightV1 request');
  if (raw.schemaVersion !== JSON_ARTIFACT_PREFLIGHT_VERSION) {
    throw new Error('Unsupported JsonArtifactPreflightV1 schemaVersion');
  }

  const artifactRef = exactArtifactRef(raw.artifactRef);
  const bytes = decodeCanonicalBase64(raw.contentBase64);
  if (bytes.byteLength !== artifactRef.sizeBytes) {
    throw new Error('JSON material byte length does not match immutable ArtifactRefV1');
  }

  const text = decodeExactUtf8(bytes);
  const digest = await createSha256FingerprintV1(text, { cryptoApi: cryptoImpl });
  const sha256 = digest.slice('sha256:'.length);
  if (sha256 !== artifactRef.sha256) {
    throw new Error('JSON material SHA-256 does not match immutable ArtifactRefV1');
  }

  const parsed = parseBoundedJson(text);
  deepFreeze(parsed.value);
  const structural = Object.freeze({
    topLevelType: typeOfJson(parsed.value),
    nodeCount: parsed.stats.nodeCount,
    objectCount: parsed.stats.objectCount,
    arrayCount: parsed.stats.arrayCount,
    propertyCount: parsed.stats.propertyCount,
    stringCount: parsed.stats.stringCount,
    numberCount: parsed.stats.numberCount,
    booleanCount: parsed.stats.booleanCount,
    nullCount: parsed.stats.nullCount,
    maxDepth: parsed.stats.maxDepth,
  });

  return deepFreeze({
    schemaVersion: JSON_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef,
    byteLength: bytes.byteLength,
    sha256,
    mediaType: artifactRef.mediaType,
    structural,
    valueAvailable: artifactRef.sensitive !== true,
    value: artifactRef.sensitive === true ? null : parsed.value,
    materialIdentityVerified: true,
    utf8Verified: true,
    duplicateKeysRejected: true,
    prototypeSafeProjection: true,
    readOnly: true,
    advisoryOnly: true,
    artifactMutationAuthorized: false,
    distributionAuthorized: false,
    contentDisclosureAuthorized: false,
    executionAuthorized: false,
    policyDecisionAuthorized: false,
    requiresCanonicalDisclosureAuthorization: artifactRef.sensitive === true,
  });
}
