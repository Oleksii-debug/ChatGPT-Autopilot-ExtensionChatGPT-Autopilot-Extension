import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import {
  ZIP_ARTIFACT_PREFLIGHT_VERSION,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ZIP_COMPRESSION_RATIO,
  preflightZipArtifactV1,
} from '../src/core/zip-artifact-preflight.js';

const UTF8_FLAG = 0x0800;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function makeExtra(id, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function makeZip(entries, options = {}) {
  const prefix = Buffer.from(options.prefix || []);
  const locals = [prefix];
  const records = [];
  let cursor = prefix.length;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const name = entry.name;
    const localName = entry.localName == null ? name : entry.localName;
    const nameBytes = Buffer.from(name, 'utf8');
    const localNameBytes = Buffer.from(localName, 'utf8');
    const flags = entry.flags == null ? UTF8_FLAG : entry.flags;
    const method = entry.method == null ? 0 : entry.method;
    const raw = Buffer.from(entry.data == null ? '' : entry.data);
    const compressed = entry.payload == null
      ? (method === 8 ? deflateRawSync(raw) : raw)
      : Buffer.from(entry.payload);
    const declaredCompressedSize = entry.declaredCompressedSize == null
      ? compressed.length
      : entry.declaredCompressedSize;
    const declaredUncompressedSize = entry.declaredUncompressedSize == null
      ? raw.length
      : entry.declaredUncompressedSize;
    const crc = entry.crc32 == null ? crc32(raw) : entry.crc32 >>> 0;
    const localExtra = Buffer.from(entry.localExtra || []);
    const versionNeeded = entry.versionNeeded == null ? 20 : entry.versionNeeded;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(versionNeeded, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(declaredCompressedSize >>> 0, 18);
    header.writeUInt32LE(declaredUncompressedSize >>> 0, 22);
    header.writeUInt16LE(localNameBytes.length, 26);
    header.writeUInt16LE(localExtra.length, 28);

    const localOffset = cursor;
    locals.push(header, localNameBytes, localExtra, compressed);
    cursor += header.length + localNameBytes.length + localExtra.length + compressed.length;

    records.push({
      entry,
      nameBytes,
      flags,
      method,
      crc,
      declaredCompressedSize,
      declaredUncompressedSize,
      localOffset,
      versionNeeded,
    });
  }

  const localBytes = Buffer.concat(locals);
  const centralOffset = localBytes.length;
  const centrals = [];
  for (const record of records) {
    const entry = record.entry;
    const centralName = entry.centralName == null ? entry.name : entry.centralName;
    const centralNameBytes = Buffer.from(centralName, 'utf8');
    const centralExtra = Buffer.from(entry.centralExtra || []);
    const centralComment = Buffer.from(entry.centralComment || []);
    const centralFlags = entry.centralFlags == null ? record.flags : entry.centralFlags;
    const centralMethod = entry.centralMethod == null ? record.method : entry.centralMethod;
    const centralCrc = entry.centralCrc32 == null ? record.crc : entry.centralCrc32 >>> 0;
    const centralCompressed = entry.centralCompressedSize == null
      ? record.declaredCompressedSize
      : entry.centralCompressedSize;
    const centralUncompressed = entry.centralUncompressedSize == null
      ? record.declaredUncompressedSize
      : entry.centralUncompressedSize;
    const centralLocalOffset = entry.centralLocalOffset == null
      ? record.localOffset
      : entry.centralLocalOffset;
    const centralVersionNeeded = entry.centralVersionNeeded == null
      ? record.versionNeeded
      : entry.centralVersionNeeded;

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(centralVersionNeeded, 6);
    header.writeUInt16LE(centralFlags, 8);
    header.writeUInt16LE(centralMethod, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(centralCrc, 16);
    header.writeUInt32LE(centralCompressed >>> 0, 20);
    header.writeUInt32LE(centralUncompressed >>> 0, 24);
    header.writeUInt16LE(centralNameBytes.length, 28);
    header.writeUInt16LE(centralExtra.length, 30);
    header.writeUInt16LE(centralComment.length, 32);
    header.writeUInt16LE(entry.diskStart == null ? 0 : entry.diskStart, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(centralLocalOffset >>> 0, 42);
    centrals.push(header, centralNameBytes, centralExtra, centralComment);
  }

  const centralBytes = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment || []);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.diskNumber == null ? 0 : options.diskNumber, 4);
  eocd.writeUInt16LE(options.centralDisk == null ? 0 : options.centralDisk, 6);
  const entryCount = options.eocdEntryCount == null ? entries.length : options.eocdEntryCount;
  eocd.writeUInt16LE(
    options.entriesOnDisk == null ? entryCount : options.entriesOnDisk,
    8,
  );
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(
    options.centralSize == null ? centralBytes.length : options.centralSize,
    12,
  );
  eocd.writeUInt32LE(
    options.centralOffset == null ? centralOffset : options.centralOffset,
    16,
  );
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([localBytes, centralBytes, eocd, comment]);
}

function artifactFor(bytes, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'zip-artifact-1',
    kind: 'archive',
    uri: 'artifact://zip-artifact-1',
    mediaType: 'application/zip',
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
    createdAt: '2026-09-25T16:30:00.000Z',
    producerInvocationId: 'invoke-zip-1',
    sensitive: false,
    ...overrides,
  };
}

