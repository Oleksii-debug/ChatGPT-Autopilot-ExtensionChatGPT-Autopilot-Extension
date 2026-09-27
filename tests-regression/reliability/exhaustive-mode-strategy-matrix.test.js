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
  let nextId = 4000;
  const live = new Map();
  const created = [];
  const removed = [];
  const updates = [];
  const alarms = [];
  return {
    live, created, removed, updates, alarms,
    setUrl(id, url) { const tab = live.get(id); if (!tab) throw new Error(`missing tab ${id}`); tab.url = url; tab.status = 'complete'; },
    api: {
      tabs: {
        async create({ url, active = false }) { const tab = { id: nextId++, url, active, status: 'complete' }; live.set(tab.id, tab); created.push({ ...tab }); return { ...tab }; },
        async get(id) { const tab = live.get(id); if (!tab) throw new Error(`No tab with id ${id}`); return { ...tab }; },
        async query() { return [...live.values()].map(tab => ({ ...tab })); },
        async update(id, patch) { const tab = live.get(id); if (!tab) throw new Error(`No tab with id ${id}`); Object.assign(tab, patch, { status: 'complete' }); updates.push({ id, ...patch }); return { ...tab }; },
        async remove(id) { if (!live.delete(id)) throw new Error(`No tab with id ${id}`); removed.push(id); },
      },
      alarms: {
        async create(name, info) { alarms.push(['create', name, info.when]); },
        async clear(name) { alarms.push(['clear', name]); return true; },
      },
    },
  };
}

const STRATEGIES = [
  TabStrategy.OPEN_CLOSE_PER_TASK,
  TabStrategy.ONE_WORKER_TAB_PER_SESSION,
  TabStrategy.KEEP_TASK_TABS_OPEN,
];
const MODES = [
  { urlMode: 'shared', promptMode: PromptMode.SHARED, label: 'shared-url/shared-prompt' },
  { urlMode: 'shared', promptMode: PromptMode.UNIQUE, label: 'shared-url/unique-prompt' },
  { urlMode: 'unique', promptMode: PromptMode.SHARED, label: 'unique-url/shared-prompt' },
  { urlMode: 'unique', promptMode: PromptMode.UNIQUE, label: 'unique-url/unique-prompt' },
];

function seedAll(state) {
  let ordinal = 0;
  for (const mode of MODES) {
    for (const strategy of STRATEGIES) {
      ordinal += 1;
      const id = `s${ordinal}`;
      const tasks = Array.from({ length: 3 }, (_, i) => createTask({
        id: `${id}-t${i + 1}`,
        url: mode.urlMode === 'shared' ? 'https://chatgpt.com/' : `https://chatgpt.com/c/${id}-${i + 1}`,
        promptOverride: mode.promptMode === PromptMode.UNIQUE ? `${id}-unique-${i + 1}` : '',
      }));
      const session = createSession({
        id, name: `${mode.label}/${strategy}`, tasks,
        promptMode: mode.promptMode,
        sharedPrompt: mode.promptMode === PromptMode.SHARED ? `${id}-shared` : '',
        runMode: RunMode.ONE_PASS,
        minimumSendIntervalMs: 60_000,
        preSendDelayMs: 10_000,
        busyCheckDelayMs: 10_000,
        retryBackoffMs: 15_000,
        tabStrategy: strategy,
        now: 0,
      });
      session.retryPolicy = 'safe';
      session.urlMode = mode.urlMode;
      session.runState = RunState.RUNNING;
      state.sessionsById[id] = session;
      state.sessionOrder.push(id);
    }
  }
}

function expectedPrompt(state, taskId) {
  for (const session of Object.values(state.sessionsById)) {
    const task = session.tasksById[taskId];
    if (!task) continue;
    return session.promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
  }
  throw new Error(`unknown task ${taskId}`);
}

