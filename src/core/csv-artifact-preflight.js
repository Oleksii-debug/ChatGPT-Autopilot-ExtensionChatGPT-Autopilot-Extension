import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const CSV_ARTIFACT_PREFLIGHT_VERSION = 1;
export const MAX_CSV_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_CSV_ROWS = 10_000;
export const MAX_CSV_COLUMNS = 256;
export const MAX_CSV_CELL_CODE_UNITS = 32 * 1024;
export const MAX_CSV_TOTAL_CELLS = 250_000;

export const CsvHeaderMode = Object.freeze({
  NONE: 'NONE',
  REQUIRED: 'REQUIRED',
});

const REQUEST_KEYS = new Set(['schemaVersion', 'artifactRef', 'csvBase64', 'headerMode']);
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
const SHA256 = /^[a-f0-9]{64}$/u;

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
  const raw = snapshotRecord(value, ARTIFACT_KEYS, 'CSV ArtifactRefV1');
  const normalized = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (normalized[key] !== raw[key]) {
      throw new Error('CSV ArtifactRefV1 must already use canonical representation: ' + key);
    }
  }
  if (normalized.mediaType !== 'text/csv') {
    throw new Error('CSV ArtifactRefV1 mediaType must be exactly text/csv');
  }
  if (!SHA256.test(normalized.sha256)) {
    throw new Error('CSV ArtifactRefV1 requires an immutable lowercase SHA-256 digest');
  }
  if (normalized.sizeBytes < 1 || normalized.sizeBytes > MAX_CSV_ARTIFACT_BYTES) {
    throw new Error('CSV ArtifactRefV1 sizeBytes exceeds the bounded CSV preflight range');
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
    throw new Error('csvBase64 must be canonical Base64 text');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const payloadLength = value.length - padding;
  if (value.slice(0, payloadLength).includes('=')) {
    throw new Error('csvBase64 contains non-terminal padding');
  }
  const byteLength = (value.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_CSV_ARTIFACT_BYTES) {
    throw new Error('csvBase64 decoded length exceeds the bounded CSV preflight range');
  }
  if (byteLength !== expectedSize) {
    throw new Error('csvBase64 decoded byte length does not match immutable ArtifactRef');
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
      throw new Error('csvBase64 contains invalid Base64 data');
    }
    if (last && padding === 2 && (sextets[1] & 15) !== 0) {
      throw new Error('csvBase64 contains non-canonical unused bits');
    }
    if (last && padding === 1 && (sextets[2] & 3) !== 0) {
      throw new Error('csvBase64 contains non-canonical unused bits');
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

function decodeUtf8(bytes) {
  const bom = bytes.length >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf;
  const material = bom ? bytes.subarray(3) : bytes;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(material);
  } catch {
    throw new Error('CSV material is not valid UTF-8');
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const unsafeC0 = code < 32 && code !== 9 && code !== 10 && code !== 13;
    const unsafeC1 = code >= 0x7f && code <= 0x9f;
    if (unsafeC0 || unsafeC1 || code === 0xfeff || code === 0x2028 || code === 0x2029) {
      throw new Error('CSV material contains an unsafe control character');
    }
  }
  return Object.freeze({ text, utf8BomPresent: bom });
}

function headerMode(value) {
  if (value !== CsvHeaderMode.NONE && value !== CsvHeaderMode.REQUIRED) {
    throw new Error('headerMode must be NONE or REQUIRED');
  }
  return value;
}

function parseCsv(text) {
  const rows = [];
  let fields = [];
  let cell = '';
  let inQuotes = false;
  let quoteClosed = false;
  let lineEnding = null;
  let totalCells = 0;

  const append = value => {
    cell += value;
    if (cell.length > MAX_CSV_CELL_CODE_UNITS) {
      throw new Error('CSV cell exceeds the bounded cell size');
    }
  };

  const finishField = () => {
    if (fields.length >= MAX_CSV_COLUMNS) {
      throw new Error('CSV row exceeds the bounded column count');
    }
    fields.push(cell);
    totalCells += 1;
    if (totalCells > MAX_CSV_TOTAL_CELLS) {
      throw new Error('CSV material exceeds the bounded total cell count');
    }
    cell = '';
    quoteClosed = false;
  };

  const finishRow = () => {
    finishField();
    if (rows.length >= MAX_CSV_ROWS) {
      throw new Error('CSV material exceeds the bounded row count');
    }
    rows.push(fields);
    fields = [];
  };

  const noteLineEnding = kind => {
    if (lineEnding === null) lineEnding = kind;
    else if (lineEnding !== kind) throw new Error('CSV material mixes LF and CRLF line endings');
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          append('"');
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
        continue;
      }
      if (char === '\r') {
        if (text[index + 1] !== '\n') {
          throw new Error('CSV material contains a bare CR line ending');
        }
        noteLineEnding('CRLF');
        append('\r\n');
        index += 1;
        continue;
      }
      if (char === '\n') {
        noteLineEnding('LF');
        append('\n');
        continue;
      }
      append(char);
      continue;
    }

    if (quoteClosed) {
      if (char === ',') {
        finishField();
        continue;
      }
      if (char === '\r') {
        if (text[index + 1] !== '\n') {
          throw new Error('CSV material contains a bare CR line ending');
        }
        noteLineEnding('CRLF');
        finishRow();
        index += 1;
        continue;
      }
      if (char === '\n') {
        noteLineEnding('LF');
        finishRow();
        continue;
      }
      throw new Error('CSV quoted field has material after its closing quote');
    }

    if (char === '"' && cell.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === '"') {
      throw new Error('CSV unquoted field contains a quote');
    }
    if (char === ',') {
      finishField();
      continue;
    }
    if (char === '\r') {
      if (text[index + 1] !== '\n') {
        throw new Error('CSV material contains a bare CR line ending');
      }
      noteLineEnding('CRLF');
      finishRow();
      index += 1;
      continue;
    }
    if (char === '\n') {
      noteLineEnding('LF');
      finishRow();
      continue;
    }
    append(char);
  }

  if (inQuotes) throw new Error('CSV quoted field is unterminated');
  if (fields.length > 0 || cell.length > 0 || quoteClosed) finishRow();
  if (rows.length === 0) throw new Error('CSV material must contain at least one row');

  const columnCount = rows[0].length;
  if (columnCount < 1 || columnCount > MAX_CSV_COLUMNS) {
    throw new Error('CSV column count is invalid');
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].length !== columnCount) {
      throw new Error('CSV row ' + (index + 1) + ' has inconsistent column count');
    }
  }

  return {
    rows,
    rowCount: rows.length,
    columnCount,
    totalCells,
    lineEnding: lineEnding || 'NONE',
  };
}

