import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const IMAGE_ARTIFACT_PREFLIGHT_VERSION = 1;
export const MAX_IMAGE_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 32_768;
export const MAX_IMAGE_PIXELS = 100_000_000;
export const MAX_PNG_CHUNKS = 4_096;
export const MAX_JPEG_SEGMENTS = 4_096;

const REQUEST_KEYS = new Set(['schemaVersion', 'artifactRef', 'contentBase64']);
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg']);
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])], [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])], [4, new Set([8, 16])], [6, new Set([8, 16])],
]);
const JPEG_SOF = new Map([[0xc0, 'BASELINE_DCT'], [0xc1, 'EXTENDED_SEQUENTIAL_DCT'], [0xc2, 'PROGRESSIVE_DCT']]);

function snapshot(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a plain object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' must be a plain or null-prototype object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(label + ' contains unknown field: ' + String(key));
    const d = descriptors[key];
    if (!d || d.enumerable !== true || !Object.prototype.hasOwnProperty.call(d, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = d.value;
  }
  for (const key of allowed) if (!Object.prototype.hasOwnProperty.call(out, key)) throw new Error(label + ' is missing field: ' + key);
  return out;
}

function exactArtifactRef(value) {
  const raw = snapshot(value, ARTIFACT_KEYS, 'Image ArtifactRefV1');
  const normalized = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.is(raw[key], normalized[key])) throw new Error('Image ArtifactRefV1 is not already canonical: ' + key);
  }
  if (!SHA256.test(normalized.sha256)) throw new Error('Image ArtifactRefV1 requires an exact lowercase SHA-256 digest');
  if (!Number.isSafeInteger(normalized.sizeBytes) || Object.is(normalized.sizeBytes, -0)
      || normalized.sizeBytes < 1 || normalized.sizeBytes > MAX_IMAGE_ARTIFACT_BYTES) {
    throw new Error('Image ArtifactRefV1 sizeBytes must be 1..' + MAX_IMAGE_ARTIFACT_BYTES);
  }
  if (!MEDIA_TYPES.has(normalized.mediaType)) throw new Error('Image ArtifactRefV1 mediaType must be image/png or image/jpeg');
  return normalized;
}

function decodeBase64(value) {
  const max = Math.ceil(MAX_IMAGE_ARTIFACT_BYTES / 3) * 4;
  if (typeof value !== 'string' || value.length < 4 || value.length > max || value.length % 4 !== 0
      || /[\r\n\t ]/u.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error('contentBase64 must be bounded canonical Base64 text');
  }
  if (typeof globalThis.atob !== 'function' || typeof globalThis.btoa !== 'function') throw new Error('Base64 decoding is unavailable');
  let binary;
  try { binary = globalThis.atob(value); } catch { throw new Error('contentBase64 is invalid Base64'); }
  if (globalThis.btoa(binary) !== value) throw new Error('contentBase64 must use canonical Base64 representation');
  if (binary.length < 1 || binary.length > MAX_IMAGE_ARTIFACT_BYTES) throw new Error('contentBase64 decoded bytes are outside admitted bounds');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
async function digest(bytes, cryptoApi) {
  if (!cryptoApi?.subtle?.digest) throw new Error('Web Crypto SHA-256 is unavailable');
  return hex(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes)));
}
function u16(bytes, offset, label) {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error(label + ' is truncated');
  return (bytes[offset] << 8) | bytes[offset + 1];
}
function u32(bytes, offset, label) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error(label + ' is truncated');
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}
function dimensions(width, height, label) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) throw new Error(label + ' dimensions are outside admitted bounds');
  const count = width * height;
  if (!Number.isSafeInteger(count) || count > MAX_IMAGE_PIXELS) throw new Error(label + ' pixel count exceeds admitted bound');
  return count;
}
function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function ascii4(bytes, offset) {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    const b = bytes[offset + i];
    if (!((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a))) throw new Error('PNG chunk type is invalid');
    out += String.fromCharCode(b);
  }
  if ((bytes[offset + 2] & 0x20) !== 0) throw new Error('PNG chunk type reserved bit must be zero');
  return out;
}

