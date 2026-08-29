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

async function seedMasterPausedOperation(repo, phase) {
  await repo.update(state => {
    const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/master-resume-test' });
    const session = createSession({ id: 's1', name: 'Session', tasks: [task], sharedPrompt: 'continue', now: 0 });
    beginOperation(session, {
      operationId: 'op1',
      taskId: task.id,
      promptFingerprint: 'fp1',
      targetUrl: task.url,
      now: 10
    });
    session.operation.phase = phase;
    session.runState = RunState.PAUSED;
    session.pausedByMaster = true;
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
