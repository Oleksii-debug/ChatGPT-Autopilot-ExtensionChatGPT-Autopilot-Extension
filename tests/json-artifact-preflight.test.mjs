import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  JSON_ARTIFACT_PREFLIGHT_VERSION,
  MAX_JSON_ARTIFACT_DEPTH,
  MAX_JSON_ARTIFACT_NODES,
  MAX_JSON_CONTAINER_ITEMS,
  MAX_JSON_STRING_CODE_UNITS,
  preflightJsonArtifactV1,
} from '../src/core/json-artifact-preflight.js';

function utf8(text) {
  return new TextEncoder().encode(text);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function artifactForBytes(bytes, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'json-artifact-1',
    kind: 'structured-data',
    uri: 'artifact://json-artifact-1',
    mediaType: 'application/json',
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    createdAt: '2026-09-25T16:00:00.000Z',
    producerInvocationId: 'invoke-json-1',
    sensitive: false,
    ...overrides,
  };
}

function requestForBytes(bytes, overrides = {}) {
  return {
    schemaVersion: JSON_ARTIFACT_PREFLIGHT_VERSION,
    artifactRef: artifactForBytes(bytes),
    contentBase64: base64(bytes),
    ...overrides,
  };
}

function requestForText(text, overrides = {}) {
  return requestForBytes(utf8(text), overrides);
}

test('verifies immutable JSON bytes and returns a frozen prototype-safe structured projection', async () => {
  const text = '{"__proto__":{"polluted":true},"constructor":"data","nested":[1,true,null,"😀"],"value":-1.25e2}';
  const out = await preflightJsonArtifactV1(requestForText(text));

  assert.equal(out.materialIdentityVerified, true);
  assert.equal(out.utf8Verified, true);
  assert.equal(out.duplicateKeysRejected, true);
  assert.equal(out.prototypeSafeProjection, true);
  assert.equal(out.structural.topLevelType, 'object');
  assert.equal(out.structural.objectCount, 2);
  assert.equal(out.structural.arrayCount, 1);
  assert.equal(out.structural.numberCount, 2);
  assert.equal(out.structural.booleanCount, 2);
  assert.equal(out.structural.nullCount, 1);
  assert.equal(out.valueAvailable, true);
  assert.equal(Object.getPrototypeOf(out.value), null);
  assert.equal(Object.getPrototypeOf(out.value.__proto__), null);
  assert.equal(out.value.__proto__.polluted, true);
  assert.equal(out.value.constructor, 'data');
  assert.equal({}.polluted, undefined);
  assert.equal(out.value.nested[3], '😀');
  assert.equal(out.value.value, -125);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.structural), true);
  assert.equal(Object.isFrozen(out.value), true);
  assert.equal(Object.isFrozen(out.value.nested), true);
  assert.equal(Object.isFrozen(out.value.__proto__), true);
  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.artifactMutationAuthorized, false);
  assert.equal(out.distributionAuthorized, false);
  assert.equal(out.contentDisclosureAuthorized, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.policyDecisionAuthorized, false);
});

test('application +json media types are admitted and deterministic output repeats exactly', async () => {
  const text = '{"type":"https://example.invalid/problem","status":409}';
  const bytes = utf8(text);
  const request = requestForBytes(bytes, {
    artifactRef: artifactForBytes(bytes, {
      mediaType: 'application/problem+json',
    }),
  });

  const first = await preflightJsonArtifactV1(request);
  const second = await preflightJsonArtifactV1(request);

  assert.equal(first.mediaType, 'application/problem+json');
  assert.deepEqual(second, first);
});

test('sensitive JSON is fully validated without reproducing parsed content', async () => {
  const text = '{"secret":"owner-only","nested":{"ok":true}}';
  const bytes = utf8(text);
  const out = await preflightJsonArtifactV1(requestForBytes(bytes, {
    artifactRef: artifactForBytes(bytes, { sensitive: true }),
  }));

  assert.equal(out.materialIdentityVerified, true);
  assert.equal(out.structural.objectCount, 2);
  assert.equal(out.valueAvailable, false);
  assert.equal(out.value, null);
  assert.equal(out.requiresCanonicalDisclosureAuthorization, true);
  assert.equal(out.contentDisclosureAuthorized, false);
});

test('duplicate object keys fail closed instead of silently taking the last value', async () => {
  await assert.rejects(
    preflightJsonArtifactV1(requestForText('{"a":1,"a":2}')),
    /duplicate property name/u,
  );

  await assert.rejects(
    preflightJsonArtifactV1(requestForText('{"outer":{"x":1,"x":2}}')),
    /duplicate property name/u,
  );
});

test('numeric overflow and unpaired escaped Unicode surrogates fail closed', async () => {
  await assert.rejects(
    preflightJsonArtifactV1(requestForText('{"value":1e400}')),
    /must remain finite/u,
  );

  await assert.rejects(
    preflightJsonArtifactV1(requestForText('{"value":"\\uD800"}')),
    /unpaired Unicode surrogate/u,
  );

  const valid = await preflightJsonArtifactV1(
    requestForText('{"value":"\\uD83D\\uDE00"}'),
  );
  assert.equal(valid.value.value, '😀');
});

