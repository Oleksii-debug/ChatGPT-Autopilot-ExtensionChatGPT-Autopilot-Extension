import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const html = fs.readFileSync(new URL('../src/ui/quick-command.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../src/ui/quick-command.js', import.meta.url), 'utf8');

test('manifest routes the existing keyboard action to the quick command popup with user-gesture activeTab scope', () => {
  assert.equal(manifest.action.default_popup, 'src/ui/quick-command.html');
  assert.equal(manifest.commands._execute_action.suggested_key.default, 'Ctrl+Shift+Y');
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
});

test('quick command popup uses native keyboard-accessible controls with explicit labels and status', () => {
  for (const id of ['source-kind', 'source-text', 'source-uri', 'operation']) {
    assert.match(html, new RegExp('<label for="' + id + '">', 'u'));
  }
  assert.match(html, /<select id="source-kind">/u);
  assert.match(html, /<textarea id="source-text"[^>]*readonly/u);
  assert.doesNotMatch(html, /<textarea id="source-text"[^>]*maxlength=/u);
  assert.match(html, /<button id="capture-source" type="button">/u);
  assert.match(html, /<button id="run-command" type="button">/u);
  assert.match(html, /id="status" role="status" aria-live="polite"/u);
  assert.doesNotMatch(html, /owner-instruction/u);
});

test('surface exposes only read-only SelectionAction operations', () => {
  for (const operation of ['SUMMARIZE', 'REWRITE', 'TRANSLATE', 'EXTRACT_STRUCTURED']) {
    assert.match(html, new RegExp('value="' + operation + '"', 'u'));
  }
  for (const operation of ['SAVE_TO_PROJECT', 'CREATE_TASK', 'RUN_RECIPE', 'CONTINUE_FROM_PAGE']) {
    assert.doesNotMatch(html, new RegExp('value="' + operation + '"', 'u'));
  }
});

test('clipboard is explicit paste and page capture happens only from the capture button handler', () => {
  assert.doesNotMatch(js, /navigator\.clipboard|clipboardRead/u);
  assert.match(js, /captureButton\.addEventListener\('click'/u);
  assert.match(js, /chrome\.scripting\.executeScript/u);
  assert.match(js, /Ctrl\+V/u);
});

test('captured page or selection material keeps exact provenance until run', () => {
  assert.match(js, /let capturedSource = null/u);
  assert.match(js, /const capturedAt = new Date\(\)\.toISOString\(\)/u);
  assert.match(js, /capturedSource = Object\.freeze/u);
  assert.match(js, /capturedAt: capturedSource\.capturedAt/u);
  assert.match(js, /text: capturedSource\.text/u);
  assert.match(js, /sourceText\.readOnly = true/u);
});

test('changing source kind invalidates captured material and requires recapture', () => {
  assert.match(js, /sourceKind\.addEventListener\('change', \(\) => updateSourceHelp\(\{ reset: true \}\)\)/u);
  assert.match(js, /function resetSourceState\(\)[\s\S]*capturedSource = null[\s\S]*sourceText\.value = ''[\s\S]*sourceUri\.value = ''/u);
  assert.match(js, /capturedSource\.kind !== sourceKind\.value/u);
  assert.match(js, /Захопити джерело/u);
});

test('page capture rejects oversize material instead of silently truncating it', () => {
  assert.doesNotMatch(js, /\.slice\(0,\s*100000\)/u);
  assert.match(js, /text\.length > maxSourceText/u);
  assert.match(js, /tooLarge: true/u);
  assert.match(js, /перевищує 100000 символів/u);
});

test('clipboard oversize input is rejected explicitly instead of being browser-truncated', () => {
  assert.match(js, /text\.length > MAX_SOURCE_TEXT/u);
  assert.match(js, /Текст буфера перевищує 100000 символів/u);
});

test('execution reuses canonical Core Session commands and preserves recoverability on start failure', () => {
  assert.match(js, /core\('CREATE_SESSION'/u);
  assert.match(js, /core\('START_SESSION'/u);
  assert.doesNotMatch(js, /DELETE_SESSION/u);
  assert.match(js, /Сеанс створено, але запуск не вдався/u);
  assert.match(js, /openOptionsPage/u);
});
