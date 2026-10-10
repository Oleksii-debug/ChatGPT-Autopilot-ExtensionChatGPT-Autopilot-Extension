import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
} from '../src/core/coding-specialist-provider.js';
import {
  SPECIALIST_PROVIDER_CONFIG_VERSION,
  SpecialistProviderConfigKind,
  canonicalSpecialistProviderIdV1,
  createSpecialistProviderConfigV1,
  normalizeSpecialistProviderConfigV1,
} from '../src/core/specialist-provider-config.js';

const UPDATED_AT = '2026-09-27T14:20:00.000Z';

function openHandsConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    serverUrl: 'http://127.0.0.1:3000',
    agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
    agentProfileId: '11111111-1111-4111-8111-111111111111',
    agentProfileRevision: 3,
    workspacePath: 'C:\\Autopilot\\workspace',
    qualifiedCapabilityIds: ['code.write'],
    requestTimeoutSeconds: 10,
    maxExecutionSeconds: 600,
    pollIntervalMs: 500,
    maxIterations: 30,
    maxResponseBytes: 65536,
    authMode: 'LOCAL_UNAUTHENTICATED',
    ...overrides,
  };
}

test('normalizes exact owner-qualified OpenHands provider configuration', () => {
  const record = createSpecialistProviderConfigV1({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision: 4,
    config: openHandsConfig(),
    updatedAt: UPDATED_AT,
  });

  assert.equal(record.schemaVersion, SPECIALIST_PROVIDER_CONFIG_VERSION);
  assert.equal(record.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(record.revision, 4);
  assert.equal(record.config.serverUrl, 'http://127.0.0.1:3000');
  assert.deepEqual(record.config.qualifiedCapabilityIds, ['code.write']);
  assert.equal(record.updatedAt, UPDATED_AT);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.config));
});

test('rejects provider identity, remote endpoint, non-canonical timestamp and unknown wrapper fields', () => {
  assert.throws(
    () => canonicalSpecialistProviderIdV1(' openhands-agent-server '),
    /canonical identity/,
  );
  assert.throws(
    () => createSpecialistProviderConfigV1({
      providerId: 'another-provider',
      kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
      config: openHandsConfig(),
      updatedAt: UPDATED_AT,
    }),
    /mismatched providerId/,
  );
  assert.throws(
    () => createSpecialistProviderConfigV1({
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
      config: openHandsConfig({ serverUrl: 'https://example.com:3000' }),
      updatedAt: UPDATED_AT,
    }),
    /local http/,
  );
  assert.throws(
    () => createSpecialistProviderConfigV1({
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
      config: openHandsConfig(),
      updatedAt: '2026-09-27T14:20:00Z',
    }),
    /canonical UTC/,
  );

  assert.throws(
    () => normalizeSpecialistProviderConfigV1({
      schemaVersion: 1,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
      revision: 1,
      config: openHandsConfig(),
      updatedAt: UPDATED_AT,
      secret: 'must-not-be-accepted',
    }),
    /unknown field/,
  );
});

test('rejects accessor-backed wrapper fields without invoking them', () => {
  let invoked = false;
  const raw = {
    schemaVersion: 1,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision: 1,
    config: openHandsConfig(),
    updatedAt: UPDATED_AT,
  };
  Object.defineProperty(raw, 'revision', {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });

  assert.throws(() => normalizeSpecialistProviderConfigV1(raw), /data property/);
  assert.equal(invoked, false);
});


test('provider config wrapper rejects hostile Proxy reflection without leaking secrets or invoking getters', () => {
  const secret = 'secret-credential-do-not-echo';
  const input = {
    schemaVersion: 1,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision: 1,
    config: openHandsConfig(),
    updatedAt: UPDATED_AT,
  };
  let accesses = 0;
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const proxy = new Proxy(input, {
      [trap]() {
        accesses += 1;
        throw new Error(secret);
      },
    });
    assert.throws(
      () => normalizeSpecialistProviderConfigV1(proxy),
      error => error.message.includes('cannot be inspected safely')
        && !error.message.includes(secret),
    );
  }
  assert.equal(accesses, 3);
});

test('provider config wrapper denies attacker-named and hidden fields without echoing names', () => {
  const secret = 'private-token-from-untrusted-key';
  const input = {
    schemaVersion: 1,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision: 1,
    config: openHandsConfig(),
    updatedAt: UPDATED_AT,
  };
  const malicious = { ...input, [secret]: true };
  assert.throws(
    () => normalizeSpecialistProviderConfigV1(malicious),
    error => error.message.includes('unknown field') && !error.message.includes(secret),
  );
  const hidden = { ...input };
  Object.defineProperty(hidden, 'revision', { enumerable: false, value: 1 });
  assert.throws(() => normalizeSpecialistProviderConfigV1(hidden), /enumerable own data property/);
  const symbolInput = { ...input, [Symbol(secret)]: true };
  assert.throws(
    () => normalizeSpecialistProviderConfigV1(symbolInput),
    error => error.message.includes('unknown field') && !error.message.includes(secret),
  );
  const recovered = normalizeSpecialistProviderConfigV1(JSON.parse(JSON.stringify(input)));
  assert.equal(recovered.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(recovered.revision, 1);
  assert.ok(Object.isFrozen(recovered));
});
