import { normalizeChatUrl } from './schema.js';

const MAX_CONCURRENCY = 50;
const MAX_TOTAL_TASKS = 100000;
const MAX_CONTINUE_COUNT = 1000000;
const MAX_START_INTERVAL_MS = 24 * 60 * 60 * 1000;

function asInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function requirePrompt(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} не може бути порожнім.`);
  return value;
}

export function normalizeBatchChatFlow(raw = {}) {
  return {
    enabled: raw.enabled === true,
    seedUrl: typeof raw.seedUrl === 'string' ? raw.seedUrl.trim() : '',
    concurrency: asInt(raw.concurrency, 1, 1, MAX_CONCURRENCY),
    totalTasks: asInt(raw.totalTasks, 1, 1, MAX_TOTAL_TASKS),
    startIntervalMs: asInt(raw.startIntervalMs, 0, 0, MAX_START_INTERVAL_MS),
    primaryPrompt: typeof raw.primaryPrompt === 'string' ? raw.primaryPrompt : '',
    continuePrompt: typeof raw.continuePrompt === 'string' ? raw.continuePrompt : 'продовжуй',
    continueCount: asInt(raw.continueCount, 10, 0, MAX_CONTINUE_COUNT),
    finalPrompt: typeof raw.finalPrompt === 'string' ? raw.finalPrompt : '',
    nextOrdinal: asInt(raw.nextOrdinal, 1, 1, MAX_TOTAL_TASKS + 1),
    completedTasks: asInt(raw.completedTasks, 0, 0, MAX_TOTAL_TASKS),
  };
}

export function validateBatchChatFlow(raw = {}) {
  const config = normalizeBatchChatFlow(raw);
  if (!config.enabled) return config;
  requirePrompt(config.seedUrl, 'Посилання початкового чату');
  requirePrompt(config.primaryPrompt, 'Стартовий промт');
  requirePrompt(config.continuePrompt, 'Постійний промт');
  requirePrompt(config.finalPrompt, 'Завершальний промт');
  normalizeChatUrl(config.seedUrl);
  if (config.concurrency > config.totalTasks) throw new Error('Кількість одночасних чатів не може перевищувати загальну кількість завдань.');
  if (config.nextOrdinal > config.totalTasks + 1) throw new Error('Неправильний наступний номер batch-завдання.');
  return config;
}

export function batchMessageCount(config) {
  return 2 + config.continueCount;
}

export function createBatchTask({ id, ordinal, seedUrl, startAt = 0 }) {
  if (!id) throw new Error('Batch task id required');
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error('Batch task ordinal must be positive');
  const normalized = normalizeChatUrl(seedUrl);
  return {
    id, enabled: true, label: `Завдання ${ordinal}`, url: seedUrl, normalizedUrl: normalized,
    promptOverride: '', status: 'BATCH_PENDING', lastCheckedAt: 0, lastVerifiedSendAt: 0,
    lastVerifiedFingerprint: '', retryAfterAt: Math.max(0, startAt), manualReviewReason: '',
    batch: { ordinal, verifiedMessages: 0, phase: 'PRIMARY', startedAt: 0, completedAt: 0, seedUrl },
  };
}

export function isBatchTaskComplete(task) {
  return task?.batch?.phase === 'DONE';
}

export function isBatchTaskActive(task) {
  return Boolean(task?.enabled) && !isBatchTaskComplete(task);
}

export function activeBatchTaskCount(session) {
  return session.taskOrder.filter(id => isBatchTaskActive(session.tasksById[id])).length;
}

export function isBatchSessionComplete(session) {
  const config = session?.batchChatFlow;
  if (!config?.enabled) return false;
  return config.completedTasks >= config.totalTasks && activeBatchTaskCount(session) === 0;
}

export function batchPromptFor(config, task) {
  const count = task?.batch?.verifiedMessages || 0;
  if (count === 0) return config.primaryPrompt;
  if (count <= config.continueCount) return config.continuePrompt;
  if (count === config.continueCount + 1) return config.finalPrompt;
  return null;
}

export function resetBatchTaskForOrdinal(task, ordinal, config, startAt = 0) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > config.totalTasks) throw new Error('Invalid next batch ordinal');
  const normalized = normalizeChatUrl(config.seedUrl);
  task.enabled = true;
  task.label = `Завдання ${ordinal}`;
  task.url = config.seedUrl;
  task.normalizedUrl = normalized;
  task.promptOverride = '';
  task.status = 'BATCH_PENDING';
  task.lastCheckedAt = 0;
  task.lastVerifiedSendAt = 0;
  task.lastVerifiedFingerprint = '';
  task.retryAfterAt = Math.max(0, startAt);
  task.manualReviewReason = '';
  task.batch = { ordinal, verifiedMessages: 0, phase: 'PRIMARY', startedAt: 0, completedAt: 0, seedUrl: config.seedUrl };
  return task;
}

export function markBatchVerifiedSend(task, verifiedAt, config) {
  if (!task?.batch || isBatchTaskComplete(task)) return { completed: true, nextPrompt: null };
  const nextCount = Number(task.batch.verifiedMessages || 0) + 1;
  task.batch.verifiedMessages = nextCount;
  task.lastVerifiedSendAt = verifiedAt;
  task.batch.startedAt ||= verifiedAt;
  if (nextCount >= batchMessageCount(config)) {
    task.batch.phase = 'DONE';
    task.batch.completedAt = verifiedAt;
    task.status = 'BATCH_COMPLETE';
    return { completed: true, nextPrompt: null };
  }
  task.batch.phase = nextCount <= config.continueCount ? 'CONTINUE' : 'FINAL';
  task.status = 'BATCH_WAITING_NEXT';
  return { completed: false, nextPrompt: batchPromptFor(config, task) };
}

export function buildBatchTasks(config, { idFactory = () => crypto.randomUUID() } = {}) {
  const normalized = validateBatchChatFlow(config);
  if (!normalized.enabled) return [];
  const slotCount = Math.min(normalized.concurrency, normalized.totalTasks);
  return Array.from({ length: slotCount }, (_, index) => createBatchTask({ id: idFactory(), ordinal: index + 1, seedUrl: normalized.seedUrl, startAt: index * normalized.startIntervalMs }));
}

export function replaceCompletedBatchSlot(session, taskId, now = Date.now()) {
  const config = session.batchChatFlow;
  const task = session.tasksById[taskId];
  if (!config?.enabled || !task?.batch || !isBatchTaskComplete(task)) return { replaced: false, completed: isBatchSessionComplete(session) };
  config.completedTasks = Math.min(config.totalTasks, config.completedTasks + 1);
  const nextOrdinal = config.nextOrdinal;
  if (nextOrdinal > config.totalTasks) {
    task.enabled = false;
    return { replaced: false, completed: isBatchSessionComplete(session), ordinal: task.batch.ordinal };
  }
  config.nextOrdinal += 1;
  resetBatchTaskForOrdinal(task, nextOrdinal, config, now + config.startIntervalMs);
  return { replaced: true, completed: false, ordinal: nextOrdinal };
}

export const BATCH_CHAT_FLOW_LIMITS = Object.freeze({ maxConcurrency: MAX_CONCURRENCY, maxTotalTasks: MAX_TOTAL_TASKS, maxContinueCount: MAX_CONTINUE_COUNT, maxStartIntervalMs: MAX_START_INTERVAL_MS });