function requestFor(bytes, overrides = {}) {
  return {
    schemaVersion: ZIP_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef: artifactFor(bytes),
    contentBase64: base64(bytes),
    ...overrides,
  };
}

test('valid STORED and DEFLATE entries produce bounded read-only archive facts without extraction', async () => {
  const zip = makeZip([
    { name: 'docs/', data: '' },
    { name: 'docs/readme.txt', data: 'hello', method: 0 },
    { name: 'data/items.json', data: '{"ok":true}', method: 8 },
  ]);
  const out = await preflightZipArtifactV1(requestFor(zip));

  assert.equal(out.materialIdentityVerified, true);
  assert.equal(out.structuralMetadataVerified, true);
  assert.equal(out.payloadContentVerified, false);
  assert.equal(out.crcContentVerified, false);
  assert.equal(out.decompressionPerformed, false);
  assert.equal(out.extractionPerformed, false);
  assert.equal(out.entryCount, 3);
  assert.equal(out.entriesAvailable, true);
  assert.deepEqual(
    out.entries.map(item => [item.path, item.compressionMethod, item.directory]),
    [
      ['docs/', 'STORED', true],
      ['docs/readme.txt', 'STORED', false],
      ['data/items.json', 'DEFLATE', false],
    ],
  );
  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.extractionAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.distributionAuthorized, false);
  assert.equal(out.requiresCanonicalExtractorRevalidation, true);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.entries), true);
  assert.equal(Object.isFrozen(out.entries[0]), true);
});

test('sensitive archive validates structure without disclosing entry paths', async () => {
  const zip = makeZip([{ name: 'private/customer-list.txt', data: 'secret' }]);
  const out = await preflightZipArtifactV1(requestFor(zip, {
    artifactRef: artifactFor(zip, { sensitive: true }),
  }));
  assert.equal(out.entryCount, 1);
  assert.equal(out.entriesAvailable, false);
  assert.equal(out.entries, null);
  assert.equal(out.requiresCanonicalDisclosureAuthorization, true);
  assert.equal(out.contentDisclosureAuthorized, false);
});

test('zip-slip, absolute, Windows alias, backslash, and ambiguous paths fail closed', async () => {
  for (const name of [
    '../evil.txt',
    'safe/../../evil.txt',
    '/absolute.txt',
    'C:/drive.txt',
    'dir\\backslash.txt',
    'NUL.txt',
    'COM1.log',
    'dir/trailing. ',
    'dir//empty.txt',
  ]) {
    const zip = makeZip([{ name, data: 'x' }]);
    await assert.rejects(
      preflightZipArtifactV1(requestFor(zip)),
      /filename|path|Windows|traversal|relative|segment|backslash|reserved/u,
      name,
    );
  }
});

