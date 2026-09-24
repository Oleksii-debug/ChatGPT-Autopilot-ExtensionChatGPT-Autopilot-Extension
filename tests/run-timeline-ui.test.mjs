import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('run timeline uses native keyboard and screen-reader semantics without a custom widget', async () => {
  const html = await readFile(new URL('src/ui/options.html', root), 'utf8');
  assert.match(html, /<section aria-labelledby="run-timeline-heading">/u);
  assert.match(html, /<label for="run-timeline-source-filter">/u);
  assert.match(html, /<select id="run-timeline-source-filter"[^>]*>/u);
  assert.match(html, /<button id="refresh-run-timeline-button" type="button"/u);
  assert.match(html, /<ol id="run-timeline-list" aria-label="[^"]+"><\/ol>/u);
  assert.match(html, /<p id="run-timeline-status" tabindex="0">/u);
  assert.doesNotMatch(html, /id="run-timeline-status"[^>]*(?:aria-live|role="status")/u);
  assert.doesNotMatch(html, /id="run-timeline-list"[^>]*role=/u);
});

test('run timeline renders text through DOM textContent and semantic time/list/evidence elements', async () => {
  const js = await readFile(new URL('src/ui/options.js', root), 'utf8');
  assert.match(js, /core\('GET_RUN_TIMELINE', \{ sessionId, limit: 200 \}\)/u);
  assert.match(js, /document\.createElement\('li'\)/u);
  assert.match(js, /document\.createElement\('time'\)/u);
  assert.match(js, /document\.createElement\('dl'\)/u);
  assert.match(js, /message\.textContent = translateText\(entry\.message\)/u);
  const timelineStart = js.indexOf('function renderRunTimeline()');
  const timelineEnd = js.indexOf('async function refreshRunTimeline', timelineStart);
  const renderer = js.slice(timelineStart, timelineEnd);
  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML|outerHTML/u);
});