function normalizeHeaders(rows, mode) {
  if (mode === CsvHeaderMode.NONE) return Object.freeze([]);
  const headers = rows[0];
  const normalizedSeen = new Set();
  for (let index = 0; index < headers.length; index += 1) {
    const value = headers[index];
    if (value.length === 0 || value !== value.trim()) {
      throw new Error('CSV header ' + (index + 1) + ' must be non-empty canonical text');
    }
    const key = value.toLowerCase();
    if (normalizedSeen.has(key)) {
      throw new Error('CSV headers must be unique under case-insensitive comparison');
    }
    normalizedSeen.add(key);
  }
  return Object.freeze([...headers]);
}

function formulaRiskFindings(rows, headers, mode) {
  const findings = [];
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length; column += 1) {
      const match = /^[\t\r\n ]*([=+\-@])/u.exec(rows[row][column]);
      if (!match) continue;
      findings.push(Object.freeze({
        row: row + 1,
        column: column + 1,
        header: mode === CsvHeaderMode.REQUIRED ? headers[column] : null,
        trigger: match[1],
      }));
    }
  }
  return Object.freeze(findings);
}

function freezeRows(rows) {
  return Object.freeze(rows.map(row => Object.freeze([...row])));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Verifies immutable CSV material and parses only a strict, bounded CSV subset.
 * It never evaluates formulas or grants import/open/write/distribution authority.
 */
export async function buildCsvArtifactPreflightV1(raw, { cryptoApi = globalThis.crypto } = {}) {
  const input = snapshotRecord(raw, REQUEST_KEYS, 'CsvArtifactPreflightV1 request');
  if (input.schemaVersion !== CSV_ARTIFACT_PREFLIGHT_VERSION) {
    throw new Error('Unsupported CsvArtifactPreflightV1 schemaVersion');
  }
  const mode = headerMode(input.headerMode);
  const artifactRef = exactArtifactRef(input.artifactRef);
  const bytes = decodeCanonicalBase64(input.csvBase64, artifactRef.sizeBytes);
  const sha256 = await sha256Bytes(bytes, cryptoApi);
  if (sha256 !== artifactRef.sha256) {
    throw new Error('CSV material SHA-256 does not match immutable ArtifactRef');
  }

  const decoded = decodeUtf8(bytes);
  const parsed = parseCsv(decoded.text);
  const headers = normalizeHeaders(parsed.rows, mode);
  const formulaRisks = formulaRiskFindings(parsed.rows, headers, mode);
  const requiresCanonicalDisclosureAuthorization = artifactRef.sensitive === true;

  return deepFreeze({
    schemaVersion: CSV_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef,
    sha256,
    byteLength: bytes.byteLength,
    utf8Verified: true,
    utf8BomPresent: decoded.utf8BomPresent,
    headerMode: mode,
    headers,
    rowCount: parsed.rowCount,
    dataRowCount: mode === CsvHeaderMode.REQUIRED ? parsed.rowCount - 1 : parsed.rowCount,
    columnCount: parsed.columnCount,
    totalCells: parsed.totalCells,
    lineEnding: parsed.lineEnding,
    rows: freezeRows(parsed.rows),
    formulaEvaluationPerformed: false,
    formulaRiskDetected: formulaRisks.length > 0,
    formulaRiskFindings: formulaRisks,
    safeForAutomaticSpreadsheetOpen:
      formulaRisks.length === 0 && !requiresCanonicalDisclosureAuthorization,
    materialIdentityVerified: true,
    requiresCanonicalDisclosureAuthorization,
    disclosureAuthorized: false,
    readOnly: true,
    advisoryOnly: true,
    automaticOpenAuthorized: false,
    importAuthorized: false,
    writeAuthorized: false,
    distributionAuthorized: false,
    executionAuthorized: false,
  });
}