test('invalid UTF-8, UTF-8 BOM and material substitutions fail before JSON admission', async () => {
  const invalidUtf8 = Uint8Array.from([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  await assert.rejects(
    preflightJsonArtifactV1(requestForBytes(invalidUtf8)),
    /valid UTF-8/u,
  );

  const body = utf8('{"ok":true}');
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...body]);
  await assert.rejects(
    preflightJsonArtifactV1(requestForBytes(bom)),
    /BOM is not admitted/u,
  );

  const bytes = utf8('{"ok":true}');
  await assert.rejects(
    preflightJsonArtifactV1(requestForBytes(bytes, {
      artifactRef: artifactForBytes(bytes, { sha256: 'b'.repeat(64) }),
    })),
    /SHA-256 does not match/u,
  );

  await assert.rejects(
    preflightJsonArtifactV1(requestForBytes(bytes, {
      artifactRef: artifactForBytes(bytes, { sizeBytes: bytes.byteLength + 1 }),
    })),
    /byte length does not match/u,
  );

  await assert.rejects(
    preflightJsonArtifactV1(requestForBytes(bytes, {
      artifactRef: artifactForBytes(bytes, { mediaType: 'text/json' }),
    })),
    /mediaType must be application\/json or application\/\*\+json/u,
  );
});

test('ArtifactRef and Base64 representations must already be canonical', async () => {
  const bytes = utf8('{"ok":true}');
  const ref = artifactForBytes(bytes);

  await assert.rejects(
    preflightJsonArtifactV1(requestForBytes(bytes, {
      artifactRef: { ...ref, sha256: ref.sha256.toUpperCase() },
    })),
    /not already canonical: sha256/u,
  );

  await assert.rejects(
    preflightJsonArtifactV1(requestForBytes(bytes, {
      artifactRef: { ...ref, createdAt: '2026-09-25T16:00:00Z' },
    })),
    /not already canonical: createdAt/u,
  );

  await assert.rejects(
    preflightJsonArtifactV1({
      schemaVersion: 1,
      artifactRef: ref,
      contentBase64: base64(bytes) + '\n',
    }),
    /canonical Base64/u,
  );

  const padded = utf8('{"x":"ab"}');
  const canonical = base64(padded);
  assert.match(canonical, /=+$/u);
  await assert.rejects(
    preflightJsonArtifactV1({
      schemaVersion: 1,
      artifactRef: artifactForBytes(padded),
      contentBase64: canonical.replace(/=+$/u, ''),
    }),
    /canonical Base64/u,
  );
});

test('depth, container size, total nodes and string length are independently bounded', async () => {
  const tooDeep = '['.repeat(MAX_JSON_ARTIFACT_DEPTH + 2)
    + '0'
    + ']'.repeat(MAX_JSON_ARTIFACT_DEPTH + 2);
  await assert.rejects(
    preflightJsonArtifactV1(requestForText(tooDeep)),
    /maximum depth/u,
  );

  const tooManyItems = '['
    + new Array(MAX_JSON_CONTAINER_ITEMS + 1).fill('0').join(',')
    + ']';
  await assert.rejects(
    preflightJsonArtifactV1(requestForText(tooManyItems)),
    /maximum item count/u,
  );

  const groups = [];
  for (let group = 0; group < 100; group += 1) {
    groups.push(
      JSON.stringify('g' + group)
      + ':['
      + new Array(100).fill('0').join(',')
      + ']',
    );
  }
  const tooManyNodes = '{' + groups.join(',') + '}';
  assert.ok(100 * 101 + 1 > MAX_JSON_ARTIFACT_NODES);
  await assert.rejects(
    preflightJsonArtifactV1(requestForText(tooManyNodes)),
    /maximum node count/u,
  );

  const tooLongString = JSON.stringify('a'.repeat(MAX_JSON_STRING_CODE_UNITS + 1));
  await assert.rejects(
    preflightJsonArtifactV1(requestForText(tooLongString)),
    /UTF-16 code units/u,
  );
});

test('malformed JSON and trailing material are rejected by the bounded grammar', async () => {
  for (const text of [
    '',
    '   ',
    '{"a":1,}',
    '[1,]',
    '{"a" 1}',
    '{"a":1} trailing',
    '{"a":"bad\nraw"}',
  ]) {
    await assert.rejects(
      preflightJsonArtifactV1(requestForText(text)),
      /JSON|contentBase64|sizeBytes/u,
      text,
    );
  }
});

test('hostile accessors are rejected without executing getters', async () => {
  const bytes = utf8('{"ok":true}');
  let getterReads = 0;
  const ref = artifactForBytes(bytes);
  Object.defineProperty(ref, 'sha256', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return sha256(bytes);
    },
  });

  await assert.rejects(
    preflightJsonArtifactV1({
      schemaVersion: 1,
      artifactRef: ref,
      contentBase64: base64(bytes),
    }),
    /sha256 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);

  const request = requestForBytes(bytes);
  Object.defineProperty(request, 'contentBase64', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return base64(bytes);
    },
  });
  await assert.rejects(
    preflightJsonArtifactV1(request),
    /contentBase64 must be an enumerable own data property/u,
  );
  assert.equal(getterReads, 0);
});

test('unknown fields, sparse authority aliases and unsupported schema fail closed', async () => {
  const bytes = utf8('{"ok":true}');

  await assert.rejects(
    preflightJsonArtifactV1({
      ...requestForBytes(bytes),
      execute: true,
    }),
    /unknown field: execute/u,
  );

  await assert.rejects(
    preflightJsonArtifactV1({
      ...requestForBytes(bytes),
      schemaVersion: '1',
    }),
    /Unsupported JsonArtifactPreflightV1 schemaVersion/u,
  );

  await assert.rejects(
    preflightJsonArtifactV1({
      ...requestForBytes(bytes),
      artifactRef: {
        ...artifactForBytes(bytes),
        distributionAuthorized: true,
      },
    }),
    /unknown field: distributionAuthorized/u,
  );
});
