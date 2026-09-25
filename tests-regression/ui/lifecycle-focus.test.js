import test from 'node:test';
import assert from 'node:assert/strict';
import { focusAfterLifecycleSuccess, lifecycleSuccessTargetId } from '../../src/ui/focus-policy.js';

function fakeControls(disabledIds = []) {
  const focused = [];
  const ids = [
    'start-session-button',
    'pause-session-button',
    'resume-session-button',
    'stop-session-button',
    'command-result',
  ];
  const controls = Object.fromEntries(ids.map((id) => [id, {
    id,
    disabled: disabledIds.includes(id),
    focus() { focused.push(id); },
  }]));
  return { controls, focused, getById: (id) => controls[id] || null };
}

test('lifecycle success maps to the next usable keyboard control', () => {
  assert.equal(lifecycleSuccessTargetId('START_SESSION'), 'pause-session-button');
  assert.equal(lifecycleSuccessTargetId('PAUSE_SESSION'), 'resume-session-button');
  assert.equal(lifecycleSuccessTargetId('RESUME_SESSION'), 'pause-session-button');
  assert.equal(lifecycleSuccessTargetId('STOP_SESSION'), 'start-session-button');
  assert.equal(lifecycleSuccessTargetId('CLEAR_LOG'), null);
});

test('Core-acknowledged lifecycle success moves focus to the expected enabled control', () => {
  for (const [command, expected] of [
    ['START_SESSION', 'pause-session-button'],
    ['PAUSE_SESSION', 'resume-session-button'],
    ['RESUME_SESSION', 'pause-session-button'],
    ['STOP_SESSION', 'start-session-button'],
  ]) {
    const { focused, getById } = fakeControls();
    assert.equal(focusAfterLifecycleSuccess(command, getById), expected);
    assert.deepEqual(focused, [expected]);
  }
});

test('lifecycle focus fails safely to persistent command result when expected control is unavailable', () => {
  const { focused, getById } = fakeControls(['pause-session-button']);
  assert.equal(focusAfterLifecycleSuccess('START_SESSION', getById), 'command-result');
  assert.deepEqual(focused, ['command-result']);
});

test('non-lifecycle commands never move focus through the lifecycle policy', () => {
  const { focused, getById } = fakeControls();
  assert.equal(focusAfterLifecycleSuccess('CLEAR_LOG', getById), null);
  assert.deepEqual(focused, []);
});
