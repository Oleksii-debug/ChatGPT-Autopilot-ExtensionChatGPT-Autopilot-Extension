import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCompatibleEndpointRegistry } from '../companion/ai-gateway/gateway.mjs';
import { collectProductFiles, RELEASE_VERSION } from '../scripts/package-release.mjs';
import {
  MISTRAL_ENDPOINT_PRESET,
  applyCompatibleEndpointPreset,
  writeCompatibleEndpointPreset,
} from '../companion/ai-gateway/provider-presets.mjs';

test('Mistral preset uses the existing OpenAI-compatible authority with a named secret reference', () => {
  assert.deepEqual(MISTRAL_ENDPOINT_PRESET, {
    endpointId: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
  });
  const settings = applyCompatibleEndpointPreset({});
  assert.deepEqual(normalizeCompatibleEndpointRegistry(settings.compatibleEndpoints), [MISTRAL_ENDPOINT_PRESET]);
  assert.equal(JSON.stringify(settings).includes('secret'), false);
});

test('Mistral preset preserves other endpoints and deterministically replaces a stale Mistral entry', () => {
  const settings = applyCompatibleEndpointPreset({
    untouched: { keep: true },
    compatibleEndpoints: [
      { endpointId: 'local', baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: '' },
      { endpointId: 'mistral', baseUrl: 'https://stale.example/v1', apiKeyEnv: 'OLD_KEY' },
    ],
  });
  assert.deepEqual(settings.untouched, { keep: true });
  assert.equal(settings.compatibleEndpoints.length, 2);
  assert.deepEqual(settings.compatibleEndpoints[0], { endpointId: 'local', baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: '' });
  assert.deepEqual(settings.compatibleEndpoints[1], MISTRAL_ENDPOINT_PRESET);
  assert.doesNotThrow(() => normalizeCompatibleEndpointRegistry(settings.compatibleEndpoints));
});

test('Mistral preset writer keeps secrets out of gateway-settings.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-mistral-'));
  const file = path.join(dir, 'gateway-settings.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ marker: 'preserve-me' }), 'utf8');
    const settings = writeCompatibleEndpointPreset(file);
    assert.equal(settings.marker, 'preserve-me');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /MISTRAL_API_KEY/);
    assert.doesNotMatch(text, /apiKey\s*[:=]/i);
    assert.doesNotMatch(text, /Bearer\s+/i);
    assert.doesNotMatch(text, /secret-value/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Mistral preset writer rejects an empty settings path instead of resolving it to the working directory', () => {
  assert.throws(() => writeCompatibleEndpointPreset(''), /settings path is required/i);
  assert.throws(() => writeCompatibleEndpointPreset('   '), /settings path is required/i);
});

test('gateway launcher loads named DPAPI provider keys by apiKeyEnv and clears them after process creation', () => {
  const launcher = fs.readFileSync(new URL('../companion/ai-gateway/ЗАПУСТИТИ GATEWAY.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /config\\provider-keys/);
  assert.match(launcher, /compatibleEndpoints/);
  assert.match(launcher, /apiKeyEnv/);
  assert.match(launcher, /Import-DpapiEnvironmentKey/);
  assert.match(launcher, /Remove-Item -Path "Env:\$envName"/);
});

test('local gateway runtime state and encrypted provider credentials are excluded from version control', () => {
  const ignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^companion\/ai-gateway\/config\/$/m);
});

test('release packaging fails closed when local AI gateway state exists even without an encrypted key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-release-gateway-state-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
    fs.mkdirSync(path.join(root, 'companion', 'ai-gateway', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: RELEASE_VERSION }), 'utf8');
    fs.writeFileSync(path.join(root, 'README.txt'), 'readme', 'utf8');
    fs.writeFileSync(path.join(root, `CHANGES-${RELEASE_VERSION}.txt`), 'changes', 'utf8');
    fs.writeFileSync(path.join(root, `QA-${RELEASE_VERSION}.txt`), 'qa', 'utf8');
    fs.writeFileSync(path.join(root, 'companion', 'ai-gateway', 'config', 'gateway-settings.json'), JSON.stringify({ compatibleEndpoints: [MISTRAL_ENDPOINT_PRESET] }), 'utf8');

    await assert.rejects(
      collectProductFiles(root),
      /Forbidden private\/sensitive path in release package: companion\/ai-gateway\/config\/gateway-settings\.json/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
