import test from 'node:test';
import assert from 'node:assert/strict';

import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
import {
  createEmptyState,
  createSession,
  createTask,
  OperationPhase,
  RunState,
  STORAGE_KEY,
} from '../../src/core/schema.js';
import { beginOperation } from '../../src/core/state-machine.js';
import { StorageRepository } from '../../src/core/storage.js';
import { InteractionResult } from '../../src/shared/protocol.js';

function makeDueSession(id, now) {
  const task = createTask({ id: `${id}-t1`, url: `https://chatgpt.com/c/${id}` });
  const session = createSession({
    id,
    name: id,
    tasks: [task],
    sharedPrompt: `prompt-${id}`,
    minimumSendIntervalMs: 120_000,
    preSendDelayMs: 1_000,
    busyCheckDelayMs: 5_000,
    retryBackoffMs: 30_000,
    now,
  });
  session.runState = RunState.RUNNING;
  const operationId = `op-${id}`;
  beginOperation(session, {
    operationId,
    taskId: task.id,
    promptFingerprint: `fp-${id}`,
    targetUrl: task.normalizedUrl,
    now,
  });
  session.operation.phase = OperationPhase.PRE_SEND_WAIT;
  session.operation.preSendDeadline = now;
  session.operation.promptText = session.sharedPrompt;
  session.operation.generation = 1;
  return session;
}

function makeState(now) {
  const state = createEmptyState(now);
  for (let index = 1; index <= 5; index += 1) {
    const session = makeDueSession(`p${index}`, now);
    state.sessionsById[session.id] = session;
    state.sessionOrder.push(session.id);
  }
  return state;
}

function fakeChrome(seedState) {
  let stored = { [STORAGE_KEY]: structuredClone(seedState) };
  let nextTabId = 100;
  const tabs = new Map();
  const alarmCalls = [];

  return {
    alarmCalls,
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(stored[key]) };
        },
        async set(record) {
          stored = { ...stored, ...structuredClone(record) };
        },
      },
    },
    tabs: {
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return structuredClone(tab);
      },
      async query() {
        return [...tabs.values()].map(tab => structuredClone(tab));
      },
      async create({ url }) {
        const tab = { id: nextTabId += 1, url };
        tabs.set(tab.id, tab);
        return structuredClone(tab);
      },
    },
    alarms: {
      async clear(name) {
        alarmCalls.push(['clear', name]);
        return true;
      },
      async create(name, info) {
        alarmCalls.push(['create', name, info.when]);
      },
    },
  };
}

test('five due Sessions drain fairly one-per-profile-gap across real runtime cycles', async () => {
  let now = 100_000;
  const chrome = fakeChrome(makeState(now));
  const repository = new StorageRepository(chrome);
  const submitted = [];
  const transport = {
    async execute(_tabId, request) {
      if (request.mode === 'PREPARE_SEND') return { status: InteractionResult.READY };
      if (request.mode === 'SUBMIT_EXISTING') {
        submitted.push(request.taskId.split('-t1')[0]);
        return { status: InteractionResult.SENT_VERIFIED };
      }
      throw new Error(`Unexpected mode: ${request.mode}`);
    },
  };
  const executor = new AutomaticSessionExecutor(repository, chrome, transport, {
    now: () => now,
    profileGapMs: 1_000,
  });

  const expectedWake = [101_000, 102_000, 103_000, 104_000, 220_000];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const result = await runRuntimeCycle({
      repository,
      chromeApi: chrome,
      executor,
      executionAvailable: true,
      now: () => now,
    });

    assert.deepEqual(submitted, Array.from({ length: cycle + 1 }, (_, index) => `p${index + 1}`));
    assert.equal(result.wakeAt, expectedWake[cycle]);
    assert.equal(result.outcomes.length, 5);

    const sentOutcome = result.outcomes[cycle];
    assert.equal(sentOutcome.sessionId, `p${cycle + 1}`);
    assert.equal(sentOutcome.result.kind, 'SENT');
    for (const later of result.outcomes.slice(cycle + 1)) {
      assert.equal(later.result.kind, 'PROFILE_BUSY');
    }

    if (cycle < 4) now += 1_000;
  }

  assert.deepEqual(submitted, ['p1', 'p2', 'p3', 'p4', 'p5']);
  const finalState = await repository.load();
  for (let index = 0; index < 5; index += 1) {
    const id = `p${index + 1}`;
    const sentAt = 100_000 + index * 1_000;
    const session = finalState.sessionsById[id];
    assert.equal(session.lastSuccessfulSendAt, sentAt);
    assert.equal(session.nextAllowedSendAt, sentAt + 120_000);
    assert.equal(session.operation.phase, OperationPhase.SENT_VERIFIED);
  }
  assert.equal(finalState.sendArbiter.lease, null);
  assert.equal(finalState.sendArbiter.profileNextAllowedSendAt, 105_000);

  const creates = chrome.alarmCalls.filter(call => call[0] === 'create');
  assert.deepEqual(creates.map(call => call[2]), expectedWake);
});
