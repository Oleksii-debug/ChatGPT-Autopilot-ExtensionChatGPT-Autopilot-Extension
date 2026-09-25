import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const ZIP_ARTIFACT_PREFLIGHT_VERSION = 1;
export const MAX_ZIP_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 2048;
export const MAX_ZIP_FILENAME_BYTES = 1024;
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_ZIP_COMPRESSION_RATIO = 200;

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
const ZIP_MEDIA_TYPES = new Set(['application/zip', 'application/x-zip-compressed']);
const SHA256 = /^[a-f0-9]{64}$/u;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_FIXED = 22;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;
const UTF8_FLAG = 0x0800;
const DEFLATE_OPTION_FLAGS = 0x0006;
const ALLOWED_FLAGS = UTF8_FLAG | DEFLATE_OPTION_FLAGS;
const ZIP64_EXTRA_ID = 0x0001;
const UNICODE_PATH_EXTRA_ID = 0x7075;
const AES_EXTRA_ID = 0x9901;
const RESERVED_WINDOWS_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

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

function exactArtifactRef(value) {
  const raw = snapshotRecord(value, ARTIFACT_KEYS, 'ZIP ArtifactRefV1');
  const normalized = normalizeArtifactRefV1(raw);
  for (const key of ARTIFACT_KEYS) {
    if (!Object.is(raw[key], normalized[key])) {
      throw new Error('ZIP ArtifactRefV1 is not already canonical: ' + key);
    }
  }
  if (!SHA256.test(normalized.sha256)) {
    throw new Error('ZIP ArtifactRefV1 requires an exact lowercase SHA-256 digest');
  }
  if (!Number.isSafeInteger(normalized.sizeBytes)
      || Object.is(normalized.sizeBytes, -0)
      || normalized.sizeBytes < EOCD_FIXED
      || normalized.sizeBytes > MAX_ZIP_ARTIFACT_BYTES) {
    throw new Error(
      'ZIP ArtifactRefV1 sizeBytes must be '
        + EOCD_FIXED
        + '..'
        + MAX_ZIP_ARTIFACT_BYTES,
    );
  }
  if (!ZIP_MEDIA_TYPES.has(normalized.mediaType)) {
    throw new Error('ZIP ArtifactRefV1 mediaType must be application/zip or application/x-zip-compressed');
  }
  return normalized;
}

function decodeCanonicalBase64(value) {
  const maxEncodedLength = Math.ceil(MAX_ZIP_ARTIFACT_BYTES / 3) * 4;
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
  if (binary.length < EOCD_FIXED || binary.length > MAX_ZIP_ARTIFACT_BYTES) {
    throw new Error('contentBase64 decoded ZIP bytes are outside the admitted size range');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function u16(bytes, offset, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 > bytes.length) {
    throw new Error(label + ' is truncated');
  }
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes.length) {
    throw new Error(label + ' is truncated');
  }
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function bytesEqual(left, leftOffset, right, rightOffset, length) {
  for (let index = 0; index < length; index += 1) {
    if (left[leftOffset + index] !== right[rightOffset + index]) return false;
  }
  return true;
}

function findExactEocd(bytes) {
  const first = Math.max(0, bytes.length - EOCD_FIXED - 0xffff);
  const candidates = [];
  for (let offset = bytes.length - EOCD_FIXED; offset >= first; offset -= 1) {
    if (u32(bytes, offset, 'ZIP EOCD candidate') !== EOCD_SIGNATURE) continue;
    const commentLength = u16(bytes, offset + 20, 'ZIP EOCD comment length');
    if (offset + EOCD_FIXED + commentLength === bytes.length) {
      candidates.push({ offset, commentLength });
    }
  }
  if (candidates.length !== 1) {
    throw new Error('ZIP must contain exactly one unambiguous terminal EOCD record');
  }
  return candidates[0];
}

function parseExtraFields(bytes, offset, length, label) {
  if (length === 0) return Object.freeze({ count: 0, unknownCount: 0 });
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(label + ' extra field block is truncated');
  }
  let cursor = offset;
  const end = offset + length;
  const ids = new Set();
  let count = 0;
  let unknownCount = 0;
  while (cursor < end) {
    if (cursor + 4 > end) throw new Error(label + ' extra field header is truncated');
    const id = u16(bytes, cursor, label + ' extra field id');
    const size = u16(bytes, cursor + 2, label + ' extra field size');
    cursor += 4;
    if (cursor + size > end) throw new Error(label + ' extra field payload is truncated');
    if (ids.has(id)) throw new Error(label + ' contains duplicate extra field id');
    ids.add(id);
    count += 1;
    if (id === ZIP64_EXTRA_ID) throw new Error(label + ' ZIP64 extra field is not admitted');
    if (id === UNICODE_PATH_EXTRA_ID) {
      throw new Error(label + ' Unicode path alias extra field is not admitted');
    }
    if (id === AES_EXTRA_ID) throw new Error(label + ' AES encryption extra field is not admitted');
    if (id !== 0x5455 && id !== 0x000a) unknownCount += 1;
    cursor += size;
  }
  return Object.freeze({ count, unknownCount });
}

