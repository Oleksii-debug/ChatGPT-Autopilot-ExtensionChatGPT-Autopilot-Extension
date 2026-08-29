import test from 'node:test';
import assert from 'node:assert/strict';
import { translateText } from '../../src/ui/uk-localization.js';

test('Ukrainian UI localization translates static labels and runtime states', () => {
  assert.equal(translateText('Create session'), 'Створити сеанс');
  assert.equal(translateText('Open session Робота'), 'Відкрити сеанс Робота');
  assert.equal(translateText('State: RUNNING.'), 'Стан: ПРАЦЮЄ.');
  assert.equal(translateText('3 enabled tasks.'), 'Увімкнених завдань: 3.');
  assert.equal(translateText('Task 2 ChatGPT URL'), 'Завдання 2: посилання ChatGPT');
  assert.equal(translateText('Prompt for Task 2'), 'Промпт для завдання 2');
  assert.equal(translateText('Task 2 must use a valid https://chatgpt.com URL.'), 'Для завдання 2 потрібно вказати коректне посилання https://chatgpt.com.');
});

test('Ukrainian UI localization translates command and Core status output', () => {
  assert.equal(translateText('Core acknowledged Start. Current state: RUNNING.'), 'Команду «Запуск» виконано. Поточний стан: ПРАЦЮЄ.');
  assert.equal(translateText('Command failed: Session not found'), 'Не вдалося виконати команду: Сеанс не знайдено');
  assert.equal(translateText('Session paused'), 'Сеанс призупинено');
  assert.equal(translateText('SUBMISSION_UNCERTAIN'), 'РЕЗУЛЬТАТ ВІДПРАВЛЕННЯ НЕВИЗНАЧЕНИЙ');
});

test('Ukrainian UI localization preserves user-provided text that is not a known interface phrase', () => {
  assert.equal(translateText('Мій сеанс 1'), 'Мій сеанс 1');
  assert.equal(translateText('https://chatgpt.com/c/example'), 'https://chatgpt.com/c/example');
});
