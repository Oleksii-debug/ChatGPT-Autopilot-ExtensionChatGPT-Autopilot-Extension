import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';
import { beginOperation } from '../../src/core/state-machine.js';
import { StorageRepository } from '../../src/core/storage.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';

function harness() {
  const db = {};
  const chrome = { storage: { local: {
    get: async key => ({ [key]: db[key] }),
    set: async record => Object.assign(db, record)
  } } };
  const repo = new StorageRepository(chrome);
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true });
  return { repo, core };
}

function sessionWithOperation({ sessionId, taskId, url, operationId, fingerprint, phase, runState, pausedByMaster = false }) {
  const task = createTask({ id: taskId, url });
  const session = createSession({ id: sessionId, name: sessionId, tasks: [task], sharedPrompt: 'continue', now: 0 });
  beginOperation(session, {
    operationId,
    taskId: task.id,
    promptFingerprint: fingerprint,
    targetUrl: task.url,
    now: 10
  });
  session.operation.phase = phase;
  session.runState = runState;
  session.pausedByMaster = pausedByMaster;
  return session;
}

async function seedMasterPausedOperation(repo, phase) {
  await repo.update(state => {
    const session = sessionWithOperation({
      sessionId: 's1',
      taskId: 't1',
      url: 'https://chatgpt.com/c/master-resume-test',
      operationId: 'op1',
      fingerprint: 'fp1',
      phase,
      runState: RunState.PAUSED,
      pausedByMaster: true
    });
    state.profile.masterPaused = true;
    state.sessionsById[session.id] = session;
    state.sessionOrder = [session.id];
    return state;
  });
}

test('MASTER_RESUME lifts master pause but keeps MANUAL_REVIEW session quiescent', async () => {
  const { repo, core } = harness();
  await seedMasterPausedOperation(repo, OperationPhase.MANUAL_REVIEW);

  assert.deepEqual(await core.execute(CoreCommand.MASTER_RESUME), { masterPaused: false });
  const { session } = await core.execute(CoreCommand.GET_SESSION, { sessionId: 's1' });
  const { snapshot } = await core.execute(CoreCommand.GET_SNAPSHOT);

  assert.equal(snapshot.profile.masterPaused, false);
  assert.equal(session.runState, RunState.PAUSED);
  assert.equal(session.pausedByMaster, false);
  assert.equal(session.operation.phase, OperationPhase.MANUAL_REVIEW);
  assert.match(session.log.at(-1).message, /remains paused for manual review/i);
});

test('MASTER_RESUME still resumes other unresolved phases into RECOVERING', async () => {
  const { repo, core } = harness();
  await seedMasterPausedOperation(repo, OperationPhase.CHECKING);

  await core.execute(CoreCommand.MASTER_RESUME);
  const { session } = await core.execute(CoreCommand.GET_SESSION, { sessionId: 's1' });

  assert.equal(session.runState, RunState.RECOVERING);
  assert.equal(session.pausedByMaster, false);
  assert.equal(session.operation.phase, OperationPhase.CHECKING);
});

test('MASTER_RESUME keeps a legacy URL-conflicting recovery session paused and preserves evidence', async () => {
  const { repo, core } = harness();
  const sharedUrl = 'https://chatgpt.com/c/legacy-conflict';
  await repo.update(state => {
    const owner = sessionWithOperation({
      sessionId: 'owner',
      taskId: 'owner-task',
      url: sharedUrl,
      operationId: 'owner-op',
      fingerprint: 'owner-fp',
      phase: OperationPhase.AMBIGUOUS,
      runState: RunState.STOPPED
    });
    const candidate = sessionWithOperation({
      sessionId: 'candidate',
      taskId: 'candidate-task',
      url: sharedUrl,
      operationId: 'candidate-op',
      fingerprint: 'candidate-fp',
      phase: OperationPhase.CHECKING,
      runState: RunState.PAUSED,
      pausedByMaster: true
    });
    state.profile.masterPaused = true;
    state.sessionsById[owner.id] = owner;
    state.sessionsById[candidate.id] = candidate;
    state.sessionOrder = [owner.id, candidate.id];
    return state;
  });

  await core.execute(CoreCommand.MASTER_RESUME);
  const { session } = await core.execute(CoreCommand.GET_SESSION, { sessionId: 'candidate' });
  const { session: owner } = await core.execute(CoreCommand.GET_SESSION, { sessionId: 'owner' });

  assert.equal(session.runState, RunState.PAUSED);
  assert.equal(session.pausedByMaster, false);
  assert.equal(session.operation.operationId, 'candidate-op');
  assert.equal(session.operation.promptFingerprint, 'candidate-fp');
  assert.equal(session.operation.phase, OperationPhase.CHECKING);
  assert.match(session.lastError, /another active or unresolved session/i);
  assert.match(session.log.at(-1).message, /remains paused because another active or unresolved session/i);
  assert.equal(owner.runState, RunState.STOPPED);
  assert.equal(owner.operation.operationId, 'owner-op');
  assert.equal(owner.operation.phase, OperationPhase.AMBIGUOUS);
});

