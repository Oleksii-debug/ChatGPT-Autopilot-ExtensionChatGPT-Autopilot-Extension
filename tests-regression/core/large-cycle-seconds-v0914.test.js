import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFromUi, validateRunnableSession } from '../../src/core/commands.js';
import { advanceAfterVerifiedSend, selectNextTask } from '../../src/core/scheduler.js';
import { previewPortableProfile } from '../../src/core/portable-profile.js';

function sharedConfig(overrides = {}) {
  return {
    id: 'large-shared', name: 'Large shared', urlMode: 'shared', promptMode: 'shared',
    sharedPrompt: 'continue', runMode: 'one-pass', tabStrategy: 'open-close',
    tasks: [{ id: 'cycle', enabled: true, label: '', url: 'https://chatgpt.com/', promptOverride: '' }],
    configuredTaskCount: 1_000_000,
    minimumSendIntervalValue: 7,
    minimumSendIntervalUnit: 'seconds',
    preSendDelaySeconds: 1,
    busyCheckDelaySeconds: 2,
    retryBackoffSeconds: 5,
    ...overrides,
  };
}

test('shared/shared supports one million logical cycles with one physical task definition', () => {
  const session = sessionFromUi(sharedConfig(), 1000);
  assert.equal(session.configuredTaskCount, 1_000_000);
  assert.equal(session.taskOrder.length, 1);
  assert.equal(Object.keys(session.tasksById).length, 1);
  assert.doesNotThrow(() => validateRunnableSession(session));
});

test('seconds are authoritative while legacy minute configs retain their exact cadence', () => {
  const seconds = sessionFromUi(sharedConfig({ configuredTaskCount: 1 }), 1000);
  assert.equal(seconds.minimumSendIntervalMs, 7000);

  const legacy = sessionFromUi({
    id: 'legacy-minutes', name: 'Legacy minutes', urlMode: 'shared', promptMode: 'shared',
    sharedPrompt: 'continue', runMode: 'continuous', minimumSendIntervalMinutes: 2,
    tasks: [{ id: 'legacy', enabled: true, url: 'https://chatgpt.com/' }],
  }, 1000);
  assert.equal(legacy.minimumSendIntervalMs, 120000);
});

test('compact one-pass advances logical progress and completes only at configured cycle target', () => {
  const session = sessionFromUi(sharedConfig({ configuredTaskCount: 3, minimumSendIntervalValue: 1 }), 1000);
  session.runState = 'RUNNING';
  assert.equal(selectNextTask(session, 1000).kind, 'TASK');
  advanceAfterVerifiedSend(session, 0, 1000);
  assert.equal(session.onePassCompletedCount, 1);
  assert.notEqual(selectNextTask(session, 2000).kind, 'COMPLETE');
  advanceAfterVerifiedSend(session, 0, 2000);
  assert.equal(session.onePassCompletedCount, 2);
  advanceAfterVerifiedSend(session, 0, 3000);
  assert.equal(session.onePassCompletedCount, 3);
  assert.equal(selectNextTask(session, 4000).kind, 'COMPLETE');
});

test('distinct task modes fail closed above the physical 1000-task ceiling', () => {
  assert.throws(() => sessionFromUi({
    id: 'distinct-too-large', name: 'Distinct too large', urlMode: 'unique', promptMode: 'shared',
    sharedPrompt: 'continue', configuredTaskCount: 1001,
    tasks: [{ id: 'one', enabled: true, url: 'https://chatgpt.com/c/one' }],
  }), /limited to 1000/i);
});

test('portable profile can represent one million compact cycles without expanding tasks', () => {
  const preview = previewPortableProfile({
    format: 'chatgpt-autopilot-profile', version: 1, profileName: 'Million', autoStart: false,
    sessions: [{
      id: 'million', name: 'Million', urlMode: 'shared', promptMode: 'shared', sharedPrompt: 'continue',
      runMode: 'one-pass', configuredTaskCount: 1_000_000,
      minimumSendIntervalValue: 5, minimumSendIntervalUnit: 'seconds',
      preSendDelaySeconds: 1, busyCheckDelaySeconds: 2, retryBackoffSeconds: 5, tabStrategy: 'open-close',
      tasks: [{ id: 'one', enabled: true, label: '', url: 'https://chatgpt.com/', promptOverride: '' }],
    }],
  }, 1000);
  assert.equal(preview.taskCount, 1_000_000);
  assert.equal(preview.sessionCount, 1);
});
