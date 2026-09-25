import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const MEDIA_ARTIFACT_PREFLIGHT_VERSION = 1;
export const MAX_MEDIA_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_WAV_CHUNKS = 128;
export const MAX_BMFF_TOP_LEVEL_BOXES = 2048;

const REQUEST_KEYS = new Set(['schemaVersion', 'artifactRef', 'mediaBase64']);
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
const MEDIA_TYPES = new Set(['audio/wav', 'audio/mp4', 'video/mp4']);
const SHA256 = /^[a-f0-9]{64}$/u;
const WAV_BITS = new Set([8, 16, 24, 32]);
const ISO_BMFF_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6',
  'mp41', 'mp42', 'M4A ', 'M4B ', 'M4V ', 'avc1', 'dash',
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
    if (!descriptor
        || descriptor.enumerable !== true
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
  const raw = snapshotRecord(value, ARTIFACT_KEYS, 'Media ArtifactRefV1');
  const normalized = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.is(normalized[key], raw[key])) {
      throw new Error('Media ArtifactRefV1 must already use canonical representation: ' + key);
    }
  }
  if (!MEDIA_TYPES.has(normalized.mediaType)) {
    throw new Error('Media ArtifactRefV1 mediaType is unsupported');
  }
  if (!SHA256.test(normalized.sha256)) {
    throw new Error('Media ArtifactRefV1 requires an exact lowercase SHA-256 digest');
  }
  if (!Number.isSafeInteger(normalized.sizeBytes)
      || normalized.sizeBytes < 1
      || normalized.sizeBytes > MAX_MEDIA_ARTIFACT_BYTES) {
    throw new Error('Media ArtifactRefV1 sizeBytes exceeds the bounded media preflight range');
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
    throw new Error('mediaBase64 must be canonical padded Base64 text');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const payloadLength = value.length - padding;
  if (value.slice(0, payloadLength).includes('=')) {
    throw new Error('mediaBase64 contains non-terminal padding');
  }
  const byteLength = (value.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(byteLength)
      || byteLength < 1
      || byteLength > MAX_MEDIA_ARTIFACT_BYTES) {
    throw new Error('mediaBase64 decoded length exceeds the bounded media preflight range');
  }
  if (byteLength !== expectedSize) {
    throw new Error('mediaBase64 decoded byte length does not match immutable ArtifactRef');
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
      throw new Error('mediaBase64 contains invalid Base64 data');
    }
    if (last && padding === 2 && (sextets[1] & 15) !== 0) {
      throw new Error('mediaBase64 contains non-canonical unused bits');
    }
    if (last && padding === 1 && (sextets[2] & 3) !== 0) {
      throw new Error('mediaBase64 contains non-canonical unused bits');
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

function ascii(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset)
      || !Number.isSafeInteger(length)
      || offset < 0
      || length < 0
      || offset + length > bytes.length) {
    throw new Error(label + ' exceeds media material bounds');
  }
  let out = '';
  for (let index = offset; index < offset + length; index += 1) {
    const byte = bytes[index];
    if (byte < 32 || byte > 126) throw new Error(label + ' must contain printable ASCII');
    out += String.fromCharCode(byte);
  }
  return out;
}

function asciiEquals(bytes, offset, value) {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readUint16Le(bytes, offset, label) {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error(label + ' is truncated');
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32Le(bytes, offset, label) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error(label + ' is truncated');
  return (
    bytes[offset]
    + bytes[offset + 1] * 0x100
    + bytes[offset + 2] * 0x10000
    + bytes[offset + 3] * 0x1000000
  );
}

function readUint32Be(bytes, offset, label) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error(label + ' is truncated');
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  );
}

