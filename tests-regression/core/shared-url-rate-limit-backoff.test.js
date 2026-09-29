import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInteractionResult } from '../../src/core/execution.js';
import { selectNextTask } from '../../src/core/scheduler.js';
import { createSession, createTask, RunState } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

function session(urlMode) {
  const s = createSession({
    id: 's', name: 'S',
    tasks: [1, 2, 3].map(i => createTask({ id: `t${i}`, url: 'https://chatgpt.com/' })),
    sharedPrompt: 'p', retryBackoffMs: 15000, now: 0,
  });
  s.runState = RunState.RUNNING;
  s.retryPolicy = 'safe';
  s.urlMode = urlMode;
  return s;
}

test('confirmed rate limit holds every shared-URL cycle instead of skipping to the next one', () => {
  const s = session('shared');
  const result = applyInteractionResult(s, 0, { status: InteractionResult.RATE_LIMITED }, { now: 1000 });
  assert.equal(result.retryAt, 301000);
  assert.deepEqual(s.taskOrder.map(id => s.tasksById[id].retryAfterAt), [301000, 301000, 301000]);
  assert.deepEqual(selectNextTask(s, 1001), { kind: 'WAIT', wakeAt: 301000 });
  const after = selectNextTask(s, 301000);
  assert.equal(after.kind, 'TASK');
  assert.equal(after.task.id, 't1');
});

test('different-URL mode keeps task-local rate-limit scheduling behavior', () => {
  const s = session('unique');
  applyInteractionResult(s, 0, { status: InteractionResult.RATE_LIMITED }, { now: 1000 });
  const decision = selectNextTask(s, 1001);
  assert.equal(decision.kind, 'TASK');
  assert.equal(decision.task.id, 't2');
});

test('temporary UI failure also holds a shared-URL series on the same logical cycle', () => {
  const s = session('shared');
  const result = applyInteractionResult(s, 0, { status: InteractionResult.TEMPORARY_ERROR }, { now: 2000 });
  assert.equal(result.retryAt, 17000);
  assert.deepEqual(s.taskOrder.map(id => s.tasksById[id].retryAfterAt), [17000, 17000, 17000]);
  assert.deepEqual(selectNextTask(s, 2001), { kind: 'WAIT', wakeAt: 17000 });
  const after = selectNextTask(s, 17000);
  assert.equal(after.kind, 'TASK');
  assert.equal(after.task.id, 't1');
});
