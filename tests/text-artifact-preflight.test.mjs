import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  TEXT_ARTIFACT_PREFLIGHT_VERSION,
  MAX_TEXT_ARTIFACT_BYTES,
  MAX_TEXT_ARTIFACT_LINES,
  MAX_TEXT_ARTIFACT_LINE_CODE_UNITS,
  preflightTextArtifactV1,
} from '../src/core/text-artifact-preflight.js';

function bytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(bytes(value)).digest('hex');
}

function artifactFor(value, overrides = {}) {
  const material = bytes(value);
  return {
    schemaVersion: 1,
    artifactId: 'text-artifact-1',
    kind: 'text',
    uri: 'artifact://text-artifact-1',
    mediaType: 'text/markdown',
    sha256: sha256(material),
    sizeBytes: material.length,
    createdAt: '2026-09-25T16:50:00.000Z',
    producerInvocationId: 'invoke-text-1',
    sensitive: false,
    ...overrides,
  };
}

function requestFor(value, overrides = {}) {
  const material = bytes(value);
  return {
    schemaVersion: TEXT_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef: artifactFor(material),
    contentBase64: material.toString('base64'),
    ...overrides,
  };
}

test('LF text material is rebound to exact bytes and remains explicitly untrusted/non-authorizing', async () => {
  const text = '# Title\nHello, світ\n';
  const out = await preflightTextArtifactV1(requestFor(text));

  assert.equal(out.byteLength, Buffer.byteLength(text));
  assert.equal(out.sha256, sha256(text));
  assert.equal(out.mediaType, 'text/markdown');
  assert.equal(out.newlineStyle, 'LF');
  assert.equal(out.lineCount, 2);
  assert.equal(out.trailingNewline, true);
  assert.equal(out.containsTabs, false);
  assert.equal(out.contentAvailable, true);
  assert.equal(out.content, text);
  assert.equal(out.materialIdentityVerified, true);
  assert.equal(out.exactUtf8Verified, true);
  assert.equal(out.sourceTrust, 'UNVERIFIED_INPUT');
  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.instructionsAuthorized, false);
  assert.equal(out.renderingAuthorized, false);
  assert.equal(out.artifactMutationAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.distributionAuthorized, false);
  assert.equal(out.externalDisclosureAuthorized, false);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.artifactRef), true);
});

test('CRLF and tabs remain exact material facts without newline normalization', async () => {
  const text = 'alpha\tbeta\r\ngamma\r\n';
  const out = await preflightTextArtifactV1(requestFor(text));
  assert.equal(out.newlineStyle, 'CRLF');
  assert.equal(out.lineCount, 2);
  assert.equal(out.trailingNewline, true);
  assert.equal(out.containsTabs, true);
  assert.equal(out.content, text);
  assert.equal(out.byteLength, Buffer.byteLength(text));
});

test('empty UTF-8 text is a valid exact artifact with zero lines', async () => {
  const out = await preflightTextArtifactV1(requestFor('', {
    artifactRef: artifactFor('', {
      mediaType: 'text/plain',
    }),
  }));
  assert.equal(out.byteLength, 0);
  assert.equal(out.lineCount, 0);
  assert.equal(out.newlineStyle, 'NONE');
  assert.equal(out.trailingNewline, false);
  assert.equal(out.content, '');
});

test('sensitive text validates identity and structure without disclosing content', async () => {
  const text = 'customer secret\n';
  const out = await preflightTextArtifactV1(requestFor(text, {
    artifactRef: artifactFor(text, { sensitive: true }),
  }));
  assert.equal(out.contentAvailable, false);
  assert.equal(out.content, null);
  assert.equal(out.requiresCanonicalDisclosureAuthorization, true);
  assert.equal(out.externalDisclosureAuthorized, false);
  assert.equal(out.lineCount, 1);
});

test('invalid UTF-8 and UTF-8 BOM fail closed before text admission', async () => {
  const invalid = Buffer.from([0xc3, 0x28]);
  await assert.rejects(
    preflightTextArtifactV1(requestFor(invalid, {
      artifactRef: artifactFor(invalid, { mediaType: 'text/plain' }),
    })),
    /valid UTF-8/u,
  );

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]);
  await assert.rejects(
    preflightTextArtifactV1(requestFor(bom, {
      artifactRef: artifactFor(bom, { mediaType: 'text/plain' }),
    })),
    /UTF-8 BOM/u,
  );
});

test('NUL, C0/C1 controls, and bidi controls are rejected', async () => {
  const cases = [
    ['nul', 'a\u0000b', /non-text control/u],
    ['bell', 'a\u0007b', /non-text control/u],
    ['c1', 'a\u0085b', /non-text control/u],
    ['bidi-override', 'safe\u202eevil', /bidi override\/isolate/u],
    ['bidi-isolate', 'safe\u2066evil\u2069', /bidi override\/isolate/u],
  ];
  for (const [label, text, pattern] of cases) {
    await assert.rejects(
      preflightTextArtifactV1(requestFor(text, {
        artifactRef: artifactFor(text, { mediaType: 'text/plain' }),
      })),
      pattern,
      label,
    );
  }
});

