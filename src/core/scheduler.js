import { RunMode, RunState } from './schema.js';

export function configuredTaskCount(session) {
  const configured = Number(session?.configuredTaskCount);
  return Number.isInteger(configured) && configured > 0 ? configured : (session?.taskOrder?.length || 0);
}

export function isCompactLogicalSession(session) {
  return configuredTaskCount(session) > (session?.taskOrder?.length || 0);
}

export function onePassCompletedCount(session) {
  if (Number.isInteger(session?.onePassCompletedCount) && session.onePassCompletedCount >= 0) return session.onePassCompletedCount;
  return Array.isArray(session?.onePassCompletedTaskIds) ? session.onePassCompletedTaskIds.length : 0;
}

function schedulableTask(session, task) {
  if (!task.enabled || task.manualReviewReason) return false;
  if (session.runMode !== RunMode.ONE_PASS) return true;
  if (isCompactLogicalSession(session)) return onePassCompletedCount(session) < configuredTaskCount(session);
  return !session.onePassCompletedTaskIds.includes(task.id);
}

function eligibleTask(session, task, now) {
  return schedulableTask(session, task) && (task.retryAfterAt || 0) <= now;
}

export function onePassComplete(session) {
  if (session.runMode !== RunMode.ONE_PASS) return false;
  if (isCompactLogicalSession(session)) return onePassCompletedCount(session) >= configuredTaskCount(session);
  return session.taskOrder.every(taskId => {
    const task = session.tasksById[taskId];
    return !task.enabled || Boolean(task.manualReviewReason) || session.onePassCompletedTaskIds.includes(taskId);
  });
}

export function selectNextTask(session, now = Date.now()) {
  if (session.runState !== RunState.RUNNING && session.runState !== RunState.RECOVERING) return { kind: 'IDLE' };
  if (onePassComplete(session)) return { kind: 'COMPLETE' };

  const cooldownAt = session.nextAllowedSendAt > now ? session.nextAllowedSendAt : 0;
  const n = session.taskOrder.length;
  let schedulableCount = 0;
  let earliestRetry = Infinity;
  let eligibleSelection = null;

  for (let offset = 0; offset < n; offset++) {
    const index = (session.currentTaskIndex + offset) % n;
    const task = session.tasksById[session.taskOrder[index]];
    if (!schedulableTask(session, task)) continue;
    schedulableCount += 1;
    if ((task.retryAfterAt || 0) > now) {
      earliestRetry = Math.min(earliestRetry, task.retryAfterAt);
      continue;
    }
    if (!eligibleSelection && eligibleTask(session, task, now)) eligibleSelection = { kind: 'TASK', index, task };
  }

  if (schedulableCount === 0) return { kind: 'IDLE' };
  if (cooldownAt) {
    if (eligibleSelection) return { kind: 'COOLDOWN', wakeAt: cooldownAt };
    if (earliestRetry < Infinity) return { kind: 'COOLDOWN', wakeAt: Math.max(cooldownAt, earliestRetry) };
    return { kind: 'COOLDOWN', wakeAt: cooldownAt };
  }
  if (eligibleSelection) return eligibleSelection;
  if (earliestRetry < Infinity) return { kind: 'WAIT', wakeAt: earliestRetry };
  if (session.runMode === RunMode.ONE_PASS) return { kind: 'COMPLETE' };
  return { kind: 'WAIT', wakeAt: now + session.busyCheckDelayMs };
}

export function advanceAfterBusy(session, taskIndex, now = Date.now()) {
  session.currentTaskIndex = (taskIndex + 1) % session.taskOrder.length;
  session.lastActionAt = now;
  return session;
}

export function advanceAfterVerifiedSend(session, taskIndex, verifiedSendTime) {
  const taskId = session.taskOrder[taskIndex];
  session.currentTaskIndex = (taskIndex + 1) % session.taskOrder.length;
  session.lastSuccessfulSendAt = verifiedSendTime;
  session.successfulSendCount = Math.max(0, Number(session.successfulSendCount || 0)) + 1;
  if (session.runMode === RunMode.ONE_PASS) {
    const priorOnePass = onePassCompletedCount(session);
    session.onePassCompletedCount = Math.min(configuredTaskCount(session), priorOnePass + 1);
  }
  session.completedAt = 0;
  session.lastActionAt = verifiedSendTime;
  session.nextAllowedSendAt = verifiedSendTime + session.minimumSendIntervalMs;
  if (session.runMode === RunMode.ONE_PASS && !isCompactLogicalSession(session) && !session.onePassCompletedTaskIds.includes(taskId)) session.onePassCompletedTaskIds.push(taskId);
  if (session.runMode === RunMode.ONE_PASS && isCompactLogicalSession(session) && session.onePassCompletedCount >= configuredTaskCount(session) && !session.onePassCompletedTaskIds.includes(taskId)) session.onePassCompletedTaskIds.push(taskId);
  return session;
}
