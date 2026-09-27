import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../../src/ui/options.css', import.meta.url), 'utf8');

function luminance(hex) {
  const raw = hex.replace('#', '');
  const channels = [0, 2, 4].map(i => Number.parseInt(raw.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('visual shell exposes clear brand and global action grouping without tutorial notices', () => {
  assert.match(html, /class="brand-row"/);
  assert.match(html, /class="app-icon"/);
  assert.match(html, /class="header-actions" aria-label="Глобальні дії"/);
  assert.match(html, /class="orchestra-actions" aria-label="Дії з вибраним оркестром"/);
  assert.doesNotMatch(html, /class="notice"/);
});

test('visual accessibility includes responsive, forced-colors, reduced-motion and explicit focus support', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 800px\)/);
  assert.match(css, /min-height:\s*2\.65rem/);
});

test('primary light palette meets WCAG AA contrast for normal text and primary actions', () => {
  assert.ok(contrast('#172033', '#f5f7fb') >= 4.5, 'main text/background contrast');
  assert.ok(contrast('#5b6578', '#ffffff') >= 4.5, 'muted text/surface contrast');
  assert.ok(contrast('#ffffff', '#2457d6') >= 4.5, 'primary button contrast');
  assert.ok(contrast('#b42318', '#ffebe9') >= 4.5, 'danger action contrast');
  assert.ok(contrast('#2457d6', '#e8efff') >= 4.5, 'selected tab contrast');
});
