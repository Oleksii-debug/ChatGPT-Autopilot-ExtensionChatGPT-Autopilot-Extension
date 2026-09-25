import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildMediaArtifactPreflightV1,
  MAX_MEDIA_ARTIFACT_BYTES,
  MEDIA_ARTIFACT_PREFLIGHT_VERSION,
} from '../src/core/media-artifact-preflight.js';

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(text) {
  return Uint8Array.from([...text].map(char => char.charCodeAt(0)));
}

function u16le(value) {
  return Uint8Array.from([value & 255, (value >>> 8) & 255]);
}

function u32le(value) {
  return Uint8Array.from([
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255,
  ]);
}

function u32be(value) {
  return Uint8Array.from([
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]);
}

function chunk(id, payload) {
  const pad = payload.length % 2 ? Uint8Array.of(0) : new Uint8Array();
  return concat([ascii(id), u32le(payload.length), payload, pad]);
}

function wavFixture({
  audioFormat = 1,
  channels = 1,
  sampleRate = 8000,
  bitsPerSample = 16,
  frames = 8000,
  byteRateOverride = null,
  blockAlignOverride = null,
  duplicateFmt = false,
  duplicateData = false,
  prefixChunks = [],
} = {}) {
  const computedBlockAlign = channels * (bitsPerSample / 8);
  const blockAlign = blockAlignOverride ?? computedBlockAlign;
  const byteRate = byteRateOverride ?? sampleRate * computedBlockAlign;
  const fmtPayload = concat([
    u16le(audioFormat),
    u16le(channels),
    u32le(sampleRate),
    u32le(byteRate),
    u16le(blockAlign),
    u16le(bitsPerSample),
  ]);
  const dataLength = Math.max(1, Math.trunc(frames * computedBlockAlign));
  const dataPayload = new Uint8Array(dataLength);
  for (let index = 0; index < dataPayload.length; index += 1) dataPayload[index] = index & 255;
  const chunks = [
    ...prefixChunks,
    chunk('fmt ', fmtPayload),
    ...(duplicateFmt ? [chunk('fmt ', fmtPayload)] : []),
    chunk('data', dataPayload),
    ...(duplicateData ? [chunk('data', dataPayload)] : []),
  ];
  const body = concat([ascii('WAVE'), ...chunks]);
  return concat([ascii('RIFF'), u32le(body.length), body]);
}

function box(type, payload, { sizeToEof = false, extended = false } = {}) {
  if (sizeToEof) return concat([u32be(0), ascii(type), payload]);
  if (extended) {
    const size = 16 + payload.length;
    return concat([u32be(1), ascii(type), u32be(0), u32be(size), payload]);
  }
  return concat([u32be(8 + payload.length), ascii(type), payload]);
}

function ftyp({ major = 'isom', compatible = ['isom', 'mp42'] } = {}) {
  return box('ftyp', concat([
    ascii(major),
    u32be(0),
    ...compatible.map(ascii),
  ]));
}

function bmffFixture({
  major = 'isom',
  compatible = ['isom', 'mp42'],
  duplicateFtyp = false,
  missingMoov = false,
  missingMdat = false,
  mdatSizeToEof = false,
  extendedMoov = false,
} = {}) {
  const f = ftyp({ major, compatible });
  const moov = box('moov', box('mvhd', Uint8Array.of(0, 0, 0, 0)), { extended: extendedMoov });
  const mdat = box('mdat', Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), { sizeToEof: mdatSizeToEof });
  return concat([
    f,
    ...(duplicateFtyp ? [f] : []),
    ...(missingMoov ? [] : [moov]),
    ...(missingMdat ? [] : [mdat]),
  ]);
}

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function artifact(bytes, mediaType, { sensitive = false, overrides = {} } = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'artifact.media.1',
    kind: 'project-media',
    uri: 'artifact://project/media/artifact.media.1',
    mediaType,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
    createdAt: '2026-09-25T16:00:00.000Z',
    producerInvocationId: 'invocation.media.import',
    sensitive,
    ...overrides,
  };
}

function request(bytes, mediaType, options = {}) {
  return {
    schemaVersion: MEDIA_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef: artifact(bytes, mediaType, options),
    mediaBase64: Buffer.from(bytes).toString('base64'),
  };
}

