import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiAutonomyManager,
  DEFAULT_AI_MANAGER_RUNTIME,
  DEFAULT_AI_MANAGER_SETTINGS,
  aiManagerDue,
  nextAiManagerDecisionWakeAt,
  applyAiManagerDecision,
  captureManagerOutcomes,
  parseAiManagerDecision,
} from '../src/core/ai-manager.js';
import { createEmptyState, createSession, createTask, RunState, OperationPhase, validateState } from '../src/core/schema.js';

function stateWithSession() {
  const state = createEmptyState(1000);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/', label: 'one' });
  const session = createSession({ id: 's1', name: 'Session 1', tasks: [task], sharedPrompt: 'base', now: 1000 });
  session.runState = RunState.RUNNING;
  session.urlMode = 'shared';
  state.sessionsById.s1 = session;
  state.sessionOrder.push('s1');
  return state;
}

class MemoryRepo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    const next = await mutator(draft) || draft;
    next.revision = this.state.revision + 1;
    validateState(next);
    this.state = next;
    return structuredClone(this.state);
  }
}


test('legacy AI Manager cannot observe or mutate Orchestration V2 owned Sessions', () => {
  const state = stateWithSession();
  const session = state.sessionsById.s1;
  session.orchestrationWorker = { managed: true, projectId: 'proj', workerId: 'worker-1', taskId: 'task-1' };
  const settings = { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, triggerEveryNSends: 1 };
  const runtime = captureManagerOutcomes(settings, DEFAULT_AI_MANAGER_RUNTIME, [
    { sessionId: 's1', result: { kind: 'SENT' } },
    { sessionId: 's1', result: { kind: 'COMPLETE' } },
  ], state, 2000);
  assert.equal(runtime.pendingEvents.length, 0);
  assert.equal(runtime.sentSinceDecision, 0);

  const result = applyAiManagerDecision(state, settings, runtime, {
    summary: 'must not touch V2',
    actions: [{ type: 'PAUSE_SESSION', sessionId: 's1', text: '' }],
  }, 3000);
  assert.equal(session.runState, RunState.RUNNING);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].reason, 'orchestration-v2-owned');
});

test('manager captures verified sends and becomes due by configured send count', () => {
  const state = stateWithSession();
  const settings = { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, triggerEveryNSends: 2, triggerEveryMinutes: 0, triggerOnComplete: false, triggerOnErrors: false };
  let runtime = captureManagerOutcomes(settings, DEFAULT_AI_MANAGER_RUNTIME, [{ sessionId: 's1', result: { kind: 'SENT' } }], state, 2000);
  assert.equal(runtime.sentSinceDecision, 1);
  assert.equal(aiManagerDue(settings, runtime, 2000).due, false);
  runtime = captureManagerOutcomes(settings, runtime, [{ sessionId: 's1', result: { kind: 'RECOVERED_SENT' } }], state, 3000);
  assert.equal(runtime.sentSinceDecision, 2);
  assert.deepEqual(aiManagerDue(settings, runtime, 3000), { due: true, reason: 'send-count' });
});

test('completion and repeated errors trigger manager immediately', () => {
  const state = stateWithSession();
  const settings = { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, triggerEveryNSends: 0, triggerEveryMinutes: 0, errorThreshold: 2 };
  let runtime = captureManagerOutcomes(settings, DEFAULT_AI_MANAGER_RUNTIME, [{ sessionId: 's1', result: { kind: 'COMPLETE' } }], state, 2000);
  assert.equal(aiManagerDue(settings, runtime, 2000).reason, 'complete');
  runtime = { ...structuredClone(DEFAULT_AI_MANAGER_RUNTIME), startedAt: 1000 };
  runtime = captureManagerOutcomes(settings, runtime, [{ sessionId: 's1', result: { kind: 'TEMPORARY_RUNTIME_ERROR', diagnosticCode: 'X' } }], state, 2000);
  assert.equal(aiManagerDue(settings, runtime, 2000).due, false);
  runtime = captureManagerOutcomes(settings, runtime, [{ sessionId: 's1', result: { kind: 'TEMPORARY_RUNTIME_ERROR', diagnosticCode: 'X' } }], state, 3000);
  assert.equal(aiManagerDue(settings, runtime, 3000).reason, 'error-threshold');
});

