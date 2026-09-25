import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { beginOperation } from '../../src/core/state-machine.js';
import { reconcileStateForStartup } from '../../src/core/recovery.js';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';
import { applyInteractionResult } from '../../src/core/execution.js';

function heldSession({ phase = OperationPhase.MANUAL_REVIEW, submitStartedAt = 0, retryPolicy = 'safe', runState = RunState.PAUSED, pausedByMaster = false } = {}) {
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
  const session = createSession({ id: 's1', name: 'Nika', tasks: [task], sharedPrompt: 'continue', retryBackoffMs: 15000, now: 0 });
  session.retryPolicy = retryPolicy;
  session.urlMode = 'shared';
  session.runState = runState;
  session.pausedByMaster = pausedByMaster;
  beginOperation(session, { operationId: 'op1', taskId: 't1', promptFingerprint: 'fp', targetUrl: task.normalizedUrl, now: 100 });
  session.operation.phase = phase;
  session.operation.submitStartedAt = submitStartedAt;
  task.status = 'MANUAL_REVIEW';
  task.manualReviewReason = 'LEGACY_HOLD';
  return session;
}

test('startup converts legacy safe pre-send manual hold into automatic retry and resumes machine pause', () => {
  const now = 1000;
  const state = createEmptyState(0);
  const session = heldSession({ submitStartedAt: 0 });
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];

  reconcileStateForStartup(state, now);

  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(session.operation.phase, OperationPhase.FAILED_SAFE);
  assert.equal(session.tasksById.t1.manualReviewReason, '');
  assert.equal(session.tasksById.t1.status, 'RETRY_WAIT');
  assert.equal(session.tasksById.t1.retryAfterAt, now + 15000);
});

test('startup converts legacy safe post-submit manual hold into automatic ambiguous recovery', () => {
  const now = 1000;
  const state = createEmptyState(0);
  const session = heldSession({ submitStartedAt: 500 });
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];

  reconcileStateForStartup(state, now);

  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(session.tasksById.t1.manualReviewReason, '');
  assert.equal(session.tasksById.t1.status, 'SUBMISSION_UNCERTAIN');
  assert.ok(session.tasksById.t1.retryAfterAt <= now + 15000);
});

test('startup clears orphaned legacy manualReviewReason in safe mode instead of silently completing one-pass', () => {
  const now = 1000;
  const state = createEmptyState(0);
  const session = heldSession({ submitStartedAt: 0 });
  session.operation = null;
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];

  reconcileStateForStartup(state, now);

  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(session.tasksById.t1.manualReviewReason, '');
  assert.equal(session.tasksById.t1.status, 'RETRY_WAIT');
});

test('manual retry policy preserves an intentional manual-review hold across startup', () => {
  const state = createEmptyState(0);
  const session = heldSession({ retryPolicy: 'manual', submitStartedAt: 500 });
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];

  reconcileStateForStartup(state, 1000);

  assert.equal(session.runState, RunState.PAUSED);
  assert.equal(session.operation.phase, OperationPhase.MANUAL_REVIEW);
  assert.equal(session.tasksById.t1.manualReviewReason, 'LEGACY_HOLD');
});

test('MASTER_RESUME heals a legacy safe manual hold and does not require another click', async () => {
  const db = {};
  const chrome = { storage: { local: {
    get: async key => ({ [key]: db[key] }),
    set: async record => Object.assign(db, record),
  } } };
  const repo = new StorageRepository(chrome);
  await repo.update(state => {
    const session = heldSession({ submitStartedAt: 500, pausedByMaster: true });
    state.profile.masterPaused = true;
    state.sessionsById.s1 = session;
    state.sessionOrder = ['s1'];
    return state;
  });
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true });

  await core.execute(CoreCommand.MASTER_RESUME);
  const { session } = await core.execute(CoreCommand.GET_SESSION, { sessionId: 's1' });

  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(session.status.currentTaskManualReviewReason, '');
});

test('every pre-submit review-like interaction result stays automatic under safe policy', () => {
  for (const status of ['AUTH_REQUIRED', 'UNKNOWN_UI', 'MANUAL_REVIEW_REQUIRED']) {
    const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
    const session = createSession({ id: 's1', name: 's', tasks: [task], sharedPrompt: 'p', retryBackoffMs: 15000, now: 0 });
    session.retryPolicy = 'safe';
    session.urlMode = 'shared';
    session.runState = RunState.RUNNING;
    beginOperation(session, { operationId: 'op1', taskId: 't1', promptFingerprint: 'fp', targetUrl: task.normalizedUrl, now: 1 });
    session.operation.phase = OperationPhase.INSERTING;

    const outcome = applyInteractionResult(session, 0, { status, safeDiagnosticCode: `TEST_${status}` }, { now: 1000 });

    assert.equal(outcome.action, 'AUTO_RETRY', status);
    assert.equal(session.runState, RunState.RUNNING, status);
    assert.equal(task.manualReviewReason, '', status);
    assert.equal(task.status, 'RETRY_WAIT', status);
    assert.equal(session.operation.phase, OperationPhase.FAILED_SAFE, status);
  }
});


test('RESUME_SESSION heals a legacy safe post-submit manual hold without another operator decision', async () => {
  const db = {};
  const chrome = { storage: { local: {
    get: async key => ({ [key]: db[key] }),
    set: async record => Object.assign(db, record),
  } } };
  const repo = new StorageRepository(chrome);
  await repo.update(state => {
    const session = heldSession({ submitStartedAt: 500, pausedByMaster: false });
    state.sessionsById.s1 = session;
    state.sessionOrder = ['s1'];
    return state;
  });
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true });

  const { session } = await core.execute(CoreCommand.RESUME_SESSION, { sessionId: 's1' });

  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(session.operation.phase, OperationPhase.AMBIGUOUS);
  assert.equal(session.status.currentTaskManualReviewReason, '');
  assert.equal(session.tasks.find(task => task.id === 't1').status, 'SUBMISSION_UNCERTAIN');
});

test('RESUME_SESSION preserves an intentional manual-policy post-submit hold', async () => {
  const db = {};
  const chrome = { storage: { local: {
    get: async key => ({ [key]: db[key] }),
    set: async record => Object.assign(db, record),
  } } };
  const repo = new StorageRepository(chrome);
  await repo.update(state => {
    const session = heldSession({ submitStartedAt: 500, retryPolicy: 'manual', pausedByMaster: false });
    state.sessionsById.s1 = session;
    state.sessionOrder = ['s1'];
    return state;
  });
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true });

  await assert.rejects(
    () => core.execute(CoreCommand.RESUME_SESSION, { sessionId: 's1' }),
    /Resolve the uncertain send operation/,
  );
  const { session } = await core.execute(CoreCommand.GET_SESSION, { sessionId: 's1' });
  assert.equal(session.runState, RunState.PAUSED);
  assert.equal(session.operation.phase, OperationPhase.MANUAL_REVIEW);
  assert.equal(session.status.currentTaskManualReviewReason, 'LEGACY_HOLD');
});
