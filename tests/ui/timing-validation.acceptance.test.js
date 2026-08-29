import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../../src/ui/options.js', import.meta.url), 'utf8');

test('busy-check delay is bounded in markup and enforced by JS save validation', () => {
  assert.match(html, /id="busy-check-delay"[^>]*min="1"[^>]*max="30"/s);
  assert.match(
    js,
    /session\.busyCheckDelaySeconds\s*>=\s*1\s*&&\s*session\.busyCheckDelaySeconds\s*<=\s*30/,
    'Save validation must reject busy-check values outside 1-30 seconds instead of relying only on input attributes.'
  );
});

test('retry backoff is bounded in markup and enforced by JS save validation', () => {
  assert.match(html, /id="retry-backoff"[^>]*min="5"[^>]*max="3600"/s);
  assert.match(
    js,
    /session\.retryBackoffSeconds\s*>=\s*5\s*&&\s*session\.retryBackoffSeconds\s*<=\s*3600/,
    'Save validation must reject retry backoff outside 5-3600 seconds to prevent zero-delay or unbounded retry configuration.'
  );
});
