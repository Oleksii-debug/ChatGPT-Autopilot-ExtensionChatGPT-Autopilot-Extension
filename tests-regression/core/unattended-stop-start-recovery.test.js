import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunMode, RunState } from '../../src/core/schema.js';
import { beginOperation, markSubmitting } from '../../src/core/state-machine.js';

function memoryChrome() {
  const db = {};
  return { storage: { local: {
    get: async key => ({ [key]: db[key] }),
    set: async record => Object.assign(db, record),
  } } };
}

async function setup({ retryPolicy = 'safe', phase = OperationPhase.AMBIGUOUS, completed = ['t1'] } = {}) {
  const repo = new StorageRepository(memoryChrome());
  const state = createEmptyState(0);
  const tasks = [
    createTask({ id: 't1', url: 'https://chatgpt.com/c/one' }),
    createTask({ id: 't2', url: 'https://chatgpt.com/c/two' }),
    createTask({ id: 't3', url: 'https://chatgpt.com/c/three' }),
  ];
  const session = createSession({ id: 's1', name: 'recoverable', tasks, sharedPrompt: 'continue', runMode: RunMode.ONE_PASS, now: 0 });
  session.retryPolicy = retryPolicy;
  session.runState = RunState.STOPPED;
  session.currentTaskIndex = 1;
  session.onePassCompletedTaskIds = [...completed];
  beginOperation(session, { operationId: 'op2', taskId: 't2', promptFingerprint: 'fp', targetUrl: tasks[1].normalizedUrl, now: 100 });
  if (phase === OperationPhase.SUBMITTING) markSubmitting(session, 200);
  else {
    session.operation.phase = phase;
    session.operation.updatedAt = 200;
    if (phase === OperationPhase.AMBIGUOUS) {
      session.operation.submitStartedAt = 150;
      tasks[1].status = 'SUBMISSION_UNCERTAIN';
    }
  }
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  await repo.save(state);
  return { repo, core: new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true }) };
}

test('safe Stop/Start resumes an ambiguous one-pass operation without resetting completed cycles', async () => {
  const { repo, core } = await setup();
  const started = (await core.execute(CoreCommand.START_SESSION, { sessionId: 's1' })).session;
  assert.equal(started.runState, RunState.RECOVERING);
  assert.equal(started.operation.operationId, 'op2');
  assert.equal(started.operation.phase, OperationPhase.AMBIGUOUS);
  assert.deepEqual(started.onePassCompletedTaskIds, ['t1']);
  assert.equal(started.currentTaskIndex, 1);
  assert.equal(started.status.currentTaskStatus, 'SUBMISSION_UNCERTAIN');

  const persisted = (await repo.load()).sessionsById.s1;
  assert.deepEqual(persisted.onePassCompletedTaskIds, ['t1']);
});

test('safe Stop/Start converts persisted SUBMITTING into ambiguous recovery in the same runtime', async () => {
  const { core } = await setup({ phase: OperationPhase.SUBMITTING });
  const started = (await core.execute(CoreCommand.START_SESSION, { sessionId: 's1' })).session;
  assert.equal(started.runState, RunState.RECOVERING);
  assert.equal(started.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(started.operation.operationId, 'op2');
  assert.equal(started.tasks.find(t => t.id === 't2').status, 'SUBMISSION_UNCERTAIN');
  assert.deepEqual(started.onePassCompletedTaskIds, ['t1']);
});

test('manual Stop/Start remains fail-closed for an unresolved post-submit operation', async () => {
  const { core } = await setup({ retryPolicy: 'manual' });
  await assert.rejects(
    () => core.execute(CoreCommand.START_SESSION, { sessionId: 's1' }),
    /Resolve the uncertain send operation/,
  );
  const { session } = await core.execute(CoreCommand.GET_SESSION, { sessionId: 's1' });
  assert.equal(session.runState, RunState.STOPPED);
  assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
  assert.deepEqual(session.onePassCompletedTaskIds, ['t1']);
});

test('fresh safe one-pass Start still intentionally resets a previously completed pass', async () => {
  const { repo, core } = await setup({ phase: OperationPhase.FAILED_SAFE, completed: ['t1', 't2', 't3'] });
  await repo.update(draft => { draft.sessionsById.s1.operation = null; return draft; });
  const started = (await core.execute(CoreCommand.START_SESSION, { sessionId: 's1' })).session;
  assert.equal(started.runState, RunState.RUNNING);
  assert.deepEqual(started.onePassCompletedTaskIds, []);
});

test('safe stopped legacy post-submit manual hold self-heals into recovery on explicit Start', async () => {
  const { repo, core } = await setup({ phase: OperationPhase.MANUAL_REVIEW });
  await repo.update(draft => {
    const session = draft.sessionsById.s1;
    session.operation.submitStartedAt = 150;
    session.tasksById.t2.status = 'MANUAL_REVIEW';
    session.tasksById.t2.manualReviewReason = 'LEGACY_MACHINE_HOLD';
    return draft;
  });
  const started = (await core.execute(CoreCommand.START_SESSION, { sessionId: 's1' })).session;
  assert.equal(started.runState, RunState.RECOVERING);
  assert.equal(started.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(started.status.currentTaskManualReviewReason, '');
  assert.deepEqual(started.onePassCompletedTaskIds, ['t1']);
});


test('stopped partial one-pass Start continues progress instead of resetting completed tasks', async () => {
  const { repo, core } = await setup({ phase: OperationPhase.FAILED_SAFE, completed: ['t1'] });
  await repo.update(draft => {
    const session = draft.sessionsById.s1;
    session.operation = null;
    session.successfulSendCount = 1;
    session.currentTaskIndex = 1;
    return draft;
  });
  const started = (await core.execute(CoreCommand.START_SESSION, { sessionId: 's1' })).session;
  assert.equal(started.runState, RunState.RUNNING);
  assert.deepEqual(started.onePassCompletedTaskIds, ['t1']);
  assert.equal(started.successfulSendCount, 1);
  assert.equal(started.currentTaskIndex, 1);
});

test('Stop before physical Send cancels pre-submit operation so Start does not enter phantom recovery', async () => {
  const { repo, core } = await setup({ phase: OperationPhase.PRE_SEND_WAIT, completed: ['t1'] });
  await repo.update(draft => {
    const session = draft.sessionsById.s1;
    session.runState = RunState.RUNNING;
    session.operation.submitStartedAt = 0;
    session.tasksById.t2.status = 'INSERTED_NOT_SENT';
    return draft;
  });
  const stopped = (await core.execute(CoreCommand.STOP_SESSION, { sessionId: 's1' })).session;
  assert.equal(stopped.runState, RunState.STOPPED);
  assert.equal(stopped.operation, null);
  const started = (await core.execute(CoreCommand.START_SESSION, { sessionId: 's1' })).session;
  assert.equal(started.runState, RunState.RUNNING);
  assert.deepEqual(started.onePassCompletedTaskIds, ['t1']);
});