test('decision parser accepts only allowlisted actions and clips handoff', () => {
  const decision = parseAiManagerDecision(JSON.stringify({
    summary: 'ok',
    actions: [
      { type: 'HANDOFF_NEXT', sessionId: 's1', text: 'x'.repeat(2000) },
      { type: 'RUN_SHELL', sessionId: 's1', text: 'bad' },
    ],
  }), { ...DEFAULT_AI_MANAGER_SETTINGS, handoffMaxChars: 500 });
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].type, 'HANDOFF_NEXT');
  assert.equal(decision.actions[0].text.length, 500);
});

test('manager applies one-use handoff and refuses unsafe retry of ambiguous submit', () => {
  const state = stateWithSession();
  state.sessionsById.s1.operation = {
    operationId: 'op', sessionId: 's1', taskId: 't1', promptFingerprint: 'fp', phase: OperationPhase.AMBIGUOUS,
    targetUrl: 'https://chatgpt.com/', createdAt: 1000, updatedAt: 1000, preSendDeadline: 0, submitStartedAt: 1000, verificationDeadline: 2000,
  };
  const settings = { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true };
  const runtime = { ...structuredClone(DEFAULT_AI_MANAGER_RUNTIME), pendingEvents: [{ id: 1, at: 1000, type: 'ERROR', sessionId: 's1', taskId: 't1', code: 'UNCERTAIN', message: '' }], nextEventId: 2 };
  const result = applyAiManagerDecision(state, settings, runtime, {
    summary: 'handoff and retry',
    actions: [
      { type: 'HANDOFF_NEXT', sessionId: 's1', text: 'check the current blocker' },
      { type: 'RETRY_NOW', sessionId: 's1', text: '' },
    ],
  }, 5000);
  assert.equal(state.sessionsById.s1.aiCoordinatorHandoff, 'check the current blocker');
  assert.equal(result.applied.some(a => a.type === 'HANDOFF_NEXT'), true);
  assert.equal(result.skipped.some(a => a.type === 'RETRY_NOW' && a.reason === 'unsafe-retry-state'), true);
  assert.equal(result.runtime.pendingEvents.length, 0);
});

test('autonomy manager routes due events and persists a safe handoff', async () => {
  const state = stateWithSession();
  state.profile.aiRouter.enabled = true;
  state.profile.aiRouter.primary.model = 'local';
  state.profile.aiManager = { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, triggerEveryNSends: 1, triggerEveryMinutes: 0, triggerOnComplete: false, triggerOnErrors: false };
  const repo = new MemoryRepo(state);
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => 5000,
    routePrompt: async ({ prompt }) => {
      assert.match(prompt, /CURRENT AUTOPILOT STATE AND EVENTS/);
      return { result: { route: 'primary', text: JSON.stringify({ summary: 'передати контекст', actions: [{ type: 'HANDOFF_NEXT', sessionId: 's1', text: 'перевір наступний blocker' }] }) } };
    },
  });
  await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
  const result = await manager.process();
  assert.equal(result.kind, 'AI_MANAGER_DECISION_APPLIED');
  const final = await repo.load();
  assert.equal(final.sessionsById.s1.aiCoordinatorHandoff, 'перевір наступний blocker');
  assert.equal(final.profile.aiManagerRuntime.decisionCount, 1);
  assert.equal(final.profile.aiManagerRuntime.pendingEvents.length, 0);
  assert.equal(final.profile.aiManagerRuntime.decisionHistory.length, 1);
  assert.equal(final.profile.aiManagerRuntime.decisionHistory[0].route, 'primary');
  assert.equal(final.profile.aiManagerRuntime.decisionHistory[0].dueReason, 'send-count');
  assert.equal(final.profile.aiManagerRuntime.decisionHistory[0].applied[0].type, 'HANDOFF_NEXT');
});

test('AI Manager cannot bypass a stored ChatGPT rate-limit hold', () => {
  const state = stateWithSession();
  const session = state.sessionsById.s1;
  const task = session.tasksById.t1;
  task.status = 'RATE_LIMITED';
  task.retryAfterAt = 999999;
  const result = applyAiManagerDecision(state, { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true }, DEFAULT_AI_MANAGER_RUNTIME, {
    summary: 'try now',
    actions: [{ type: 'RETRY_NOW', sessionId: 's1', text: '' }],
  }, 5000);
  assert.equal(task.retryAfterAt, 999999);
  assert.equal(result.skipped[0].reason, 'unsafe-retry-state');
});

