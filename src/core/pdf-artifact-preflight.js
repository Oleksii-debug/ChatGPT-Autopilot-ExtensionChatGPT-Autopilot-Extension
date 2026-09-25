import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const PDF_ARTIFACT_PREFLIGHT_VERSION = 1;
export const MAX_PDF_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const PDF_PASSIVE_SCREEN_SCOPE = 'STRUCTURAL_NAME_TOKENS_OUTSIDE_STREAMS';

const REQUEST_KEYS = new Set(['schemaVersion', 'artifactRef', 'pdfBase64']);
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);

const ACTIVE_NAMES = new Map([
  ['AA', 'ADDITIONAL_ACTIONS'],
  ['EmbeddedFile', 'EMBEDDED_FILE'],
  ['EmbeddedFiles', 'EMBEDDED_FILES'],
  ['ImportData', 'IMPORT_DATA'],
  ['JavaScript', 'JAVASCRIPT'],
  ['JS', 'JAVASCRIPT_SHORT_NAME'],
  ['Launch', 'LAUNCH'],
  ['Movie', 'MOVIE'],
  ['OpenAction', 'OPEN_ACTION'],
  ['RichMedia', 'RICH_MEDIA'],
  ['Sound', 'SOUND'],
  ['SubmitForm', 'SUBMIT_FORM'],
  ['URI', 'EXTERNAL_URI'],
  ['XFA', 'XFA'],
]);

function snapshotRecord(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  const seen = new Set();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
    out[key] = descriptor.value;
    seen.add(key);
  }
  for (const key of allowedKeys) {
    if (!seen.has(key)) throw new Error(label + ' is missing field: ' + key);
  }
  return out;
}

function exactArtifactRef(value) {
  const raw = snapshotRecord(value, ARTIFACT_KEYS, 'PDF ArtifactRefV1');
  const normalized = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (normalized[key] !== raw[key]) {
      throw new Error('PDF ArtifactRefV1 must already use canonical representation: ' + key);
    }
  }
  if (normalized.mediaType !== 'application/pdf') {
    throw new Error('PDF ArtifactRefV1 mediaType must be exactly application/pdf');
  }
  if (!normalized.sha256) {
    throw new Error('PDF ArtifactRefV1 requires an immutable SHA-256 digest');
  }
  if (normalized.sizeBytes < 1 || normalized.sizeBytes > MAX_PDF_ARTIFACT_BYTES) {
    throw new Error('PDF ArtifactRefV1 sizeBytes exceeds the bounded PDF preflight range');
  }
  return normalized;
}

function base64Value(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function decodeCanonicalBase64(value, expectedSize) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new Error('pdfBase64 must be canonical padded Base64 text');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const payloadLength = value.length - padding;
  if (value.slice(0, payloadLength).includes('=')) {
    throw new Error('pdfBase64 contains non-terminal padding');
  }
  const byteLength = (value.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_PDF_ARTIFACT_BYTES) {
    throw new Error('pdfBase64 decoded length exceeds the bounded PDF preflight range');
  }
  if (byteLength !== expectedSize) {
    throw new Error('pdfBase64 decoded byte length does not match immutable ArtifactRef');
  }

  const bytes = new Uint8Array(byteLength);
  let out = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const last = offset + 4 === value.length;
    const codes = [
      value.charCodeAt(offset),
      value.charCodeAt(offset + 1),
      value.charCodeAt(offset + 2),
      value.charCodeAt(offset + 3),
    ];
    const sextets = [
      base64Value(codes[0]),
      base64Value(codes[1]),
      codes[2] === 61 && last ? 0 : base64Value(codes[2]),
      codes[3] === 61 && last ? 0 : base64Value(codes[3]),
    ];
    if (sextets.some(item => item < 0)
        || (codes[2] === 61 && (!last || padding !== 2))
        || (codes[3] === 61 && (!last || padding < 1))) {
      throw new Error('pdfBase64 contains invalid Base64 data');
    }
    if (last && padding === 2 && (sextets[1] & 15) !== 0) {
      throw new Error('pdfBase64 contains non-canonical unused bits');
    }
    if (last && padding === 1 && (sextets[2] & 3) !== 0) {
      throw new Error('pdfBase64 contains non-canonical unused bits');
    }
    const word = (sextets[0] << 18) | (sextets[1] << 12) | (sextets[2] << 6) | sextets[3];
    if (out < byteLength) bytes[out++] = (word >>> 16) & 255;
    if (out < byteLength) bytes[out++] = (word >>> 8) & 255;
    if (out < byteLength) bytes[out++] = word & 255;
  }
  return bytes;
}

