import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
import { createEmptyState, createSession, createTask, PromptMode, RunMode, RunState, TabStrategy } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class Repo {
  constructor(state) {
    this.state = structuredClone(state);
    this.updateQueue = Promise.resolve();
  }
  async load() { return structuredClone(this.state); }
  update(fn) {
    const operation = this.updateQueue.then(async () => {
      const current = structuredClone(this.state);
      const draft = structuredClone(current);
      const next = await fn(draft) || draft;
      next.revision = current.revision + 1;
      this.state = structuredClone(next);
      return this.load();
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }
}

function fakeChrome() {
  let nextId = 1000;
  const live = new Map();
  const created = [];
  const removed = [];
  const alarms = [];
  return {
    created, removed, live, alarms,
    api: {
      tabs: {
        async create({ url, active = false }) {
          const tab = { id: nextId++, url, active, status: 'complete' };
          live.set(tab.id, tab); created.push({ ...tab }); return { ...tab };
        },
        async get(id) {
          const tab = live.get(id); if (!tab) throw new Error(`No tab with id ${id}`); return { ...tab };
        },
        async query() { return [...live.values()].map(tab => ({ ...tab })); },
        async update(id, patch) {
          const tab = live.get(id); if (!tab) throw new Error(`No tab with id ${id}`);
          Object.assign(tab, patch, { status: 'complete' }); return { ...tab };
        },
        async remove(id) { live.delete(id); removed.push(id); },
      },
      alarms: {
        async create(name, info) { alarms.push(['create', name, info.when]); },
        async clear(name) { alarms.push(['clear', name]); return true; },
      },
    },
  };
}

function addSession(state, { id, urlMode, promptMode, tabStrategy }) {
  const tasks = Array.from({ length: 4 }, (_, i) => {
    const n = i + 1;
    const url = urlMode === 'shared'
      ? `https://chatgpt.com/g/${id}-launch`
      : `https://chatgpt.com/c/${id}-${n}`;
    return createTask({
      id: `${id}-t${n}`,
      url,
      label: `${id} task ${n}`,
      promptOverride: promptMode === PromptMode.UNIQUE ? `${id}-unique-prompt-${n}` : '',
    });
  });
  const session = createSession({
    id,
    name: id,
    tasks,
    promptMode,
    sharedPrompt: promptMode === PromptMode.SHARED ? `${id}-shared-prompt` : '',
    runMode: RunMode.ONE_PASS,
    minimumSendIntervalMs: 60_000,
    preSendDelayMs: 10_000,
    busyCheckDelayMs: 10_000,
    retryBackoffMs: 15_000,
    tabStrategy,
    now: 0,
  });
  session.retryPolicy = 'safe';
  session.urlMode = urlMode;
  session.runState = RunState.RUNNING;
  state.sessionsById[id] = session;
  state.sessionOrder.push(id);
  return session;
}

function expectedPrompt(state, taskId) {
  for (const session of Object.values(state.sessionsById)) {
    const task = session.tasksById[taskId];
    if (!task) continue;
    return session.promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
  }
  throw new Error(`Unknown task ${taskId}`);
}

test('four configuration modes run concurrently across all tab strategies, faults and cold restart without human intervention', async () => {
  const state = createEmptyState(0);
  addSession(state, { id: 's1', urlMode: 'shared', promptMode: PromptMode.SHARED, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK });
  addSession(state, { id: 's2', urlMode: 'shared', promptMode: PromptMode.UNIQUE, tabStrategy: TabStrategy.ONE_WORKER_TAB_PER_SESSION });
  addSession(state, { id: 's3', urlMode: 'unique', promptMode: PromptMode.SHARED, tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN });
  addSession(state, { id: 's4', urlMode: 'unique', promptMode: PromptMode.UNIQUE, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK });

  const repo = new Repo(state);
  const chrome = fakeChrome();
  const clock = { now: 1_000_000 };
  const faulted = new Set();
  const confirmed = new Set();
  const submitAttempts = [];
  const requests = [];

  const transport = { async execute(tabId, request) {
    requests.push({ tabId, ...request });
    const live = await repo.load();
    const expected = expectedPrompt(live, request.taskId);
    if (request.mode !== 'CHECK_ONLY') assert.equal(request.promptText, expected, `${request.taskId} prompt must remain task/session-local`);

    if (request.mode === 'ENSURE_HIGH_EFFORT') {
      return { status: InteractionResult.READY, effortLevel: 'high', safeDiagnosticCode: 'EFFORT_HIGH_CONFIRMED' };
    }
    if (request.mode === 'CHECK_ONLY') {
      if (request.taskId === 's1-t2' && !faulted.has('s1-temp')) {
        faulted.add('s1-temp');
        return { status: InteractionResult.TEMPORARY_ERROR, safeDiagnosticCode: 'SYNTHETIC_NETWORK_BLIP' };
      }
      if (request.taskId === 's3-t2' && !faulted.has('s3-busy')) {
        faulted.add('s3-busy');
        return { status: InteractionResult.BUSY };
      }
      return { status: InteractionResult.READY };
    }
    if (request.mode === 'INSERT_ONLY') {
      if (request.taskId === 's4-t4') {
        return { status: InteractionResult.INSERTED_NOT_SENT, composerState: 'VISIBLE_NONEMPTY', safeDiagnosticCode: 'INSERTION_REPEATED_PROMPT_ACCEPTED' };
      }
      return { status: InteractionResult.INSERTED_NOT_SENT, composerState: 'VISIBLE_NONEMPTY', safeDiagnosticCode: 'INSERTION_TEXT_PROVEN' };
    }
    if (request.mode === 'PREPARE_SEND') return { status: InteractionResult.READY };
    if (request.mode === 'SUBMIT_EXISTING') {
      submitAttempts.push(request.taskId);
      if (request.taskId === 's2-t3' && !faulted.has('s2-uncertain')) {
        faulted.add('s2-uncertain');
        return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'SYNTHETIC_ACK_DELAY' };
      }
      confirmed.add(request.taskId);
      return { status: InteractionResult.SENT_VERIFIED };
    }
    if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
      assert.equal(request.taskId, 's2-t3');
      confirmed.add(request.taskId);
      return { status: InteractionResult.SENT_VERIFIED };
    }
    throw new Error(`Unexpected mode ${request.mode}`);
  } };

  const executor = new AutomaticSessionExecutor(repo, chrome.api, transport, {
    now: () => clock.now,
    cryptoApi: webcrypto,
    profileGapMs: 1000,
  });

  let didColdRestart = false;
  let completed = false;
  for (let guard = 0; guard < 500; guard += 1) {
    const snapshot = await repo.load();
    const completedCount = Object.values(snapshot.sessionsById)
      .reduce((sum, session) => sum + session.onePassCompletedTaskIds.length, 0);
    const startup = !didColdRestart && completedCount >= 5;
    if (startup) didColdRestart = true;

    const cycle = await runRuntimeCycle({
      repository: repo,
      chromeApi: chrome.api,
      executor,
      startup,
      executionAvailable: true,
      now: () => clock.now,
    });

    for (const session of Object.values(cycle.state.sessionsById)) {
      assert.notEqual(session.runState, RunState.PAUSED, `${session.id} must remain unattended`);
      assert.equal(Object.values(session.tasksById).some(task => task.manualReviewReason), false, `${session.id} must not require manual review`);
    }

    if (Object.values(cycle.state.sessionsById).every(session => session.runState === RunState.STOPPED)) {
      completed = true;
      break;
    }
    if (Number.isFinite(cycle.wakeAt) && cycle.wakeAt > clock.now) clock.now = cycle.wakeAt;
    else clock.now += 1;
  }

  const after = await repo.load();
  assert.equal(completed, true, 'all four one-pass Sessions must terminate');
  assert.equal(didColdRestart, true, 'test must include a real cold-start reconciliation');
  assert.equal(confirmed.size, 16);
  assert.deepEqual([...confirmed].sort(), Array.from({ length: 4 }, (_, s) => Array.from({ length: 4 }, (_, t) => `s${s + 1}-t${t + 1}`)).flat().sort());
  for (const session of Object.values(after.sessionsById)) {
    assert.equal(session.onePassCompletedTaskIds.length, 4, `${session.id} completed all tasks exactly once`);
    assert.equal(new Set(session.onePassCompletedTaskIds).size, 4);
    assert.equal(session.lastError, '');
  }

  assert.equal(submitAttempts.filter(id => id === 's2-t3').length, 1, 'uncertain send is passively verified before any resend');
  assert.equal(faulted.has('s1-temp'), true);
  assert.equal(faulted.has('s3-busy'), true);
  assert.equal(faulted.has('s2-uncertain'), true);

  // open-close: s1=5 creates/removes because one pre-submit transient retry; s4=4.
  // worker: s2 owns one reusable tab. keep-open: s3 owns four reusable tabs.
  assert.equal(chrome.removed.length, 9, 'all extension-owned open-close tabs are cleaned up, including retry tab');
  assert.equal(chrome.live.size, 5, 'only one worker tab plus four keep-open tabs remain');
  assert.equal(chrome.created.length, 14);

  // Ensure each task was always bound to its configured URL; no cross-session leakage.
  for (const request of requests) {
    const liveTask = Object.values(after.sessionsById).map(s => s.tasksById[request.taskId]).find(Boolean);
    assert.equal(request.expectedUrl, liveTask.normalizedUrl, `${request.taskId} URL binding`);
  }
});

test('shared-URL backoff is session-local and never freezes an unrelated parallel Session', async () => {
  const state = createEmptyState(0);
  const a = addSession(state, { id: 'a', urlMode: 'shared', promptMode: PromptMode.SHARED, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK });
  const b = addSession(state, { id: 'b', urlMode: 'unique', promptMode: PromptMode.SHARED, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK });
  const now = 50_000;
  a.tasksById['a-t1'].status = 'RETRY_WAIT';
  for (const id of a.taskOrder) a.tasksById[id].retryAfterAt = now + 15_000;

  // The unrelated Session must remain immediately runnable.
  const { selectNextTask } = await import('../../src/core/scheduler.js');
  assert.equal(selectNextTask(a, now).kind, 'WAIT');
  const decisionB = selectNextTask(b, now);
  assert.equal(decisionB.kind, 'TASK');
  assert.equal(decisionB.task.id, 'b-t1');
});