test('verified send schedules durable web-report collection and collected report triggers manager', async () => {
  const state = stateWithSession();
  state.profile.aiRouter.enabled = true;
  state.profile.aiRouter.primary.model = 'local';
  state.profile.aiManager = {
    ...DEFAULT_AI_MANAGER_SETTINGS,
    enabled: true,
    triggerEveryNSends: 0,
    triggerEveryMinutes: 0,
    triggerOnComplete: false,
    triggerOnErrors: false,
    triggerOnWebReport: true,
    captureWebReports: true,
    webReportPollSeconds: 5,
  };
  state.sessionsById.s1.tasksById.t1.lastConversationUrl = 'https://chatgpt.com/c/abc123';
  state.sessionsById.s1.tasksById.t1.lastAssistantBaselineKnown = true;
  state.sessionsById.s1.tasksById.t1.lastAssistantBaselineCount = 0;
  const repo = new MemoryRepo(state);
  let now = 10000;
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => now,
    collectWebReport: async job => {
      assert.equal(job.conversationUrl, 'https://chatgpt.com/c/abc123');
      return { ready: true, text: 'worker finished and reported useful result', code: 'ASSISTANT_RESPONSE_READY' };
    },
    routePrompt: async () => ({ result: { route: 'primary', text: JSON.stringify({ summary: 'report reviewed', actions: [] }) } }),
  });
  await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
  let mid = await repo.load();
  assert.equal(mid.profile.aiManagerRuntime.pendingReports.length, 1);
  now += 5000;
  const collected = await manager.collectOneDueReport();
  assert.equal(collected.kind, 'AI_REPORT_COLLECTED');
  mid = await repo.load();
  assert.equal(mid.sessionsById.s1.tasksById.t1.lastAssistantReport, 'worker finished and reported useful result');
  assert.equal(mid.profile.aiManagerRuntime.pendingEvents.some(e => e.type === 'WEB_REPORT'), true);
  assert.equal(aiManagerDue(mid.profile.aiManager, mid.profile.aiManagerRuntime, now).reason, 'web-report');
  const decision = await manager.process();
  assert.equal(decision.kind, 'AI_MANAGER_DECISION_APPLIED');
});

test('pending web-report job survives manager/repository restart and is collected later', async () => {
  const state = stateWithSession();
  state.profile.aiRouter.enabled = true;
  state.profile.aiRouter.primary.model = 'local';
  state.profile.aiManager = {
    ...DEFAULT_AI_MANAGER_SETTINGS,
    enabled: true,
    triggerEveryNSends: 0,
    triggerEveryMinutes: 0,
    triggerOnComplete: false,
    triggerOnErrors: false,
    triggerOnWebReport: true,
    captureWebReports: true,
    webReportPollSeconds: 5,
  };
  state.sessionsById.s1.tasksById.t1.lastConversationUrl = 'https://chatgpt.com/c/restart-proof';
  state.sessionsById.s1.tasksById.t1.lastAssistantBaselineKnown = true;
  state.sessionsById.s1.tasksById.t1.lastAssistantBaselineCount = 0;
  const repoBeforeRestart = new MemoryRepo(state);
  let now = 10_000;
  const managerBeforeRestart = new AiAutonomyManager({
    repository: repoBeforeRestart,
    now: () => now,
    routePrompt: async () => ({ result: { route: 'primary', text: '{"summary":"ok","actions":[]}' } }),
    collectWebReport: async () => { throw new Error('old process must not collect'); },
  });
  await managerBeforeRestart.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
  const persisted = await repoBeforeRestart.load();
  assert.equal(persisted.profile.aiManagerRuntime.pendingReports.length, 1);

  // Simulate Chrome/service-worker restart: a brand-new repository and manager are
  // reconstructed only from durable persisted state.
  const repoAfterRestart = new MemoryRepo(persisted);
  now += 5_000;
  const managerAfterRestart = new AiAutonomyManager({
    repository: repoAfterRestart,
    now: () => now,
    routePrompt: async () => ({ result: { route: 'primary', text: '{"summary":"ok","actions":[]}' } }),
    collectWebReport: async job => ({ ready: true, text: `restored report for ${job.taskId}`, code: 'ASSISTANT_RESPONSE_READY' }),
  });
  const result = await managerAfterRestart.collectOneDueReport();
  assert.equal(result.kind, 'AI_REPORT_COLLECTED');
  const final = await repoAfterRestart.load();
  assert.equal(final.profile.aiManagerRuntime.pendingReports.length, 0);
  assert.equal(final.sessionsById.s1.tasksById.t1.lastAssistantReport, 'restored report for t1');
});

