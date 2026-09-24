import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_RUN_TIMELINE_ENTRIES, buildRunTimelineV1 } from '../src/core/run-timeline.js';

function state() {
  return {
    sessionsById: {
      'session-a': {
        name: 'Основний', runState: 'RUNNING', currentTaskIndex: 0,
        taskOrder: ['task-a'], tasksById: { 'task-a': { id: 'task-a', label: 'Перевірка' } },
        operation: { phase: 'READY_TO_SEND' }, lastError: 'password=SECRET_ERROR_PASSWORD', lastActionAt: 30, updatedAt: 31,
      },
      'session-b': {
        name: 'Інший', runState: 'STOPPED', currentTaskIndex: 0,
        taskOrder: [], tasksById: {}, operation: null, lastError: '', lastActionAt: 0, updatedAt: 0,
      },
    },
    logs: {
      'session-a': [
        { at: 10, level: 'info', message: 'Authorization: Bearer SECRET_LOG_TOKEN' },
        { at: 30, level: 'warn', message: 'Відкрито https://example.invalid/private?token=SECRET_URL_TOKEN' },
      ],
      'session-b': [{ at: 5, level: 'info', message: 'Не показувати' }],
    },
    diagnostics: [
      {
        at: 20, event: 'SEND_CHECK', sessionId: 'session-a', taskLabel: 'Перевірка',
        phase: 'READY', status: 'SECRET_STATUS', code: 'SECRET_CODE', message: 'api_key=SECRET_DIAGNOSTIC_KEY',
        target: 'chatgpt.com/розмова: …123456', observed: 'https://example.invalid/?token=SECRET_OBSERVED',
        promptFingerprint: 'SECRET_FINGERPRINT', operationIdSuffix: 'SECRET_OPERATION',
        promptText: 'СЕКРЕТНИЙ ПРОМПТ НЕ МОЖНА ВИВОДИТИ',
      },
      { at: 25, event: 'OTHER', sessionId: 'session-b', message: 'Чужий сеанс' },
    ],
  };
}

test('timeline deterministically merges only selected-session logs and redacted diagnostics', () => {
  const timeline = buildRunTimelineV1(state(), { sessionId: 'session-a', limit: 20 });
  assert.equal(timeline.schemaVersion, 1);
  assert.deepEqual(timeline.entries.map(entry => [entry.source, entry.at]), [
    ['LOG', 10], ['DIAGNOSTIC', 20], ['LOG', 30],
  ]);
  assert.equal(timeline.session.runState, 'RUNNING');
  assert.equal(timeline.session.currentTaskLabel, '');
  assert.equal(timeline.session.lastError, '');
  assert.equal(timeline.session.phase, 'READY');
  assert.deepEqual(timeline.sources, { logCount: 2, diagnosticCount: 1 });
  const serialized = JSON.stringify(timeline);
  assert.doesNotMatch(serialized, /SECRET_/u);
  assert.doesNotMatch(serialized, /example\.invalid/u);
  assert.doesNotMatch(serialized, /СЕКРЕТНИЙ ПРОМПТ/u);
  assert.match(serialized, /Подію Core log зафіксовано/u);
  assert.match(serialized, /Діагностичну подію зафіксовано/u);
  assert.match(serialized, /chatgpt\.com\/розмова: …123456/u);
  assert.equal(Object.isFrozen(timeline), true);
  assert.equal(Object.isFrozen(timeline.entries), true);
});

test('timeline is bounded to newest entries without mutating canonical state', () => {
  const canonical = state();
  canonical.logs['session-a'] = Array.from({ length: 205 }, (_, index) => ({
    at: index + 1, level: 'info', message: `log-${index + 1}`,
  }));
  canonical.diagnostics = [];
  const before = structuredClone(canonical);
  const timeline = buildRunTimelineV1(canonical, { sessionId: 'session-a', limit: MAX_RUN_TIMELINE_ENTRIES });
  assert.equal(timeline.totalEntries, 205);
  assert.equal(timeline.returnedEntries, 200);
  assert.equal(timeline.truncated, true);
  assert.equal(timeline.entries[0].message, 'log-6');
  assert.equal(timeline.entries.at(-1).message, 'log-205');
  assert.deepEqual(canonical, before);
});

test('timeline preserves a canonical legacy text identity instead of imposing a new ID alphabet', () => {
  const canonical = state();
  canonical.sessionsById['legacy session 1'] = {
    name: 'Legacy', runState: 'STOPPED', currentTaskIndex: 0,
    taskOrder: [], tasksById: {}, operation: null, lastError: '', lastActionAt: 0, updatedAt: 0,
  };
  canonical.logs['legacy session 1'] = [{ at: 1, level: 'info', message: 'legacy' }];
  const timeline = buildRunTimelineV1(canonical, { sessionId: 'legacy session 1', limit: 10 });
  assert.equal(timeline.sessionId, 'legacy session 1');
  assert.equal(timeline.entries[0].message, 'Подію Core log зафіксовано.');
});

test('timeline boundary rejects coerced identities, coerced limits and missing sessions', () => {
  const canonical = state();
  for (const sessionId of [1, true, {}, '']) {
    assert.throws(() => buildRunTimelineV1(canonical, { sessionId }), /sessionId/);
  }
  for (const limit of ['10', true, 0, 201, 1.5]) {
    assert.throws(() => buildRunTimelineV1(canonical, { sessionId: 'session-a', limit }), /limit/);
  }
  assert.throws(() => buildRunTimelineV1(canonical, { sessionId: 'missing' }), /not found/);
});