function decodeEntryName(bytes, offset, length, flags, label) {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_ZIP_FILENAME_BYTES) {
    throw new Error(label + ' filename length is invalid');
  }
  if (offset < 0 || offset + length > bytes.length) throw new Error(label + ' filename is truncated');
  const nameBytes = bytes.subarray(offset, offset + length);
  let name;
  if ((flags & UTF8_FLAG) !== 0) {
    if (typeof globalThis.TextDecoder !== 'function') throw new Error('UTF-8 decoder is unavailable');
    try {
      name = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      throw new Error(label + ' filename must be valid UTF-8');
    }
  } else {
    for (const byte of nameBytes) {
      if (byte > 0x7f) {
        throw new Error(label + ' non-ASCII filename requires the UTF-8 ZIP flag');
      }
    }
    name = String.fromCharCode(...nameBytes);
  }
  if (name.normalize('NFC') !== name) {
    throw new Error(label + ' filename must already use NFC Unicode normalization');
  }
  return name;
}

function assertPortableEntryPath(name, label) {
  if (name.includes('\\')) throw new Error(label + ' filename must not contain backslashes');
  if (name.startsWith('/') || name.startsWith('//')) {
    throw new Error(label + ' filename must be relative');
  }
  if (/^[A-Za-z]:/u.test(name)) throw new Error(label + ' filename must not use a drive path');
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(label + ' filename contains a control character');
    }
  }
  if (/[<>:"|?*]/u.test(name)) {
    throw new Error(label + ' filename contains a non-portable Windows path character');
  }

  const directory = name.endsWith('/');
  const body = directory ? name.slice(0, -1) : name;
  if (!body || body.includes('//')) throw new Error(label + ' filename contains an empty path segment');
  const segments = body.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(label + ' filename contains a traversal or empty path segment');
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new Error(label + ' filename contains a Windows-ambiguous trailing dot or space');
    }
    if (RESERVED_WINDOWS_NAMES.test(segment)) {
      throw new Error(label + ' filename contains a reserved Windows device name');
    }
  }
  return directory;
}

function validateFlags(flags, method, label) {
  if ((flags & ~ALLOWED_FLAGS) !== 0) {
    throw new Error(label + ' ZIP general-purpose flags are not admitted');
  }
  if ((flags & 0x0001) !== 0) throw new Error(label + ' encrypted ZIP entry is not admitted');
  if ((flags & 0x0008) !== 0) throw new Error(label + ' data-descriptor ZIP entry is not admitted');
  if (method !== 0 && method !== 8) {
    throw new Error(label + ' compression method must be STORED or DEFLATE');
  }
  if (method === 0 && (flags & DEFLATE_OPTION_FLAGS) !== 0) {
    throw new Error(label + ' STORED entry must not carry DEFLATE option flags');
  }
}

function crcHex(value) {
  return value.toString(16).padStart(8, '0');
}

function safeAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < left) throw new Error(label + ' exceeds safe integer bounds');
  return value;
}

function parseCentralDirectory(bytes, eocd) {
  const diskNumber = u16(bytes, eocd.offset + 4, 'ZIP EOCD diskNumber');
  const centralDisk = u16(bytes, eocd.offset + 6, 'ZIP EOCD centralDirectoryDisk');
  const entriesOnDisk = u16(bytes, eocd.offset + 8, 'ZIP EOCD entriesOnDisk');
  const entryCount = u16(bytes, eocd.offset + 10, 'ZIP EOCD entryCount');
  const centralSize = u32(bytes, eocd.offset + 12, 'ZIP EOCD centralDirectorySize');
  const centralOffset = u32(bytes, eocd.offset + 16, 'ZIP EOCD centralDirectoryOffset');

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('multi-disk ZIP archives are not admitted');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not admitted');
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error('ZIP entry count exceeds ' + MAX_ZIP_ENTRIES);
  }
  if (safeAdd(centralOffset, centralSize, 'ZIP central directory range') !== eocd.offset) {
    throw new Error('ZIP central directory must end exactly at the EOCD record');
  }

  let cursor = centralOffset;
  const end = centralOffset + centralSize;
  const entries = [];
  const exactNames = new Set();
  const foldedNames = new Set();
  let totalUncompressed = 0;
  let compressedPayloadBytes = 0;
  let unknownExtraFieldCount = 0;
  let maxCompressionRatio = 1;

  for (let index = 0; index < entryCount; index += 1) {
    const label = 'ZIP central entry[' + index + ']';
    if (cursor + CENTRAL_FIXED > end || u32(bytes, cursor, label) !== CENTRAL_SIGNATURE) {
      throw new Error(label + ' header is missing or truncated');
    }
    const versionNeeded = u16(bytes, cursor + 6, label + ' versionNeeded');
    const flags = u16(bytes, cursor + 8, label + ' flags');
    const method = u16(bytes, cursor + 10, label + ' method');
    const crc32 = u32(bytes, cursor + 16, label + ' crc32');
    const compressedSize = u32(bytes, cursor + 20, label + ' compressedSize');
    const uncompressedSize = u32(bytes, cursor + 24, label + ' uncompressedSize');
    const nameLength = u16(bytes, cursor + 28, label + ' filenameLength');
    const extraLength = u16(bytes, cursor + 30, label + ' extraLength');
    const commentLength = u16(bytes, cursor + 32, label + ' commentLength');
    const diskStart = u16(bytes, cursor + 34, label + ' diskStart');
    const localOffset = u32(bytes, cursor + 42, label + ' localHeaderOffset');

    if (versionNeeded > 20) throw new Error(label + ' requires unsupported ZIP features');
    if (diskStart !== 0) throw new Error(label + ' references another disk');
    if (compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff) {
      throw new Error(label + ' ZIP64 sentinel is not admitted');
    }
    validateFlags(flags, method, label);

    const variableLength = nameLength + extraLength + commentLength;
    if (cursor + CENTRAL_FIXED + variableLength > end) {
      throw new Error(label + ' variable fields exceed the central directory');
    }
    const nameOffset = cursor + CENTRAL_FIXED;
    const name = decodeEntryName(bytes, nameOffset, nameLength, flags, label);
    const directory = assertPortableEntryPath(name, label);
    if (exactNames.has(name)) throw new Error('ZIP contains duplicate entry path: ' + name);
    exactNames.add(name);
    const folded = name.toLowerCase();
    if (foldedNames.has(folded)) {
      throw new Error('ZIP contains case-folding path collision: ' + name);
    }
    foldedNames.add(folded);

    const extras = parseExtraFields(
      bytes,
      nameOffset + nameLength,
      extraLength,
      label,
    );
    unknownExtraFieldCount += extras.unknownCount;

    if (directory) {
      if (compressedSize !== 0 || uncompressedSize !== 0 || method !== 0) {
        throw new Error(label + ' directory entry must be zero-size STORED metadata');
      }
    } else {
      if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
        throw new Error(label + ' uncompressed size exceeds per-entry bound');
      }
      if (method === 0 && compressedSize !== uncompressedSize) {
        throw new Error(label + ' STORED entry size fields must match');
      }
      if (compressedSize === 0 && uncompressedSize !== 0) {
        throw new Error(label + ' non-empty entry cannot declare zero compressed bytes');
      }
      const ratio = uncompressedSize === 0 ? 1 : uncompressedSize / Math.max(1, compressedSize);
      if (!Number.isFinite(ratio) || ratio > MAX_ZIP_COMPRESSION_RATIO) {
        throw new Error(label + ' compression ratio exceeds ' + MAX_ZIP_COMPRESSION_RATIO);
      }
      maxCompressionRatio = Math.max(maxCompressionRatio, ratio);
    }

    totalUncompressed = safeAdd(
      totalUncompressed,
      uncompressedSize,
      'ZIP total declared uncompressed size',
    );
    if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(
        'ZIP total declared uncompressed size exceeds '
          + MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
      );
    }
    compressedPayloadBytes = safeAdd(
      compressedPayloadBytes,
      compressedSize,
      'ZIP compressed payload total',
    );

    entries.push({
      index,
      name,
      directory,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      centralNameOffset: nameOffset,
      centralNameLength: nameLength,
      centralExtraLength: extraLength,
    });
    cursor += CENTRAL_FIXED + variableLength;
  }

  if (cursor !== end) {
    throw new Error('ZIP central directory contains unparsed or inconsistent bytes');
  }
  if (entryCount === 0 && (centralOffset !== 0 || centralSize !== 0)) {
    throw new Error('empty ZIP archive has a non-empty central directory');
  }

  return {
    entryCount,
    centralOffset,
    centralSize,
    entries,
    totalUncompressed,
    compressedPayloadBytes,
    unknownExtraFieldCount,
    maxCompressionRatio,
  };
}