test('preflights exact PCM WAV material without granting playback or transcription authority', async () => {
  const bytes = wavFixture();
  const out = await buildMediaArtifactPreflightV1(request(bytes, 'audio/wav'));

  assert.equal(out.schemaVersion, 1);
  assert.equal(out.mediaType, 'audio/wav');
  assert.equal(out.byteLength, bytes.length);
  assert.equal(out.sha256, sha256(bytes));
  assert.equal(out.formatEnvelopeVerified, true);
  assert.equal(out.materialIdentityVerified, true);
  assert.equal(out.technical.container, 'RIFF_WAVE_PCM');
  assert.equal(out.technical.channels, 1);
  assert.equal(out.technical.sampleRateHz, 8000);
  assert.equal(out.technical.bitsPerSample, 16);
  assert.equal(out.technical.sampleFrames, 8000);
  assert.equal(out.technical.durationMillisFloor, 1000);
  assert.equal(out.technical.modalityVerified, true);
  assert.equal(out.rawBytesReturned, false);
  assert.equal(out.contentDecoded, false);
  assert.equal(out.transcriptExtracted, false);
  assert.equal(out.playbackAuthorized, false);
  assert.equal(out.transcriptionAuthorized, false);
  assert.equal(out.uploadAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.technical), true);
});

test('preflights bounded ISO-BMFF envelope for audio/mp4 and video/mp4 without claiming track modality', async () => {
  for (const mediaType of ['audio/mp4', 'video/mp4']) {
    const bytes = bmffFixture();
    const out = await buildMediaArtifactPreflightV1(request(bytes, mediaType));
    assert.equal(out.technical.container, 'ISO_BMFF');
    assert.equal(out.technical.majorBrand, 'isom');
    assert.deepEqual(out.technical.compatibleBrands, ['isom', 'mp42']);
    assert.deepEqual(out.technical.topLevelBoxTypes, ['ftyp', 'moov', 'mdat']);
    assert.equal(out.technical.moovCount, 1);
    assert.equal(out.technical.mdatCount, 1);
    assert.equal(out.technical.mdatPayloadBytes, 8);
    assert.equal(out.technical.modalityVerified, false);
    assert.equal(out.codecVerified, false);
    assert.equal(out.tracksVerified, false);
    assert.equal(out.requiresQualifiedDecoder, true);
  }
});

test('accepts M4A-compatible branding and bounded extended-size moov box', async () => {
  const bytes = bmffFixture({
    major: 'M4A ',
    compatible: ['isom', 'mp42'],
    extendedMoov: true,
  });
  const out = await buildMediaArtifactPreflightV1(request(bytes, 'audio/mp4'));
  assert.equal(out.technical.majorBrand, 'M4A ');
  assert.equal(out.technical.topLevelBoxCount, 3);
});

test('sensitive media stays identity-only and requires later canonical disclosure authorization', async () => {
  const bytes = wavFixture({ frames: 16 });
  const out = await buildMediaArtifactPreflightV1(
    request(bytes, 'audio/wav', { sensitive: true }),
  );
  assert.equal(out.artifactRef.sensitive, true);
  assert.equal(out.requiresCanonicalDisclosureAuthorization, true);
  assert.equal(out.disclosureAuthorized, false);
  assert.equal(out.rawBytesReturned, false);
  assert.equal('mediaBase64' in out, false);
});

test('fails closed on immutable size, digest, MIME and container substitution', async () => {
  const wav = wavFixture({ frames: 16 });
  await assert.rejects(
    buildMediaArtifactPreflightV1({
      ...request(wav, 'audio/wav'),
      artifactRef: artifact(wav, 'audio/wav', { overrides: { sizeBytes: wav.length + 1 } }),
    }),
    /decoded byte length does not match/u,
  );

  await assert.rejects(
    buildMediaArtifactPreflightV1({
      ...request(wav, 'audio/wav'),
      artifactRef: artifact(wav, 'audio/wav', { overrides: { sha256: '0'.repeat(64) } }),
    }),
    /SHA-256 does not match/u,
  );

  const mp4 = bmffFixture();
  await assert.rejects(
    buildMediaArtifactPreflightV1({
      ...request(mp4, 'video/mp4'),
      artifactRef: artifact(mp4, 'application/octet-stream'),
    }),
    /mediaType is unsupported/u,
  );

  await assert.rejects(
    buildMediaArtifactPreflightV1(request(mp4, 'audio/wav')),
    /RIFF\/WAVE envelope/u,
  );
});

test('rejects non-canonical Base64 before media parsing', async () => {
  const one = Uint8Array.of(0);
  const req = request(one, 'audio/wav');
  await assert.rejects(
    buildMediaArtifactPreflightV1({ ...req, mediaBase64: 'AB==' }),
    /non-canonical unused bits/u,
  );
  await assert.rejects(
    buildMediaArtifactPreflightV1({ ...req, mediaBase64: 'AA' }),
    /canonical padded Base64/u,
  );
});

