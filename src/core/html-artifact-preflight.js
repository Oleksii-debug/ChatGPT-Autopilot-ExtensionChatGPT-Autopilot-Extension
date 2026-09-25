import { createSha256FingerprintV1 } from './fingerprint.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const HTML_ARTIFACT_PREFLIGHT_VERSION = 1;
export const MAX_HTML_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_HTML_CODE_UNITS = 2 * 1024 * 1024;

const REQUEST_KEYS = new Set(['schemaVersion', 'artifactRef', 'contentBase64']);
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml']);

const RISK_RULES = Object.freeze([
  ['SCRIPT_TAG', /<\s*script\b/iu],
  ['IFRAME_TAG', /<\s*iframe\b/iu],
  ['OBJECT_OR_EMBED_TAG', /<\s*(?:object|embed)\b/iu],
  ['SVG_OR_MATH_TAG', /<\s*(?:svg|math)\b/iu],
  ['BASE_TAG', /<\s*base\b/iu],
  ['FORM_TAG', /<\s*form\b/iu],
  ['META_REFRESH', /<\s*meta\b[^>]*\bhttp-equiv\s*=\s*(?:"\s*refresh\s*"|'\s*refresh\s*'|refresh\b)/iu],
  ['EVENT_HANDLER_ATTRIBUTE', /\bon[a-z][a-z0-9_-]*\s*=/iu],
  ['JAVASCRIPT_URL', /javascript\s*:/iu],
  ['DATA_URL', /\b(?:src|href|action|formaction|poster)\s*=\s*(?:"\s*data:|'\s*data:|data:)/iu],
  ['REMOTE_RESOURCE_URL', /\b(?:src|href|action|formaction|poster)\s*=\s*(?:"\s*(?:https?:)?\/\/|'\s*(?:https?:)?\/\/|(?:https?:)?\/\/)/iu],
  ['STYLE_SURFACE', /(?:<\s*style\b|\bstyle\s*=)/iu],
  ['IMPORT_OR_URL_CSS', /(?:@import\b|url\s*\()/iu],
]);

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain or null-prototype object');
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

function exactArtifactRef(value) {
  const raw = snapshotRecord(value, ARTIFACT_KEYS, 'HTML ArtifactRefV1');
  const normalized = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.is(raw[key], normalized[key])) {
      throw new Error('HTML ArtifactRefV1 is not already canonical: ' + key);
    }
  }
  if (!SHA256.test(normalized.sha256)) {
    throw new Error('HTML ArtifactRefV1 requires an exact lowercase SHA-256 digest');
  }
  if (!Number.isSafeInteger(normalized.sizeBytes)
      || Object.is(normalized.sizeBytes, -0)
      || normalized.sizeBytes < 1
      || normalized.sizeBytes > MAX_HTML_ARTIFACT_BYTES) {
    throw new Error('HTML ArtifactRefV1 sizeBytes must be 1..' + MAX_HTML_ARTIFACT_BYTES);
  }
  if (!MEDIA_TYPES.has(normalized.mediaType)) {
    throw new Error('HTML ArtifactRefV1 mediaType must be text/html or application/xhtml+xml');
  }
  return normalized;
}

function decodeCanonicalBase64(value) {
  const maxEncodedLength = Math.ceil(MAX_HTML_ARTIFACT_BYTES / 3) * 4;
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
  if (binary.length < 1 || binary.length > MAX_HTML_ARTIFACT_BYTES) {
    throw new Error('contentBase64 decoded bytes are outside admitted bounds');
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
    throw new Error('HTML artifact UTF-8 BOM is not admitted');
  }
  if (typeof globalThis.TextDecoder !== 'function'
      || typeof globalThis.TextEncoder !== 'function') {
    throw new Error('UTF-8 codec is unavailable');
  }
  let text;
  try {
    text = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('HTML artifact bytes must be valid UTF-8');
  }
  const roundTrip = new globalThis.TextEncoder().encode(text);
  if (!bytesEqual(bytes, roundTrip)) {
    throw new Error('HTML artifact bytes must round-trip through exact UTF-8');
  }
  if (text.length < 1 || text.length > MAX_HTML_CODE_UNITS) {
    throw new Error('HTML artifact text is outside admitted code-unit bounds');
  }
  return text;
}

function assertTextControls(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) throw new Error('HTML artifact contains NUL');
    if ((code >= 0x01 && code <= 0x08)
        || code === 0x0b
        || code === 0x0c
        || (code >= 0x0e && code <= 0x1f)
        || code === 0x7f) {
      throw new Error('HTML artifact contains a disallowed control character');
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error('HTML artifact contains an unpaired Unicode surrogate');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('HTML artifact contains an unpaired Unicode surrogate');
    }
  }
}

function lineFacts(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (code === 0x0a) {
      lf += 1;
    }
  }
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  let lineEnding = 'NONE';
  if (kinds > 1) lineEnding = 'MIXED';
  else if (crlf > 0) lineEnding = 'CRLF';
  else if (lf > 0) lineEnding = 'LF';
  else if (cr > 0) lineEnding = 'CR';
  return Object.freeze({
    lineEnding,
    lineCount: crlf + lf + cr + 1,
    crlfCount: crlf,
    lfCount: lf,
    crCount: cr,
  });
}

