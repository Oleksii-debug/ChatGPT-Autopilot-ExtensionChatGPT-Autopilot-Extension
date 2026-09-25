import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { OperationPhase, RunState } from '../../src/core/schema.js';
import { beginOperation, markSubmitting } from '../../src/core/state-machine.js';
import { StorageRepository } from '../../src/core/storage.js';

function harness() {
  const db = {};
  const chromeApi = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(db[key]) }; },
        async set(record) { Object.assign(db, structuredClone(record)); },
      },
    },
  };
  const repository = new StorageRepository(chromeApi);
  let clock = 10_000;
  const dispatcher = new CoreCommandDispatcher(repository, () => ++clock);
  return { repository, command: (name, payload = {}) => dispatcher.execute(name, payload) };
}

function blankConfig(id = 'session-1', taskId = 'task-1') {
  return {
    id,
    version: 0,
    name: 'Session one',
    promptMode: 'shared',
    sharedPrompt: '',
    defaultUniquePrompt: '',
    runMode: 'continuous',
    tasks: [{ id: taskId, enabled: true, label: '', url: '', promptOverride: '' }],
    minimumSendIntervalMinutes: 2,
    preSendDelaySeconds: 5,
    busyCheckDelaySeconds: 2,
    retryBackoffSeconds: 30,
    retryPolicy: 'safe',
    busyChatBehavior: 'skip-next',
    tabStrategy: 'keep-open',
  };
}

async function createRunnable(command, id = 'session-1', taskId = 'task-1', url = 'https://chatgpt.com/c/one') {
  const created = await command('CREATE_SESSION', { config: blankConfig(id, taskId) });
  const config = created.session;
  config.sharedPrompt = 'Continue safely.';
  config.tasks[0].url = url;
  return (await command('UPDATE_SESSION', {
    sessionId: id,
    expectedVersion: config.version,
    config,
  })).session;
}

test('canonical dispatcher persists editable drafts and per-session versions', async () => {
  const { command } = harness();
  const created = await command('CREATE_SESSION', { config: blankConfig() });
  assert.equal(created.session.version, 1);
  assert.equal(created.session.tasks[0].url, '');
  created.session.sharedPrompt = 'Продовжуй без дублювання.';
  created.session.tasks[0].url = 'https://www.chatgpt.com/c/abc?temporary=1#fragment';
  const saved = await command('UPDATE_SESSION', {
    sessionId: created.session.id,
    expectedVersion: created.session.version,
    config: created.session,
  });
  assert.equal(saved.session.version, 2);
  assert.equal((await command('GET_SESSION', { sessionId: 'session-1' })).session.sharedPrompt, 'Продовжуй без дублювання.');
});

test('stale configuration writes fail closed without overwriting the current session', async () => {
  const { command } = harness();
  const session = await createRunnable(command);
  const stale = structuredClone(session);
  stale.name = 'Stale overwrite';
  await assert.rejects(() => command('UPDATE_SESSION', {
    sessionId: session.id,
    expectedVersion: session.version - 1,
    config: stale,
  }), /changed in another view/);
  assert.equal((await command('GET_SESSION', { sessionId: session.id })).session.name, 'Session one');
});

test('Start, Pause, Resume and Stop operate on durable Core state', async () => {
  const { command } = harness();
  const session = await createRunnable(command);
  assert.equal((await command('START_SESSION', { sessionId: session.id })).session.runState, RunState.RUNNING);
  assert.equal((await command('PAUSE_SESSION', { sessionId: session.id })).session.runState, RunState.PAUSED);
  assert.equal((await command('RESUME_SESSION', { sessionId: session.id })).session.runState, RunState.RUNNING);
  assert.equal((await command('STOP_SESSION', { sessionId: session.id })).session.runState, RunState.STOPPED);
});

test('active sessions cannot own the same normalized conversation URL', async () => {
  const { command } = harness();
  const first = await createRunnable(command, 'session-1', 'task-1', 'https://chatgpt.com/c/shared');
  const second = await createRunnable(command, 'session-2', 'task-2', 'https://www.chatgpt.com/c/shared?x=1');
  await command('START_SESSION', { sessionId: first.id });
  await assert.rejects(() => command('START_SESSION', { sessionId: second.id }), /already owns/);
});