test('lone CR and mixed LF/CRLF representations fail closed', async () => {
  const loneCr = 'a\rb';
  await assert.rejects(
    preflightTextArtifactV1(requestFor(loneCr, {
      artifactRef: artifactFor(loneCr, { mediaType: 'text/plain' }),
    })),
    /lone CR/u,
  );

  const mixed = 'a\nb\r\nc';
  await assert.rejects(
    preflightTextArtifactV1(requestFor(mixed, {
      artifactRef: artifactFor(mixed, { mediaType: 'text/plain' }),
    })),
    /mixes LF and CRLF/u,
  );
});

test('line length and line count are bounded independently of artifact byte bound', async () => {
  const longLine = 'a'.repeat(MAX_TEXT_ARTIFACT_LINE_CODE_UNITS + 1);
  await assert.rejects(
    preflightTextArtifactV1(requestFor(longLine, {
      artifactRef: artifactFor(longLine, { mediaType: 'text/plain' }),
    })),
    /line exceeds/u,
  );

  const tooManyLines = 'x\n'.repeat(MAX_TEXT_ARTIFACT_LINES + 1);
  await assert.rejects(
    preflightTextArtifactV1(requestFor(tooManyLines, {
      artifactRef: artifactFor(tooManyLines, { mediaType: 'text/plain' }),
    })),
    /line count/u,
  );
});

test('artifact byte ceiling fails closed before oversized material is admitted', async () => {
  const oversized = Buffer.alloc(MAX_TEXT_ARTIFACT_BYTES + 1, 0x61);
  await assert.rejects(
    preflightTextArtifactV1(requestFor(oversized, {
      artifactRef: artifactFor(oversized, { mediaType: 'text/plain' }),
    })),
    /sizeBytes is outside/u,
  );
});

test('immutable ArtifactRef rejects representation aliases, digest/size substitution, and non-text MIME', async () => {
  const text = 'hello\n';
  const ref = artifactFor(text);

  await assert.rejects(
    preflightTextArtifactV1(requestFor(text, {
      artifactRef: { ...ref, sha256: ref.sha256.toUpperCase() },
    })),
    /not already canonical: sha256/u,
  );
  await assert.rejects(
    preflightTextArtifactV1(requestFor(text, {
      artifactRef: { ...ref, sha256: 'a'.repeat(64) },
    })),
    /SHA-256 does not match/u,
  );
  await assert.rejects(
    preflightTextArtifactV1(requestFor(text, {
      artifactRef: { ...ref, sizeBytes: ref.sizeBytes + 1 },
    })),
    /byte length does not match/u,
  );
  await assert.rejects(
    preflightTextArtifactV1(requestFor(text, {
      artifactRef: { ...ref, mediaType: 'application/octet-stream' },
    })),
    /mediaType/u,
  );
  await assert.rejects(
    preflightTextArtifactV1(requestFor(text, {
      artifactRef: { ...ref, mediaType: 'Text/Plain' },
    })),
    /mediaType|not already canonical/u,
  );
  await assert.rejects(
    preflightTextArtifactV1(requestFor(text, {
      artifactRef: { ...ref, mediaType: 'text/plain; charset=utf-8' },
    })),
    /mediaType/u,
  );
});

test('application text-like media types are admitted but JSON remains routed to its dedicated preflight', async () => {
  for (const mediaType of [
    'application/xml',
    'application/javascript',
    'application/yaml',
    'application/markdown',
    'application/sql',
    'application/graphql',
  ]) {
    const text = 'value\n';
    const out = await preflightTextArtifactV1(requestFor(text, {
      artifactRef: artifactFor(text, { mediaType }),
    }));
    assert.equal(out.mediaType, mediaType);
  }

  const json = '{}';
  await assert.rejects(
    preflightTextArtifactV1(requestFor(json, {
      artifactRef: artifactFor(json, { mediaType: 'application/json' }),
    })),
    /mediaType/u,
  );
});

test('Base64 must be exact canonical bytes without whitespace or padding aliases', async () => {
  const text = 'abc';
  const request = requestFor(text, {
    artifactRef: artifactFor(text, { mediaType: 'text/plain' }),
  });
  await assert.rejects(
    preflightTextArtifactV1({
      ...request,
      contentBase64: request.contentBase64 + '\n',
    }),
    /canonical Base64/u,
  );
  await assert.rejects(
    preflightTextArtifactV1({
      ...request,
      contentBase64: request.contentBase64.replace(/=$/u, ''),
    }),
    /canonical Base64/u,
  );
});

test('hostile descriptors and unknown fields fail without executing getters', async () => {
  const text = 'safe';
  let getterReads = 0;
  const ref = artifactFor(text, { mediaType: 'text/plain' });
  Object.defineProperty(ref, 'sha256', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return sha256(text);
    },
  });
  await assert.rejects(
    preflightTextArtifactV1({
      schemaVersion: 1,
      artifactRef: ref,
      contentBase64: Buffer.from(text).toString('base64'),
    }),
    /sha256 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);

  const request = requestFor(text, {
    artifactRef: artifactFor(text, { mediaType: 'text/plain' }),
  });
  Object.defineProperty(request, 'contentBase64', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return Buffer.from(text).toString('base64');
    },
  });
  await assert.rejects(
    preflightTextArtifactV1(request),
    /contentBase64 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);

  await assert.rejects(
    preflightTextArtifactV1({ ...requestFor(text), schemaVersion: '1' }),
    /Unsupported TextArtifactPreflightV1 schemaVersion/u,
  );
  await assert.rejects(
    preflightTextArtifactV1({ ...requestFor(text), render: true }),
    /unknown field: render/u,
  );
});
