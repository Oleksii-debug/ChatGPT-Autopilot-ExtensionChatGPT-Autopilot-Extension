import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSimplifiedSessionConfig } from '../../src/ui/simplified-session-config.js';

const html = await readFile(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../../src/ui/options.js', import.meta.url), 'utf8');

function simplifiedSection() {
  const start = html.indexOf('<section data-app-mode="simplified"');
  const end = html.indexOf('<section aria-labelledby="rate-limit-settings-heading" data-app-mode="sessions">', start);
  assert.ok(start >= 0 && end > start, 'Simplified Sessions section not found');
  return html.slice(start, end);
}

test('Simplified Sessions restores the familiar legacy editor questions with select controls', () => {
  const section = simplifiedSection();
  for (const label of [
    'Назва сеансу',
    'Режим налаштування завдань',
    'Посилання ChatGPT для всіх завдань',
    'Спільний промпт для всіх завдань',
    'Режим роботи',
    'Кількість завдань / циклів',
    'Інтервал відправлення',
    'Пауза перед відправленням, с',
    'Перевірка зайнятості, с',
    'Повторна спроба',
    'Політика повторних спроб',
    'Поведінка, коли чат зайнятий',
    'Режим вкладок',
  ]) assert.ok(section.includes(label), `missing legacy field: ${label}`);

  for (const id of [
    'simplified-config-mode',
    'simplified-run-mode',
    'simplified-interval-unit',
    'simplified-retry-unit',
    'simplified-retry-policy',
    'simplified-busy-behavior',
    'simplified-tabs',
  ]) assert.match(section, new RegExp(`<select id="${id}"`), `missing select ${id}`);

  assert.doesNotMatch(section, /type="checkbox"/u);
  assert.doesNotMatch(section, /type="radio"/u);
});

test('Simplified Sessions exposes the old global recovery and concurrency controls against current Core', () => {
  const section = simplifiedSection();
  assert.match(section, /Пауза після обмеження запитів, хв/u);
  assert.match(section, /id="simplified-max-concurrent-session-operations"[^>]*min="1"[^>]*max="32"/u);
  assert.match(js, /UPDATE_PROFILE_SETTINGS[\s\S]*maxConcurrentSessionOperations: concurrency/u);
  assert.match(js, /GET_PROFILE_SETTINGS/u);
});

test('Simplified retry unit preserves the old minutes-or-seconds behavior', () => {
  const config = buildSimplifiedSessionConfig({
    name: 'спорт',
    mode: 'shared-shared',
    url: 'https://chatgpt.com/',
    prompt: 'Продовжуй розробку.',
    runMode: 'continuous',
    cycles: '5000',
    interval: '2',
    intervalUnit: 'minutes',
    delay: '10',
    busy: '3',
    retry: '2',
    retryUnit: 'minutes',
    retryPolicy: 'safe',
    busyBehavior: 'skip-next',
    tabs: 'open-close',
  }, null, (() => { let n = 0; return () => `id-${++n}`; })());

  assert.equal(config.configuredTaskCount, 5000);
  assert.equal(config.retryBackoffSeconds, 120);
  assert.equal(config.busyCheckDelaySeconds, 3);
  assert.equal(config.tabStrategy, 'open-close');
  assert.equal(config.busyChatBehavior, 'skip-next');
});

test('UI removes tutorial prose globally while keeping runtime and safety status', () => {
  assert.doesNotMatch(html, /class="[^"]*field-help/u);
  assert.doesNotMatch(html, /class="notice"/u);
  assert.doesNotMatch(html, /Один чат і один промпт можна повторювати без обмеження часу/u);
  assert.doesNotMatch(html, /0 означає «без окремого ліміту»/u);
  assert.doesNotMatch(html, /Стандартна адреса локального Gateway/u);
  assert.doesNotMatch(html, /Один рядок — один напрям/u);
  assert.doesNotMatch(html, /\splaceholder="/u);
  const described = [...html.matchAll(/aria-describedby="([^"]+)"/gu)].flatMap(match => match[1].split(/\s+/u));
  assert.deepEqual([...new Set(described)].sort(), ['delete-dialog-description', 'uncertain-help']);
  assert.match(html, /id="uncertain-help"/u, 'duplicate-send safety warning must remain');
  assert.match(html, /id="delete-dialog-description"/u, 'destructive delete description must remain');
});
