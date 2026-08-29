import { reconcileAlarm, reconcileStateForStartup, suspendActiveSessionsWhenExecutionUnavailable } from './recovery.js';
import { RunState } from './schema.js';

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);
const PROFILE_BUSY_MESSAGE = 'Profile send arbiter is busy';
const RUNTIME_RETRY_MESSAGE = 'Automatic execution temporarily unavailable; retry scheduled.';

function orderedSessionIds(state) {
  const seen = new Set();
  const ids = [];
  for (const id of state.sessionOrder || []) {
    if (!seen.has(id) && state.sessionsById?.[id]) {
      ids.push(id);
      seen.add(id);
    }
  }
  for (const id of Object.keys(state.sessionsById || {})) {
    if (!seen.has(id)) ids.push(id);
  }
  return ids;
}

async function prepareStartupState(repository, executionAvailable, now) {
  return repository.update(draft => {
    reconcileStateForStartup(draft, now());
    if (!executionAvailable) suspendActiveSessionsWhenExecutionUnavailable(draft, now());
    return draft;
  });
}

export async function reconcileRuntimeColdStart({
  repository,
  chromeApi,
  executionAvailable = false,
  now = () => Date.now(),
}) {
  if (!repository || !chromeApi) throw new Error('Runtime cold-start dependencies are required');
  const state = await prepareStartupState(repository, executionAvailable, now);
  const wakeAt = await reconcileAlarm(chromeApi, state, now());
  return { state, wakeAt };
}

async function persistRuntimeFailure(repository, sessionId, now) {
  await repository.update(draft => {
    const session = draft.sessionsById?.[sessionId];
    if (!session || !ACTIVE_STATES.has(session.runState)) return draft;
    const retryAt = now + Math.max(1000, session.retryBackoffMs || 30000);
    const taskId = session.operation?.taskId;
    if (taskId && session.tasksById?.[taskId]) {
      session.tasksById[taskId].retryAfterAt = Math.max(
        session.tasksById[taskId].retryAfterAt || 0,
        retryAt,
      );
    } else {
      session.nextAllowedSendAt = Math.max(session.nextAllowedSendAt || 0, retryAt);
    }
    session.lastError = RUNTIME_RETRY_MESSAGE;
    session.lastActionAt = now;
    session.updatedAt = now;
    return draft;
  });
}

export async function runRuntimeCycle({
  repository,
  chromeApi,
  executor,
  startup = false,
  executionAvailable = false,
  now = () => Date.now(),
}) {
  if (!repository || !chromeApi || !executor) throw new Error('Runtime dependencies are required');

  const state = startup
    ? await prepareStartupState(repository, executionAvailable, now)
    : await repository.load();

  const outcomes = [];
  if (executionAvailable) {
    for (const sessionId of orderedSessionIds(state)) {
      const live = await repository.load();
      const session = live.sessionsById?.[sessionId];
      if (!session || !ACTIVE_STATES.has(session.runState)) continue;
      try {
        outcomes.push({ sessionId, result: await executor.runSessionOnce(sessionId) });
      } catch (error) {
        const message = error?.message || '';
        if (message === PROFILE_BUSY_MESSAGE) {
          outcomes.push({ sessionId, result: { kind: 'PROFILE_BUSY' } });
          continue;
        }
        await persistRuntimeFailure(repository, sessionId, now());
        outcomes.push({ sessionId, result: { kind: 'TEMPORARY_RUNTIME_ERROR' } });
      }
    }
  }

  const finalState = await repository.load();
  const wakeAt = await reconcileAlarm(chromeApi, finalState, now());
  return { state: finalState, outcomes, wakeAt };
}

export const RuntimeExecutionConstants = Object.freeze({
  RUNTIME_RETRY_MESSAGE,
});
