import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionPairingStore, normalizeExtensionOrigin } from '../companion/ai-gateway/gateway.mjs';

const ORIGIN_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ORIGIN_B = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';

function tempConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-pairing-'));
}

test('extension origin normalization accepts only real Chrome extension ID shape', () => {
  assert.equal(normalizeExtensionOrigin(ORIGIN_A), ORIGIN_A);
  assert.equal(normalizeExtensionOrigin(ORIGIN_A.toUpperCase()), ORIGIN_A);
  assert.equal(normalizeExtensionOrigin('chrome-extension://abc'), '');
  assert.equal(normalizeExtensionOrigin('https://example.com'), '');
  assert.equal(normalizeExtensionOrigin(`${ORIGIN_A}/path`), '');
});

test('unpaired extension is fail-closed until an explicit pairing window is open', () => {
  const configDir = tempConfig();
  const store = createExtensionPairingStore({ configDir, now: () => 1_000_000 });
  try {
    const denied = store.authorize(ORIGIN_A);
    assert.equal(denied.allowed, false);
    assert.equal(denied.statusCode, 428);
    assert.equal(denied.code, 'GATEWAY_PAIRING_REQUIRED');
    assert.equal(denied.corsOrigin, ORIGIN_A);
    assert.deepEqual(store.snapshot(), {
      paired: false,
      pairingStateValid: true,
      pairingWindowOpen: false,
      pairingWindowExpiresAtUnixMs: 0,
    });
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('pairing window does not bind on preflight and binds exactly one extension on first real request', () => {
  const configDir = tempConfig();
  let now = 2_000_000;
  const store = createExtensionPairingStore({ configDir, now: () => now });
  try {
    store.openWindow({ durationMs: 60_000 });
    const preflight = store.authorize(ORIGIN_A, { allowPair: false });
    assert.equal(preflight.allowed, true);
    assert.equal(preflight.mode, 'pairing-preflight');
    assert.equal(store.snapshot().paired, false);

    const paired = store.authorize(ORIGIN_A);
    assert.equal(paired.allowed, true);
    assert.equal(paired.pairedNow, true);
    assert.equal(store.snapshot().paired, true);
    assert.equal(store.snapshot().pairingWindowOpen, false);

    const same = store.authorize(ORIGIN_A);
    assert.equal(same.allowed, true);
    assert.equal(same.pairedNow, false);

    const attacker = store.authorize(ORIGIN_B);
    assert.equal(attacker.allowed, false);
    assert.equal(attacker.statusCode, 403);
    assert.equal(attacker.code, 'GATEWAY_EXTENSION_NOT_PAIRED');

    now += 120_000;
    assert.equal(store.authorize(ORIGIN_A).allowed, true, 'paired origin must not depend on pairing-window expiry');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('expired pairing window cannot bind an extension', () => {
  const configDir = tempConfig();
  let now = 3_000_000;
  const store = createExtensionPairingStore({ configDir, now: () => now });
  try {
    store.openWindow({ durationMs: 30_000 });
    now += 30_001;
    const denied = store.authorize(ORIGIN_A);
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 'GATEWAY_PAIRING_REQUIRED');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('corrupt persisted pairing fails closed and requires explicit reset', () => {
  const configDir = tempConfig();
  fs.writeFileSync(path.join(configDir, 'extension-origin.json'), '{broken', 'utf8');
  const store = createExtensionPairingStore({ configDir, now: () => 4_000_000 });
  try {
    const denied = store.authorize(ORIGIN_A);
    assert.equal(denied.allowed, false);
    assert.equal(denied.statusCode, 500);
    assert.equal(denied.code, 'GATEWAY_PAIRING_STATE_INVALID');
    assert.equal(store.snapshot().pairingStateValid, false);
    assert.throws(() => store.openWindow(), /pairing state is invalid/i);

    store.reset();
    assert.equal(store.snapshot().pairingStateValid, true);
    store.openWindow();
    assert.equal(store.authorize(ORIGIN_A).allowed, true);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('local non-browser clients stay available without extension pairing', () => {
  const configDir = tempConfig();
  const store = createExtensionPairingStore({ configDir });
  try {
    const local = store.authorize('');
    assert.equal(local.allowed, true);
    assert.equal(local.mode, 'local-non-browser');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
