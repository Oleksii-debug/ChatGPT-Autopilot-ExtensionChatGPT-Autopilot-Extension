import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  HTML_ARTIFACT_PREFLIGHT_VERSION,
  MAX_HTML_ARTIFACT_BYTES,
  preflightHtmlArtifactV1,
} from '../src/core/html-artifact-preflight.js';

const utf8 = value => Buffer.from(value, 'utf8');
const b64 = bytes => Buffer.from(bytes).toString('base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function ref(bytes, mediaType = 'text/html', overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'html-1',
    kind: 'document',
    uri: 'artifact://html-1',
    mediaType,
    sha256: sha(bytes),
    sizeBytes: bytes.byteLength,
    createdAt: '2026-09-25T18:00:00.000Z',
    producerInvocationId: 'invoke-html-1',
    sensitive: false,
    ...overrides,
  };
}

function requestFromBytes(bytes, mediaType = 'text/html', overrides = {}) {
  return {
    schemaVersion: HTML_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef: ref(bytes, mediaType),
    contentBase64: b64(bytes),
    ...overrides,
  };
}

function request(text, mediaType = 'text/html', overrides = {}) {
  return requestFromBytes(utf8(text), mediaType, overrides);
}

test('verifies immutable benign HTML material without claiming parse or render safety', async () => {
  const out = await preflightHtmlArtifactV1(request(
    '<!doctype html>\n<html lang="uk"><head><title>Тест</title></head><body><main>Привіт</main></body></html>\n',
  ));
  assert.equal(out.materialIdentityVerified, true);
  assert.equal(out.utf8Verified, true);
  assert.equal(out.mediaType, 'text/html');
  assert.equal(out.lexical.doctypeDeclared, true);
  assert.equal(out.lexical.htmlElementSeen, true);
  assert.equal(out.lexical.hasRiskIndicators, false);
  assert.equal(out.lines.lineEnding, 'LF');
  assert.equal(out.textReturned, false);
  assert.equal(out.fullHtmlParsePerformed, false);
  assert.equal(out.activeContentScanComplete, false);
  assert.equal(out.safeForAutomaticRender, false);
  assert.equal(out.renderingAuthorized, false);
  assert.equal(out.publishingAuthorized, false);
  assert.equal(out.requiresQualifiedHtmlParser, true);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.lexical), true);
  assert.equal(Object.isFrozen(out.lexical.riskIndicators), true);
});

test('supports exact XHTML media identity without widening media aliases', async () => {
  const text = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body>ok</body></html>';
  const out = await preflightHtmlArtifactV1(request(text, 'application/xhtml+xml'));
  assert.equal(out.mediaType, 'application/xhtml+xml');
  assert.equal(out.lexical.htmlElementSeen, true);

  await assert.rejects(
    preflightHtmlArtifactV1(request(text, 'application/xml')),
    /mediaType must be/u,
  );
  await assert.rejects(
    preflightHtmlArtifactV1(request(text, 'text/html; charset=utf-8')),
    /mediaType must be/u,
  );
});

test('reports conservative executable and remote-loading risk evidence without executing markup', async () => {
  const html = [
    '<!doctype html><html><head>',
    '<base href="https://example.test/">',
    '<style>@import url(//cdn.example.test/a.css)</style>',
    '<meta http-equiv="refresh" content="0;url=https://example.test/next">',
    '</head><body onload="boot()">',
    '<script>location.href="javascript:alert(1)"</script>',
    '<iframe src="https://example.test/frame"></iframe>',
    '<form action="//example.test/post"><input></form>',
    '<a href="data:text/html,x">x</a>',
    '</body></html>',
  ].join('');
  const out = await preflightHtmlArtifactV1(request(html));
  const risks = new Set(out.lexical.riskIndicators);
  for (const risk of [
    'BASE_TAG',
    'DATA_URL',
    'EVENT_HANDLER_ATTRIBUTE',
    'FORM_TAG',
    'IFRAME_TAG',
    'IMPORT_OR_URL_CSS',
    'JAVASCRIPT_URL',
    'META_REFRESH',
    'REMOTE_RESOURCE_URL',
    'SCRIPT_TAG',
    'STYLE_SURFACE',
  ]) {
    assert.equal(risks.has(risk), true, risk);
  }
  assert.equal(out.lexical.hasRiskIndicators, true);
  assert.equal(out.activeContentScanComplete, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.browserNavigationAuthorized, false);
});

test('sensitive HTML returns structural facts only and preserves disclosure fence', async () => {
  const bytes = utf8('<html><body>private</body></html>');
  const out = await preflightHtmlArtifactV1(requestFromBytes(bytes, 'text/html', {
    artifactRef: ref(bytes, 'text/html', { sensitive: true }),
  }));
  assert.equal(out.artifactRef.sensitive, true);
  assert.equal(out.textReturned, false);
  assert.equal(out.contentDisclosureAuthorized, false);
  assert.equal(out.requiresCanonicalDisclosureAuthorization, true);
  assert.equal(JSON.stringify(out).includes('private'), false);
});