test('web-report collector retries streaming/BUSY state and later succeeds without losing job', async () => {
  const state = stateWithSession();
  state.profile.aiManager = {
    ...DEFAULT_AI_MANAGER_SETTINGS,
    enabled: true,
    captureWebReports: true,
    triggerOnWebReport: true,
    webReportPollSeconds: 5,
    webReportMaxWaitMinutes: 10,
  };
  state.sessionsById.s1.tasksById.t1.lastConversationUrl = 'https://chatgpt.com/c/busy-then-ready';
  state.sessionsById.s1.tasksById.t1.lastAssistantBaselineKnown = true;
  state.sessionsById.s1.tasksById.t1.lastAssistantBaselineCount = 0;
  const repo = new MemoryRepo(state);
  let now = 1_000;
  let attempts = 0;
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => now,
    routePrompt: async () => ({ result: { route: 'primary', text: '{"summary":"ok","actions":[]}' } }),
    collectWebReport: async () => {
      attempts += 1;
      if (attempts === 1) return { ready: false, code: 'ASSISTANT_RESPONSE_STREAMING' };
      return { ready: true, text: 'final web-worker report', code: 'ASSISTANT_RESPONSE_READY' };
    },
  });
  await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
  now += 5_000;
  const retry = await manager.collectOneDueReport();
  assert.equal(retry.kind, 'AI_REPORT_RETRY');
  let mid = await repo.load();
  assert.equal(mid.profile.aiManagerRuntime.pendingReports.length, 1);
  assert.equal(mid.profile.aiManagerRuntime.pendingReports[0].attempts, 1);
  assert.equal(mid.profile.aiManagerRuntime.pendingReports[0].lastCode, 'ASSISTANT_RESPONSE_STREAMING');
  now = mid.profile.aiManagerRuntime.pendingReports[0].retryAt;
  const success = await manager.collectOneDueReport();
  assert.equal(success.kind, 'AI_REPORT_COLLECTED');
  mid = await repo.load();
  assert.equal(mid.profile.aiManagerRuntime.pendingReports.length, 0);
  assert.equal(mid.sessionsById.s1.tasksById.t1.lastAssistantReport, 'final web-worker report');
});

test('AI manager model error and invalid JSON preserve pending events for a later retry', async () => {
  for (const mode of ['throw', 'invalid']) {
    const state = stateWithSession();
    state.profile.aiRouter.enabled = true;
    state.profile.aiRouter.primary.model = 'local';
    state.profile.aiManager = { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, triggerEveryNSends: 1, triggerEveryMinutes: 0, triggerOnComplete: false, triggerOnErrors: false };
    const repo = new MemoryRepo(state);
    const manager = new AiAutonomyManager({
      repository: repo,
      now: () => 5_000,
      routePrompt: async () => {
        if (mode === 'throw') throw new Error('model offline');
        return { result: { route: 'primary', text: 'not-json-at-all' } };
      },
    });
    await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
    const before = await repo.load();
    assert.equal(before.profile.aiManagerRuntime.pendingEvents.length, 1);
    const result = await manager.process();
    assert.equal(result.kind, mode === 'throw' ? 'AI_MANAGER_AI_ERROR' : 'AI_MANAGER_INVALID_DECISION');
    const after = await repo.load();
    assert.equal(after.profile.aiManagerRuntime.pendingEvents.length, 1);
    assert.equal(after.profile.aiManagerRuntime.decisionCount, 0);
    assert.ok(after.profile.aiManagerRuntime.lastError);
  }
});

