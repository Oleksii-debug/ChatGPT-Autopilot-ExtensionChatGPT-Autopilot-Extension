import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { applyPortableProfile } from '../../src/core/portable-profile.js';
import { advanceAfterVerifiedSend, selectNextTask } from '../../src/core/scheduler.js';
import { createEmptyState, createSession, createTask, RunMode, RunState } from '../../src/core/schema.js';
import { InteractionResult } from '../../src/shared/protocol.js';

class Repo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(fn) {
    const draft = structuredClone(this.state);
    const next = await fn(draft) || draft;
    next.revision = this.state.revision + 1;
    this.state = structuredClone(next);
    return this.load();
  }
}

function fakeOpenCloseChrome() {
  let nextId = 100;
  const live = new Map();
  const created = [];
  const removed = [];
  return {
    created, removed,
    api: { tabs: {
      async create({ url, active }) {
        const tab = { id: nextId++, url, active, status: 'complete' };
        live.set(tab.id, tab); created.push(tab.id); return { ...tab };
      },
      async get(id) {
        const tab = live.get(id);
        if (!tab) throw new Error(`No tab with id ${id}`);
        return { ...tab };
      },
      async query() { return [...live.values()].map(tab => ({ ...tab })); },
      async remove(id) { live.delete(id); removed.push(id); },
      async update(id, patch) {
        const tab = live.get(id);
        if (!tab) throw new Error(`No tab with id ${id}`);
        Object.assign(tab, patch, { status: 'complete' });
        return { ...tab };
      },
    } },
  };
}

test('bundled Nika profile completes all 30 one-pass cycles unattended with configured timings', async () => {
  const profile = JSON.parse(await readFile(new URL('../fixtures/Nika-30-cycles-profile.json', import.meta.url), 'utf8'));
  const state = createEmptyState(0);
  applyPortableProfile(state, profile, { now: 0, confirmAutoStart: false, executionAvailable: true });
  const session = state.sessionsById['session-nika-30'];
  session.runState = RunState.RUNNING;
  const repo = new Repo(state);
  const clock = { now: 1_000_000 };
  const chrome = fakeOpenCloseChrome();
  const submitted = [];
  const transport = { async execute(_tabId, request) {
    if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY };
    if (request.mode === 'INSERT_ONLY') {
      return {
        status: InteractionResult.INSERTED_NOT_SENT,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: 'INSERTION_TEXT_PROVEN',
      };
    }
    if (request.mode === 'PREPARE_SEND') return { status: InteractionResult.READY };
    if (request.mode === 'SUBMIT_EXISTING') {
      submitted.push(request.taskId);
      return { status: InteractionResult.SENT_VERIFIED };
    }
    throw new Error(`Unexpected mode ${request.mode}`);
  } };
  const executor = new AutomaticSessionExecutor(repo, chrome.api, transport, {
    now: () => clock.now, cryptoApi: webcrypto,
  });

  let guard = 0;
  while (guard++ < 200) {
    const result = await executor.runSessionOnce('session-nika-30');
    if (result.kind === 'COMPLETE') break;
    if (Number.isFinite(result.wakeAt) && result.wakeAt > clock.now) clock.now = result.wakeAt;
    // SENT itself has no wakeAt; next iteration exposes the one-minute cooldown.
  }

  const after = await repo.load();
  assert.equal(after.sessionsById['session-nika-30'].runState, RunState.STOPPED);
  assert.equal(submitted.length, 30);
  assert.equal(new Set(submitted).size, 30);
  assert.deepEqual(submitted, Array.from({ length: 30 }, (_, i) => `nika-${String(i + 1).padStart(3, '0')}`));
  assert.equal(after.sessionsById['session-nika-30'].onePassCompletedTaskIds.length, 30);
  assert.equal(after.sessionsById['session-nika-30'].minimumSendIntervalMs, 60_000);
  assert.equal(after.sessionsById['session-nika-30'].preSendDelayMs, 10_000);
  assert.equal(after.sessionsById['session-nika-30'].busyCheckDelayMs, 10_000);
  assert.equal(after.sessionsById['session-nika-30'].retryBackoffMs, 15_000);
  assert.equal(chrome.created.length, 30);
  assert.equal(chrome.removed.length, 30);
});

