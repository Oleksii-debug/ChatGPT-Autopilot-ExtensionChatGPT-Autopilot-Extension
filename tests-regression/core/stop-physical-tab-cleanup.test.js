import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState, TabStrategy } from '../../src/core/schema.js';
import { CoreCommand } from '../../src/shared/protocol.js';

class MemoryRepo {
  constructor(state) { this.state = structuredClone(state); this.queue = Promise.resolve(); }
  async load() { return structuredClone(this.state); }
  update(mutator) {
    const op = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const next = await mutator(draft) || draft;
      next.revision = Number(this.state.revision || 0) + 1;
      this.state = structuredClone(next);
      return structuredClone(next);
    });
    this.queue = op.catch(() => undefined);
    return op;
  }
}

function chromeWithTabs(initial, { failRemove = false } = {}) {
  const tabs = new Map(initial.map(tab => [tab.id, { ...tab }]));
  const removed = [];
  return {
    tabs: {
      async remove(id) {
        if (failRemove) throw new Error('synthetic close failure');
        if (!tabs.has(id)) throw new Error('No tab with id');
        tabs.delete(id);
        removed.push(id);
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error('No tab with id');
        return { ...tabs.get(id) };
      },
    },
    _tabs: tabs,
    _removed: removed,
  };
}

function makeState({ strategy = TabStrategy.OPEN_CLOSE_PER_TASK, ambiguous = false } = {}) {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
  const session = createSession({
    id: 's1', name: 'S1', tasks: [task], sharedPrompt: 'continue',
    tabStrategy: strategy, now: 1,
  });
  session.runState = RunState.RUNNING;
  if (ambiguous) {
    session.operation = {
      operationId: 'op1', sessionId: 's1', taskId: 't1', promptFingerprint: 'sha256:test',
      phase: OperationPhase.AMBIGUOUS, targetUrl: 'https://chatgpt.com/c/generated', launchUrl: 'https://chatgpt.com/',
      createdAt: 10, updatedAt: 20, preSendDeadline: 0, submitStartedAt: 15, verificationDeadline: 100,
    };
    task.status = 'SUBMISSION_UNCERTAIN';
    task.url = 'https://chatgpt.com/c/generated';
    task.normalizedUrl = 'https://chatgpt.com/c/generated';
  }
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

test('explicit Stop physically closes terminal extension-owned open-close tab and removes hint', async () => {
  const state = makeState();
  state.tabHintsByTaskId.t1 = {
    tabId: 41, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK',
    ownedByExtension: true, retirePending: false, boundAt: 1,
  };
  const chromeApi = chromeWithTabs([{ id: 41, url: 'https://chatgpt.com/', status: 'complete' }]);
  const repo = new MemoryRepo(state);
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true, chromeApi });

  const result = await core.execute(CoreCommand.STOP_SESSION, { sessionId: 's1' });
  assert.equal(result.session.runState, RunState.STOPPED);
  assert.deepEqual(chromeApi._removed, [41]);
  assert.equal(chromeApi._tabs.size, 0);
  assert.equal((await repo.load()).tabHintsByTaskId.t1, undefined);
});

test('explicit Stop preserves the exact post-submit ambiguous evidence tab for safe recovery', async () => {
  const state = makeState({ ambiguous: true });
  state.tabHintsByTaskId.t1 = {
    tabId: 42, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK',
    ownedByExtension: true, retirePending: false, boundAt: 1,
  };
  const chromeApi = chromeWithTabs([{ id: 42, url: 'https://chatgpt.com/c/generated', status: 'complete' }]);
  const repo = new MemoryRepo(state);
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true, chromeApi });

  const result = await core.execute(CoreCommand.STOP_SESSION, { sessionId: 's1' });
  assert.equal(result.session.runState, RunState.STOPPED);
  assert.equal(result.session.operation.phase, OperationPhase.AMBIGUOUS);
  assert.deepEqual(chromeApi._removed, []);
  assert.equal(chromeApi._tabs.has(42), true);
  assert.equal((await repo.load()).tabHintsByTaskId.t1.tabId, 42);
});

test('Stop remains successful when Chrome temporarily refuses close and keeps ownership retirePending', async () => {
  const state = makeState();
  state.tabHintsByTaskId.t1 = {
    tabId: 43, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK',
    ownedByExtension: true, retirePending: false, boundAt: 1,
  };
  const chromeApi = chromeWithTabs([{ id: 43, url: 'https://chatgpt.com/', status: 'complete' }], { failRemove: true });
  const repo = new MemoryRepo(state);
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true, chromeApi });

  const result = await core.execute(CoreCommand.STOP_SESSION, { sessionId: 's1' });
  assert.equal(result.session.runState, RunState.STOPPED);
  const after = await repo.load();
  assert.equal(after.tabHintsByTaskId.t1.tabId, 43);
  assert.equal(after.tabHintsByTaskId.t1.retirePending, true);
  assert.equal(after.tabHintsByTaskId.t1.ownedByExtension, true);
});