test('stopped unresolved operation reserves its exact conversation across Session identities', async () => {
  const { command, repository } = harness();
  const first = await createRunnable(command, 'session-1', 'task-1', 'https://chatgpt.com/c/uncertain-owner');
  const second = await createRunnable(command, 'session-2', 'task-2', 'https://www.chatgpt.com/c/uncertain-owner?copy=1');
  const unrelated = await createRunnable(command, 'session-3', 'task-3', 'https://chatgpt.com/c/unrelated');

  await repository.update((state) => {
    const live = state.sessionsById[first.id];
    const taskId = live.taskOrder[0];
    const task = live.tasksById[taskId];
    beginOperation(live, {
      operationId: 'operation-reserved',
      taskId,
      promptFingerprint: 'fingerprint-reserved',
      targetUrl: task.normalizedUrl,
      now: 10_100,
    });
    live.operation.generation = state.revision + 1;
    live.operation.promptText = 'Continue safely.';
    markSubmitting(live, 10_101);
    live.operation.phase = OperationPhase.AMBIGUOUS;
    task.status = 'SUBMISSION_UNCERTAIN';
    task.retryAfterAt = 40_000;
  });

  await assert.rejects(
    () => command('START_SESSION', { sessionId: second.id }),
    /active or unresolved session already owns/,
  );
  assert.equal((await command('GET_SESSION', { sessionId: second.id })).session.runState, RunState.STOPPED);

  const started = await command('START_SESSION', { sessionId: unrelated.id });
  assert.equal(started.session.runState, RunState.RUNNING, 'only the exact unresolved operation conversation is reserved');
});

test('master pause and resume affect only sessions that were active', async () => {
  const { command } = harness();
  const first = await createRunnable(command, 'session-1', 'task-1', 'https://chatgpt.com/c/one');
  await createRunnable(command, 'session-2', 'task-2', 'https://chatgpt.com/c/two');
  await command('START_SESSION', { sessionId: first.id });
  await command('MASTER_PAUSE');
  assert.equal((await command('GET_SESSION', { sessionId: 'session-1' })).session.runState, RunState.PAUSED);
  assert.equal((await command('GET_SESSION', { sessionId: 'session-2' })).session.runState, RunState.STOPPED);
  await command('MASTER_RESUME');
  assert.equal((await command('GET_SESSION', { sessionId: 'session-1' })).session.runState, RunState.RUNNING);
  assert.equal((await command('GET_SESSION', { sessionId: 'session-2' })).session.runState, RunState.STOPPED);
});

test('Stop preserves unresolved submission evidence and safe Start resumes it without discarding provenance', async () => {
  const { command, repository } = harness();
  const session = await createRunnable(command);
  await command('START_SESSION', { sessionId: session.id });
  await repository.update((state) => {
    const live = state.sessionsById[session.id];
    const taskId = live.taskOrder[live.currentTaskIndex];
    const task = live.tasksById[taskId];
    beginOperation(live, {
      operationId: 'operation-1',
      taskId,
      promptFingerprint: 'fingerprint-1',
      targetUrl: task.normalizedUrl,
      now: 10_100,
    });
    live.operation.generation = state.revision + 1;
    live.operation.promptText = 'Continue safely.';
    markSubmitting(live, 10_101);
  });
  await command('STOP_SESSION', { sessionId: session.id });
  const state = await repository.load();
  assert.equal(state.sessionsById[session.id].operation.phase, OperationPhase.SUBMITTING);
  const restarted = await command('START_SESSION', { sessionId: session.id });
  assert.equal(restarted.session.runState, RunState.RECOVERING);
  assert.equal(restarted.session.operation.operationId, 'operation-1');
  assert.equal(restarted.session.operation.phase, OperationPhase.AMBIGUOUS);
});


