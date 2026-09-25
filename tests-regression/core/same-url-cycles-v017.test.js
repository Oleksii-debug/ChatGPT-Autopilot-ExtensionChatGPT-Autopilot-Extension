import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFromUi, validateRunnableSession } from '../../src/core/commands.js';
import { previewPortableProfile } from '../../src/core/portable-profile.js';

function tasks(count, url = 'https://chatgpt.com/') {
  return Array.from({ length: count }, (_, index) => ({
    id: `cycle-${index + 1}`,
    enabled: true,
    label: '',
    url,
    promptOverride: '',
  }));
}

test('one Session may intentionally contain repeated new-chat launch URL tasks', () => {
  const session = sessionFromUi({
    id: 'same-url', name: 'Same URL cycles', urlMode: 'shared', promptMode: 'shared',
    sharedPrompt: 'continue', runMode: 'one-pass', tabStrategy: 'open-close', tasks: tasks(30),
  }, 1000);
  assert.equal(session.taskOrder.length, 30);
  assert.doesNotThrow(() => validateRunnableSession(session));
  assert.equal(new Set(session.taskOrder.map(id => session.tasksById[id].normalizedUrl)).size, 1);
});

test('portable profile accepts repeated URLs inside one Session and reports all cycles', () => {
  const preview = previewPortableProfile({
    format: 'chatgpt-autopilot-profile', version: 1, profileName: 'Cycles', autoStart: false,
    sessions: [{
      id: 'same-url', name: 'Same URL cycles', autoStart: false, urlMode: 'shared',
      promptMode: 'shared', sharedPrompt: 'continue', defaultUniquePrompt: '', runMode: 'one-pass',
      minimumSendIntervalMinutes: 1, preSendDelaySeconds: 10, busyCheckDelaySeconds: 2,
      retryBackoffSeconds: 30, retryPolicy: 'safe', tabStrategy: 'open-close', tasks: tasks(30),
    }],
  }, 1000);
  assert.equal(preview.sessionCount, 1);
  assert.equal(preview.taskCount, 30);
});

test('session task capacity supports the requested 1-1000 spinner range', () => {
  const session = sessionFromUi({
    id: 'max-cycles', name: 'Max cycles', urlMode: 'shared', promptMode: 'shared',
    sharedPrompt: 'continue', runMode: 'one-pass', tabStrategy: 'open-close', tasks: tasks(1000),
  }, 1000);
  assert.equal(session.taskOrder.length, 1000);
  assert.doesNotThrow(() => validateRunnableSession(session));
});
