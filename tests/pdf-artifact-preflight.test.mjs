import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  MAX_PDF_ARTIFACT_BYTES,
  PDF_PASSIVE_SCREEN_SCOPE,
  buildPdfArtifactPreflightV1,
} from '../src/core/pdf-artifact-preflight.js';

function pdf(body = '<< /Type /Catalog >>', { version = '1.7' } = {}) {
  return [
    '%PDF-' + version,
    '1 0 obj',
    body,
    'endobj',
    'xref',
    '0 1',
    '0000000000 65535 f ',
    'trailer',
    '<< /Size 1 /Root 1 0 R >>',
    'startxref',
    '9',
    '%%EOF',
    '',
  ].join('\n');
}

function artifactFor(material, overrides = {}) {
  const bytes = Buffer.from(material, 'binary');
  return {
    schemaVersion: 1,
    artifactId: 'pdf-report',
    kind: 'DOCUMENT',
    uri: 'artifact://project/pdf-report',
    mediaType: 'application/pdf',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    createdAt: '2026-09-25T15:20:00.000Z',
    producerInvocationId: 'build-pdf',
    sensitive: false,
    ...overrides,
  };
}

function request(material, artifactOverrides = {}) {
  const bytes = Buffer.from(material, 'binary');
  return {
    schemaVersion: 1,
    artifactRef: artifactFor(material, artifactOverrides),
    pdfBase64: bytes.toString('base64'),
  };
}

async function run(material, artifactOverrides = {}) {
  return buildPdfArtifactPreflightV1(
    request(material, artifactOverrides),
    { cryptoApi: webcrypto },
  );
}

test('valid immutable PDF material produces a bounded authority-free passive preflight', async () => {
  const material = pdf();
  const result = await run(material);

  assert.equal(result.materialIdentityVerified, true);
  assert.equal(result.formatEnvelopeVerified, true);
  assert.equal(result.pdfVersion, '1.7');
  assert.equal(result.byteLength, Buffer.byteLength(material, 'binary'));
  assert.equal(result.sha256, artifactFor(material).sha256);
  assert.equal(result.streamCount, 0);
  assert.equal(result.passiveSafetyScreenScope, PDF_PASSIVE_SCREEN_SCOPE);
  assert.equal(result.activeContentDetected, false);
  assert.deepEqual(result.activeContentFindings, []);
  assert.equal(result.safePassiveReviewReady, true);
  assert.equal(result.fullPdfParsePerformed, false);
  assert.equal(result.requiresQualifiedParserOrRenderer, true);
  assert.equal(result.extractionAuthorized, false);
  assert.equal(result.accessibilityVerified, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.approvalAuthorized, false);
  assert.equal(result.distributionAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.artifactRef), true);
  assert.equal(Object.isFrozen(result.activeContentFindings), true);
});

test('material size and digest are rebound to the exact immutable ArtifactRef', async () => {
  const material = pdf();

  const wrongSize = request(material);
  wrongSize.artifactRef.sizeBytes += 1;
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(wrongSize, { cryptoApi: webcrypto }),
    /decoded byte length does not match immutable ArtifactRef/,
  );

  const wrongDigest = request(material);
  wrongDigest.artifactRef.sha256 = '0'.repeat(64);
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(wrongDigest, { cryptoApi: webcrypto }),
    /SHA-256 does not match immutable ArtifactRef/,
  );

  const uppercaseDigest = request(material);
  uppercaseDigest.artifactRef.sha256 = uppercaseDigest.artifactRef.sha256.toUpperCase();
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(uppercaseDigest, { cryptoApi: webcrypto }),
    /canonical representation: sha256/,
  );

  await assert.rejects(
    () => run(material, { mediaType: 'application/octet-stream' }),
    /mediaType must be exactly application\/pdf/,
  );
});

test('PDF envelope rejects bad header, missing EOF, missing startxref, and impossible xref offset', async () => {
  await assert.rejects(
    () => run(pdf().replace('%PDF-1.7', '%PDF-9.9')),
    /header\/version is not admitted/,
  );
  await assert.rejects(
    () => run(pdf().replace('%%EOF', '%%EOX')),
    /final %%EOF marker is missing/,
  );
  await assert.rejects(
    () => run(pdf().replace('startxref\n9\n', 'startxreX\n9\n')),
    /final startxref marker is missing/,
  );
  await assert.rejects(
    () => run(pdf().replace('startxref\n9\n', 'startxref\n999999\n')),
    /startxref offset is outside/,
  );
});

test('active structural action names block passive-ready state, including #xx name escapes', async () => {
  const material = pdf([
    '<<',
    ' /Type /Catalog',
    ' /OpenAction 2 0 R',
    ' /AA << /O 3 0 R >>',
    ' /Names << /Java#53cript 4 0 R >>',
    ' /S /Launch',
    ' /Subtype /EmbeddedFile',
    '>>',
  ].join('\n'));
  const result = await run(material);

  assert.equal(result.activeContentDetected, true);
  assert.equal(result.safePassiveReviewReady, false);
  assert.deepEqual(
    result.activeContentFindings.map(item => item.name),
    ['/AA', '/EmbeddedFile', '/JavaScript', '/Launch', '/OpenAction'],
  );
  assert.equal(result.executionAuthorized, false);
});

