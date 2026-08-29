import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { OperationPhase, RunState } from '../../src/core/schema.js';
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

test('Stop preserves unresolved submission evidence and prevents a new Start', async () => {
  const { command, repository } = harness();
  const session = await createRunnable(command);
  await command('START_SESSION', { sessionId: session.id });
  await repository.update((state) => {
    state.sessionsById[session.id].operation = { operationId: 'operation-1', phase: OperationPhase.SUBMITTING };
  });
  await command('STOP_SESSION', { sessionId: session.id });
  const state = await repository.load();
  assert.equal(state.sessionsById[session.id].operation.phase, OperationPhase.SUBMITTING);
  await assert.rejects(() => command('START_SESSION', { sessionId: session.id }), /Resolve the uncertain/);
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
