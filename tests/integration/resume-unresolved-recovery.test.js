import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState } from '../../src/core/schema.js';

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

function pausedState(phase) {
  const state = createEmptyState(0);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/c/resume-recovery' });
  const session = createSession({
    id: 's1',
    name: 'resume recovery',
    tasks: [task],
    sharedPrompt: 'continue',
    now: 0,
  });
  session.version = 1;
  session.runState = RunState.PAUSED;
  session.operation = {
    operationId: 'op1',
    sessionId: 's1',
    taskId: 't1',
    promptFingerprint: 'fp1',
    promptText: 'continue',
    phase,
    targetUrl: task.normalizedUrl,
    createdAt: 10,
    updatedAt: 20,
    preSendDeadline: phase === OperationPhase.PRE_SEND_WAIT ? 1000 : 0,
    submitStartedAt: phase === OperationPhase.SUBMITTING ? 20 : 0,
    verificationDeadline: 0,
  };
  if (phase === OperationPhase.MANUAL_REVIEW) {
    task.status = 'MANUAL_REVIEW';
    task.manualReviewReason = 'MANUAL_REVIEW_REQUIRED';
  }
  state.sessionsById.s1 = session;
  state.sessionOrder = ['s1'];
  return state;
}

for (const phase of [OperationPhase.AMBIGUOUS, OperationPhase.PRE_SEND_WAIT]) {
  test(`explicit Resume preserves ${phase} evidence and enters RECOVERING`, async () => {
    const repo = new Repo(pausedState(phase));
    const dispatcher = new CoreCommandDispatcher(repo, () => 100, { executionAvailable: true });

    const result = await dispatcher.execute(CoreCommand.RESUME_SESSION, { sessionId: 's1' });
    const after = await repo.load();

    assert.equal(result.session.runState, RunState.RECOVERING);
    assert.equal(after.sessionsById.s1.runState, RunState.RECOVERING);
    assert.equal(after.sessionsById.s1.operation.operationId, 'op1');
    assert.equal(after.sessionsById.s1.operation.phase, phase);
    assert.equal(after.sessionsById.s1.operation.promptFingerprint, 'fp1');
  });
}

test('explicit Resume cannot bypass MANUAL_REVIEW', async () => {
  const repo = new Repo(pausedState(OperationPhase.MANUAL_REVIEW));
  const dispatcher = new CoreCommandDispatcher(repo, () => 100, { executionAvailable: true });

  await assert.rejects(
    () => dispatcher.execute(CoreCommand.RESUME_SESSION, { sessionId: 's1' }),
    /Resolve manual review before resuming/,
  );
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.equal(after.sessionsById.s1.operation.phase, OperationPhase.MANUAL_REVIEW);
});
