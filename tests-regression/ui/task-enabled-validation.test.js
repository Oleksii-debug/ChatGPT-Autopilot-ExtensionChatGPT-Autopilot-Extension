import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = fs.readFileSync(new URL('../../src/ui/options.js', import.meta.url), 'utf8');

test('disabled tasks are excluded from enabled-only task validation', () => {
  assert.match(js, /session\.tasks\.forEach\(\(task, i\) => \{\s*if \(!task\.enabled\) return;/s);
});

test('shared prompt is required only when at least one task is enabled', () => {
  assert.match(js, /const hasEnabledTasks = session\.tasks\.some\(\(task\) => task\.enabled\);/);
  assert.match(js, /if \(hasEnabledTasks && session\.promptMode === 'shared' && !session\.sharedPrompt\.trim\(\)\)/);
});

test('enabled ChatGPT URLs must use HTTPS in the accessible Save validation path', () => {
  assert.match(js, /u\.protocol !== 'https:' \|\| !\['chatgpt\.com','www\.chatgpt\.com'\]\.includes\(u\.hostname\)/);
  assert.match(js, /must use a valid https:\/\/chatgpt\.com URL/);
});
