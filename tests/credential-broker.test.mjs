import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_BROKER_ID,
  CredentialKind,
  createCredentialBroker,
  credentialScopeMatches,
  normalizeCredentialStore,
} from '../companion/native-host/credential-broker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function store(overrides = {}) {
  return {
    schemaVersion: 1,
    credentials: [
      {
        credentialId: 'ais-main',
        kind: 'username-password',
        scope: ['https://ais.example.edu', 'https://*.student.example.org'],
        username: 'owner@example.edu',
        secretFile: 'ais-main.dpapi',
        enabled: true,
        expiresAt: null,
      },
    ],
    ...overrides,
  };
}

test('CredentialBroker list returns opaque refs only and never username/secret file', async () => {
  const dir = path.join(os.tmpdir(), 'credential-broker-test');
  const broker = createCredentialBroker({
    store: store(),
    credentialsDir: dir,
    decryptSecret: async () => 'not-used',
    now: () => Date.parse('2026-09-19T18:00:00Z'),
  });
  const refs = broker.list('https://ais.example.edu/login');
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], {
    schemaVersion: 1,
    credentialId: 'ais-main',
    brokerId: CREDENTIAL_BROKER_ID,
    kind: CredentialKind.USERNAME_PASSWORD,
    scope: ['https://ais.example.edu', 'https://*.student.example.org'],
    expiresAt: null,
  });
  const visible = JSON.stringify(refs);
  assert.equal(visible.includes('owner@example.edu'), false);
  assert.equal(visible.includes('.dpapi'), false);
  assert.equal(visible.toLowerCase().includes('password'), true, 'kind name may describe username-password but no value is exposed');
});

test('CredentialBroker resolves only an in-scope credential and decrypts only on resolve', async () => {
  const dir = path.join(os.tmpdir(), 'credential-broker-test');
  let decryptCalls = 0;
  let requestedFile = '';
  const broker = createCredentialBroker({
    store: store(),
    credentialsDir: dir,
    decryptSecret: async file => {
      decryptCalls += 1;
      requestedFile = file;
      return 'S3cret-value';
    },
  });

  const refs = broker.list('https://ais.example.edu/login');
  assert.equal(refs.length, 1);
  assert.equal(decryptCalls, 0, 'listing must never decrypt a secret');

  const resolved = await broker.resolve({
    credentialId: 'ais-main',
    targetOrigin: 'https://ais.example.edu',
  });
  assert.equal(decryptCalls, 1);
  assert.equal(requestedFile, path.resolve(dir, 'ais-main.dpapi'));
  assert.equal(resolved.credentialId, 'ais-main');
  assert.equal(resolved.username, 'owner@example.edu');
  assert.equal(resolved.secret, 'S3cret-value');

  await assert.rejects(() => broker.resolve({
    credentialId: 'ais-main',
    targetOrigin: 'https://evil.example',
  }), error => {
    assert.equal(error.code, 'CREDENTIAL_SCOPE_DENIED');
    return true;
  });
  assert.equal(decryptCalls, 1, 'out-of-scope resolve must fail before decrypting');
});

test('CredentialBroker wildcard scope matches subdomains but not sibling or apex domains', () => {
  assert.equal(credentialScopeMatches(['https://*.example.org'], 'https://a.example.org/login'), true);
  assert.equal(credentialScopeMatches(['https://*.example.org'], 'https://b.a.example.org/login'), true);
  assert.equal(credentialScopeMatches(['https://*.example.org'], 'https://example.org/login'), false);
  assert.equal(credentialScopeMatches(['https://*.example.org'], 'https://example.org.evil.test/login'), false);
});

test('CredentialBroker omits disabled and expired credentials', () => {
  const dir = path.join(os.tmpdir(), 'credential-broker-test');
  const broker = createCredentialBroker({
    credentialsDir: dir,
    decryptSecret: async () => 'secret',
    now: () => Date.parse('2026-09-19T18:00:00Z'),
    store: {
      schemaVersion: 1,
      credentials: [
        {
          credentialId: 'disabled',
          kind: 'username-password',
          scope: ['https://example.com'],
          username: 'a',
          secretFile: 'disabled.dpapi',
          enabled: false,
          expiresAt: null,
        },
        {
          credentialId: 'expired',
          kind: 'username-password',
          scope: ['https://example.com'],
          username: 'b',
          secretFile: 'expired.dpapi',
          enabled: true,
          expiresAt: '2026-09-18T00:00:00.000Z',
        },
      ],
    },
  });
  assert.deepEqual(broker.list('https://example.com'), []);
});

test('CredentialBroker store fails closed on secret-bearing or ambiguous metadata', () => {
  assert.throws(() => normalizeCredentialStore({
    schemaVersion: 1,
    credentials: [{
      credentialId: 'bad',
      kind: 'username-password',
      scope: ['https://example.com'],
      username: 'u',
      secretFile: 'bad.dpapi',
      enabled: true,
      expiresAt: null,
      password: 'must-not-be-here',
    }],
  }), /unknown field: password/);

  assert.throws(() => createCredentialBroker({
    store: { schemaVersion: 1, credentials: [] },
    credentialsDir: '',
    decryptSecret: async () => 'secret',
  }), /credentialsDir must be absolute/);

  assert.throws(() => normalizeCredentialStore({
    schemaVersion: 1,
    credentials: [{
      credentialId: 'bad-file',
      kind: 'username-password',
      scope: ['https://example.com'],
      username: 'u',
      secretFile: '../secret.dpapi',
      enabled: true,
      expiresAt: null,
    }],
  }), /secretFile/);
});

test('CredentialBroker enrollment scripts use Windows DPAPI and do not write plaintext password metadata', async () => {
  const add = await fs.readFile(path.join(repoRoot, 'companion', 'native-host', 'ДОДАТИ CREDENTIAL.ps1'), 'utf8');
  const remove = await fs.readFile(path.join(repoRoot, 'companion', 'native-host', 'ВИДАЛИТИ CREDENTIAL.ps1'), 'utf8');
  const host = await fs.readFile(path.join(repoRoot, 'companion', 'native-host', 'host.mjs'), 'utf8');

  assert.match(add, /Read-Host 'Пароль або секрет' -AsSecureString/);
  assert.match(add, /ConvertFrom-SecureString/);
  assert.match(add, /\.dpapi/);
  assert.doesNotMatch(add, /password\s*=/i);
  assert.match(host, /ConvertTo-SecureString/);
  assert.match(host, /ZeroFreeBSTR/);
  assert.match(remove, /Remove-Item/);
});
