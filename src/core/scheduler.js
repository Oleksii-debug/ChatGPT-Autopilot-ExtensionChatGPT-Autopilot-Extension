import { RunMode, RunState } from './schema.js';

function eligibleTask(session, task, now) {
  return task.enabled && !task.manualReviewReason && (task.retryAfterAt || 0) <= now && !(session.runMode === RunMode.ONE_PASS && session.onePassCompletedTaskIds.includes(task.id));
}

function onePassComplete(session) {
  if (session.runMode !== RunMode.ONE_PASS) return false;
  return session.taskOrder.every(taskId => {
    const task = session.tasksById[taskId];
    return !task.enabled || Boolean(task.manualReviewReason) || session.onePassCompletedTaskIds.includes(taskId);
  });
}

export function selectNextTask(session, now = Date.now()) {
  if (session.runState !== RunState.RUNNING && session.runState !== RunState.RECOVERING) return { kind: 'IDLE' };
  if (onePassComplete(session)) return { kind: 'COMPLETE' };
  if (session.nextAllowedSendAt > now) return { kind: 'COOLDOWN', wakeAt: session.nextAllowedSendAt };
  const n = session.taskOrder.length;
  let earliestRetry = Infinity;
  for (let offset = 0; offset < n; offset++) {
    const index = (session.currentTaskIndex + offset) % n;
    const task = session.tasksById[session.taskOrder[index]];
    if ((task.retryAfterAt || 0) > now) earliestRetry = Math.min(earliestRetry, task.retryAfterAt);
    if (eligibleTask(session, task, now)) return { kind: 'TASK', index, task };
  }
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
  session.lastActionAt = verifiedSendTime;
  session.nextAllowedSendAt = verifiedSendTime + session.minimumSendIntervalMs;
  if (session.runMode === RunMode.ONE_PASS && !session.onePassCompletedTaskIds.includes(taskId)) session.onePassCompletedTaskIds.push(taskId);
  return session;
}