function readUint64BeSafe(bytes, offset, label) {
  const high = readUint32Be(bytes, offset, label);
  const low = readUint32Be(bytes, offset + 4, label);
  if (high > Math.floor(Number.MAX_SAFE_INTEGER / 0x100000000)) {
    throw new Error(label + ' exceeds safe integer range');
  }
  const value = high * 0x100000000 + low;
  if (!Number.isSafeInteger(value)) throw new Error(label + ' exceeds safe integer range');
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function inspectPcmWav(bytes) {
  if (bytes.length < 44
      || !asciiEquals(bytes, 0, 'RIFF')
      || !asciiEquals(bytes, 8, 'WAVE')) {
    throw new Error('WAV material is missing RIFF/WAVE envelope');
  }
  const riffPayloadSize = readUint32Le(bytes, 4, 'WAV RIFF size');
  if (riffPayloadSize !== bytes.length - 8) {
    throw new Error('WAV RIFF size does not match immutable material length');
  }

  let offset = 12;
  let chunkCount = 0;
  let fmt = null;
  let dataBytes = null;
  while (offset < bytes.length) {
    if (chunkCount >= MAX_WAV_CHUNKS) throw new Error('WAV chunk count exceeds bounded preflight range');
    if (offset + 8 > bytes.length) throw new Error('WAV contains a truncated chunk header');
    const chunkId = ascii(bytes, offset, 4, 'WAV chunk id');
    const chunkSize = readUint32Le(bytes, offset + 4, 'WAV chunk size');
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > bytes.length) {
      throw new Error('WAV chunk payload exceeds immutable material bounds');
    }

    if (chunkId === 'fmt ') {
      if (fmt) throw new Error('WAV contains ambiguous duplicate fmt chunks');
      if (chunkSize < 16) throw new Error('WAV fmt chunk is too short');
      const audioFormat = readUint16Le(bytes, payloadStart, 'WAV audio format');
      const channels = readUint16Le(bytes, payloadStart + 2, 'WAV channel count');
      const sampleRate = readUint32Le(bytes, payloadStart + 4, 'WAV sample rate');
      const byteRate = readUint32Le(bytes, payloadStart + 8, 'WAV byte rate');
      const blockAlign = readUint16Le(bytes, payloadStart + 12, 'WAV block align');
      const bitsPerSample = readUint16Le(bytes, payloadStart + 14, 'WAV bits per sample');
      if (audioFormat !== 1) throw new Error('WAV preflight admits only uncompressed PCM format 1');
      if (!Number.isSafeInteger(channels) || channels < 1 || channels > 8) {
        throw new Error('WAV channel count must be 1..8');
      }
      if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
        throw new Error('WAV sample rate must be 8000..192000 Hz');
      }
      if (!WAV_BITS.has(bitsPerSample)) {
        throw new Error('WAV PCM bits per sample must be 8, 16, 24, or 32');
      }
      const expectedBlockAlign = channels * (bitsPerSample / 8);
      const expectedByteRate = sampleRate * expectedBlockAlign;
      if (!Number.isSafeInteger(expectedBlockAlign)
          || blockAlign !== expectedBlockAlign
          || byteRate !== expectedByteRate) {
        throw new Error('WAV PCM byte-rate/block-align invariants do not match format');
      }
      fmt = {
        audioFormat,
        channels,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample,
      };
    } else if (chunkId === 'data') {
      if (dataBytes !== null) throw new Error('WAV contains ambiguous duplicate data chunks');
      if (chunkSize < 1) throw new Error('WAV data chunk must not be empty');
      dataBytes = chunkSize;
    }

    chunkCount += 1;
    const paddedEnd = payloadEnd + (chunkSize % 2);
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > bytes.length) {
      throw new Error('WAV chunk padding exceeds immutable material bounds');
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length) throw new Error('WAV chunks do not consume immutable material exactly');
  if (!fmt) throw new Error('WAV material is missing fmt chunk');
  if (dataBytes === null) throw new Error('WAV material is missing data chunk');
  if (dataBytes % fmt.blockAlign !== 0) {
    throw new Error('WAV data length is not aligned to complete PCM sample frames');
  }
  const sampleFrames = dataBytes / fmt.blockAlign;
  if (!Number.isSafeInteger(sampleFrames) || sampleFrames < 1) {
    throw new Error('WAV PCM sample frame count is invalid');
  }
  const durationMillisFloor = Math.floor(sampleFrames * 1000 / fmt.sampleRate);
  if (!Number.isSafeInteger(durationMillisFloor)) {
    throw new Error('WAV duration metadata exceeds safe integer range');
  }
  return deepFreeze({
    container: 'RIFF_WAVE_PCM',
    chunkCount,
    channels: fmt.channels,
    sampleRateHz: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    blockAlignBytes: fmt.blockAlign,
    byteRate: fmt.byteRate,
    dataBytes,
    sampleFrames,
    durationMillisFloor,
    modalityVerified: true,
  });
}

function parseBmffBox(bytes, offset, index) {
  if (offset + 8 > bytes.length) throw new Error('ISO-BMFF contains a truncated top-level box header');
  const size32 = readUint32Be(bytes, offset, 'ISO-BMFF box size');
  const type = ascii(bytes, offset + 4, 4, 'ISO-BMFF box type');
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    if (offset + 16 > bytes.length) throw new Error('ISO-BMFF extended-size box header is truncated');
    size = readUint64BeSafe(bytes, offset + 8, 'ISO-BMFF extended box size');
    headerSize = 16;
  } else if (size32 === 0) {
    throw new Error('ISO-BMFF size-to-EOF boxes are not admitted by bounded preflight');
  }
  if (!Number.isSafeInteger(size) || size < headerSize) {
    throw new Error('ISO-BMFF top-level box has invalid size');
  }
  const end = offset + size;
  if (!Number.isSafeInteger(end) || end > bytes.length) {
    throw new Error('ISO-BMFF top-level box exceeds immutable material bounds');
  }
  return { index, offset, type, size, headerSize, payloadOffset: offset + headerSize, end };
}