test('duplicate and case-folding path aliases are rejected', async () => {
  const duplicate = makeZip([
    { name: 'a.txt', data: '1' },
    { name: 'a.txt', data: '2' },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(duplicate)),
    /duplicate entry path/u,
  );

  const caseCollision = makeZip([
    { name: 'Readme.txt', data: '1' },
    { name: 'README.TXT', data: '2' },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(caseCollision)),
    /case-folding path collision/u,
  );
});

test('encryption, data descriptors, unsupported methods, ZIP64, and multi-disk metadata are rejected', async () => {
  for (const flags of [UTF8_FLAG | 0x0001, UTF8_FLAG | 0x0008]) {
    const zip = makeZip([{ name: 'a.txt', data: 'x', flags }]);
    await assert.rejects(
      preflightZipArtifactV1(requestFor(zip)),
      /flags|encrypted|data-descriptor/u,
    );
  }

  const unsupportedMethod = makeZip([{ name: 'a.txt', data: 'x', method: 12 }]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(unsupportedMethod)),
    /compression method/u,
  );

  const zip64Sentinel = makeZip([
    {
      name: 'a.txt',
      data: 'x',
      centralCompressedSize: 0xffffffff,
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(zip64Sentinel)),
    /ZIP64/u,
  );

  const zip64Extra = makeZip([
    {
      name: 'a.txt',
      data: 'x',
      centralExtra: makeExtra(0x0001),
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(zip64Extra)),
    /ZIP64 extra/u,
  );

  const multiDisk = makeZip([{ name: 'a.txt', data: 'x' }], { diskNumber: 1 });
  await assert.rejects(
    preflightZipArtifactV1(requestFor(multiDisk)),
    /multi-disk/u,
  );
});

test('central and local metadata must agree exactly', async () => {
  const nameMismatch = makeZip([
    {
      name: 'central.txt',
      localName: 'local-xx.txt',
      data: 'x',
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(nameMismatch)),
    /filename bytes|metadata does not match/u,
  );

  const methodMismatch = makeZip([
    {
      name: 'a.txt',
      data: 'x',
      method: 0,
      centralMethod: 8,
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(methodMismatch)),
    /metadata does not match/u,
  );

  const sizeMismatch = makeZip([
    {
      name: 'a.txt',
      data: 'x',
      centralUncompressedSize: 2,
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(sizeMismatch)),
    /metadata does not match|STORED entry size/u,
  );
});

test('overlapping local payload declarations and executable prefixes are rejected', async () => {
  const overlap = makeZip([
    {
      name: 'one.txt',
      data: 'x',
      declaredCompressedSize: 20,
      declaredUncompressedSize: 20,
    },
    { name: 'two.txt', data: 'y' },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(overlap)),
    /overlap|central directory/u,
  );

  const prefixed = makeZip(
    [{ name: 'a.txt', data: 'x' }],
    { prefix: Buffer.from('MZ') },
  );
  await assert.rejects(
    preflightZipArtifactV1(requestFor(prefixed)),
    /prefix\/self-extracting/u,
  );
});

test('declared decompression bombs are rejected before any decompression', async () => {
  const ratioBomb = makeZip([
    {
      name: 'bomb.bin',
      payload: Buffer.from([0]),
      method: 8,
      declaredCompressedSize: 1,
      declaredUncompressedSize: MAX_ZIP_COMPRESSION_RATIO + 1,
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(ratioBomb)),
    /compression ratio/u,
  );

  const entryBomb = makeZip([
    {
      name: 'huge.bin',
      payload: Buffer.from([0]),
      method: 8,
      declaredCompressedSize: 1024 * 1024,
      declaredUncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1,
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(entryBomb)),
    /per-entry bound/u,
  );

  const totalBomb = makeZip(
    Array.from({ length: 5 }, (_, index) => ({
      name: 'file-' + index + '.bin',
      payload: Buffer.from([0]),
      method: 8,
      declaredCompressedSize: 1024 * 1024,
      declaredUncompressedSize: Math.floor(MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES / 5) + 1,
    })),
  );
  await assert.rejects(
    preflightZipArtifactV1(requestFor(totalBomb)),
    /total declared uncompressed size/u,
  );
});

test('immutable ArtifactRef, Base64, digest, size, and MIME representations fail closed on aliases or substitution', async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'x' }]);
  const ref = artifactFor(zip);

  await assert.rejects(
    preflightZipArtifactV1(requestFor(zip, {
      artifactRef: { ...ref, sha256: ref.sha256.toUpperCase() },
    })),
    /not already canonical: sha256/u,
  );
  await assert.rejects(
    preflightZipArtifactV1(requestFor(zip, {
      artifactRef: { ...ref, sha256: 'b'.repeat(64) },
    })),
    /SHA-256 does not match/u,
  );
  await assert.rejects(
    preflightZipArtifactV1(requestFor(zip, {
      artifactRef: { ...ref, sizeBytes: zip.length + 1 },
    })),
    /byte length does not match/u,
  );
  await assert.rejects(
    preflightZipArtifactV1(requestFor(zip, {
      artifactRef: { ...ref, mediaType: 'application/octet-stream' },
    })),
    /mediaType/u,
  );
  await assert.rejects(
    preflightZipArtifactV1({
      schemaVersion: 1,
      artifactRef: ref,
      contentBase64: base64(zip) + '\n',
    }),
    /canonical Base64/u,
  );
});

test('EOCD and central-directory structural ambiguity fails closed', async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'x' }]);

  await assert.rejects(
    preflightZipArtifactV1(requestFor(zip.subarray(0, zip.length - 1))),
    /EOCD|byte length|SHA-256/u,
  );

  const wrongCentralOffset = makeZip(
    [{ name: 'a.txt', data: 'x' }],
    { centralOffset: 1 },
  );
  await assert.rejects(
    preflightZipArtifactV1(requestFor(wrongCentralOffset)),
    /central directory/u,
  );

  const zip64Eocd = makeZip(
    [{ name: 'a.txt', data: 'x' }],
    { eocdEntryCount: 0xffff, entriesOnDisk: 0xffff },
  );
  await assert.rejects(
    preflightZipArtifactV1(requestFor(zip64Eocd)),
    /ZIP64|entry count/u,
  );
});

