import test from 'node:test';
import assert from 'node:assert/strict';
import { AiAutonomyManager, DEFAULT_AI_MANAGER_SETTINGS } from '../src/core/ai-manager.js';
import { composePromptForSession } from '../src/core/automatic-executor.js';
import { applyInteractionResult } from '../src/core/execution.js';
import { createEmptyState, createSession, createTask, PromptMode, RunMode, RunState, TabStrategy, validateState } from '../src/core/schema.js';
import { InteractionResult } from '../src/shared/protocol.js';

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

function fixture() {
  const state = createEmptyState(1);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
  const session = createSession({ id: 's1', name: 'Worker', tasks: [task], sharedPrompt: 'ORIGINAL WEB WORK', promptMode: PromptMode.SHARED, runMode: RunMode.ONE_PASS, tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK, now: 1 });
  session.runState = RunState.RUNNING;
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  state.profile.aiRouter.enabled = true;
  state.profile.aiRouter.primary.model = 'local-small';
  state.profile.aiRouter.strong.model = 'strong-model';
  state.profile.aiManager = { ...DEFAULT_AI_MANAGER_SETTINGS, enabled: true, triggerEveryNSends: 0, triggerEveryMinutes: 0, triggerOnComplete: false, triggerOnErrors: false, triggerOnWebReport: true, captureWebReports: true, webReportPollSeconds: 5 };
  return state;
}

test('web-worker report can become manager handoff, enter next prompt once, then clear only after verified send', async () => {
  const state = fixture();
  state.sessionsById.s1.tasksById.t1.lastConversationUrl = 'https://chatgpt.com/c/e2e-worker';
  state.sessionsById.s1.tasksById.t1.lastAssistantBaselineKnown = true;
  state.sessionsById.s1.tasksById.t1.lastAssistantBaselineCount = 0;
  const repo = new MemoryRepo(state);
  let now = 1_000;
  const routeCalls = [];
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => now,
    collectWebReport: async () => ({ ready: true, text: 'WEB WORKER REPORT: integration is green; next blocker is packaging.', code: 'ASSISTANT_RESPONSE_READY' }),
    routePrompt: async request => {
      routeCalls.push(request.prompt);
      assert.match(request.prompt, /WEB WORKER REPORT: integration is green/);
      // This stands in for primary->strong hybrid routing. Manager consumes the
      // final routed JSON decision, regardless of which configured model won.
      return { result: { route: 'strong', text: JSON.stringify({ summary: 'strong review complete', actions: [{ type: 'HANDOFF_NEXT', sessionId: 's1', text: 'Packaging is the next blocker; verify packaged artifact before starting a new feature.' }] }) } };
    },
  });

  await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
  now += 5_000;
  assert.equal((await manager.collectOneDueReport()).kind, 'AI_REPORT_COLLECTED');
  assert.equal((await manager.process()).kind, 'AI_MANAGER_DECISION_APPLIED');
  assert.equal(routeCalls.length, 1);

  let live = await repo.load();
  const session = live.sessionsById.s1;
  const task = session.tasksById.t1;
  const composed = composePromptForSession(session, task);
  assert.match(composed, /^ORIGINAL WEB WORK/);
  assert.match(composed, /ЛОКАЛЬНИЙ AI-КООРДИНАТОР/);
  assert.match(composed, /Packaging is the next blocker/);

  // A non-verified result must not consume the handoff.
  session.operation = { operationId: 'op1', sessionId: 's1', taskId: 't1', promptFingerprint: 'fp', phase: 'INSERTED', targetUrl: 'https://chatgpt.com/', createdAt: now, updatedAt: now, preSendDeadline: now, submitStartedAt: 0, verificationDeadline: 0 };
  applyInteractionResult(session, 0, { status: InteractionResult.BUSY }, { now: now + 1, promptFingerprint: 'fp' });
  assert.ok(session.aiCoordinatorHandoff);

  // A positively verified send consumes it exactly once.
  session.operation = { operationId: 'op2', sessionId: 's1', taskId: 't1', promptFingerprint: 'fp2', phase: 'SUBMITTING', targetUrl: 'https://chatgpt.com/', createdAt: now, updatedAt: now, preSendDeadline: now, submitStartedAt: now, verificationDeadline: now + 1000 };
  applyInteractionResult(session, 0, { status: InteractionResult.SENT_VERIFIED, normalizedObservedUrl: 'https://chatgpt.com/c/next' }, { now: now + 2, promptFingerprint: 'fp2' });
  assert.equal(session.aiCoordinatorHandoff, '');
  assert.equal(composePromptForSession(session, task), 'ORIGINAL WEB WORK');
});

test('normal one-pass completion can hand off context and restart the same Session in one manager decision', async () => {
  const state = fixture();
  const session = state.sessionsById.s1;
  session.runState = RunState.STOPPED;
  session.completedAt = 20_000;
  session.onePassCompletedTaskIds = ['t1'];
  session.successfulSendCount = 1;
  state.profile.aiManager = {
    ...state.profile.aiManager,
    triggerOnComplete: true,
    allowRestartCompletedOnePass: true,
    appendHandoffToNextPrompt: true,
  };
  const repo = new MemoryRepo(state);
  const manager = new AiAutonomyManager({
    repository: repo,
    now: () => 21_000,
    routePrompt: async () => ({
      result: {
        route: 'strong',
        text: JSON.stringify({
          summary: 'continue the project with the next blocker',
          actions: [
            { type: 'HANDOFF_NEXT', sessionId: 's1', text: 'Previous pass completed. Continue with the next unresolved blocker and do not repeat already integrated work.' },
            { type: 'RESTART_COMPLETED_SESSION', sessionId: 's1', text: '' },
          ],
        }),
      },
    }),
  });

  await manager.capture([{ sessionId: 's1', result: { kind: 'COMPLETE' } }], state);
  const result = await manager.process();
  assert.equal(result.kind, 'AI_MANAGER_DECISION_APPLIED');
  assert.equal(result.applied.map(action => action.type).join(','), 'HANDOFF_NEXT,RESTART_COMPLETED_SESSION');

  const live = await repo.load();
  const restarted = live.sessionsById.s1;
  assert.equal(restarted.runState, RunState.RUNNING);
  assert.equal(restarted.completedAt, 0);
  assert.equal(restarted.successfulSendCount, 0);
  assert.deepEqual(restarted.onePassCompletedTaskIds, []);
  assert.match(composePromptForSession(restarted, restarted.tasksById.t1), /Previous pass completed/);
});
