import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cadence = fs.readFileSync(new URL('../../src/ui/prompt-cadence-ui.js', import.meta.url), 'utf8');
const drive = fs.readFileSync(new URL('../../src/ui/drive-source-ui.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');

test('prompt 2 and prompt 3 expose independent labelled cadence controls', () => {
  for (const id of ['prompt2-enabled','prompt2-text','prompt2-every','prompt3-enabled','prompt3-text','prompt3-every']) {
    assert.match(cadence, new RegExp(`id=["']${id}["']`), `missing ${id}`);
  }
  assert.match(cadence, /<label for="prompt2-text">/);
  assert.match(cadence, /<label for="prompt2-every">/);
  assert.match(cadence, /<label for="prompt3-text">/);
  assert.match(cadence, /<label for="prompt3-every">/);
  assert.match(cadence, /id="prompt2-every" type="number" min="2" max="1000000"/);
  assert.match(cadence, /id="prompt3-every" type="number" min="2" max="1000000"/);
});

test('chat-flow is a separate opt-in and saving prompt cadence cannot silently enable it', () => {
  assert.match(cadence, /id="chat-flow-enabled" type="checkbox"/);
  assert.match(cadence, /id="chat-flow-fields" hidden/);
  assert.match(cadence, /enabled: $('chat-flow-enabled').checked/);
  assert.doesNotMatch(cadence, /const chatFlow = {s*enabled: true,/);
  assert.match(cadence, /chatFlow.enabled && mode === 'staged'/);
});

test('Drive source exposes direct link, explicit prompt target and visible autosync safety settings', () => {
  for (const id of [
    'drive-source-url','drive-source-target','drive-source-auto',
    'drive-source-interval','drive-source-min-chars','drive-source-bind','drive-source-sync',
  ]) {
    assert.match(drive, new RegExp(`id=["']${id}["']`), `missing ${id}`);
  }
  assert.ok(drive.includes('<option value="primary">Основний prompt</option>'));
  assert.ok(drive.includes('<option value="prompt2">Другий prompt</option>'));
  assert.ok(drive.includes('<option value="prompt3">Третій prompt</option>'));
  assert.match(drive, /id="drive-source-interval" type="number" min="1" max="1440"[^>]*value="3"/);
  assert.match(drive, /id="drive-source-min-chars" type="number" min="1" max="1000000"[^>]*value="1000"/);
  assert.match(drive, /autoSyncEnabled: $('drive-source-auto').checked/);
  assert.match(drive, /syncIntervalMinutes/);
  assert.match(drive, /minChars/);
});

test('Drive file list is labelled honestly as already-authorized files rather than a full Picker', () => {
  assert.match(drive, /Вибрати вже дозволений файл Drive/);
  assert.match(drive, /Показати вже дозволені файли Drive/);
  assert.doesNotMatch(drive, /Показати доступні файли Drive/);
});

test('obsolete duplicate direct Drive import script is not loaded', () => {
  assert.doesNotMatch(html, /drive-prompt-import\.js/);
  assert.match(html, /drive-source-ui\.js/);
});

test('dynamic status surfaces stay in normal readable status text', () => {
  assert.match(cadence, /id="prompt-cadence-status" role="status" tabindex="0"/);
  assert.match(drive, /id="drive-source-status" role="status" tabindex="0"/);
  assert.match(drive, /id="drive-source-identity" role="status"/);
});