test('Delete closes owned open-close tab before forgetting the Session', async () => {
  const state = makeState();
  state.sessionsById.s1.runState = RunState.STOPPED;
  state.tabHintsByTaskId.t1 = {
    tabId: 44, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK',
    ownedByExtension: true, retirePending: false, boundAt: 1,
  };
  const chromeApi = chromeWithTabs([{ id: 44, url: 'https://chatgpt.com/', status: 'complete' }]);
  const repo = new MemoryRepo(state);
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true, chromeApi });

  await core.execute(CoreCommand.DELETE_SESSION, { sessionId: 's1' });
  const after = await repo.load();
  assert.equal(after.sessionsById.s1, undefined);
  assert.equal(after.tabHintsByTaskId.t1, undefined);
  assert.deepEqual(chromeApi._removed, [44]);
});

test('Delete refuses to forget Session ownership if an owned tab still exists after close failure', async () => {
  const state = makeState();
  state.sessionsById.s1.runState = RunState.STOPPED;
  state.tabHintsByTaskId.t1 = {
    tabId: 45, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK',
    ownedByExtension: true, retirePending: false, boundAt: 1,
  };
  const chromeApi = chromeWithTabs([{ id: 45, url: 'https://chatgpt.com/', status: 'complete' }], { failRemove: true });
  const repo = new MemoryRepo(state);
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true, chromeApi });

  await assert.rejects(
    () => core.execute(CoreCommand.DELETE_SESSION, { sessionId: 's1' }),
    /Could not close extension-owned ChatGPT tab 45/,
  );
  const after = await repo.load();
  assert.ok(after.sessionsById.s1);
  assert.equal(after.tabHintsByTaskId.t1.tabId, 45);
});


test('UPDATE_SESSION physically retires an owned tab before dropping a changed Task hint', async () => {
  const state = makeState();
  state.sessionsById.s1.runState = RunState.STOPPED;
  state.tabHintsByTaskId.t1 = {
    tabId: 46, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK',
    ownedByExtension: true, retirePending: false, boundAt: 1,
  };
  const chromeApi = chromeWithTabs([{ id: 46, url: 'https://chatgpt.com/', status: 'complete' }]);
  const repo = new MemoryRepo(state);
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true, chromeApi });
  const current = (await core.execute(CoreCommand.GET_SESSION, { sessionId: 's1' })).session;
  const updatedConfig = {
    ...current,
    tasks: current.tasks.map(task => ({ ...task, url: 'https://chatgpt.com/c/changed' })),
  };

  await core.execute(CoreCommand.UPDATE_SESSION, {
    sessionId: 's1', expectedVersion: current.version, config: updatedConfig,
  });

  const after = await repo.load();
  assert.equal(after.tabHintsByTaskId.t1, undefined);
  assert.deepEqual(chromeApi._removed, [46]);
  assert.equal(chromeApi._tabs.size, 0);
});

test('portable-profile replacement physically retires existing owned tabs before clearing ownership', async () => {
  const state = makeState();
  state.sessionsById.s1.runState = RunState.STOPPED;
  state.tabHintsByTaskId.t1 = {
    tabId: 47, sessionId: 's1', normalizedUrl: 'https://chatgpt.com/', kind: 'TASK',
    ownedByExtension: true, retirePending: false, boundAt: 1,
  };
  const chromeApi = chromeWithTabs([{ id: 47, url: 'https://chatgpt.com/', status: 'complete' }]);
  const repo = new MemoryRepo(state);
  const core = new CoreCommandDispatcher(repo, () => 1000, { executionAvailable: true, chromeApi });
  const profile = (await core.execute(CoreCommand.EXPORT_PORTABLE_PROFILE, { sessionIds: ['s1'], profileName: 'test' })).profile;

  await core.execute(CoreCommand.IMPORT_PORTABLE_PROFILE, { profile, confirmAutoStart: false });

  const after = await repo.load();
  assert.ok(after.sessionsById.s1);
  assert.equal(after.tabHintsByTaskId.t1, undefined);
  assert.deepEqual(chromeApi._removed, [47]);
  assert.equal(chromeApi._tabs.size, 0);
});
