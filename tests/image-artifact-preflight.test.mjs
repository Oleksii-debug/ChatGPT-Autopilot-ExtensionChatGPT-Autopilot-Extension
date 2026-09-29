import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
  IMAGE_ARTIFACT_PREFLIGHT_VERSION, MAX_IMAGE_ARTIFACT_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS,
  preflightImageArtifactV1,
} from '../src/core/image-artifact-preflight.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const b64 = bytes => Buffer.from(bytes).toString('base64');
const u32 = n => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = n => Uint8Array.from([(n >>> 8) & 255, n & 255]);
function cat(...parts) { const n = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
const ascii = s => Uint8Array.from([...s].map(c => c.charCodeAt(0)));
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = ascii(type); return cat(u32(data.length), t, data, u32(crc32(cat(t, data)))); }
function png({ width = 4, height = 3, bitDepth = 8, colorType = 6, before = [], after = [] } = {}) {
  return cat(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', cat(u32(width), u32(height), Uint8Array.from([bitDepth,colorType,0,0,0]))), ...before,
    chunk('IDAT', Uint8Array.from([0x78,0x9c,0x01])), ...after, chunk('IEND', new Uint8Array()));
}
function seg(marker, payload) { return cat(Uint8Array.from([0xff,marker]), u16(payload.length + 2), payload); }
function jpeg({ width = 4, height = 3, progressive = false, precision = 8, components = 3 } = {}) {
  const triples = []; const pairs = []; for (let i = 0; i < components; i += 1) { triples.push(i + 1, 0x11, 0); pairs.push(i + 1, 0); }
  const sof = cat(Uint8Array.from([precision]), u16(height), u16(width), Uint8Array.from([components, ...triples]));
  const sos = Uint8Array.from([components, ...pairs, 0, 63, 0]);
  return cat(Uint8Array.from([0xff,0xd8]), seg(progressive ? 0xc2 : 0xc0, sof), seg(0xda, sos),
    Uint8Array.from([0x11,0xff,0x00,0x22,0xff,0xd0,0x33]), Uint8Array.from([0xff,0xd9]));
}
function ref(bytes, mediaType, overrides = {}) { return { schemaVersion: 1, artifactId: 'image-1', kind: 'image', uri: 'artifact://image-1', mediaType, sha256: sha(bytes), sizeBytes: bytes.byteLength, createdAt: '2026-09-25T17:00:00.000Z', producerInvocationId: 'invoke-image-1', sensitive: false, ...overrides }; }
function request(bytes, mediaType, overrides = {}) { return { schemaVersion: IMAGE_ARTIFACT_PREFLIGHT_VERSION, artifactRef: ref(bytes, mediaType), contentBase64: b64(bytes), ...overrides }; }
const preflight = r => preflightImageArtifactV1(r, { cryptoImpl: webcrypto });

test('verifies exact PNG identity, CRCs and bounded structural facts without decoding pixels', async () => {
  const bytes = png({ width: 640, height: 480 }); const out = await preflight(request(bytes, 'image/png'));
  assert.equal(out.structural.format, 'PNG'); assert.equal(out.structural.width, 640); assert.equal(out.structural.height, 480);
  assert.equal(out.structural.pixelCount, 307200); assert.equal(out.materialIdentityVerified, true); assert.equal(out.structural.crcVerified, true);
  assert.equal(out.pixelsDecoded, false); assert.equal(out.visionAuthorized, false); assert.equal(out.contentDisclosureAuthorized, false);
  assert.equal(Object.isFrozen(out), true); assert.equal(Object.isFrozen(out.structural), true);
});

test('verifies baseline and progressive JPEG scan envelopes with stuffed and restart bytes', async () => {
  const a = await preflight(request(jpeg({ width: 1280, height: 720 }), 'image/jpeg'));
  assert.equal(a.structural.coding, 'BASELINE_DCT'); assert.equal(a.structural.pixelCount, 921600); assert.equal(a.structural.entropyEnvelopeVerified, true);
  const b = await preflight(request(jpeg({ width: 320, height: 200, progressive: true }), 'image/jpeg'));
  assert.equal(b.structural.coding, 'PROGRESSIVE_DCT'); assert.equal(b.structural.progressive, true);
});

test('sensitive image preserves disclosure fences', async () => {
  const bytes = png(); const out = await preflight(request(bytes, 'image/png', { artifactRef: ref(bytes, 'image/png', { sensitive: true }) }));
  assert.equal(out.requiresCanonicalDisclosureAuthorization, true); assert.equal(out.pixelContentDisclosed, false); assert.equal(out.contentDisclosureAuthorized, false);
});

test('immutable binding rejects digest, size, media and representation aliases', async () => {
  const bytes = png(); const r = ref(bytes, 'image/png');
  await assert.rejects(preflight(request(bytes, 'image/png', { artifactRef: { ...r, sha256: 'b'.repeat(64) } })), /SHA-256 does not match/u);
  await assert.rejects(preflight(request(bytes, 'image/png', { artifactRef: { ...r, sizeBytes: bytes.length + 1 } })), /byte length does not match/u);
  await assert.rejects(preflight({ schemaVersion: 1, artifactRef: { ...r, mediaType: 'image/webp' }, contentBase64: b64(bytes) }), /mediaType must be/u);
  await assert.rejects(preflight(request(bytes, 'image/png', { artifactRef: { ...r, sha256: r.sha256.toUpperCase() } })), /not already canonical: sha256/u);
  await assert.rejects(preflight({ schemaVersion: 1, artifactRef: r, contentBase64: b64(bytes) + '\n' }), /canonical Base64/u);
});

