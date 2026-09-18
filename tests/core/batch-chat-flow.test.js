import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeBatchTaskCount,
  batchMessageCount,
  batchPromptFor,
  buildBatchTasks,
  createBatchTask,
  isBatchSessionComplete,
  markBatchVerifiedSend,
  normalizeBatchChatFlow,
  replaceCompletedBatchSlot,
  validateBatchChatFlow,
} from '../../src/core/batch-chat-flow.js';

test('normalizes batch flow with explicit concurrency and cadence', () => {
  const config = validateBatchChatFlow({
    enabled: true, seedUrl: 'https://chatgpt.com/c/one', concurrency: 5, totalTasks: 100,
    startIntervalMs: 10_000, primaryPrompt: 'Старт', continuePrompt: 'продовжуй', continueCount: 12, finalPrompt: 'Завершуй',
  });
  assert.equal(config.concurrency, 5); assert.equal(config.totalTasks, 100); assert.equal(config.startIntervalMs, 10_000); assert.deepEqual(config.seedUrls, ['https://chatgpt.com/c/one']); assert.equal(batchMessageCount(config), 14);
});

test('rejects concurrency above total task count', () => {
  assert.throws(() => validateBatchChatFlow({ enabled: true, seedUrl: 'https://chatgpt.com/c/one', concurrency: 5, totalTasks: 2, primaryPrompt: 'Старт', continuePrompt: 'продовжуй', continueCount: 2, finalPrompt: 'Готово' }), /Кількість одночасних чатів/);
});

test('rejects duplicate initial chat URLs so two workers cannot own one chat', () => {
  assert.throws(() => validateBatchChatFlow({ enabled: true, seedUrls: ['https://chatgpt.com/c/a', 'https://www.chatgpt.com/c/a'], concurrency: 2, totalTasks: 2, primaryPrompt: 'START', continuePrompt: 'CONTINUE', continueCount: 1, finalPrompt: 'FINAL' }), /не можуть повторюватися/);
});

test('creates only the concurrent slot count for a large batch and opens new chats for empty slots', () => {
  const config = normalizeBatchChatFlow({ enabled: true, seedUrls: ['https://chatgpt.com/c/one'], concurrency: 3, totalTasks: 1000, startIntervalMs: 10_000, primaryPrompt: 'Старт', continuePrompt: 'продовжуй', continueCount: 1, finalPrompt: 'Завершуй' });
  const tasks = buildBatchTasks(config, { idFactory: (() => { let i = 0; return () => `task-${++i}`; })(), now: 5_000 });
  assert.equal(tasks.length, 3); assert.deepEqual(tasks.map(task => task.batch.ordinal), [1, 2, 3]); assert.equal(tasks[0].batch.source, 'INITIAL_LINK'); assert.equal(tasks[1].batch.source, 'NEW_CHAT'); assert.equal(tasks[2].url, 'https://chatgpt.com/'); assert.deepEqual(tasks.map(task => task.retryAfterAt), [5_000, 15_000, 25_000]);
});

test('prompt lifecycle is primary, continue N times, then final once', () => {
  const config = normalizeBatchChatFlow({ enabled: true, seedUrl: 'https://chatgpt.com/c/one', concurrency: 1, totalTasks: 1, primaryPrompt: 'START', continuePrompt: 'CONTINUE', continueCount: 2, finalPrompt: 'FINAL' });
  const task = createBatchTask({ id: 't1', ordinal: 1, initialUrl: config.seedUrls[0] });
  assert.equal(batchPromptFor(config, task), 'START'); assert.equal(markBatchVerifiedSend(task, 100, config).nextPrompt, 'CONTINUE'); assert.equal(markBatchVerifiedSend(task, 200, config).nextPrompt, 'CONTINUE'); assert.equal(markBatchVerifiedSend(task, 300, config).nextPrompt, 'FINAL'); const result = markBatchVerifiedSend(task, 400, config); assert.equal(result.completed, true); assert.equal(task.batch.phase, 'DONE');
});

test('completed slot is recycled into a clean new chat without growing task count', () => {
  const config = normalizeBatchChatFlow({ enabled: true, seedUrl: 'https://chatgpt.com/c/one', concurrency: 2, totalTasks: 4, primaryPrompt: 'START', continuePrompt: 'CONTINUE', continueCount: 0, finalPrompt: 'FINAL' });
  config.nextOrdinal = 3; config.completedTasks = 1;
  const tasks = buildBatchTasks(config, { idFactory: (() => { let i = 0; return () => `task-${++i}`; })() });
  const session = { batchChatFlow: config, taskOrder: tasks.map(t => t.id), tasksById: Object.fromEntries(tasks.map(t => [t.id, t])) };
  markBatchVerifiedSend(tasks[0], 100, config); markBatchVerifiedSend(tasks[0], 200, config); assert.equal(activeBatchTaskCount(session), 1);
  const recycle = replaceCompletedBatchSlot(session, tasks[0].id, 300);
  assert.equal(recycle.replaced, true); assert.equal(tasks[0].batch.ordinal, 3); assert.equal(tasks[0].batch.verifiedMessages, 0); assert.equal(tasks[0].enabled, true); assert.equal(tasks[0].batch.source, 'NEW_CHAT'); assert.equal(tasks[0].url, 'https://chatgpt.com/');
});

test('batch completes after the final set of slots is finished', () => {
  const config = normalizeBatchChatFlow({ enabled: true, seedUrl: 'https://chatgpt.com/c/one', concurrency: 2, totalTasks: 2, primaryPrompt: 'START', continuePrompt: 'CONTINUE', continueCount: 0, finalPrompt: 'FINAL' });
  config.nextOrdinal = 3;
  const tasks = buildBatchTasks(config, { idFactory: (() => { let i = 0; return () => `task-${++i}`; })() });
  const session = { batchChatFlow: config, taskOrder: tasks.map(t => t.id), tasksById: Object.fromEntries(tasks.map(t => [t.id, t])) };
  for (const task of tasks) { markBatchVerifiedSend(task, 100, config); markBatchVerifiedSend(task, 200, config); replaceCompletedBatchSlot(session, task.id, 300); }
  assert.equal(isBatchSessionComplete(session), true);
});
