import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MISTRAL_ENDPOINT_PRESET, OPENROUTER_ENDPOINT_PRESET,
  PINNED_COMPATIBLE_CREDENTIAL_BINDINGS,
  applyCompatibleEndpointPreset, buildNamedProviderCredentialPlan,
  writeCompatibleEndpointPreset,
} from '../companion/ai-gateway/provider-presets.mjs';

test('OpenRouter preset shares compatible registry and preserves Mistral', () => {
  assert.deepEqual(OPENROUTER_ENDPOINT_PRESET, {
    endpointId:'openrouter', baseUrl:'https://openrouter.ai/api/v1', apiKeyEnv:'OPENROUTER_API_KEY',
  });
  const settings = applyCompatibleEndpointPreset(applyCompatibleEndpointPreset({}, MISTRAL_ENDPOINT_PRESET), OPENROUTER_ENDPOINT_PRESET);
  assert.equal(settings.compatibleEndpoints.length, 2);
  assert.deepEqual(settings.compatibleEndpoints.find(item => item.endpointId === 'mistral'), MISTRAL_ENDPOINT_PRESET);
  assert.deepEqual(settings.compatibleEndpoints.find(item => item.endpointId === 'openrouter'), OPENROUTER_ENDPOINT_PRESET);
  assert.deepEqual(PINNED_COMPATIBLE_CREDENTIAL_BINDINGS.OPENROUTER_API_KEY, { endpointId:'openrouter', origin:'https://openrouter.ai' });
});

test('OpenRouter DPAPI credential cannot be redirected to another endpoint or origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-openrouter-binding-'));
  const keyDir = path.join(root, 'keys');
  fs.mkdirSync(keyDir);
  fs.writeFileSync(path.join(keyDir, 'OPENROUTER_API_KEY.dpapi'), 'opaque-encrypted-test-placeholder');
  try {
    assert.deepEqual(buildNamedProviderCredentialPlan({ compatibleEndpoints:[OPENROUTER_ENDPOINT_PRESET] }, { providerKeysDir:keyDir }), [
      { apiKeyEnv:'OPENROUTER_API_KEY', endpointId:'openrouter', origin:'https://openrouter.ai', keyFile:path.join(keyDir,'OPENROUTER_API_KEY.dpapi') },
    ]);
    for (const altered of [
      { ...OPENROUTER_ENDPOINT_PRESET, endpointId:'attacker' },
      { ...OPENROUTER_ENDPOINT_PRESET, baseUrl:'https://attacker.example/v1' },
    ]) assert.throws(() => buildNamedProviderCredentialPlan({ compatibleEndpoints:[altered] }, { providerKeysDir:keyDir }), /pinned|bound|binding/i);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('OpenRouter preset writer stores only an endpoint reference, never a credential', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-openrouter-config-'));
  try {
    const config = path.join(root, 'gateway-settings.json');
    writeCompatibleEndpointPreset(config, OPENROUTER_ENDPOINT_PRESET);
    const text = fs.readFileSync(config, 'utf8');
    assert.deepEqual(JSON.parse(text).compatibleEndpoints, [OPENROUTER_ENDPOINT_PRESET]);
    assert.equal(text.includes('opaque-encrypted-test-placeholder'), false);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});
