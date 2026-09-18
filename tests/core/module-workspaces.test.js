import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, RunState, validateState } from '../../src/core/schema.js';
import { buildBatchTasks, normalizeBatchChatFlow } from '../../src/core/batch-chat-flow.js';
import { configureBatchChatFlow } from '../../src/core/batch-chat-flow-service.js';
import {
  ExecutionModuleId,
  createModuleSessionView,
  ensureSessionModuleState,
} from '../../src/core/module-workspaces.js';
import { ModuleWorkspaceRepository } from '../../src/core/module-repository.js';
import { SessionFunctionId, isSessionFunctionEnabled, setSessionFunctionEnabled } from '../../src/core/session-functions.js';
import { startSession } from '../../src/core/state-machine.js';
import { applyInteractionResult } from '../../src/core/execution.js';
import { InteractionResult } from '../../src/shared/protocol.js';

function makeState() {
  const state = createEmptyState(100);
  const task = createTask({ id: 'standard-1', url: 'https://chatgpt.com/c/standard' });
  const session = createSession({
    id: 's1',
    name: 'Standard + batch',
    tasks: [task],
    sharedPrompt: 'STANDARD',
    minimumSendIntervalMs: 60_000,
    now: 100,
  });
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  state.logs.s1 = [];
  return state;
}

function batchConfig(overrides = {}) {
  return {
    enabled: true,
    seedUrls: ['https://chatgpt.com/c/batch-seed'],
    concurrency: 2,
    totalTasks: 4,
    startIntervalMs: 0,
    primaryPrompt: 'BATCH PRIMARY',
    continuePrompt: 'CONTINUE',
    continueCount: 1,
    finalPrompt: 'FINAL',
    ...overrides,
  };
}

class MemoryRepo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    const next = await mutator(draft) || draft;
    this.state = structuredClone(next);
    return this.load();
  }
}

test('configuring batch preserves the standard Session workspace byte-for-byte at the execution fields', () => {
  const state = makeState();
  const session = state.sessionsById.s1;
  const before = {
    sharedPrompt: session.sharedPrompt,
    taskOrder: structuredClone(session.taskOrder),
    tasksById: structuredClone(session.tasksById),
    currentTaskIndex: session.currentTaskIndex,
    nextAllowedSendAt: session.nextAllowedSendAt,
    operation: session.operation,
    tabStrategy: session.tabStrategy,
    runMode: session.runMode,
  };

  configureBatchChatFlow(state, 's1', batchConfig(), 200);
  const after = state.sessionsById.s1;

  assert.equal(after.sharedPrompt, before.sharedPrompt);
  assert.deepEqual(after.taskOrder, before.taskOrder);
  assert.deepEqual(after.tasksById, before.tasksById);
  assert.equal(after.currentTaskIndex, before.currentTaskIndex);
  assert.equal(after.nextAllowedSendAt, before.nextAllowedSendAt);
  assert.equal(after.operation, before.operation);
  assert.equal(after.tabStrategy, before.tabStrategy);
  assert.equal(after.runMode, before.runMode);

  const batch = after.moduleWorkspaces[ExecutionModuleId.BATCH_CHAT];
  assert.equal(batch.taskOrder.length, 2);
  assert.equal(Object.keys(batch.tasksById).length, 2);
  assert.ok(batch.taskOrder.every(id => batch.tasksById[id].batch));
  assert.doesNotThrow(() => validateState(state));
});

test('module repository mutations cannot leak batch cursor/error state into standard execution state', async () => {
  const state = makeState();
  configureBatchChatFlow(state, 's1', batchConfig(), 200);
  const base = new MemoryRepo(state);
  const batchRepo = new ModuleWorkspaceRepository(base, ExecutionModuleId.BATCH_CHAT);

  await batchRepo.update(draft => {
    const projected = draft.sessionsById.s1;
    projected.currentTaskIndex = 1;
    projected.lastError = 'batch-only-error';
    projected.nextAllowedSendAt = 777;
    return draft;
  });

  const root = await base.load();
  assert.equal(root.sessionsById.s1.currentTaskIndex, 0);
  assert.equal(root.sessionsById.s1.lastError, '');
  assert.equal(root.sessionsById.s1.nextAllowedSendAt, 0);
  assert.equal(root.sessionsById.s1.moduleWorkspaces.batch_chat.currentTaskIndex, 1);
  assert.equal(root.sessionsById.s1.moduleWorkspaces.batch_chat.lastError, 'batch-only-error');
  assert.equal(root.sessionsById.s1.moduleWorkspaces.batch_chat.nextAllowedSendAt, 777);
});

test('legacy root-owned batch state migrates once into batch workspace and disables ordinary lane to prevent duplicate execution', () => {
  const state = makeState();
  const session = state.sessionsById.s1;
  const config = normalizeBatchChatFlow(batchConfig({ concurrency: 1, totalTasks: 1 }));
  const tasks = buildBatchTasks(config, { idFactory: () => 'legacy-batch-1' });

  session.batchChatFlow = { ...config, nextOrdinal: 2, completedTasks: 0 };
  session.taskOrder = tasks.map(task => task.id);
  session.tasksById = Object.fromEntries(tasks.map(task => [task.id, task]));
  session.currentTaskIndex = 0;
  session.runState = RunState.RUNNING;
  delete session.moduleWorkspaces;
  delete session.moduleCoordinator;

  ensureSessionModuleState(session);

  assert.equal(isSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.BATCH_CHAT), true);
  assert.equal(isSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.ORDINARY_SEND), false);
  assert.deepEqual(session.moduleWorkspaces.batch_chat.taskOrder, ['legacy-batch-1']);
  assert.equal(session.moduleWorkspaces.batch_chat.runState, RunState.RUNNING);
});

test('batch verified sends do not consume the standard prompt cadence counter', () => {
  const state = makeState();
  configureBatchChatFlow(state, 's1', batchConfig({ concurrency: 1, totalTasks: 1, continueCount: 0 }), 200);
  const session = state.sessionsById.s1;
  session.cadenceVerifiedSendCount = 7;
  const batch = createModuleSessionView(session, ExecutionModuleId.BATCH_CHAT);
  const taskId = batch.taskOrder[0];
  applyInteractionResult(batch, 0, { status: InteractionResult.SENT_VERIFIED }, { now: 300, promptFingerprint: 'batch-fp' });
  assert.equal(session.cadenceVerifiedSendCount, 7);
  assert.equal(batch.tasksById[taskId].lastVerifiedFingerprint, 'batch-fp');
});

test('starting one container activates both enabled execution modules without sharing their task queues', () => {
  const state = makeState();
  configureBatchChatFlow(state, 's1', batchConfig(), 200);
  const session = state.sessionsById.s1;
  session.activeFunctions = setSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.BATCH_CHAT, true);

  startSession(session, 300);

  const standard = createModuleSessionView(session, ExecutionModuleId.STANDARD_SENDS);
  const batch = createModuleSessionView(session, ExecutionModuleId.BATCH_CHAT);
  assert.equal(session.runState, RunState.RUNNING);
  assert.equal(standard.runState, RunState.RUNNING);
  assert.equal(batch.runState, RunState.RUNNING);
  assert.deepEqual(standard.taskOrder, ['standard-1']);
  assert.equal(batch.taskOrder.length, 2);
  assert.notDeepEqual(batch.taskOrder, standard.taskOrder);
});