test('time-based AI Manager trigger exposes an independent durable wake time and router-disabled backoff', async () => {
  const state = stateWithSession();
  state.profile.aiManager = {
    ...DEFAULT_AI_MANAGER_SETTINGS,
    enabled: true,
    triggerEveryNSends: 0,
    triggerEveryMinutes: 120,
    triggerOnComplete: false,
    triggerOnErrors: false,
    triggerOnWebReport: false,
    failureRetrySeconds: 60,
  };
  const repo = new MemoryRepo(state);
  let now = 1_000;
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => now,
    routePrompt: async () => ({ result: { route: 'primary', text: '{"summary":"ok","actions":[]}' } }),
  });
  await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
  const wakeAt = await manager.nextDecisionWakeAt();
  assert.equal(wakeAt, 1_000 + 120 * 60_000);
  now = wakeAt;
  assert.equal(await manager.nextDecisionWakeAt(), now);
  const result = await manager.process();
  assert.equal(result.kind, 'AI_MANAGER_ROUTER_DISABLED');
  const after = await repo.load();
  assert.equal(after.profile.aiManagerRuntime.pendingEvents.length, 1);
  assert.equal(after.profile.aiManagerRuntime.failureStreak, 1);
  assert.equal(after.profile.aiManagerRuntime.retryAfterAt, now + 60_000);
  assert.equal(await manager.nextDecisionWakeAt(), now + 60_000);
  assert.deepEqual(aiManagerDue(after.profile.aiManager, after.profile.aiManagerRuntime, now + 1), {
    due: false,
    reason: 'manager-backoff',
    wakeAt: now + 60_000,
  });
});

test('completed one-pass Session can be restarted only when the user explicitly enabled it', () => {
  const state = stateWithSession();
  const session = state.sessionsById.s1;
  session.runMode = 'ONE_PASS';
  session.runState = RunState.STOPPED;
  session.completedAt = 9_000;
  session.onePassCompletedTaskIds = ['t1'];
  session.successfulSendCount = 1;
  session.currentTaskIndex = 0;
  session.operation = { operationId: 'done', sessionId: 's1', taskId: 't1', phase: OperationPhase.SENT_VERIFIED, targetUrl: 'https://chatgpt.com/', createdAt: 1, updatedAt: 1, preSendDeadline: 0, submitStartedAt: 1, verificationDeadline: 0 };

  const decision = { summary: 'continue project', actions: [{ type: 'RESTART_COMPLETED_SESSION', sessionId: 's1', text: '' }] };
  const disabled = applyAiManagerDecision(structuredClone(state), { ...DEFAULT_AI_MANAGER_SETTINGS, allowRestartCompletedOnePass: false }, DEFAULT_AI_MANAGER_RUNTIME, decision, 10_000);
  assert.equal(disabled.applied.length, 0);
  assert.equal(disabled.skipped[0].reason, 'restart-completed-disabled');

  const enabledState = structuredClone(state);
  const enabled = applyAiManagerDecision(enabledState, { ...DEFAULT_AI_MANAGER_SETTINGS, allowRestartCompletedOnePass: true }, DEFAULT_AI_MANAGER_RUNTIME, decision, 10_000);
  assert.equal(enabled.applied.length, 1);
  assert.equal(enabledState.sessionsById.s1.runState, RunState.RUNNING);
  assert.equal(enabledState.sessionsById.s1.completedAt, 0);
  assert.deepEqual(enabledState.sessionsById.s1.onePassCompletedTaskIds, []);
  assert.equal(enabledState.sessionsById.s1.successfulSendCount, 0);
  assert.equal(enabledState.sessionsById.s1.operation, null);
});

test('AI Manager never treats an ordinary manual Stop as a completed Session restart candidate', () => {
  const state = stateWithSession();
  const session = state.sessionsById.s1;
  session.runMode = 'ONE_PASS';
  session.runState = RunState.STOPPED;
  session.completedAt = 0;
  const decision = { summary: 'do not override manual stop', actions: [{ type: 'RESTART_COMPLETED_SESSION', sessionId: 's1', text: '' }] };
  const result = applyAiManagerDecision(state, { ...DEFAULT_AI_MANAGER_SETTINGS, allowRestartCompletedOnePass: true }, DEFAULT_AI_MANAGER_RUNTIME, decision, 10_000);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].reason, 'not-safely-restartable');
  assert.equal(state.sessionsById.s1.runState, RunState.STOPPED);
});