test('all 12 mode x tab-strategy combinations complete concurrently with real root->conversation transitions and restart faults', async () => {
  const state = createEmptyState(0);
  seedAll(state);
  const repo = new Repo(state);
  const chrome = fakeChrome();
  const clock = { now: 5_000_000 };
  const submitCounts = new Map();
  const once = new Set();
  const verified = new Set();

  const transport = { async execute(tabId, request) {
    const liveState = await repo.load();
    if (!['CHECK_ONLY', 'ENSURE_HIGH_EFFORT'].includes(request.mode)) {
      assert.equal(request.promptText, expectedPrompt(liveState, request.taskId));
    }
    const sessionId = request.taskId.split('-t')[0];
    const session = liveState.sessionsById[sessionId];
    const ordinal = Number(request.taskId.match(/-t(\d+)$/)?.[1] || 0);
    const sessionOrdinal = Number(sessionId.slice(1));
    const faultKey = `${request.mode}:${request.taskId}`;

    if (request.mode === 'CHECK_ONLY') {
      if ((sessionOrdinal + ordinal) % 7 === 0 && !once.has(faultKey)) {
        once.add(faultKey);
        return { status: InteractionResult.TEMPORARY_ERROR, safeDiagnosticCode: 'SYNTHETIC_TRANSIENT' };
      }
      if ((sessionOrdinal + ordinal) % 11 === 0 && !once.has(`busy:${request.taskId}`)) {
        once.add(`busy:${request.taskId}`);
        return { status: InteractionResult.BUSY };
      }
      return { status: InteractionResult.READY };
    }
    if (request.mode === 'ENSURE_HIGH_EFFORT') {
      return { status: InteractionResult.READY, effortLevel: 'high', safeDiagnosticCode: 'EFFORT_HIGH_CONFIRMED' };
    }
    if (request.mode === 'INSERT_ONLY') {
      return {
        status: InteractionResult.INSERTED_NOT_SENT,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: (sessionOrdinal + ordinal) % 5 === 0 ? 'INSERTION_REPEATED_PROMPT_ACCEPTED' : 'INSERTION_TEXT_PROVEN',
      };
    }
    if (request.mode === 'PREPARE_SEND') return { status: InteractionResult.READY };
    if (request.mode === 'SUBMIT_EXISTING') {
      submitCounts.set(request.taskId, (submitCounts.get(request.taskId) || 0) + 1);
      if ((sessionOrdinal + ordinal) % 13 === 0 && !once.has(`uncertain:${request.taskId}`)) {
        once.add(`uncertain:${request.taskId}`);
        return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'SYNTHETIC_ACK_DELAY' };
      }
      verified.add(request.taskId);
      if (session.urlMode === 'shared') chrome.setUrl(tabId, `https://chatgpt.com/c/generated-${request.taskId}`);
      return { status: InteractionResult.SENT_VERIFIED };
    }
    if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
      verified.add(request.taskId);
      if (session.urlMode === 'shared') chrome.setUrl(tabId, `https://chatgpt.com/c/generated-${request.taskId}`);
      return { status: InteractionResult.SENT_VERIFIED };
    }
    throw new Error(`unexpected mode ${request.mode}`);
  } };

  let executor = new AutomaticSessionExecutor(repo, chrome.api, transport, { now: () => clock.now, cryptoApi: webcrypto });
  let restarted = false;
  let done = false;
  for (let guard = 0; guard < 1500; guard += 1) {
    const snapshot = await repo.load();
    const completedCount = Object.values(snapshot.sessionsById).reduce((n, s) => n + s.onePassCompletedTaskIds.length, 0);
    const startup = !restarted && completedCount >= 9;
    if (startup) {
      restarted = true;
      executor = new AutomaticSessionExecutor(repo, chrome.api, transport, { now: () => clock.now, cryptoApi: webcrypto });
    }
    const cycle = await runRuntimeCycle({ repository: repo, chromeApi: chrome.api, executor, startup, executionAvailable: true, now: () => clock.now });
    for (const session of Object.values(cycle.state.sessionsById)) {
      assert.notEqual(session.runState, RunState.PAUSED, `${session.id} unexpectedly paused`);
      assert.equal(Object.values(session.tasksById).some(t => t.manualReviewReason), false, `${session.id} leaked manual review`);
    }
    if (Object.values(cycle.state.sessionsById).every(s => s.runState === RunState.STOPPED)) { done = true; break; }
    if (Number.isFinite(cycle.wakeAt) && cycle.wakeAt > clock.now) clock.now = cycle.wakeAt;
    else clock.now += 1;
  }

  const after = await repo.load();
  assert.equal(done, true);
  assert.equal(restarted, true);
  assert.equal(verified.size, 36);
  for (const session of Object.values(after.sessionsById)) {
    assert.equal(session.onePassCompletedTaskIds.length, 3, `${session.id} completion count`);
    assert.equal(new Set(session.onePassCompletedTaskIds).size, 3, `${session.id} completion identity`);
    assert.equal(session.lastError, '');
  }
  for (const taskId of verified) assert.equal(submitCounts.get(taskId), 1, `${taskId} must have one actual submit attempt`);

  // Four shared-url worker Sessions exist (one per prompt mode pair across strategies => actually 2 worker shared sessions).
  // Each worker Session must still own only one tab after root->/c transitions; no per-cycle leak.
  const workerSharedSessionIds = Object.values(after.sessionsById)
    .filter(s => s.urlMode === 'shared' && s.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION)
    .map(s => s.id);
  assert.equal(workerSharedSessionIds.length, 2);
  for (const id of workerSharedSessionIds) {
    const hint = after.tabHintsByTaskId[`__session_worker__:${id}`];
    assert.ok(hint?.tabId != null, `${id} must retain one worker hint`);
    assert.ok(chrome.live.has(hint.tabId), `${id} worker tab must remain live`);
  }

  // Shared root is allowed across parallel Sessions. Concrete /c identities remain isolated by task/session.
  const sharedRootCreates = chrome.created.filter(t => t.url === 'https://chatgpt.com/').length;
  assert.ok(sharedRootCreates >= 2, 'parallel shared-root Sessions must be able to create independent tabs');
});
