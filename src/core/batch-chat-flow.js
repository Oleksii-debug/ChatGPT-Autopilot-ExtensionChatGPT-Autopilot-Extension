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
  const enabled = raw.enabled === true;
  const concurrency = asInt(raw.concurrency, 1, 1, MAX_CONCURRENCY);
  const totalTasks = asInt(raw.totalTasks, 1, 1, MAX_TOTAL_TASKS);
  const continueCount = asInt(raw.continueCount, 10, 0, MAX_CONTINUE_COUNT);
  const startIntervalMs = asInt(raw.startIntervalMs, 0, 0, MAX_START_INTERVAL_MS);
  const seedUrl = typeof raw.seedUrl === 'string' ? raw.seedUrl.trim() : '';
  const primaryPrompt = typeof raw.primaryPrompt === 'string' ? raw.primaryPrompt : '';
  const continuePrompt = typeof raw.continuePrompt === 'string' ? raw.continuePrompt : 'продовжуй';
  const finalPrompt = typeof raw.finalPrompt === 'string' ? raw.finalPrompt : '';

  return {
    enabled,
    seedUrl,
    concurrency,
    totalTasks,
    startIntervalMs,
    primaryPrompt,
    continuePrompt,
    continueCount,
    finalPrompt,
  };
}

export function validateBatchChatFlow(raw = {}) {
  const config = normalizeBatchChatFlow(raw);
  if (!config.enabled) return config;
  requirePrompt(config.seedUrl, 'Посилання початкового чату');
  requirePrompt(config.primaryPrompt, 'Стартовий промт');
  requirePrompt(config.continuePrompt, 'Постійний промт');
  requirePrompt(config.finalPrompt, 'Завершальний промт');
  if (config.concurrency > config.totalTasks) {
    throw new Error('Кількість одночасних чатів не може перевищувати загальну кількість завдань.');
  }
  return config;
}

export function batchMessageCount(config) {
  return 2 + config.continueCount;
}

export function createBatchTask({ id, ordinal, seedUrl, startAt = 0 }) {
  if (!id) throw new Error('Batch task id required');
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error('Batch task ordinal must be positive');
  if (typeof seedUrl !== 'string' || !seedUrl.trim()) throw new Error('Batch task seedUrl required');
  return {
    id,
    enabled: true,
    label: `Завдання ${ordinal}`,
    url: seedUrl,
    normalizedUrl: '',
    promptOverride: '',
    status: 'BATCH_PENDING',
    lastCheckedAt: 0,
    lastVerifiedSendAt: 0,
    lastVerifiedFingerprint: '',
    retryAfterAt: Math.max(0, startAt),
    manualReviewReason: '',
    batch: {
      ordinal,
      verifiedMessages: 0,
      phase: 'PRIMARY',
      startedAt: 0,
      completedAt: 0,
      seedUrl,
    },
  };
}

export function isBatchTaskComplete(task) {
  return task?.batch?.phase === 'DONE';
}

export function isBatchSessionComplete(session) {
  if (!session?.batchChatFlow?.enabled) return false;
  return session.taskOrder.length > 0 && session.taskOrder.every(id => isBatchTaskComplete(session.tasksById[id]));
}

export function isBatchTaskActive(task) {
  return Boolean(task?.enabled) && !isBatchTaskComplete(task);
}

export function activeBatchTaskCount(session) {
  return session.taskOrder.filter(id => isBatchTaskActive(session.tasksById[id])).length;
}

export function batchPromptFor(config, task) {
  const count = task?.batch?.verifiedMessages || 0;
  if (count === 0) return config.primaryPrompt;
  if (count <= config.continueCount) return config.continuePrompt;
  if (count === config.continueCount + 1) return config.finalPrompt;
  return null;
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
    task.enabled = false;
    return { completed: true, nextPrompt: null };
  }
  task.batch.phase = nextCount === 0 ? 'PRIMARY' : nextCount <= config.continueCount ? 'CONTINUE' : 'FINAL';
  task.status = 'BATCH_WAITING_NEXT';
  return { completed: false, nextPrompt: batchPromptFor(config, task) };
}

export function buildBatchTasks(config, { idFactory = () => crypto.randomUUID() } = {}) {
  const normalized = validateBatchChatFlow(config);
  if (!normalized.enabled) return [];
  return Array.from({ length: normalized.totalTasks }, (_, index) => createBatchTask({
    id: idFactory(),
    ordinal: index + 1,
    seedUrl: normalized.seedUrl,
    startAt: index * normalized.startIntervalMs,
  }));
}

export const BATCH_CHAT_FLOW_LIMITS = Object.freeze({
  maxConcurrency: MAX_CONCURRENCY,
  maxTotalTasks: MAX_TOTAL_TASKS,
  maxContinueCount: MAX_CONTINUE_COUNT,
  maxStartIntervalMs: MAX_START_INTERVAL_MS,
});