test('stream payload is not misclassified as structural active content', async () => {
  const material = pdf([
    '<< /Length 37 >>',
    'stream',
    '/JavaScript /Launch /OpenAction /AA',
    'endstream',
  ].join('\n'));
  const result = await run(material);

  assert.equal(result.streamCount, 1);
  assert.equal(result.activeContentDetected, false);
  assert.equal(result.safePassiveReviewReady, true);
});

test('literal strings, hex strings, and comments are data rather than structural action names', async () => {
  const material = pdf([
    '<<',
    ' /Type /Catalog',
    ' /Title (/JavaScript /Launch /OpenAction)',
    ' /Subject <2F4A617661536372697074>',
    ' % /AA /EmbeddedFile',
    '>>',
  ].join('\n'));
  const result = await run(material);
  assert.equal(result.activeContentDetected, false);
});

test('canonical Base64 representation is required before PDF bytes are admitted', async () => {
  const material = pdf();
  const canonical = request(material);

  const withWhitespace = structuredClone(canonical);
  withWhitespace.pdfBase64 += '\n';
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(withWhitespace, { cryptoApi: webcrypto }),
    /canonical padded Base64/,
  );

  const unpadded = structuredClone(canonical);
  unpadded.pdfBase64 = unpadded.pdfBase64.replace(/=+$/u, '');
  if (unpadded.pdfBase64.length % 4 === 0) unpadded.pdfBase64 += 'A';
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(unpadded, { cryptoApi: webcrypto }),
    /canonical padded Base64|invalid Base64/,
  );

  const nonTerminalPadding = structuredClone(canonical);
  nonTerminalPadding.pdfBase64 = 'AA=A';
  nonTerminalPadding.artifactRef.sizeBytes = 3;
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(nonTerminalPadding, { cryptoApi: webcrypto }),
    /non-terminal padding|invalid Base64/,
  );
});

test('bounded PDF admission rejects declared oversized material before large decode allocation', async () => {
  const material = pdf();
  const oversized = request(material);
  oversized.artifactRef.sizeBytes = MAX_PDF_ARTIFACT_BYTES + 1;
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(oversized, { cryptoApi: webcrypto }),
    /sizeBytes exceeds the bounded PDF preflight range/,
  );
});

test('top-level and ArtifactRef accessors fail before getter execution', async () => {
  const material = pdf();
  const base = request(material);
  let reads = 0;

  const hostileRequest = {
    schemaVersion: 1,
    artifactRef: base.artifactRef,
  };
  Object.defineProperty(hostileRequest, 'pdfBase64', {
    enumerable: true,
    get() {
      reads += 1;
      return base.pdfBase64;
    },
  });
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(hostileRequest, { cryptoApi: webcrypto }),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);

  const hostileArtifact = { ...base.artifactRef };
  Object.defineProperty(hostileArtifact, 'sha256', {
    enumerable: true,
    get() {
      reads += 1;
      return base.artifactRef.sha256;
    },
  });
  await assert.rejects(
    () => buildPdfArtifactPreflightV1({
      ...base,
      artifactRef: hostileArtifact,
    }, { cryptoApi: webcrypto }),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);
});

test('unknown request fields and malformed structural tokens fail closed', async () => {
  const material = pdf();
  await assert.rejects(
    () => buildPdfArtifactPreflightV1({
      ...request(material),
      parserAuthority: true,
    }, { cryptoApi: webcrypto }),
    /unknown field/,
  );

  await assert.rejects(
    () => run(pdf('<< /Title (unterminated >>')),
    /unterminated literal string/,
  );

  await assert.rejects(
    () => run(pdf('<< /Length 5 >>\nstream\nabcde')),
    /stream is not terminated/,
  );

  await assert.rejects(
    () => run(pdf('<< /Java#5Gcript 2 0 R >>')),
    /malformed #xx escape/,
  );
});

test('sensitive PDF remains disclosure-gated even when structural screen is clean', async () => {
  const result = await run(pdf(), { sensitive: true });
  assert.equal(result.safePassiveReviewReady, true);
  assert.equal(result.requiresCanonicalDisclosureAuthorization, true);
  assert.equal(result.disclosureAuthorized, false);
  assert.equal(result.distributionAuthorized, false);
});

test('Web Crypto is mandatory and PDF 2.0 is admitted without claiming full parse', async () => {
  const material = pdf('<< /Type /Catalog >>', { version: '2.0' });
  const req = request(material);
  await assert.rejects(
    () => buildPdfArtifactPreflightV1(req, { cryptoApi: null }),
    /Web Crypto SHA-256 is unavailable/,
  );
  const result = await buildPdfArtifactPreflightV1(req, { cryptoApi: webcrypto });
  assert.equal(result.pdfVersion, '2.0');
  assert.equal(result.fullPdfParsePerformed, false);
});