test('scheduler handles 1000 one-pass cycles without skips, duplicates, or manual state', () => {
  const tasks = Array.from({ length: 1000 }, (_, i) => createTask({
    id: `t${i + 1}`, url: 'https://chatgpt.com/', label: `T ${i + 1}`,
  }));
  const session = createSession({
    id: 'scale', name: 'Scale', tasks, sharedPrompt: 'x', runMode: RunMode.ONE_PASS,
    minimumSendIntervalMs: 60_000, now: 0,
  });
  session.retryPolicy = 'safe';
  session.urlMode = 'shared';
  session.runState = RunState.RUNNING;

  let now = 1;
  const seen = [];
  for (let i = 0; i < 1000; i++) {
    let decision = selectNextTask(session, now);
    if (decision.kind === 'COOLDOWN') {
      now = decision.wakeAt;
      decision = selectNextTask(session, now);
    }
    assert.equal(decision.kind, 'TASK');
    seen.push(decision.task.id);
    advanceAfterVerifiedSend(session, decision.index, now);
    now += 60_000;
  }
  assert.equal(selectNextTask(session, now).kind, 'COMPLETE');
  assert.equal(seen.length, 1000);
  assert.equal(new Set(seen).size, 1000);
  assert.deepEqual(seen.slice(0, 3), ['t1', 't2', 't3']);
  assert.deepEqual(seen.slice(-3), ['t998', 't999', 't1000']);
  assert.ok(tasks.every(task => !task.manualReviewReason));
});

test('bundled Nika profile survives mixed transient faults across 30 cycles without human intervention', async () => {
  const profile = JSON.parse(await readFile(new URL('../fixtures/Nika-30-cycles-profile.json', import.meta.url), 'utf8'));
  const state = createEmptyState(0);
  applyPortableProfile(state, profile, { now: 0, confirmAutoStart: false, executionAvailable: true });
  state.sessionsById['session-nika-30'].runState = RunState.RUNNING;
  const repo = new Repo(state);
  const clock = { now: 2_000_000 };
  const chrome = fakeOpenCloseChrome();
  const sent = [];
  const once = new Set();
  const recovered = new Set();

  const transport = { async execute(_tabId, request) {
    const ordinal = Number(request.taskId.match(/(\d+)$/)?.[1] || 0);
    const key = `${request.mode}:${request.taskId}`;

    if (request.mode === 'CHECK_ONLY') {
      if (ordinal === 5 && !once.has(key)) {
        once.add(key);
        return { status: InteractionResult.UNKNOWN_UI, safeDiagnosticCode: 'SYNTHETIC_UNKNOWN_UI' };
      }
      return { status: InteractionResult.READY };
    }
    if (request.mode === 'INSERT_ONLY') {
      if (ordinal === 7 && !once.has(key)) {
        once.add(key);
        return { status: InteractionResult.MANUAL_REVIEW_REQUIRED, safeDiagnosticCode: 'SYNTHETIC_PRE_SEND_OBSTRUCTION' };
      }
      if (ordinal % 4 === 0) {
        return {
          status: InteractionResult.INSERTED_NOT_SENT,
          composerState: 'VISIBLE_NONEMPTY',
          safeDiagnosticCode: 'INSERTION_REPEATED_PROMPT_ACCEPTED',
        };
      }
      return {
        status: InteractionResult.INSERTED_NOT_SENT,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: 'INSERTION_TEXT_PROVEN',
      };
    }
    if (request.mode === 'PREPARE_SEND') return { status: InteractionResult.READY };
    if (request.mode === 'SUBMIT_EXISTING') {
      if (ordinal % 5 === 0 && !once.has(key)) {
        once.add(key);
        return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'SYNTHETIC_SEND_UNCERTAIN' };
      }
      sent.push(request.taskId);
      return { status: InteractionResult.SENT_VERIFIED };
    }
    if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
      recovered.add(request.taskId);
      sent.push(request.taskId);
      return { status: InteractionResult.SENT_VERIFIED };
    }
    throw new Error(`Unexpected mode ${request.mode}`);
  } };

  const executor = new AutomaticSessionExecutor(repo, chrome.api, transport, {
    now: () => clock.now, cryptoApi: webcrypto,
  });

  let completed = false;
  for (let guard = 0; guard < 400; guard++) {
    const result = await executor.runSessionOnce('session-nika-30');
    const mid = await repo.load();
    const session = mid.sessionsById['session-nika-30'];
    assert.notEqual(session.runState, RunState.PAUSED, `safe mode paused at ${result.kind}`);
    assert.equal(Object.values(session.tasksById).some(task => task.manualReviewReason), false);
    if (result.kind === 'COMPLETE') { completed = true; break; }
    if (Number.isFinite(result.wakeAt) && result.wakeAt > clock.now) clock.now = result.wakeAt;
  }

  const after = await repo.load();
  assert.equal(completed, true);
  assert.equal(after.sessionsById['session-nika-30'].runState, RunState.STOPPED);
  if (sent.length !== 30 || new Set(sent).size !== 30) console.error('FAULT_SENT', sent, 'RECOVERED', [...recovered]);
  assert.equal(sent.length, 30);
  assert.equal(new Set(sent).size, 30);
  assert.deepEqual([...recovered].sort(), ['nika-005', 'nika-010', 'nika-015', 'nika-020', 'nika-025', 'nika-030']);
  assert.equal(after.sessionsById['session-nika-30'].onePassCompletedTaskIds.length, 30);
  assert.equal(chrome.created.length, 32, 'two pre-submit faults should each get a fresh retry tab');
  assert.equal(chrome.removed.length, 32, 'every extension-owned open-close tab should be cleaned up');
});