test('PNG rejects bad signature, CRC, unknown critical chunk and required ordering', async () => {
  const good = png(); const sig = good.slice(); sig[0] = 0; await assert.rejects(preflight(request(sig, 'image/png')), /signature/u);
  const badCrc = good.slice(); badCrc[29] ^= 1; await assert.rejects(preflight(request(badCrc, 'image/png')), /CRC mismatch/u);
  const signature = good.slice(0, 8); const ihdr = good.slice(8, 33);
  const unknown = cat(signature, ihdr, chunk('ABCD', Uint8Array.from([1])), chunk('IDAT', Uint8Array.from([1])), chunk('IEND', new Uint8Array()));
  await assert.rejects(preflight(request(unknown, 'image/png')), /unsupported critical/u);
  const before = cat(signature, chunk('IDAT', Uint8Array.from([1])), ihdr, chunk('IEND', new Uint8Array()));
  await assert.rejects(preflight(request(before, 'image/png')), /IHDR must be the first/u);
});

test('PNG bounds palette, contiguous IDAT, APNG declaration and chunk reserved bit', async () => {
  await assert.rejects(preflight(request(png({ width: MAX_IMAGE_DIMENSION + 1 }), 'image/png')), /dimensions/u);
  const h = Math.floor(MAX_IMAGE_PIXELS / MAX_IMAGE_DIMENSION) + 1;
  await assert.rejects(preflight(request(png({ width: MAX_IMAGE_DIMENSION, height: h }), 'image/png')), /pixel count/u);
  await assert.rejects(preflight(request(png({ colorType: 3 }), 'image/png')), /requires PLTE/u);
  const palette = chunk('PLTE', Uint8Array.from([0,0,0])); const indexed = await preflight(request(png({ colorType: 3, bitDepth: 1, before: [palette] }), 'image/png')); assert.equal(indexed.structural.colorType, 3);
  const text = chunk('tEXt', Uint8Array.from([1])); const split = png({ after: [text, chunk('IDAT', Uint8Array.from([2]))] });
  await assert.rejects(preflight(request(split, 'image/png')), /IDAT chunks must be consecutive/u);
  const actl = chunk('acTL', cat(u32(1), u32(0))); const animated = await preflight(request(png({ before: [actl] }), 'image/png')); assert.equal(animated.structural.animationDeclared, true);
  await assert.rejects(preflight(request(png({ before: [actl, actl] }), 'image/png')), /acTL animation declaration/u);
  await assert.rejects(preflight(request(png({ before: [chunk('abca', new Uint8Array())] }), 'image/png')), /reserved bit/u);
});

test('JPEG rejects invalid structure, unsupported coding and noncanonical baseline precision', async () => {
  await assert.rejects(preflight(request(Uint8Array.from([0xff,0xd8,0xff,0xd9]), 'image/jpeg')), /EOI cannot precede/u);
  const unsupported = jpeg().slice(); unsupported[3] = 0xc3; await assert.rejects(preflight(request(unsupported, 'image/jpeg')), /unsupported/u);
  await assert.rejects(preflight(request(jpeg({ precision: 12 }), 'image/jpeg')), /sample precision/u);
  const trailing = cat(jpeg(), Uint8Array.from([0])); await assert.rejects(preflight(request(trailing, 'image/jpeg')), /trailing bytes after EOI/u);
  const missing = jpeg().slice(0, -2); await assert.rejects(preflight(request(missing, 'image/jpeg')), /missing required|entropy stream/u);
});

test('hostile descriptors and noncanonical numeric identity fail closed without getter evaluation', async () => {
  const bytes = png(); const r = ref(bytes, 'image/png'); let calls = 0;
  const hostile = { schemaVersion: 1, artifactRef: r }; Object.defineProperty(hostile, 'contentBase64', { enumerable: true, get() { calls += 1; return b64(bytes); } });
  await assert.rejects(preflight(hostile), /enumerable own data property/u); assert.equal(calls, 0);
  const badRef = { ...r }; let rcalls = 0; Object.defineProperty(badRef, 'sha256', { enumerable: true, get() { rcalls += 1; return r.sha256; } });
  await assert.rejects(preflight({ schemaVersion: 1, artifactRef: badRef, contentBase64: b64(bytes) }), /enumerable own data property/u); assert.equal(rcalls, 0);
  await assert.rejects(preflight({ schemaVersion: 1, artifactRef: { ...r, sizeBytes: -0 }, contentBase64: b64(bytes) }), /sizeBytes/u);
  await assert.rejects(preflight({ schemaVersion: 1, artifactRef: { ...r, sizeBytes: MAX_IMAGE_ARTIFACT_BYTES + 1 }, contentBase64: b64(bytes) }), /sizeBytes/u);
});


test('crypto options are descriptor-safe and never execute caller accessors', async () => {
  const bytes = png();
  let calls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'cryptoImpl', {
    enumerable: true,
    get() { calls += 1; return webcrypto; },
  });
  await assert.rejects(
    preflightImageArtifactV1(request(bytes, 'image/png'), hostile),
    /enumerable own data property/u,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    preflightImageArtifactV1(request(bytes, 'image/png'), { cryptoImpl: webcrypto, extra: true }),
    /unknown field/u,
  );

  const nullPrototype = Object.create(null);
  nullPrototype.cryptoImpl = webcrypto;
  const out = await preflightImageArtifactV1(request(bytes, 'image/png'), nullPrototype);
  assert.equal(out.materialIdentityVerified, true);
});