test('immutable ArtifactRef binding rejects digest, size, signed zero and representation aliases', async () => {
  const bytes = utf8('<html><body>ok</body></html>');
  const canonical = ref(bytes);

  await assert.rejects(
    preflightHtmlArtifactV1(requestFromBytes(bytes, 'text/html', {
      artifactRef: { ...canonical, sha256: 'b'.repeat(64) },
    })),
    /SHA-256 does not match/u,
  );
  await assert.rejects(
    preflightHtmlArtifactV1(requestFromBytes(bytes, 'text/html', {
      artifactRef: { ...canonical, sizeBytes: bytes.length + 1 },
    })),
    /byte length does not match/u,
  );
  await assert.rejects(
    preflightHtmlArtifactV1(requestFromBytes(bytes, 'text/html', {
      artifactRef: { ...canonical, sizeBytes: -0 },
    })),
    /sizeBytes/u,
  );
  await assert.rejects(
    preflightHtmlArtifactV1(requestFromBytes(bytes, 'text/html', {
      artifactRef: { ...canonical, sha256: canonical.sha256.toUpperCase() },
    })),
    /not already canonical: sha256/u,
  );
  await assert.rejects(
    preflightHtmlArtifactV1(requestFromBytes(bytes, 'text/html', {
      artifactRef: { ...canonical, mediaType: ' text/html ' },
    })),
    /not already canonical: mediaType/u,
  );
});

test('rejects noncanonical Base64, UTF-8 BOM, invalid UTF-8, NUL and disallowed controls', async () => {
  const bytes = utf8('<html>ok</html>');
  const valid = requestFromBytes(bytes);
  await assert.rejects(
    preflightHtmlArtifactV1({ ...valid, contentBase64: valid.contentBase64 + '\n' }),
    /canonical Base64/u,
  );

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('<html>ok</html>')]);
  await assert.rejects(preflightHtmlArtifactV1(requestFromBytes(bom)), /BOM/u);

  const invalid = Buffer.from([0x3c, 0x70, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x70, 0x3e]);
  await assert.rejects(preflightHtmlArtifactV1(requestFromBytes(invalid)), /valid UTF-8/u);

  const nul = Buffer.from('<html>\u0000</html>', 'utf8');
  await assert.rejects(preflightHtmlArtifactV1(requestFromBytes(nul)), /NUL/u);

  const control = Buffer.from('<html>\u0001</html>', 'utf8');
  await assert.rejects(preflightHtmlArtifactV1(requestFromBytes(control)), /control character/u);
});

test('reports exact line-ending facts without normalizing artifact bytes', async () => {
  const lf = await preflightHtmlArtifactV1(request('<html>\n<body>x</body>\n</html>'));
  assert.deepEqual(lf.lines, {
    lineEnding: 'LF',
    lineCount: 3,
    crlfCount: 0,
    lfCount: 2,
    crCount: 0,
  });

  const crlf = await preflightHtmlArtifactV1(request('<html>\r\n<body>x</body>\r\n</html>'));
  assert.equal(crlf.lines.lineEnding, 'CRLF');
  assert.equal(crlf.lines.crlfCount, 2);

  const mixed = await preflightHtmlArtifactV1(request('<html>\r\n<body>x</body>\n</html>'));
  assert.equal(mixed.lines.lineEnding, 'MIXED');
});

test('request and ArtifactRef descriptor boundaries reject accessors without executing getters', async () => {
  const bytes = utf8('<html>safe</html>');
  const canonical = ref(bytes);
  let requestGetterCalls = 0;
  const hostile = {
    schemaVersion: 1,
    artifactRef: canonical,
  };
  Object.defineProperty(hostile, 'contentBase64', {
    enumerable: true,
    get() {
      requestGetterCalls += 1;
      return b64(bytes);
    },
  });
  await assert.rejects(preflightHtmlArtifactV1(hostile), /enumerable own data property/u);
  assert.equal(requestGetterCalls, 0);

  let refGetterCalls = 0;
  const hostileRef = { ...canonical };
  Object.defineProperty(hostileRef, 'sha256', {
    enumerable: true,
    get() {
      refGetterCalls += 1;
      return canonical.sha256;
    },
  });
  await assert.rejects(
    preflightHtmlArtifactV1({ schemaVersion: 1, artifactRef: hostileRef, contentBase64: b64(bytes) }),
    /enumerable own data property/u,
  );
  assert.equal(refGetterCalls, 0);
});

test('rejects unknown, symbol, hidden and exotic public envelope fields', async () => {
  const bytes = utf8('<html>ok</html>');
  const base = requestFromBytes(bytes);

  await assert.rejects(
    preflightHtmlArtifactV1({ ...base, extra: true }),
    /unknown field/u,
  );

  const symbolic = { ...base };
  symbolic[Symbol('hidden')] = true;
  await assert.rejects(preflightHtmlArtifactV1(symbolic), /unknown field/u);

  const hidden = { ...base };
  Object.defineProperty(hidden, 'contentBase64', {
    value: base.contentBase64,
    enumerable: false,
  });
  await assert.rejects(preflightHtmlArtifactV1(hidden), /enumerable own data property/u);

  const exotic = Object.create({ inherited: true });
  Object.assign(exotic, base);
  await assert.rejects(preflightHtmlArtifactV1(exotic), /plain or null-prototype/u);

  const nullPrototype = Object.assign(Object.create(null), base);
  const out = await preflightHtmlArtifactV1(nullPrototype);
  assert.equal(out.materialIdentityVerified, true);
});

test('enforces admitted byte bound before downstream HTML interpretation', async () => {
  const bytes = utf8('<html>x</html>');
  const oversizedRef = ref(bytes, 'text/html', { sizeBytes: MAX_HTML_ARTIFACT_BYTES + 1 });
  await assert.rejects(
    preflightHtmlArtifactV1({
      schemaVersion: 1,
      artifactRef: oversizedRef,
      contentBase64: b64(bytes),
    }),
    /sizeBytes/u,
  );
});
