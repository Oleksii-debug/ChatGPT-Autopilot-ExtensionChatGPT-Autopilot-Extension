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
  validateBatchChatFlow,
} from '../../src/core/batch-chat-flow.js';

test('normalizes batch flow with explicit concurrency and cadence', () => {
  const config = validateBatchChatFlow({
    enabled: true,
    seedUrl: 'https://chatgpt.com/',
    concurrency: 5,
    totalTasks: 100,
    startIntervalMs: 10_000,
    primaryPrompt: 'Старт',
    continuePrompt: 'продовжуй',
    continueCount: 12,
    finalPrompt: 'Завершуй',
  });
  assert.equal(config.concurrency, 5);
  assert.equal(config.totalTasks, 100);
  assert.equal(config.startIntervalMs, 10_000);
  assert.equal(batchMessageCount(config), 14);
});

test('rejects concurrency above total task count', () => {
  assert.throws(() => validateBatchChatFlow({
    enabled: true,
    seedUrl: 'https://chatgpt.com/',
    concurrency: 5,
    totalTasks: 2,
    primaryPrompt: 'Старт',
    continuePrompt: 'продовжуй',
    continueCount: 2,
    finalPrompt: 'Готово',
  }), /Кількість одночасних чатів/);
});

test('builds one task per requested job and uses equal launch spacing', () => {
  const config = normalizeBatchChatFlow({
    enabled: true,
    seedUrl: 'https://chatgpt.com/',
    concurrency: 3,
    totalTasks: 4,
    startIntervalMs: 10_000,
    primaryPrompt: 'Старт',
    continuePrompt: 'продовжуй',
    continueCount: 1,
    finalPrompt: 'Завершуй',
  });
  const tasks = buildBatchTasks(config, { idFactory: (() => { let i = 0; return () => `task-${++i}`; })() });
  assert.deepEqual(tasks.map(task => task.batch.ordinal), [1, 2, 3, 4]);
  assert.deepEqual(tasks.map(task => task.retryAfterAt), [0, 10_000, 20_000, 30_000]);
  assert.equal(new Set(tasks.map(task => task.id)).size, 4);
});

test('prompt lifecycle is primary, continue N times, then final once', () => {
  const config = normalizeBatchChatFlow({
    enabled: true,
    seedUrl: 'https://chatgpt.com/',
    concurrency: 1,
    totalTasks: 1,
    primaryPrompt: 'START',
    continuePrompt: 'CONTINUE',
    continueCount: 2,
    finalPrompt: 'FINAL',
  });
  const task = createBatchTask({ id: 't1', ordinal: 1, seedUrl: config.seedUrl });
  assert.equal(batchPromptFor(config, task), 'START');
  assert.equal(markBatchVerifiedSend(task, 100, config).nextPrompt, 'CONTINUE');
  assert.equal(markBatchVerifiedSend(task, 200, config).nextPrompt, 'CONTINUE');
  assert.equal(markBatchVerifiedSend(task, 300, config).nextPrompt, 'FINAL');
  const result = markBatchVerifiedSend(task, 400, config);
  assert.equal(result.completed, true);
  assert.equal(task.batch.phase, 'DONE');
  assert.equal(task.enabled, false);
});

test('active slot count ignores completed jobs and completion is durable', () => {
  const config = normalizeBatchChatFlow({
    enabled: true,
    seedUrl: 'https://chatgpt.com/',
    concurrency: 2,
    totalTasks: 2,
    primaryPrompt: 'START',
    continuePrompt: 'CONTINUE',
    continueCount: 0,
    finalPrompt: 'FINAL',
  });
  const tasks = buildBatchTasks(config, { idFactory: (() => { let i = 0; return () => `task-${++i}`; })() });
  const session = { batchChatFlow: config, taskOrder: tasks.map(t => t.id), tasksById: Object.fromEntries(tasks.map(t => [t.id, t])) };
  assert.equal(activeBatchTaskCount(session), 2);
  markBatchVerifiedSend(tasks[0], 100, config);
  markBatchVerifiedSend(tasks[0], 200, config);
  assert.equal(activeBatchTaskCount(session), 1);
  markBatchVerifiedSend(tasks[1], 300, config);
  markBatchVerifiedSend(tasks[1], 400, config);
  assert.equal(isBatchSessionComplete(session), true);
});
