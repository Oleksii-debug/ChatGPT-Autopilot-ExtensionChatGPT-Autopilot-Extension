import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunTimelineV1 } from '../src/core/run-timeline.js';

function state() {
  return {
    sessionsById: {
      'session-a': {
        name: 'A',
        runState: 'RUNNING',
        operation: { phase: 'READY' },
        taskOrder: [],
        tasksById: {},
        currentTaskIndex: 0,
        lastError: '',
        lastActionAt: Number.MAX_VALUE,
        updatedAt: Number.MAX_VALUE,
      },
    },
    logs: {
      'session-a': [{ at: Number.MAX_VALUE, level: 'info', message: 'out-of-range' }],
    },
    diagnostics: [{
      at: Number.MAX_VALUE,
      sessionId: 'session-a',
      phase: 'READY',
      message: 'out-of-range',
    }],
  };
}

test('run timeline rejects timestamps outside the JavaScript Date range before UI rendering', () => {
  const timeline = buildRunTimelineV1(state(), { sessionId: 'session-a', limit: 20 });
  assert.deepEqual(timeline.entries.map((entry) => entry.at), [0, 0]);
  assert.equal(timeline.session.lastActionAt, 0);
  assert.equal(timeline.session.updatedAt, 0);
  for (const entry of timeline.entries) {
    assert.doesNotThrow(() => new Date(entry.at).toISOString());
  }
});