function validateLocalEntries(bytes, central) {
  const ranges = [];
  let minimumLocalOffset = Number.POSITIVE_INFINITY;
  let unknownExtraFieldCount = central.unknownExtraFieldCount;

  for (const entry of central.entries) {
    const label = 'ZIP local entry[' + entry.index + ']';
    const offset = entry.localOffset;
    minimumLocalOffset = Math.min(minimumLocalOffset, offset);
    if (offset + LOCAL_FIXED > central.centralOffset
        || u32(bytes, offset, label) !== LOCAL_SIGNATURE) {
      throw new Error(label + ' header is missing, truncated, or inside central metadata');
    }

    const versionNeeded = u16(bytes, offset + 4, label + ' versionNeeded');
    const flags = u16(bytes, offset + 6, label + ' flags');
    const method = u16(bytes, offset + 8, label + ' method');
    const crc32 = u32(bytes, offset + 14, label + ' crc32');
    const compressedSize = u32(bytes, offset + 18, label + ' compressedSize');
    const uncompressedSize = u32(bytes, offset + 22, label + ' uncompressedSize');
    const nameLength = u16(bytes, offset + 26, label + ' filenameLength');
    const extraLength = u16(bytes, offset + 28, label + ' extraLength');

    if (versionNeeded > 20) throw new Error(label + ' requires unsupported ZIP features');
    validateFlags(flags, method, label);
    if (flags !== entry.flags
        || method !== entry.method
        || crc32 !== entry.crc32
        || compressedSize !== entry.compressedSize
        || uncompressedSize !== entry.uncompressedSize
        || nameLength !== entry.centralNameLength) {
      throw new Error(label + ' metadata does not match the central directory');
    }

    const nameOffset = offset + LOCAL_FIXED;
    if (nameOffset + nameLength + extraLength > central.centralOffset) {
      throw new Error(label + ' variable fields exceed local metadata region');
    }
    if (!bytesEqual(
      bytes,
      nameOffset,
      bytes,
      entry.centralNameOffset,
      nameLength,
    )) {
      throw new Error(label + ' filename bytes do not match the central directory');
    }
    const localName = decodeEntryName(bytes, nameOffset, nameLength, flags, label);
    if (localName !== entry.name) throw new Error(label + ' filename identity mismatch');

    const extras = parseExtraFields(
      bytes,
      nameOffset + nameLength,
      extraLength,
      label,
    );
    unknownExtraFieldCount += extras.unknownCount;

    const dataStart = nameOffset + nameLength + extraLength;
    const dataEnd = safeAdd(dataStart, compressedSize, label + ' payload range');
    if (dataEnd > central.centralOffset) {
      throw new Error(label + ' payload overlaps the central directory');
    }
    ranges.push({ start: offset, end: dataEnd, index: entry.index });
  }

  if (central.entryCount > 0 && minimumLocalOffset !== 0) {
    throw new Error('ZIP archive prefix/self-extracting payload is not admitted');
  }

  ranges.sort((left, right) => left.start - right.start || left.index - right.index);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error('ZIP local entry ranges overlap or alias one another');
    }
  }

  return { unknownExtraFieldCount };
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
    throw new Error('ZIP SHA-256 calculation failed');
  }
  return toHex(new Uint8Array(digest));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Verifies immutable ZIP material and screens archive metadata without
 * decompressing, extracting, executing, or distributing any entry.
 */
