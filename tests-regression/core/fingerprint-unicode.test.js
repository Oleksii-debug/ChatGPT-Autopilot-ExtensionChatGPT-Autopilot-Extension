import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createSha256FingerprintV1 } from '../../src/core/fingerprint.js';

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

test('fingerprint rejects lone high surrogate before any digest call', async () => {
  let digestCalls = 0;
  const cryptoApi = {
    subtle: {
      async digest() {
        digestCalls += 1;
        throw new Error('digest must not run');
      },
    },
  };

  await assert.rejects(
    createSha256FingerprintV1('\ud800', { cryptoApi }),
    /well-formed Unicode/u,
  );
  assert.equal(digestCalls, 0);
});

test('fingerprint rejects lone low surrogate before any digest call', async () => {
  let digestCalls = 0;
  const cryptoApi = {
    subtle: {
      async digest() {
        digestCalls += 1;
        throw new Error('digest must not run');
      },
    },
  };

  await assert.rejects(
    createSha256FingerprintV1('\udc00', { cryptoApi }),
    /well-formed Unicode/u,
  );
  assert.equal(digestCalls, 0);
});

test('fingerprint rejects a high surrogate followed by an ordinary code unit', async () => {
  await assert.rejects(
    createSha256FingerprintV1('\ud800A', { cryptoApi: webcrypto }),
    /well-formed Unicode/u,
  );
});

test('valid surrogate pairs preserve canonical UTF-8 SHA-256 identity', async () => {
  const canonical = 'rocket-🚀-music-𝄞';
  const digest = new Uint8Array(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)),
  );
  const expected = `sha256:${hex(digest)}`;

  assert.equal(
    await createSha256FingerprintV1(canonical, { cryptoApi: webcrypto }),
    expected,
  );
});

test('literal replacement character remains valid but cannot alias a lone surrogate input', async () => {
  const replacement = await createSha256FingerprintV1('\ufffd', { cryptoApi: webcrypto });
  assert.match(replacement, /^sha256:[a-f0-9]{64}$/u);

  await assert.rejects(
    createSha256FingerprintV1('\udfff', { cryptoApi: webcrypto }),
    /well-formed Unicode/u,
  );
});