function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function sha256Bytes(bytes, cryptoApi) {
  if (!cryptoApi?.subtle?.digest) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

function isPdfWhitespace(byte) {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function isDelimiter(byte) {
  return isPdfWhitespace(byte)
    || byte === 40 || byte === 41 || byte === 60 || byte === 62
    || byte === 91 || byte === 93 || byte === 123 || byte === 125
    || byte === 47 || byte === 37;
}

function asciiAt(bytes, offset, value) {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function asciiSlice(bytes, start, end) {
  let out = '';
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index];
    if (byte > 127) throw new Error('PDF structural token contains non-ASCII bytes');
    out += String.fromCharCode(byte);
  }
  return out;
}

function verifyEnvelope(bytes) {
  if (bytes.length < 32) throw new Error('PDF material is too short to contain a valid envelope');
  const header = asciiSlice(bytes, 0, Math.min(8, bytes.length));
  const match = /^%PDF-(1\.[0-7]|2\.0)$/u.exec(header);
  if (!match) throw new Error('PDF header/version is not admitted');

  let last = bytes.length - 1;
  while (last >= 0 && isPdfWhitespace(bytes[last])) last -= 1;
  const eofStart = last - 4;
  if (eofStart < 8 || !asciiAt(bytes, eofStart, '%%EOF')) {
    throw new Error('PDF final %%EOF marker is missing');
  }

  const lowerBound = Math.max(8, eofStart - 4096);
  let startXref = -1;
  for (let index = eofStart - 9; index >= lowerBound; index -= 1) {
    if (!asciiAt(bytes, index, 'startxref')) continue;
    const before = index === 0 ? 32 : bytes[index - 1];
    const afterIndex = index + 9;
    const after = afterIndex >= bytes.length ? 32 : bytes[afterIndex];
    if ((index === 0 || isDelimiter(before)) && isDelimiter(after)) {
      startXref = index;
      break;
    }
  }
  if (startXref < 0) throw new Error('PDF final startxref marker is missing');

  let cursor = startXref + 9;
  while (cursor < eofStart && isPdfWhitespace(bytes[cursor])) cursor += 1;
  const digitsStart = cursor;
  let offset = 0;
  while (cursor < eofStart && bytes[cursor] >= 48 && bytes[cursor] <= 57) {
    offset = offset * 10 + bytes[cursor] - 48;
    if (!Number.isSafeInteger(offset)) throw new Error('PDF startxref offset is not a safe integer');
    cursor += 1;
  }
  if (cursor === digitsStart) throw new Error('PDF startxref offset is missing');
  while (cursor < eofStart && isPdfWhitespace(bytes[cursor])) cursor += 1;
  if (cursor !== eofStart) throw new Error('PDF final startxref envelope contains unexpected material');
  if (offset < 8 || offset >= startXref) {
    throw new Error('PDF startxref offset is outside the bounded structural region');
  }

  return Object.freeze({
    pdfVersion: match[1],
    eofOffset: eofStart,
    startXrefOffset: startXref,
    referencedXrefOffset: offset,
  });
}

function hexNibble(byte) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return -1;
}

function readName(bytes, slashIndex) {
  const decoded = [];
  let cursor = slashIndex + 1;
  while (cursor < bytes.length && !isDelimiter(bytes[cursor])) {
    if (bytes[cursor] === 35) {
      if (cursor + 2 >= bytes.length) throw new Error('PDF name contains truncated #xx escape');
      const high = hexNibble(bytes[cursor + 1]);
      const low = hexNibble(bytes[cursor + 2]);
      if (high < 0 || low < 0) throw new Error('PDF name contains malformed #xx escape');
      decoded.push((high << 4) | low);
      cursor += 3;
      continue;
    }
    decoded.push(bytes[cursor]);
    cursor += 1;
  }
  let ascii = '';
  for (const byte of decoded) {
    if (byte > 127) return { name: null, next: cursor };
    ascii += String.fromCharCode(byte);
  }
  return { name: ascii, next: cursor };
}