export async function preflightZipArtifactV1(input, {
  cryptoImpl = globalThis.crypto,
} = {}) {
  const raw = snapshotRecord(input, REQUEST_KEYS, 'ZipArtifactPreflightV1 request');
  if (raw.schemaVersion !== ZIP_ARTIFACT_PREFLIGHT_VERSION) {
    throw new Error('Unsupported ZipArtifactPreflightV1 schemaVersion');
  }

  const artifactRef = exactArtifactRef(raw.artifactRef);
  const bytes = decodeCanonicalBase64(raw.contentBase64);
  if (bytes.byteLength !== artifactRef.sizeBytes) {
    throw new Error('ZIP material byte length does not match immutable ArtifactRefV1');
  }
  const sha256 = await sha256Bytes(bytes, cryptoImpl);
  if (sha256 !== artifactRef.sha256) {
    throw new Error('ZIP material SHA-256 does not match immutable ArtifactRefV1');
  }

  const eocd = findExactEocd(bytes);
  const central = parseCentralDirectory(bytes, eocd);
  const local = validateLocalEntries(bytes, central);
  const publicEntries = central.entries.map(entry => Object.freeze({
    entryIndex: entry.index,
    path: entry.name,
    directory: entry.directory,
    compressionMethod: entry.method === 0 ? 'STORED' : 'DEFLATE',
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    crc32: crcHex(entry.crc32),
    localHeaderOffset: entry.localOffset,
  }));

  const sensitive = artifactRef.sensitive === true;
  return deepFreeze({
    schemaVersion: ZIP_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef,
    byteLength: bytes.byteLength,
    sha256,
    mediaType: artifactRef.mediaType,
    entryCount: central.entryCount,
    archiveCommentLength: eocd.commentLength,
    centralDirectoryOffset: central.centralOffset,
    centralDirectorySize: central.centralSize,
    compressedPayloadBytes: central.compressedPayloadBytes,
    declaredUncompressedBytes: central.totalUncompressed,
    maxCompressionRatio: central.maxCompressionRatio,
    unknownExtraFieldCount: local.unknownExtraFieldCount,
    entriesAvailable: !sensitive,
    entries: sensitive ? null : Object.freeze(publicEntries),
    materialIdentityVerified: true,
    structuralMetadataVerified: true,
    payloadContentVerified: false,
    crcContentVerified: false,
    decompressionPerformed: false,
    extractionPerformed: false,
    readOnly: true,
    advisoryOnly: true,
    artifactMutationAuthorized: false,
    extractionAuthorized: false,
    executionAuthorized: false,
    distributionAuthorized: false,
    contentDisclosureAuthorized: false,
    requiresCanonicalExtractorRevalidation: true,
    requiresCanonicalDisclosureAuthorization: sensitive,
  });
}
