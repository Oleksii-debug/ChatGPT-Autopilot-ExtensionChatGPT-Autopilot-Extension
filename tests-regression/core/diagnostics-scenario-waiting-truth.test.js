import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticReport } from '../../src/core/diagnostics.js';

test('managed scenario transport that sent one prompt is reported as waiting for assistant, not scenario-completed', () => {
  const sessionId = 'scenario-work:chess:chat:generation-1';
  const taskId = sessionId + ':task';
  const state = {
    schemaVersion: 2,
    sessionOrder: [sessionId],
    sessionsById: {
      [sessionId]: {
        id: sessionId,
        name: 'Accessible Chess — чат 1 — chat',
        runState: 'STOPPED',
        runMode: 'ONE_PASS',
        successfulSendCount: 1,
        completedAt: 123,
        onePassCompletedTaskIds: [taskId],
        taskOrder: [taskId],
        tasksById: {
          [taskId]: {
            id: taskId,
            enabled: true,
            label: 'Accessible Chess — чат 1: chat',
            status: 'IDLE',
            retryAfterAt: 0,
            normalizedUrl: 'https://chatgpt.com/',
            url: 'https://chatgpt.com/',
          },
        },
        operation: {
          phase: 'SENT_VERIFIED',
          targetUrl: 'https://chatgpt.com/',
        },
        scenarioWork: { managed: true, scenarioId: 'chess-1', generation: 1 },
        lastError: '',
      },
    },
    diagnostics: [],
  };
  const report = createDiagnosticReport(state, { now: 456, extensionVersion: '10.0.0' });
  assert.match(report, /стан: WAITING_RESPONSE/u);
  assert.match(report, /Scenario Work ще має підтвердити завершення відповіді ChatGPT/u);
  assert.doesNotMatch(report, /стан: COMPLETED/u);
});
