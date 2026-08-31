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
  assert.equal(translateText('Open dashboard shortcut: Ctrl+Shift+Y.'), 'Комбінація для відкриття панелі: Ctrl+Shift+Y.');
});

test('Ukrainian UI localization covers portable configuration, bulk links, drafts and bounded log output', () => {
  assert.equal(translateText('Configuration file'), 'Файл налаштувань');
  assert.equal(translateText('Download blank configuration template'), 'Завантажити порожній шаблон налаштувань');
  assert.equal(translateText('Import and start requested Sessions'), 'Імпортувати й запустити запитані сеанси');
  assert.equal(translateText('Bulk ChatGPT links'), 'Масове додавання посилань ChatGPT');
  assert.equal(translateText('Unsaved changes are protected locally in this browser.'), 'Незбережені зміни локально захищено в цьому браузері.');
  assert.equal(translateText('3 of 25 Core log entries shown.'), 'Показано 3 із 25 записів журналу.');
  assert.equal(
    translateText('7 unique ChatGPT link(s) recognized; 5 new task(s) created. 2 link(s) did not fit the 50-task limit.'),
    'Розпізнано унікальних посилань ChatGPT: 7; створено нових завдань: 5. Не вмістилося через обмеження у 50 завдань: 2.'
  );
  assert.equal(
    translateText('Profile Робота: 2 Session(s), 10 Task(s), 2 marked for automatic start.'),
    'Профіль Робота: сеансів — 2, завдань — 10, позначено для автоматичного запуску — 2.'
  );
  assert.equal(
    translateText('Portable configuration imported: 2 Session(s). 2 Session(s) started.'),
    'Переносні налаштування імпортовано: сеансів — 2. Запущено сеансів — 2.'
  );
});

test('Ukrainian UI localization translates command and Core status output', () => {
  assert.equal(translateText('Core acknowledged Start. Current state: RUNNING.'), 'Команду «Запуск» виконано. Поточний стан: ПРАЦЮЄ.');
  assert.equal(translateText('Command failed: Session not found'), 'Не вдалося виконати команду: Сеанс не знайдено');
  assert.equal(translateText('Session paused'), 'Сеанс призупинено');
  assert.equal(translateText('SUBMISSION_UNCERTAIN'), 'РЕЗУЛЬТАТ ВІДПРАВЛЕННЯ НЕВИЗНАЧЕНИЙ');
  assert.equal(
    translateText('Automatic execution temporarily unavailable; retry scheduled. Diagnostic: TAB_NAVIGATION_TIMEOUT.'),
    'Автоматичне виконання тимчасово недоступне; повторну спробу заплановано. Діагностика: TAB_NAVIGATION_TIMEOUT.',
  );
  assert.equal(
    translateText('Submission outcome uncertain; no resend scheduled. Diagnostic: INTERACTION_RECEIVER_MISSING_EFFECTFUL.'),
    'Результат відправлення невизначений; повторне відправлення не заплановано. Діагностика: INTERACTION_RECEIVER_MISSING_EFFECTFUL.',
  );
});

test('Ukrainian UI localization preserves user-provided text that is not a known interface phrase', () => {
  assert.equal(translateText('Мій сеанс 1'), 'Мій сеанс 1');
  assert.equal(translateText('https://chatgpt.com/c/example'), 'https://chatgpt.com/c/example');
});
