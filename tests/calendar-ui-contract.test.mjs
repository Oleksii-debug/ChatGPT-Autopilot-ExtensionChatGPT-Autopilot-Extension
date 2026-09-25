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


test('Agent and Scenario scheduling are text-first and do not require inaccessible native date/time pickers', () => {
  assert.match(html, /id="agent-schedule-start" type="text"[^>]*placeholder="25\.09\.2026 04:00"/);
  assert.match(html, /id="agent-schedule-end" type="text"/);
  assert.match(html, /id="agent-active-window-start" type="text"[^>]*placeholder="09:00"/);
  assert.match(html, /id="scenario-work-start-at" type="text"[^>]*placeholder="25\.09\.2026 04:00"/);
  assert.doesNotMatch(html, /id="agent-schedule-start" type="datetime-local"/);
  assert.doesNotMatch(html, /id="agent-active-window-start" type="time"/);
  assert.match(js, /parseAccessibleLocalDateTime/);
  assert.match(js, /formatAccessibleLocalDateTime/);
});


test('Session calendar presents dotted owner format while preserving canonical schedule storage', () => {
  assert.match(html, /placeholder="25\.09\.2026"/);
  assert.match(html, /placeholder="25\.09\.2026 09:00/);
  assert.match(html, /Рекомендований формат дати: ДД\.ММ\.РРРР/);
  assert.match(js, /normalizeAccessibleCalendarDate/);
  assert.match(js, /formatAccessibleCalendarDate/);
  assert.match(js, /parseAccessibleOccurrenceLine/);
});


test('Session calendar exposes accessible interval recurrence with now or later start', () => {
  for (const id of [
    'calendar-interval-fields', 'calendar-interval-start-mode',
    'calendar-interval-start-date', 'calendar-interval-start-time',
    'calendar-interval-value', 'calendar-interval-unit',
    'calendar-interval-max-occurrences',
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /<option value="INTERVAL">/);
  assert.match(html, /value="NOW">Зараз/);
  assert.match(html, /value="LATER">У задану дату й час/);
  assert.match(js, /intervalSecondsFromUi/);
  assert.match(js, /calendarNowFields/);
  assert.match(js, /kind === 'INTERVAL'/);
});