test('AI Manager failures use durable exponential backoff without dropping pending events', async () => {
  const state = stateWithSession();
  state.profile.aiRouter.enabled = true;
  state.profile.aiRouter.primary.model = 'local';
  state.profile.aiManager = {
    ...DEFAULT_AI_MANAGER_SETTINGS,
    enabled: true,
    triggerEveryNSends: 1,
    triggerEveryMinutes: 0,
    triggerOnComplete: false,
    triggerOnErrors: false,
    failureRetrySeconds: 60,
  };
  const repo = new MemoryRepo(state);
  let now = 5_000;
  let shouldFail = true;
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => now,
    routePrompt: async () => {
      if (shouldFail) throw new Error('gateway offline');
      return { result: { route: 'primary', text: '{"summary":"recovered","actions":[]}' } };
    },
  });

  await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
  let result = await manager.process();
  assert.equal(result.kind, 'AI_MANAGER_AI_ERROR');
  let after = await repo.load();
  assert.equal(after.profile.aiManagerRuntime.pendingEvents.length, 1);
  assert.equal(after.profile.aiManagerRuntime.failureStreak, 1);
  assert.equal(after.profile.aiManagerRuntime.retryAfterAt, 65_000);
  assert.equal(nextAiManagerDecisionWakeAt(after.profile.aiManager, after.profile.aiManagerRuntime, now), 65_000);

  now = 30_000;
  result = await manager.process();
  assert.equal(result.kind, 'AI_MANAGER_IDLE');
  assert.equal(result.reason, 'manager-backoff');

  now = 65_000;
  result = await manager.process();
  assert.equal(result.kind, 'AI_MANAGER_AI_ERROR');
  after = await repo.load();
  assert.equal(after.profile.aiManagerRuntime.pendingEvents.length, 1);
  assert.equal(after.profile.aiManagerRuntime.failureStreak, 2);
  assert.equal(after.profile.aiManagerRuntime.retryAfterAt, 185_000);

  shouldFail = false;
  now = 185_000;
  result = await manager.process();
  assert.equal(result.kind, 'AI_MANAGER_DECISION_APPLIED');
  after = await repo.load();
  assert.equal(after.profile.aiManagerRuntime.pendingEvents.length, 0);
  assert.equal(after.profile.aiManagerRuntime.failureStreak, 0);
  assert.equal(after.profile.aiManagerRuntime.retryAfterAt, 0);
  assert.equal(after.profile.aiManagerRuntime.lastError, '');
});

test('invalid manager JSON also backs off durably and preserves the event queue', async () => {
  const state = stateWithSession();
  state.profile.aiRouter.enabled = true;
  state.profile.aiRouter.primary.model = 'local';
  state.profile.aiManager = {
    ...DEFAULT_AI_MANAGER_SETTINGS,
    enabled: true,
    triggerEveryNSends: 1,
    triggerEveryMinutes: 0,
    triggerOnComplete: false,
    triggerOnErrors: false,
    failureRetrySeconds: 30,
  };
  const repo = new MemoryRepo(state);
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => 10_000,
    routePrompt: async () => ({ result: { route: 'primary', text: 'not valid json' } }),
  });
  await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
  const result = await manager.process();
  assert.equal(result.kind, 'AI_MANAGER_INVALID_DECISION');
  const after = await repo.load();
  assert.equal(after.profile.aiManagerRuntime.pendingEvents.length, 1);
  assert.equal(after.profile.aiManagerRuntime.failureStreak, 1);
  assert.equal(after.profile.aiManagerRuntime.retryAfterAt, 40_000);
  assert.equal(after.profile.aiManagerRuntime.decisionCount, 0);
});


test('AI Manager persists only the latest 50 decision-history entries without handoff text', async () => {
  const state = stateWithSession();
  state.profile.aiRouter.enabled = true;
  state.profile.aiRouter.primary.model = 'local';
  state.profile.aiManager = { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, triggerEveryNSends: 1, triggerEveryMinutes: 0, triggerOnComplete: false, triggerOnErrors: false };
  const repo = new MemoryRepo(state);
  let now = 1000;
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => now,
    routePrompt: async () => ({ result: { route: 'primary', text: JSON.stringify({ summary: `decision ${now}`, actions: [{ type: 'CONTINUE', sessionId: 's1', text: 'must not be persisted' }] }) } }),
  });
  for (let i = 0; i < 55; i += 1) {
    await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
    await manager.process();
    now += 1000;
  }
  const final = await repo.load();
  const history = final.profile.aiManagerRuntime.decisionHistory;
  assert.equal(history.length, 50);
  assert.equal(history.at(-1).summary, `decision ${now - 1000}`);
  assert.equal(Object.hasOwn(history.at(-1).applied[0], 'text'), false);
});