test('explicit Start after Pause continues the same Session without resetting progress', async () => {
  const { command, repository } = harness();
  const session = await createRunnable(command);
  await command('START_SESSION', { sessionId: session.id });
  await repository.update((state) => {
    const live = state.sessionsById[session.id];
    live.successfulSendCount = 7;
    live.lastSuccessfulSendAt = 12_345;
  });
  const paused = await command('PAUSE_SESSION', { sessionId: session.id });
  assert.equal(paused.session.runState, RunState.PAUSED);
  assert.equal(paused.session.actionAvailability.start, true);

  const continued = await command('START_SESSION', { sessionId: session.id });
  assert.equal(continued.session.runState, RunState.RUNNING);
  assert.equal(continued.session.successfulSendCount, 7);
  assert.equal(continued.session.lastSuccessfulSendAt, 12_345);
});

test('explicit Resume after Stop continues an ordinary Session instead of rejecting STOPPED state', async () => {
  const { command } = harness();
  const session = await createRunnable(command);
  await command('START_SESSION', { sessionId: session.id });
  await command('STOP_SESSION', { sessionId: session.id });
  const stopped = await command('GET_SESSION', { sessionId: session.id });
  assert.equal(stopped.session.runState, RunState.STOPPED);
  assert.equal(stopped.session.actionAvailability.resume, true);

  const resumed = await command('RESUME_SESSION', { sessionId: session.id });
  assert.equal(resumed.session.runState, RunState.RUNNING);
});

test('explicit Resume after Stop preserves unresolved submit evidence and enters recovery', async () => {
  const { command, repository } = harness();
  const session = await createRunnable(command);
  await command('START_SESSION', { sessionId: session.id });
  await repository.update((state) => {
    const live = state.sessionsById[session.id];
    const taskId = live.taskOrder[live.currentTaskIndex];
    const task = live.tasksById[taskId];
    beginOperation(live, {
      operationId: 'resume-operation-1',
      taskId,
      promptFingerprint: 'resume-fingerprint-1',
      targetUrl: task.normalizedUrl,
      now: 20_100,
    });
    live.operation.generation = state.revision + 1;
    live.operation.promptText = 'Continue safely after Stop.';
    markSubmitting(live, 20_101);
  });
  await command('STOP_SESSION', { sessionId: session.id });

  const resumed = await command('RESUME_SESSION', { sessionId: session.id });
  assert.equal(resumed.session.runState, RunState.RECOVERING);
  assert.equal(resumed.session.operation.operationId, 'resume-operation-1');
  assert.equal(resumed.session.operation.phase, OperationPhase.AMBIGUOUS);
});

test('repository serializes concurrent updates and prevents lost revisions', async () => {
  const { repository } = harness();
  const first = repository.update(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.profile.first = true;
  });
  const second = repository.update((state) => { state.profile.second = true; });
  await Promise.all([first, second]);
  const state = await repository.load();
  assert.equal(state.profile.first, true);
  assert.equal(state.profile.second, true);
  assert.equal(state.revision, 2);
});

test('explicit Start clears master pause without resuming other paused sessions', async () => {
  const { command, repository } = harness();
  const first = await createRunnable(command, 'session-1', 'task-1', 'https://chatgpt.com/c/one');
  const second = await createRunnable(command, 'session-2', 'task-2', 'https://chatgpt.com/c/two');
  await command('START_SESSION', { sessionId: first.id });
  await command('MASTER_PAUSE');

  const started = await command('START_SESSION', { sessionId: second.id });
  assert.equal(started.session.runState, RunState.RUNNING);
  const state = await repository.load();
  assert.equal(state.profile.masterPaused, false);
  assert.equal(state.sessionsById[first.id].runState, RunState.PAUSED, 'other master-paused session must stay paused');
  assert.equal(state.sessionsById[first.id].pausedByMaster, false, 'master ownership flag must be cleared when master pause ends');
  assert.equal(state.sessionsById[second.id].runState, RunState.RUNNING);
});