function parsePng(bytes) {
  if (bytes.length < 20) throw new Error('PNG material is truncated');
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('PNG signature is invalid');
  let offset = 8; let chunks = 0; let ihdr = false; let plte = false; let actl = false;
  let idat = false; let endedIdat = false; let iend = false; let idatBytes = 0;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlaceMethod = 0; let animationDeclared = false;
  while (offset < bytes.length) {
    chunks += 1;
    if (chunks > MAX_PNG_CHUNKS) throw new Error('PNG exceeds maximum chunk count ' + MAX_PNG_CHUNKS);
    if (offset + 12 > bytes.length) throw new Error('PNG chunk envelope is truncated');
    const length = u32(bytes, offset, 'PNG chunk length');
    const typeOffset = offset + 4; const type = ascii4(bytes, typeOffset);
    const data = offset + 8; const crcOffset = data + length; const next = crcOffset + 4;
    if (next > bytes.length) throw new Error('PNG ' + type + ' chunk exceeds material bounds');
    if (crc32(bytes, typeOffset, crcOffset) !== u32(bytes, crcOffset, 'PNG ' + type + ' CRC')) throw new Error('PNG ' + type + ' CRC mismatch');
    const critical = (bytes[typeOffset] & 0x20) === 0;
    if (critical && !new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']).has(type)) throw new Error('PNG contains unsupported critical chunk ' + type);
    if (!ihdr && type !== 'IHDR') throw new Error('PNG IHDR must be the first chunk');
    if (type === 'IHDR') {
      if (ihdr || length !== 13) throw new Error('PNG requires exactly one 13-byte IHDR');
      ihdr = true; width = u32(bytes, data, 'PNG width'); height = u32(bytes, data + 4, 'PNG height');
      bitDepth = bytes[data + 8]; colorType = bytes[data + 9]; interlaceMethod = bytes[data + 12];
      dimensions(width, height, 'PNG');
      if (!PNG_DEPTHS.get(colorType)?.has(bitDepth)) throw new Error('PNG bit depth/color type combination is invalid');
      if (bytes[data + 10] !== 0 || bytes[data + 11] !== 0 || ![0, 1].includes(interlaceMethod)) throw new Error('PNG IHDR compression/filter/interlace method is invalid');
    } else if (type === 'PLTE') {
      if (plte || idat || iend || colorType === 0 || colorType === 4 || length < 3 || length > 768 || length % 3 !== 0) throw new Error('PNG PLTE structure or ordering is invalid');
      if (colorType === 3 && length / 3 > (1 << bitDepth)) throw new Error('PNG PLTE exceeds indexed-color capacity');
      plte = true;
    } else if (type === 'IDAT') {
      if (iend || endedIdat) throw new Error('PNG IDAT chunks must be consecutive and precede IEND');
      if (colorType === 3 && !plte) throw new Error('Indexed PNG requires PLTE before IDAT');
      idat = true; idatBytes += length;
      if (!Number.isSafeInteger(idatBytes) || idatBytes > MAX_IMAGE_ARTIFACT_BYTES) throw new Error('PNG IDAT byte count exceeds admitted bound');
    } else if (type === 'IEND') {
      if (!idat || idatBytes < 1 || iend || length !== 0) throw new Error('PNG requires non-empty IDAT material followed by one empty IEND');
      iend = true;
      if (next !== bytes.length) throw new Error('PNG contains trailing bytes after IEND');
    } else {
      if (idat) endedIdat = true;
      if (type === 'acTL') {
        if (actl || length !== 8 || idat) throw new Error('PNG acTL animation declaration is invalid');
        actl = true;
        if (u32(bytes, data, 'PNG acTL frame count') < 1) throw new Error('PNG acTL frame count must be positive');
        animationDeclared = true;
      }
    }
    offset = next;
    if (iend) break;
  }
  if (!ihdr || !idat || !iend) throw new Error('PNG is missing required IHDR, IDAT, or IEND structure');
  return Object.freeze({ format: 'PNG', width, height, pixelCount: width * height, bitDepth, colorType, interlaceMethod, chunkCount: chunks, idatBytes, animationDeclared, crcVerified: true });
}

function standaloneJpeg(marker) { return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9); }
function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('JPEG SOI signature is invalid');
  let offset = 2; let segments = 0; let width = 0; let height = 0; let precisionBits = 0; let componentCount = 0;
  let coding = ''; let progressive = false; let sof = false; let sos = false; let eoi = false; let entropy = false;
  while (offset < bytes.length) {
    if (entropy) {
      let markerFound = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        let cursor = offset + 1;
        while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
        if (cursor >= bytes.length) throw new Error('JPEG entropy stream ends with incomplete marker');
        const marker = bytes[cursor];
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) { offset = cursor + 1; continue; }
        offset = cursor + 1; entropy = false; markerFound = true;
        if (marker === 0xd9) { eoi = true; if (offset !== bytes.length) throw new Error('JPEG contains trailing bytes after EOI'); break; }
        if (standaloneJpeg(marker)) throw new Error('JPEG contains invalid standalone marker after scan data');
        if (offset + 2 > bytes.length) throw new Error('JPEG segment length is truncated');
        const length = u16(bytes, offset, 'JPEG segment length');
        if (length < 2 || offset + length > bytes.length) throw new Error('JPEG segment length is invalid');
        if (marker === 0xda) {
          const n = bytes[offset + 2];
          if (!sof || length !== 6 + 2 * n || n < 1 || n > componentCount) throw new Error('JPEG SOS component structure is invalid');
          sos = true; entropy = true;
        } else if (JPEG_SOF.has(marker) || (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))) {
          throw new Error('JPEG frame coding marker 0x' + marker.toString(16) + ' is unsupported after scan data');
        }
        segments += 1; if (segments > MAX_JPEG_SEGMENTS) throw new Error('JPEG exceeds maximum segment count ' + MAX_JPEG_SEGMENTS);
        offset += length; break;
      }
      if (eoi) break;
      if (!markerFound && offset >= bytes.length) break;
      continue;
    }
    if (bytes[offset] !== 0xff) throw new Error('JPEG expected a marker prefix');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new Error('JPEG marker is truncated');
    const marker = bytes[offset]; offset += 1;
    if (marker === 0x00) throw new Error('JPEG stuffed zero is only valid inside entropy data');
    if (marker === 0xd8) throw new Error('JPEG contains an unexpected nested SOI marker');
    if (marker === 0xd9) { if (!sos) throw new Error('JPEG EOI cannot precede image scan data'); eoi = true; if (offset !== bytes.length) throw new Error('JPEG contains trailing bytes after EOI'); break; }
    if (standaloneJpeg(marker)) throw new Error('JPEG standalone marker is invalid outside entropy data');
    if (offset + 2 > bytes.length) throw new Error('JPEG segment length is truncated');
    const length = u16(bytes, offset, 'JPEG segment length'); const data = offset + 2;
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEG segment length is invalid');
    segments += 1; if (segments > MAX_JPEG_SEGMENTS) throw new Error('JPEG exceeds maximum segment count ' + MAX_JPEG_SEGMENTS);
    if (JPEG_SOF.has(marker)) {
      if (sof || length < 8) throw new Error('JPEG SOF structure is invalid');
      precisionBits = bytes[data]; height = u16(bytes, data + 1, 'JPEG height'); width = u16(bytes, data + 3, 'JPEG width'); componentCount = bytes[data + 5];
      if (componentCount < 1 || componentCount > 4 || length !== 8 + 3 * componentCount) throw new Error('JPEG SOF component structure is invalid');
      if ((marker === 0xc0 && precisionBits !== 8) || (marker !== 0xc0 && precisionBits !== 8 && precisionBits !== 12)) throw new Error('JPEG sample precision is unsupported');
      dimensions(width, height, 'JPEG'); coding = JPEG_SOF.get(marker); progressive = marker === 0xc2; sof = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      throw new Error('JPEG frame coding marker 0x' + marker.toString(16) + ' is unsupported');
    } else if (marker === 0xda) {
      const n = bytes[data];
      if (!sof || n < 1 || n > componentCount || length !== 6 + 2 * n) throw new Error('JPEG SOS component structure is invalid');
      sos = true; entropy = true;
    }
    offset += length;
  }
  if (!sof || !sos || !eoi) throw new Error('JPEG is missing required SOF, SOS, or EOI structure');
  return Object.freeze({ format: 'JPEG', width, height, pixelCount: width * height, precisionBits, componentCount, coding, progressive, segmentCount: segments, entropyEnvelopeVerified: true });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export async function preflightImageArtifactV1(input, { cryptoImpl = globalThis.crypto } = {}) {
  const raw = snapshot(input, REQUEST_KEYS, 'ImageArtifactPreflightV1 request');
  if (raw.schemaVersion !== IMAGE_ARTIFACT_PREFLIGHT_VERSION) throw new Error('Unsupported ImageArtifactPreflightV1 schemaVersion');
  const artifactRef = exactArtifactRef(raw.artifactRef);
  const bytes = decodeBase64(raw.contentBase64);
  if (bytes.byteLength !== artifactRef.sizeBytes) throw new Error('Image material byte length does not match immutable ArtifactRefV1');
  const sha256 = await digest(bytes, cryptoImpl);
  if (sha256 !== artifactRef.sha256) throw new Error('Image material SHA-256 does not match immutable ArtifactRefV1');
  const structural = artifactRef.mediaType === 'image/png' ? parsePng(bytes) : parseJpeg(bytes);
  return deepFreeze({
    schemaVersion: IMAGE_ARTIFACT_PREFLIGHT_VERSION, artifactRef, byteLength: bytes.byteLength, sha256,
    mediaType: artifactRef.mediaType, structural, sourceTrust: 'UNVERIFIED_INPUT', materialIdentityVerified: true,
    formatEnvelopeVerified: true, dimensionsVerified: true, pixelsDecoded: false, pixelContentDisclosed: false,
    readOnly: true, advisoryOnly: true, artifactMutationAuthorized: false, renderingAuthorized: false,
    visionAuthorized: false, ocrAuthorized: false, decoderAdmissionAuthorized: false, distributionAuthorized: false,
    contentDisclosureAuthorized: false, executionAuthorized: false, policyDecisionAuthorized: false,
    requiresCanonicalDisclosureAuthorization: artifactRef.sensitive === true,
  });
}