test('TUNE_SESSION parser allowlists only bounded timing fields', () => {
  const decision = parseAiManagerDecision(JSON.stringify({
    summary: 'tune',
    actions: [{
      type: 'TUNE_SESSION', sessionId: 's1',
      tuning: {
        minimumSendIntervalMinutes: 4,
        preSendDelaySeconds: 10,
        busyCheckDelaySeconds: 2,
        retryBackoffSeconds: 45,
        prompt: 'must be ignored',
        taskCount: 999,
      },
    }],
  }));
  assert.deepEqual(decision.actions[0].tuning, {
    minimumSendIntervalMinutes: 4,
    preSendDelaySeconds: 10,
    busyCheckDelaySeconds: 2,
    retryBackoffSeconds: 45,
  });

  const invalid = parseAiManagerDecision(JSON.stringify({
    summary: 'bad tune',
    actions: [{ type: 'TUNE_SESSION', sessionId: 's1', tuning: {
      minimumSendIntervalMinutes: 0,
      preSendDelaySeconds: 31,
      busyCheckDelaySeconds: -1,
      retryBackoffSeconds: 99999,
    } }],
  }));
  assert.deepEqual(invalid.actions[0].tuning, {});
});

test('TUNE_SESSION requires explicit permission and changes only safe timing fields', () => {
  const state = stateWithSession();
  const session = state.sessionsById.s1;
  session.lastSuccessfulSendAt = 10_000;
  session.nextAllowedSendAt = 70_000;
  const decision = {
    summary: 'tune timing',
    actions: [{ type: 'TUNE_SESSION', sessionId: 's1', tuning: {
      minimumSendIntervalMinutes: 4,
      preSendDelaySeconds: 12,
      busyCheckDelaySeconds: 3,
      retryBackoffSeconds: 50,
    } }],
  };
  const denied = applyAiManagerDecision(state, { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true }, DEFAULT_AI_MANAGER_RUNTIME, decision, 20_000);
  assert.equal(denied.skipped[0].reason, 'session-tuning-disabled');
  assert.equal(session.minimumSendIntervalMs, 120_000);

  const beforePrompt = session.sharedPrompt;
  const beforeUrl = session.tasksById.t1.url;
  const applied = applyAiManagerDecision(state, { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, allowSessionTuning: true }, DEFAULT_AI_MANAGER_RUNTIME, decision, 30_000);
  assert.equal(applied.applied[0].type, 'TUNE_SESSION');
  assert.equal(session.minimumSendIntervalMs, 240_000);
  assert.equal(session.preSendDelayMs, 12_000);
  assert.equal(session.busyCheckDelayMs, 3_000);
  assert.equal(session.retryBackoffMs, 50_000);
  assert.equal(session.nextAllowedSendAt, 250_000);
  assert.equal(session.sharedPrompt, beforePrompt);
  assert.equal(session.tasksById.t1.url, beforeUrl);
});

test('TUNE_SESSION cannot mutate an in-flight or ambiguous send', () => {
  for (const phase of [OperationPhase.SUBMITTING, OperationPhase.AMBIGUOUS]) {
    const state = stateWithSession();
    const session = state.sessionsById.s1;
    session.operation = {
      operationId: 'op', sessionId: 's1', taskId: 't1', promptFingerprint: 'fp', phase,
      targetUrl: 'https://chatgpt.com/', createdAt: 1000, updatedAt: 1000, preSendDeadline: 0, submitStartedAt: phase === OperationPhase.SUBMITTING ? 1000 : 0, verificationDeadline: 2000,
    };
    const original = session.minimumSendIntervalMs;
    const result = applyAiManagerDecision(state, { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, allowSessionTuning: true }, DEFAULT_AI_MANAGER_RUNTIME, {
      summary: 'tune', actions: [{ type: 'TUNE_SESSION', sessionId: 's1', tuning: { minimumSendIntervalMinutes: 4 } }],
    }, 5000);
    assert.equal(session.minimumSendIntervalMs, original);
    assert.equal(result.skipped[0].reason, 'unsafe-or-no-change');
  }
});