test('explicit Resume clears master pause and resumes only the selected session', async () => {
  const { command, repository } = harness();
  const first = await createRunnable(command, 'session-1', 'task-1', 'https://chatgpt.com/c/one');
  const second = await createRunnable(command, 'session-2', 'task-2', 'https://chatgpt.com/c/two');
  await command('START_SESSION', { sessionId: first.id });
  await command('START_SESSION', { sessionId: second.id });
  await command('MASTER_PAUSE');

  const resumed = await command('RESUME_SESSION', { sessionId: first.id });
  assert.equal(resumed.session.runState, RunState.RUNNING);
  const state = await repository.load();
  assert.equal(state.profile.masterPaused, false);
  assert.equal(state.sessionsById[first.id].runState, RunState.RUNNING);
  assert.equal(state.sessionsById[second.id].runState, RunState.PAUSED, 'other session must not be silently resumed');
  assert.equal(state.sessionsById[second.id].pausedByMaster, false);
});

test('safe paused session can be deleted without redundant Stop', async () => {
  const { command } = harness();
  const session = await createRunnable(command);
  await command('START_SESSION', { sessionId: session.id });
  await command('PAUSE_SESSION', { sessionId: session.id });
  await command('DELETE_SESSION', { sessionId: session.id });
  await assert.rejects(() => command('GET_SESSION', { sessionId: session.id }), /Session not found/);
});

test('delete fails closed while active or paused with unfinished work, but explicit Stop permits discard', async () => {
  const { command, repository } = harness();
  const active = await createRunnable(command, 'session-active', 'task-active', 'https://chatgpt.com/c/active');
  await command('START_SESSION', { sessionId: active.id });
  await assert.rejects(() => command('DELETE_SESSION', { sessionId: active.id }), /Pause or stop/);

  const unresolved = await createRunnable(command, 'session-unresolved', 'task-unresolved', 'https://chatgpt.com/c/unresolved');
  await repository.update((state) => {
    const live = state.sessionsById[unresolved.id];
    const taskId = live.taskOrder[0];
    beginOperation(live, {
      operationId: 'op-delete-hold',
      taskId,
      promptFingerprint: 'fp-delete-hold',
      targetUrl: live.tasksById[taskId].normalizedUrl,
      now: 20_000,
    });
    live.operation.generation = 1;
    live.operation.promptText = 'Continue safely.';
    markSubmitting(live, 20_001);
    live.operation.phase = OperationPhase.AMBIGUOUS;
    live.runState = RunState.PAUSED;
    state.sendArbiter.lease = { ownerSessionId: live.id, operationId: live.operation.operationId, acquiredAt: 20_001, expiresAt: 50_001 };
  });
  await assert.rejects(() => command('DELETE_SESSION', { sessionId: unresolved.id }), /Stop the session before deleting unfinished work/);

  await command('STOP_SESSION', { sessionId: unresolved.id });
  await command('DELETE_SESSION', { sessionId: unresolved.id });
  await assert.rejects(() => command('GET_SESSION', { sessionId: unresolved.id }), /Session not found/);
  const state = await repository.load();
  assert.equal(state.sendArbiter.lease, null, 'deleting a stopped unresolved session releases its own send lease');
});

test('parallel Sessions may share a ChatGPT launch surface while concrete conversation URLs stay exclusive', async () => {
  const { command } = harness();
  const first = await createRunnable(command, 'launch-1', 'launch-task-1', 'https://chatgpt.com/');
  const second = await createRunnable(command, 'launch-2', 'launch-task-2', 'https://chatgpt.com/');
  const gptFirst = await createRunnable(command, 'gpt-launch-1', 'gpt-task-1', 'https://chatgpt.com/g/example-gpt');
  const gptSecond = await createRunnable(command, 'gpt-launch-2', 'gpt-task-2', 'https://chatgpt.com/g/example-gpt');

  assert.equal((await command('START_SESSION', { sessionId: first.id })).session.runState, RunState.RUNNING);
  assert.equal((await command('START_SESSION', { sessionId: second.id })).session.runState, RunState.RUNNING);
  assert.equal((await command('START_SESSION', { sessionId: gptFirst.id })).session.runState, RunState.RUNNING);
  assert.equal((await command('START_SESSION', { sessionId: gptSecond.id })).session.runState, RunState.RUNNING);
});
