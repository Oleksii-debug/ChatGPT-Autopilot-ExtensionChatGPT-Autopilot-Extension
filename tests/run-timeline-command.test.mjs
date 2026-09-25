import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../src/core/commands.js';
import { CoreCommand } from '../src/shared/protocol.js';

function canonicalState() {
  return {
    sessionsById: {
      'session-a': {
        name: 'A', runState: 'RUNNING', currentTaskIndex: 0,
        taskOrder: ['task-a'], tasksById: { 'task-a': { id: 'task-a', label: 'A1' } },
        operation: null, lastError: '', lastActionAt: 2, updatedAt: 2,
      },
    },
    logs: { 'session-a': [{ at: 1, level: 'info', message: 'started' }] },
    diagnostics: [{ at: 2, sessionId: 'session-a', event: 'CHECK', message: 'verified' }],
  };
}

test('GET_RUN_TIMELINE returns the bounded projection through the existing Core read authority', async () => {
  const state = canonicalState();
  const repo = {
    loadCount: 0,
    async load() { this.loadCount += 1; return structuredClone(state); },
  };
  const dispatcher = new CoreCommandDispatcher(repo, () => 123);
  const result = await dispatcher.execute(CoreCommand.GET_RUN_TIMELINE, { sessionId: 'session-a', limit: 10 });
  assert.equal(repo.loadCount, 1);
  assert.equal(result.timeline.sessionId, 'session-a');
  assert.equal(result.timeline.entries.length, 2);
  assert.deepEqual(result.timeline.entries.map(entry => entry.source), ['LOG', 'DIAGNOSTIC']);
  assert.deepEqual(state, canonicalState());
});

test('GET_RUN_TIMELINE preserves strict payload typing', async () => {
  const dispatcher = new CoreCommandDispatcher({ async load() { return canonicalState(); } }, () => 123);
  await assert.rejects(
    dispatcher.execute(CoreCommand.GET_RUN_TIMELINE, { sessionId: 'session-a', limit: '10' }),
    /limit/,
  );
});