function skipLiteralString(bytes, start) {
  let depth = 1;
  let cursor = start + 1;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    if (byte === 92) {
      cursor += 1;
      if (cursor < bytes.length && bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 1;
      cursor += 1;
      continue;
    }
    if (byte === 40) depth += 1;
    if (byte === 41) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  throw new Error('PDF contains an unterminated literal string');
}

function skipHexString(bytes, start) {
  let cursor = start + 1;
  while (cursor < bytes.length) {
    if (bytes[cursor] === 62) return cursor + 1;
    cursor += 1;
  }
  throw new Error('PDF contains an unterminated hexadecimal string');
}

function keywordBoundary(bytes, start, length) {
  const beforeOk = start === 0 || isDelimiter(bytes[start - 1]);
  const after = start + length;
  const afterOk = after >= bytes.length || isDelimiter(bytes[after]);
  return beforeOk && afterOk;
}

function findEndstream(bytes, start) {
  for (let cursor = start; cursor + 9 <= bytes.length; cursor += 1) {
    if (!asciiAt(bytes, cursor, 'endstream') || !keywordBoundary(bytes, cursor, 9)) continue;
    if (cursor > 0 && bytes[cursor - 1] !== 10 && bytes[cursor - 1] !== 13) continue;
    return cursor;
  }
  return -1;
}

function scanPassiveStructuralNames(bytes) {
  const findings = new Map();
  let streamCount = 0;
  let cursor = 0;

  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    if (isPdfWhitespace(byte)) {
      cursor += 1;
      continue;
    }
    if (byte === 37) {
      while (cursor < bytes.length && bytes[cursor] !== 10 && bytes[cursor] !== 13) cursor += 1;
      continue;
    }
    if (byte === 40) {
      cursor = skipLiteralString(bytes, cursor);
      continue;
    }
    if (byte === 60 && bytes[cursor + 1] !== 60) {
      cursor = skipHexString(bytes, cursor);
      continue;
    }
    if (byte === 47) {
      const parsed = readName(bytes, cursor);
      if (parsed.name && ACTIVE_NAMES.has(parsed.name)) {
        findings.set(parsed.name, ACTIVE_NAMES.get(parsed.name));
      }
      cursor = parsed.next;
      continue;
    }
    if (isDelimiter(byte)) {
      cursor += 1;
      continue;
    }

    const tokenStart = cursor;
    while (cursor < bytes.length && !isDelimiter(bytes[cursor])) cursor += 1;
    const tokenLength = cursor - tokenStart;
    if (tokenLength === 6 && asciiAt(bytes, tokenStart, 'stream')) {
      if (cursor >= bytes.length) throw new Error('PDF stream keyword lacks end-of-line');
      if (bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 2;
      else if (bytes[cursor] === 10 || bytes[cursor] === 13) cursor += 1;
      else throw new Error('PDF stream keyword must be followed by end-of-line');
      const endstream = findEndstream(bytes, cursor);
      if (endstream < 0) throw new Error('PDF stream is not terminated by endstream');
      streamCount += 1;
      cursor = endstream + 9;
    }
  }

  const activeContentFindings = [...findings.entries()]
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
    .map(([name, risk]) => Object.freeze({ name: '/' + name, risk }));

  return Object.freeze({
    streamCount,
    activeContentFindings: Object.freeze(activeContentFindings),
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Verifies bounded PDF bytes against one immutable ArtifactRef and performs a
 * deliberately narrow passive structural-name screen.
 *
 * This is not a PDF parser, renderer, extractor, accessibility verifier, or
 * malware scanner. It grants no approval, disclosure, distribution, or
 * execution authority. Downstream parsing/rendering remains independently
 * qualified work.
 */
export async function buildPdfArtifactPreflightV1(raw, { cryptoApi = globalThis.crypto } = {}) {
  const input = snapshotRecord(raw, REQUEST_KEYS, 'PdfArtifactPreflightV1 request');
  if (input.schemaVersion !== PDF_ARTIFACT_PREFLIGHT_VERSION) {
    throw new Error('Unsupported PdfArtifactPreflightV1 schemaVersion');
  }

  const artifactRef = exactArtifactRef(input.artifactRef);
  const bytes = decodeCanonicalBase64(input.pdfBase64, artifactRef.sizeBytes);
  const sha256 = await sha256Bytes(bytes, cryptoApi);
  if (sha256 !== artifactRef.sha256) {
    throw new Error('PDF material SHA-256 does not match immutable ArtifactRef');
  }

  const envelope = verifyEnvelope(bytes);
  const screen = scanPassiveStructuralNames(bytes);
  const activeContentDetected = screen.activeContentFindings.length > 0;

  return deepFreeze({
    schemaVersion: PDF_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef,
    byteLength: bytes.byteLength,
    sha256,
    formatEnvelopeVerified: true,
    pdfVersion: envelope.pdfVersion,
    eofOffset: envelope.eofOffset,
    startXrefOffset: envelope.startXrefOffset,
    referencedXrefOffset: envelope.referencedXrefOffset,
    streamCount: screen.streamCount,
    passiveSafetyScreenScope: PDF_PASSIVE_SCREEN_SCOPE,
    activeContentDetected,
    activeContentFindings: screen.activeContentFindings,
    safePassiveReviewReady: !activeContentDetected,
    materialIdentityVerified: true,
    fullPdfParsePerformed: false,
    extractionAuthorized: false,
    accessibilityVerified: false,
    requiresQualifiedParserOrRenderer: true,
    requiresCanonicalDisclosureAuthorization: artifactRef.sensitive === true,
    disclosureAuthorized: false,
    readOnly: true,
    advisoryOnly: true,
    approvalAuthorized: false,
    distributionAuthorized: false,
    executionAuthorized: false,
  });
}
