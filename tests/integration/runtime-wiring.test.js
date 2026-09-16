import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { STORAGE_KEY, createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

test('manifest wires the options UI and ChatGPT content scripts with bounded permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.options_ui.page, 'src/ui/options.html');
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'identity', 'scripting', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions, [
    'https://chatgpt.com/*',
    'https://drive.google.com/*',
    'https://docs.google.com/*',
    'https://www.googleapis.com/*',
  ]);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['https://chatgpt.com/*'],
    js: ['src/interaction/chatgpt-adapter.js', 'src/interaction/content-script.js'],
    run_at: 'document_idle',
  }]);
  assert.deepEqual(manifest.commands, {
    _execute_action: {
      suggested_key: { default: 'Ctrl+Shift+Y' },
      description: 'Відкрити панель ChatGPT Автопілот',
    },
  });
});

test('content script ignores unrelated messages and returns structured adapter results', async () => {
  const source = fs.readFileSync(new URL('../../src/interaction/content-script.js', import.meta.url), 'utf8');
  let listener;
  const sandbox = {
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    ChatGPTInteractionAdapter: {
      async execute(request) { return { status: 'READY', requestId: request.requestId }; },
    },
    Promise,