function lexicalFacts(text) {
  const indicators = [];
  for (const [id, pattern] of RISK_RULES) {
    if (pattern.test(text)) indicators.push(id);
  }
  indicators.sort();
  const doctypeDeclared = /<!doctype\s+html(?:\s|>)/iu.test(text);
  const htmlElementSeen = /<\s*html(?:\s|>)/iu.test(text);
  const markupSeen = /<\s*[!/?a-z]/iu.test(text);
  return Object.freeze({
    doctypeDeclared,
    htmlElementSeen,
    markupSeen,
    riskIndicators: Object.freeze(indicators),
    riskIndicatorCount: indicators.length,
    hasRiskIndicators: indicators.length > 0,
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Rebinds bounded HTML/XHTML bytes to an immutable ArtifactRefV1 and returns
 * deterministic lexical facts only. It deliberately does not parse a DOM,
 * render content, execute markup, authorize disclosure/publishing, or assert
 * that markup is safe. Risk indicators are conservative evidence for a later
 * qualified HTML/browser verifier.
 */
export async function preflightHtmlArtifactV1(input) {
  const raw = snapshotRecord(input, REQUEST_KEYS, 'HtmlArtifactPreflightV1 request');
  if (raw.schemaVersion !== HTML_ARTIFACT_PREFLIGHT_VERSION) {
    throw new Error('Unsupported HtmlArtifactPreflightV1 schemaVersion');
  }

  const artifactRef = exactArtifactRef(raw.artifactRef);
  const bytes = decodeCanonicalBase64(raw.contentBase64);
  if (bytes.byteLength !== artifactRef.sizeBytes) {
    throw new Error('HTML material byte length does not match immutable ArtifactRefV1');
  }

  const text = decodeExactUtf8(bytes);
  assertTextControls(text);
  const taggedDigest = await createSha256FingerprintV1(text, { cryptoApi: globalThis.crypto });
  const sha256 = taggedDigest.slice('sha256:'.length);
  if (sha256 !== artifactRef.sha256) {
    throw new Error('HTML material SHA-256 does not match immutable ArtifactRefV1');
  }

  const lines = lineFacts(text);
  const lexical = lexicalFacts(text);

  return deepFreeze({
    schemaVersion: HTML_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef,
    byteLength: bytes.byteLength,
    codeUnitLength: text.length,
    sha256,
    mediaType: artifactRef.mediaType,
    lines,
    lexical,
    sourceTrust: 'UNVERIFIED_INPUT',
    materialIdentityVerified: true,
    utf8Verified: true,
    controlCharactersVerified: true,
    textReturned: false,
    fullHtmlParsePerformed: false,
    domConstructed: false,
    activeContentScanComplete: false,
    safeForAutomaticRender: false,
    readOnly: true,
    advisoryOnly: true,
    artifactMutationAuthorized: false,
    renderingAuthorized: false,
    browserNavigationAuthorized: false,
    executionAuthorized: false,
    publishingAuthorized: false,
    distributionAuthorized: false,
    contentDisclosureAuthorized: false,
    policyDecisionAuthorized: false,
    requiresQualifiedHtmlParser: true,
    requiresCanonicalDisclosureAuthorization: artifactRef.sensitive === true,
  });
}
