import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cadence = fs.readFileSync(new URL('../../src/ui/prompt-cadence-ui.js', import.meta.url), 'utf8');
const drive = fs.readFileSync(new URL('../../src/ui/drive-source-ui.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');

test('prompt 2 and prompt 3 expose independent labelled cadence controls', () => {
  for (const id of ['prompt2-enabled','prompt2-text','prompt2-every','prompt3-enabled','prompt3-text','prompt3-every']) {
    assert.ok(cadence.includes(`id="${id}"`), `missing ${id}`);
  }
  for (const id of ['prompt2-text','prompt2-every','prompt3-text','prompt3-every']) {
    assert.ok(cadence.includes(`<label for="${id}">`), `missing label for ${id}`);
  }
  assert.ok(cadence.includes('id="prompt2-every" type="number" min="2" max="1000000"'));
  assert.ok(cadence.includes('id="prompt3-every" type="number" min="2" max="1000000"'));
});

test('chat-flow is a separate opt-in and saving prompt cadence cannot silently enable it', () => {
  assert.ok(cadence.includes('id="chat-flow-enabled" type="checkbox"'));
  assert.ok(cadence.includes('id="chat-flow-fields" hidden'));
  assert.ok(cadence.includes("enabled: $('chat-flow-enabled').checked"));
  assert.equal(cadence.includes('const chatFlow = {\n      enabled: true,'), false);
  assert.ok(cadence.includes("chatFlow.enabled && mode === 'staged'"));
});

test('Drive source exposes direct link, explicit prompt target and visible autosync safety settings', () => {
  for (const id of [
    'drive-source-url','drive-source-target','drive-source-auto',
    'drive-source-interval','drive-source-min-chars','drive-source-bind','drive-source-sync',
  ]) {
    assert.ok(drive.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(drive.includes('<option value="primary">Основний prompt</option>'));
  assert.ok(drive.includes('<option value="prompt2">Другий prompt</option>'));
  assert.ok(drive.includes('<option value="prompt3">Третій prompt</option>'));
  assert.ok(drive.includes('id="drive-source-interval" type="number" min="1" max="1440" step="1" value="3"'));
  assert.ok(drive.includes('id="drive-source-min-chars" type="number" min="1" max="1000000" step="1" value="1000"'));
  assert.ok(drive.includes("const autoSyncEnabled = $('drive-source-auto').checked"));
  assert.ok(drive.includes('syncIntervalMinutes'));
  assert.ok(drive.includes('minChars'));
});

test('Drive file list is labelled honestly as already-authorized files rather than a full Picker', () => {
  assert.ok(drive.includes('Вибрати вже дозволений файл Drive'));
  assert.ok(drive.includes('Показати вже дозволені файли Drive'));
  assert.equal(drive.includes('Показати доступні файли Drive'), false);
});

test('obsolete duplicate direct Drive import script is not loaded', () => {
  assert.equal(html.includes('drive-prompt-import.js'), false);
  assert.ok(html.includes('drive-source-ui.js'));
});

test('dynamic status surfaces stay in normal readable status text', () => {
  assert.ok(cadence.includes('id="prompt-cadence-status" role="status" tabindex="0"'));
  assert.ok(drive.includes('id="drive-source-status" role="status" tabindex="0"'));
  assert.ok(drive.includes('id="drive-source-identity" role="status"'));
});
