import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const guard = fs.readFileSync(new URL('../../src/ui/runtime-reload-guard.js', import.meta.url), 'utf8');

test('options page exposes an accessible explicit extension reload action', () => {
  assert.match(html, /<button id="reload-extension-button" type="button" aria-describedby="reload-extension-help">Перезавантажити розширення<\/button>/);
  assert.match(html, /id="reload-extension-help"/);
  assert.match(html, /<script type="module" src="runtime-reload-guard\.js"><\/script>/);
  assert.doesNotMatch(html, /id="reload-extension-button"[^>]*tabindex="[1-9]/i);
});

test('stale background Core command errors trigger one safe extension reload with readable Ukrainian status', () => {
  assert.match(guard, /const STALE_CORE_PATTERN = \/Unknown Core command:\/i/);
  assert.match(guard, /let reloadScheduled = false/);
  assert.match(guard, /function reloadExtension\(reason = 'manual'\)/);
  assert.match(guard, /if \(reloadScheduled \|\| typeof chrome\?\.runtime\?\.reload !== 'function'\) return/);
  assert.match(guard, /setTimeout\(\(\) => chrome\.runtime\.reload\(\), 1000\)/);
  assert.match(guard, /Виявлено застарілу фонову частину Chrome/);
  assert.match(guard, /new MutationObserver/);
  assert.match(guard, /STALE_CORE_PATTERN\.test\(preview\.textContent \|\| ''\)/);
  assert.match(guard, /reloadExtension\('stale-core'\)/);
});

test('manual reload is available independently of portable-profile preview failures', () => {
  assert.match(guard, /getElementById\('reload-extension-button'\)\?\.addEventListener\('click', \(\) => reloadExtension\('manual'\)\)/);
  assert.match(guard, /ChatGPT Автопілот перезавантажується/);
});