test('MASTER_RESUME isolates a legacy URL conflict and still resumes an unrelated session', async () => {
  const { repo, core } = harness();
  const sharedUrl = 'https://chatgpt.com/c/legacy-conflict';
  const safeUrl = 'https://chatgpt.com/c/unrelated-safe';
  await repo.update(state => {
    const owner = sessionWithOperation({
      sessionId: 'owner',
      taskId: 'owner-task',
      url: sharedUrl,
      operationId: 'owner-op',
      fingerprint: 'owner-fp',
      phase: OperationPhase.AMBIGUOUS,
      runState: RunState.STOPPED
    });
    const conflict = sessionWithOperation({
      sessionId: 'conflict',
      taskId: 'conflict-task',
      url: sharedUrl,
      operationId: 'conflict-op',
      fingerprint: 'conflict-fp',
      phase: OperationPhase.CHECKING,
      runState: RunState.PAUSED,
      pausedByMaster: true
    });
    const safe = sessionWithOperation({
      sessionId: 'safe',
      taskId: 'safe-task',
      url: safeUrl,
      operationId: 'safe-op',
      fingerprint: 'safe-fp',
      phase: OperationPhase.CHECKING,
      runState: RunState.PAUSED,
      pausedByMaster: true
    });
    state.profile.masterPaused = true;
    for (const session of [owner, conflict, safe]) state.sessionsById[session.id] = session;
    state.sessionOrder = [owner.id, conflict.id, safe.id];
    return state;
  });

  assert.deepEqual(await core.execute(CoreCommand.MASTER_RESUME), { masterPaused: false });
  const { snapshot } = await core.execute(CoreCommand.GET_SNAPSHOT);
  const conflict = snapshot.sessionsById.conflict;
  const safe = snapshot.sessionsById.safe;

  assert.equal(snapshot.profile.masterPaused, false);
  assert.equal(conflict.runState, RunState.PAUSED);
  assert.equal(conflict.pausedByMaster, false);
  assert.equal(conflict.operation.operationId, 'conflict-op');
  assert.equal(safe.runState, RunState.RECOVERING);
  assert.equal(safe.pausedByMaster, false);
  assert.equal(safe.operation.operationId, 'safe-op');
  assert.equal(safe.operation.phase, OperationPhase.CHECKING);
});

test('MASTER_RESUME reserves a disabled Task unresolved operation target', async () => {
  const { repo, core } = harness();
  const sharedUrl = 'https://chatgpt.com/c/disabled-unresolved-target';
  await repo.update(state => {
    const owner = sessionWithOperation({
      sessionId: 'owner',
      taskId: 'owner-task',
      url: sharedUrl,
      operationId: 'owner-op',
      fingerprint: 'owner-fp',
      phase: OperationPhase.AMBIGUOUS,
      runState: RunState.STOPPED
    });
    const candidate = sessionWithOperation({
      sessionId: 'candidate',
      taskId: 'candidate-task',
      url: sharedUrl,
      operationId: 'candidate-op',
      fingerprint: 'candidate-fp',
      phase: OperationPhase.CHECKING,
      runState: RunState.PAUSED,
      pausedByMaster: true
    });
    candidate.tasksById['candidate-task'].enabled = false;
    state.profile.masterPaused = true;
    state.sessionsById[owner.id] = owner;
    state.sessionsById[candidate.id] = candidate;
    state.sessionOrder = [owner.id, candidate.id];
    return state;
  });

  await core.execute(CoreCommand.MASTER_RESUME);
  const { session } = await core.execute(CoreCommand.GET_SESSION, { sessionId: 'candidate' });

  assert.equal(session.runState, RunState.PAUSED);
  assert.equal(session.pausedByMaster, false);
  assert.equal(session.tasksById['candidate-task'].enabled, false);
  assert.equal(session.operation.operationId, 'candidate-op');
  assert.equal(session.operation.promptFingerprint, 'candidate-fp');
  assert.equal(session.operation.targetUrl, sharedUrl);
  assert.match(session.lastError, /another active or unresolved session/i);
});