test('non-ASCII names without the UTF-8 flag and Unicode path aliases are rejected', async () => {
  const nonUtf8Flag = makeZip([
    {
      name: 'café.txt',
      data: 'x',
      flags: 0,
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(nonUtf8Flag)),
    /non-ASCII filename requires the UTF-8 ZIP flag/u,
  );

  const unicodeAlias = makeZip([
    {
      name: 'a.txt',
      data: 'x',
      centralExtra: makeExtra(0x7075),
    },
  ]);
  await assert.rejects(
    preflightZipArtifactV1(requestFor(unicodeAlias)),
    /Unicode path alias/u,
  );
});

test('hostile descriptors, unknown fields, and schema aliases are rejected without executing getters', async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'x' }]);
  let getterReads = 0;
  const ref = artifactFor(zip);
  Object.defineProperty(ref, 'sha256', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return sha256(zip);
    },
  });
  await assert.rejects(
    preflightZipArtifactV1({
      schemaVersion: 1,
      artifactRef: ref,
      contentBase64: base64(zip),
    }),
    /sha256 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);

  const request = requestFor(zip);
  Object.defineProperty(request, 'contentBase64', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return base64(zip);
    },
  });
  await assert.rejects(
    preflightZipArtifactV1(request),
    /contentBase64 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);

  await assert.rejects(
    preflightZipArtifactV1({ ...requestFor(zip), schemaVersion: '1' }),
    /Unsupported ZipArtifactPreflightV1 schemaVersion/u,
  );
  await assert.rejects(
    preflightZipArtifactV1({ ...requestFor(zip), extract: true }),
    /unknown field: extract/u,
  );
});