test('rejects malformed WAV envelope, duplicate critical chunks and PCM invariant drift', async () => {
  const valid = wavFixture({ frames: 16 });

  const badRiffSize = valid.slice();
  badRiffSize.set(u32le(1), 4);
  await assert.rejects(
    buildMediaArtifactPreflightV1(request(badRiffSize, 'audio/wav')),
    /RIFF size/u,
  );

  for (const bytes of [
    wavFixture({ frames: 16, duplicateFmt: true }),
    wavFixture({ frames: 16, duplicateData: true }),
  ]) {
    await assert.rejects(
      buildMediaArtifactPreflightV1(request(bytes, 'audio/wav')),
      /ambiguous duplicate/u,
    );
  }

  await assert.rejects(
    buildMediaArtifactPreflightV1(request(
      wavFixture({ frames: 16, audioFormat: 3 }),
      'audio/wav',
    )),
    /only uncompressed PCM/u,
  );

  await assert.rejects(
    buildMediaArtifactPreflightV1(request(
      wavFixture({ frames: 16, blockAlignOverride: 99 }),
      'audio/wav',
    )),
    /byte-rate\/block-align invariants/u,
  );

  await assert.rejects(
    buildMediaArtifactPreflightV1(request(
      wavFixture({ frames: 16, byteRateOverride: 1 }),
      'audio/wav',
    )),
    /byte-rate\/block-align invariants/u,
  );
});

test('rejects truncated WAV chunks and incomplete sample frames', async () => {
  const truncated = wavFixture({ frames: 16 }).slice(0, -1);
  const fixedHeader = truncated.slice();
  fixedHeader.set(u32le(fixedHeader.length - 8), 4);
  await assert.rejects(
    buildMediaArtifactPreflightV1(request(fixedHeader, 'audio/wav')),
    /chunk payload|padding|sample frames/u,
  );

  const bytes = wavFixture({ frames: 16 });
  const odd = bytes.slice(0, -1);
  odd.set(u32le(odd.length - 8), 4);
  const dataSizeOffset = 40;
  odd.set(u32le(31), dataSizeOffset);
  await assert.rejects(
    buildMediaArtifactPreflightV1(request(odd, 'audio/wav')),
    /sample frames|padding|payload/u,
  );
});

test('rejects ambiguous or incomplete ISO-BMFF top-level structure', async () => {
  for (const [bytes, pattern] of [
    [bmffFixture({ duplicateFtyp: true }), /duplicate ftyp/u],
    [bmffFixture({ missingMoov: true }), /exactly one moov/u],
    [bmffFixture({ missingMdat: true }), /at least one mdat/u],
    [bmffFixture({ mdatSizeToEof: true }), /size-to-EOF/u],
    [bmffFixture({ major: 'xxxx', compatible: ['yyyy'] }), /no admitted MP4\/M4A-compatible brand/u],
  ]) {
    await assert.rejects(
      buildMediaArtifactPreflightV1(request(bytes, 'video/mp4')),
      pattern,
    );
  }
});

test('rejects ISO-BMFF truncation and unsafe box sizes', async () => {
  const valid = bmffFixture();
  const truncated = valid.slice(0, -1);
  await assert.rejects(
    buildMediaArtifactPreflightV1(request(truncated, 'video/mp4')),
    /exceeds immutable material bounds/u,
  );

  const bad = valid.slice();
  const ftypSize = (
    bad[0] * 0x1000000 + bad[1] * 0x10000 + bad[2] * 0x100 + bad[3]
  );
  bad.set(u32be(MAX_MEDIA_ARTIFACT_BYTES), ftypSize);
  await assert.rejects(
    buildMediaArtifactPreflightV1(request(bad, 'video/mp4')),
    /exceeds immutable material bounds/u,
  );
});

test('public request and ArtifactRef boundaries reject accessors, symbols and unknown fields without coercion', async () => {
  const bytes = wavFixture({ frames: 16 });
  const base = request(bytes, 'audio/wav');
  let getterCalls = 0;
  const hostile = {
    artifactRef: base.artifactRef,
    mediaBase64: base.mediaBase64,
  };
  Object.defineProperty(hostile, 'schemaVersion', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  await assert.rejects(
    buildMediaArtifactPreflightV1(hostile),
    /enumerable own data properties/u,
  );
  assert.equal(getterCalls, 0);

  const withUnknown = { ...base, extra: true };
  await assert.rejects(
    buildMediaArtifactPreflightV1(withUnknown),
    /unknown field/u,
  );

  const withSymbol = { ...base };
  withSymbol[Symbol('hidden')] = true;
  await assert.rejects(
    buildMediaArtifactPreflightV1(withSymbol),
    /unknown field/u,
  );

  const hostileArtifact = { ...base.artifactRef };
  Object.defineProperty(hostileArtifact, 'mediaType', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'audio/wav';
    },
  });
  await assert.rejects(
    buildMediaArtifactPreflightV1({ ...base, artifactRef: hostileArtifact }),
    /enumerable own data properties/u,
  );
  assert.equal(getterCalls, 0);
});