function inspectIsoBmff(bytes) {
  if (bytes.length < 32) throw new Error('ISO-BMFF material is too short for bounded envelope verification');
  let offset = 0;
  let index = 0;
  let ftyp = null;
  let moovCount = 0;
  let mdatCount = 0;
  let mdatPayloadBytes = 0;
  const topLevelBoxTypes = [];
  while (offset < bytes.length) {
    if (index >= MAX_BMFF_TOP_LEVEL_BOXES) {
      throw new Error('ISO-BMFF top-level box count exceeds bounded preflight range');
    }
    const box = parseBmffBox(bytes, offset, index);
    topLevelBoxTypes.push(box.type);
    if (box.type === 'ftyp') {
      if (ftyp) throw new Error('ISO-BMFF contains ambiguous duplicate ftyp boxes');
      if (box.index !== 0) throw new Error('ISO-BMFF ftyp box must be first');
      const payloadLength = box.size - box.headerSize;
      if (payloadLength < 8 || (payloadLength - 8) % 4 !== 0) {
        throw new Error('ISO-BMFF ftyp payload length is invalid');
      }
      const majorBrand = ascii(bytes, box.payloadOffset, 4, 'ISO-BMFF major brand');
      const minorVersion = readUint32Be(bytes, box.payloadOffset + 4, 'ISO-BMFF minor version');
      const compatibleBrands = [];
      for (let brandOffset = box.payloadOffset + 8; brandOffset < box.end; brandOffset += 4) {
        compatibleBrands.push(ascii(bytes, brandOffset, 4, 'ISO-BMFF compatible brand'));
      }
      const allBrands = [majorBrand, ...compatibleBrands];
      if (!allBrands.some(brand => ISO_BMFF_BRANDS.has(brand))) {
        throw new Error('ISO-BMFF ftyp declares no admitted MP4/M4A-compatible brand');
      }
      ftyp = { majorBrand, minorVersion, compatibleBrands };
    } else if (box.type === 'moov') {
      moovCount += 1;
      if (moovCount > 1) throw new Error('ISO-BMFF contains ambiguous duplicate moov boxes');
      if (box.size === box.headerSize) throw new Error('ISO-BMFF moov box must not be empty');
    } else if (box.type === 'mdat') {
      mdatCount += 1;
      const payloadBytes = box.size - box.headerSize;
      if (payloadBytes < 1) throw new Error('ISO-BMFF mdat box must not be empty');
      mdatPayloadBytes += payloadBytes;
      if (!Number.isSafeInteger(mdatPayloadBytes)) {
        throw new Error('ISO-BMFF media payload size exceeds safe integer range');
      }
    }
    offset = box.end;
    index += 1;
  }
  if (offset !== bytes.length) throw new Error('ISO-BMFF boxes do not consume immutable material exactly');
  if (!ftyp) throw new Error('ISO-BMFF material is missing ftyp box');
  if (moovCount !== 1) throw new Error('ISO-BMFF material requires exactly one moov box');
  if (mdatCount < 1) throw new Error('ISO-BMFF material requires at least one mdat box');

  return deepFreeze({
    container: 'ISO_BMFF',
    topLevelBoxCount: index,
    topLevelBoxTypes,
    majorBrand: ftyp.majorBrand,
    minorVersion: ftyp.minorVersion,
    compatibleBrands: ftyp.compatibleBrands,
    moovCount,
    mdatCount,
    mdatPayloadBytes,
    modalityVerified: false,
  });
}

/**
 * Verifies immutable audio/video material identity and a deliberately narrow
 * container envelope. It does not decode media, inspect codecs/tracks, play,
 * transcribe, upload, disclose, or execute any content.
 */
export async function buildMediaArtifactPreflightV1(raw, { cryptoApi = globalThis.crypto } = {}) {
  const input = snapshotRecord(raw, REQUEST_KEYS, 'MediaArtifactPreflightV1 request');
  if (input.schemaVersion !== MEDIA_ARTIFACT_PREFLIGHT_VERSION) {
    throw new Error('Unsupported MediaArtifactPreflightV1 schemaVersion');
  }
  const artifactRef = exactArtifactRef(input.artifactRef);
  const bytes = decodeCanonicalBase64(input.mediaBase64, artifactRef.sizeBytes);
  const sha256 = await sha256Bytes(bytes, cryptoApi);
  if (sha256 !== artifactRef.sha256) {
    throw new Error('Media material SHA-256 does not match immutable ArtifactRef');
  }

  const technical = artifactRef.mediaType === 'audio/wav'
    ? inspectPcmWav(bytes)
    : inspectIsoBmff(bytes);
  const requiresCanonicalDisclosureAuthorization = artifactRef.sensitive === true;

  return deepFreeze({
    schemaVersion: MEDIA_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef,
    mediaType: artifactRef.mediaType,
    byteLength: bytes.byteLength,
    sha256,
    formatEnvelopeVerified: true,
    materialIdentityVerified: true,
    technical,
    rawBytesReturned: false,
    contentDecoded: false,
    codecVerified: false,
    tracksVerified: false,
    transcriptExtracted: false,
    externalReferenceScanPerformed: false,
    requiresQualifiedDecoder: true,
    requiresCanonicalDisclosureAuthorization,
    disclosureAuthorized: false,
    playbackAuthorized: false,
    transcriptionAuthorized: false,
    visualAnalysisAuthorized: false,
    uploadAuthorized: false,
    distributionAuthorized: false,
    executionAuthorized: false,
    readOnly: true,
    advisoryOnly: true,
  });
}
