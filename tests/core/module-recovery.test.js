import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { configureBatchChatFlow } from '../../src/core/batch-chat-flow-service.js';
import { ExecutionModuleId, createModuleSessionView } from '../../src/core/module-workspaces.js';
import { SessionFunctionId, setSessionFunctionEnabled } from '../../src/core/session-functions.js';
import { reconcileStateForStartup, computeNextWake } from '../../src/core/recovery.js';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';

function stateWithBatch() {
  const state = createEmptyState(1);
  const standardTask = createTask({ id: 'standard-task', url: 'https://chatgpt.com/c/standard' });
  const session = createSession({
    id: 's1',
    name: 'Recovery isolation',
    tasks: [standardTask],
    sharedPrompt: 'STANDARD',
    retryBackoffMs: 5000,
    now: 1,
  });
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  state.logs.s1 = [];
  configureBatchChatFlow(state, 's1', {
    enabled: true,
    seedUrls: ['https://chatgpt.com/c/batch'],
    concurrency: 1,
    totalTasks: 1,
    startIntervalMs: 0,
    primaryPrompt: 'BATCH',
    continuePrompt: 'continue',
    continueCount: 0,
    finalPrompt: 'final',
  }, 2);
  session.activeFunctions = setSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.BATCH_CHAT, true);
  session.runState = RunState.RUNNING;
  session.moduleWorkspaces.standard_sends.runState = RunState.RUNNING;
  session.moduleWorkspaces.batch_chat.runState = RunState.RUNNING;
  return state;
}

function batchOperation(view, phase = OperationPhase.SUBMITTING) {
  const taskId = view.taskOrder[0];
  const task = view.tasksById[taskId];
  view.operation = {
    operationId: 'batch-op',
    sessionId: 's1',
    taskId,
    promptFingerprint: 'batch-fingerprint',
    promptText: 'BATCH',
    phase,
    targetUrl: task.normalizedUrl,
    createdAt: 10,
    updatedAt: 10,
    preSendDeadline: 0,
    submitStartedAt: phase === OperationPhase.SUBMITTING ? 10 : 0,
    verificationDeadline: 0,
  };
  return taskId;
}

class Repo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    const next = await mutator(draft) || draft;
    next.revision = this.state.revision + 1;
    this.state = structuredClone(next);
    return this.load();
  }
}

function fakeChrome() {
  return {
    alarms: {
      async clear() { return true; },
      async create() {},
    },
  };
}

test('cold-start turns only nested batch SUBMITTING into AMBIGUOUS and leaves standard operation empty', () => {
  const state = stateWithBatch();
  const batch = createModuleSessionView(state.sessionsById.s1, ExecutionModuleId.BATCH_CHAT);
  const batchTaskId = batchOperation(batch, OperationPhase.SUBMITTING);
  batch.tasksById[batchTaskId].retryAfterAt = 7000;

  reconcileStateForStartup(state, 5000);

  assert.equal(state.sessionsById.s1.runState, RunState.RECOVERING);
  assert.equal(state.sessionsById.s1.operation, null);
  assert.equal(state.sessionsById.s1.moduleWorkspaces.batch_chat.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(computeNextWake(state, 5000), 7000);
});

test('batch runtime error schedules retry on batch task without mutating standard task', async () => {
  const state = stateWithBatch();
  const batch = createModuleSessionView(state.sessionsById.s1, ExecutionModuleId.BATCH_CHAT);
  const batchTaskId = batch.taskOrder[0];
  const repo = new Repo(state);

  const executor = {
    async runSessionOnce() {
      const error = new Error('simulated nested batch runtime failure');
      error.autopilotModuleId = ExecutionModuleId.BATCH_CHAT;
      error.autopilotTaskId = batchTaskId;
      throw error;
    },
  };

  await runRuntimeCycle({
    repository: repo,
    chromeApi: fakeChrome(),
    executor,
    executionAvailable: true,
    now: () => 1000,
  });

  const after = await repo.load();
  assert.equal(after.sessionsById.s1.tasksById['standard-task'].status, 'IDLE');
  assert.equal(after.sessionsById.s1.tasksById['standard-task'].retryAfterAt, 0);
  assert.equal(after.sessionsById.s1.moduleWorkspaces.batch_chat.tasksById[batchTaskId].status, 'RETRY_WAIT');
  assert.equal(after.sessionsById.s1.moduleWorkspaces.batch_chat.tasksById[batchTaskId].retryAfterAt, 6000);
  assert.match(after.sessionsById.s1.moduleWorkspaces.batch_chat.lastError, /RUNTIME_FAILURE_UNCLASSIFIED/);
});
