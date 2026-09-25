import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');

test('Session calendar editor exposes keyboard-native labelled controls and owner-visible runtime status', () => {
  for (const id of [
    'calendar-mode', 'calendar-time-zone', 'calendar-catch-up', 'calendar-revision-confirm',
    'calendar-one-time-date', 'calendar-one-time-time',
    'calendar-start-date', 'calendar-times',
    'calendar-weekday-1', 'calendar-weekday-7',
    'calendar-end-date', 'calendar-max-occurrences',
    'calendar-explicit-occurrences', 'calendar-runtime-status',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /<label for="calendar-mode">/);
  assert.match(html, /<label for="calendar-time-zone">/);
  assert.match(html, /<label[^>]*><input id="calendar-catch-up" type="checkbox"> Наздоганяти пропущені запуски<\/label>/);
  assert.match(html, /id="calendar-runtime-status" role="status" tabindex="0"/);
  assert.match(html, /id="calendar-revision-confirm" type="checkbox" aria-describedby="calendar-revision-help"/);
  assert.doesNotMatch(html, /calendar[^\n]*onclick=/i);
});

test('Session editor persists calendarSchedule but never writes caller-shaped calendarRuntime', () => {
  assert.match(js, /s\.calendarSchedule = collectCalendarSchedule\(\);/);
  assert.match(js, /calendarSchedule: clone\(session\.calendarSchedule \|\| null\)/);
  assert.doesNotMatch(js, /s\.calendarRuntime\s*=/);
});

test('calendar mode visibility is semantic and explicit list remains direct text-entry', () => {
  assert.match(js, /function syncCalendarVisibility\(\)/);
  assert.match(js, /calendar-explicit-occurrences/);
  assert.match(html, /Щоб додати час, додайте новий рядок/);
  assert.match(html, /value="WEEKLY"/);
});
