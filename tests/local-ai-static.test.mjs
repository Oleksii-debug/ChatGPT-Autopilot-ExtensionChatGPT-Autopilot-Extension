import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const html = fs.readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const protocol = fs.readFileSync(new URL('../src/shared/protocol.js', import.meta.url), 'utf8');

test('manifest grants only explicit local AI hosts in addition to ChatGPT', () => {
  for (const host of ['http://localhost/*', 'http://127.0.0.1/*', 'https://localhost/*', 'https://127.0.0.1/*']) {
    assert.ok(manifest.host_permissions.includes(host));
  }
  assert.equal(manifest.version, '0.9.19');
});

test('Local AI UI controls and commands are present', () => {
  for (const id of ['local-ai-enabled', 'local-ai-provider', 'local-ai-base-url', 'local-ai-model', 'local-ai-timeout', 'test-local-ai-button', 'run-local-ai-test-button', 'local-ai-test-response']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const command of ['GET_LOCAL_AI_SETTINGS', 'UPDATE_LOCAL_AI_SETTINGS', 'TEST_LOCAL_AI_CONNECTION', 'RUN_LOCAL_AI_PROMPT']) {
    assert.match(protocol, new RegExp(command));
  }
});
