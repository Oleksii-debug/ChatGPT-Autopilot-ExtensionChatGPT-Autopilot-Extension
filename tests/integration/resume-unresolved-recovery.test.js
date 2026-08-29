import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { CoreCommand } from '../../src/shared/protocol.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunState, validateState } from '../../src/core/schema.js';

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

function addUnresolvedOwner(state, url = 'https://chatgpt.com/c/resume-recovery') {
  const task = createTask({ id: 'owner-task', url });
  const owner = createSession({
    id: 'owner',
    name: 'owner',
    tasks: [task],
    sharedPrompt: 'continue',
    now: 0,
  });
  owner.runState = RunState.STOPPED;
  owner.operation = {
    operationId: 'owner-op',
    sessionId: owner.id,
    taskId: task.id,
    promptFingerprint: 'owner-fp',
    promptText: 'continue',
    phase: OperationPhase.AMBIGUOUS,
    targetUrl: task.normalizedUrl,
    createdAt: 10,
    updatedAt: 20,
    preSendDeadline: 0,
    submitStartedAt: 0,
    verificationDeadline: 0,
  };
  state.sessionsById[owner.id] = owner;
  state.sessionOrder.unshift(owner.id);
  return owner;
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

test('explicit Resume reserves an unresolved operation target even when its bound Task is disabled', async () => {
  const state = pausedState(OperationPhase.AMBIGUOUS);
  state.sessionsById.s1.tasksById.t1.enabled = false;
  addUnresolvedOwner(state);
  assert.doesNotThrow(() => validateState(state));

  const repo = new Repo(state);
  const dispatcher = new CoreCommandDispatcher(repo, () => 100, { executionAvailable: true });

  await assert.rejects(
    () => dispatcher.execute(CoreCommand.RESUME_SESSION, { sessionId: 's1' }),
    /Another active or unresolved session already owns/i,
  );
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.equal(after.sessionsById.s1.operation.operationId, 'op1');
  assert.equal(after.sessionsById.s1.operation.promptFingerprint, 'fp1');
  assert.equal(after.sessionsById.s1.operation.targetUrl, 'https://chatgpt.com/c/resume-recovery');
});

test('explicit Resume treats a RECOVERING unresolved owner target as reserved when its bound Task is disabled', async () => {
  const state = pausedState(OperationPhase.AMBIGUOUS);
  state.sessionsById.s1.tasksById.t1.enabled = false;
  const owner = addUnresolvedOwner(state);
  owner.runState = RunState.RECOVERING;
  owner.tasksById['owner-task'].enabled = false;
  assert.doesNotThrow(() => validateState(state));

  const repo = new Repo(state);
  const dispatcher = new CoreCommandDispatcher(repo, () => 100, { executionAvailable: true });

  await assert.rejects(
    () => dispatcher.execute(CoreCommand.RESUME_SESSION, { sessionId: 's1' }),
    /Another active or unresolved session already owns/i,
  );
  const after = await repo.load();
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.equal(after.sessionsById.s1.operation.operationId, 'op1');
  assert.equal(after.sessionsById.owner.runState, RunState.RECOVERING);
  assert.equal(after.sessionsById.owner.tasksById['owner-task'].enabled, false);
  assert.equal(after.sessionsById.owner.operation.operationId, 'owner-op');
  assert.equal(after.sessionsById.owner.operation.targetUrl, 'https://chatgpt.com/c/resume-recovery');
});

test('MASTER_RESUME keeps a conflicting Session paused when a RECOVERING owner reserves the same unresolved disabled-Task target', async () => {
  const state = pausedState(OperationPhase.AMBIGUOUS);
  const candidate = state.sessionsById.s1;
  candidate.tasksById.t1.enabled = false;
  candidate.pausedByMaster = true;
  state.profile.masterPaused = true;
  const owner = addUnresolvedOwner(state);
  owner.runState = RunState.RECOVERING;
  owner.tasksById['owner-task'].enabled = false;
  assert.doesNotThrow(() => validateState(state));

  const repo = new Repo(state);
  const dispatcher = new CoreCommandDispatcher(repo, () => 100, { executionAvailable: true });

  assert.deepEqual(await dispatcher.execute(CoreCommand.MASTER_RESUME), { masterPaused: false });
  const after = await repo.load();
  assert.equal(after.profile.masterPaused, false);
  assert.equal(after.sessionsById.s1.runState, RunState.PAUSED);
  assert.equal(after.sessionsById.s1.pausedByMaster, false);
  assert.equal(after.sessionsById.s1.operation.operationId, 'op1');
  assert.equal(after.sessionsById.owner.runState, RunState.RECOVERING);
  assert.equal(after.sessionsById.owner.operation.operationId, 'owner-op');
  assert.equal(after.sessionsById.owner.operation.targetUrl, 'https://chatgpt.com/c/resume-recovery');
});

test('fresh Start cannot take a URL reserved by a RECOVERING unresolved owner whose bound Task is disabled', async () => {
  const state = createEmptyState(0);
  const candidateTask = createTask({ id: 'candidate-task', url: 'https://chatgpt.com/c/resume-recovery' });
  const candidate = createSession({
    id: 'candidate',
    name: 'candidate',
    tasks: [candidateTask],
    sharedPrompt: 'continue',
    now: 0,
  });
  const owner = addUnresolvedOwner(state);
  owner.runState = RunState.RECOVERING;
  owner.tasksById['owner-task'].enabled = false;
  state.sessionsById[candidate.id] = candidate;
  state.sessionOrder.push(candidate.id);
  assert.doesNotThrow(() => validateState(state));

  const repo = new Repo(state);
  const dispatcher = new CoreCommandDispatcher(repo, () => 100, { executionAvailable: true });

  await assert.rejects(
    () => dispatcher.execute(CoreCommand.START_SESSION, { sessionId: candidate.id }),
    /Another active or unresolved session already owns/i,
  );
  const after = await repo.load();
  assert.equal(after.sessionsById.candidate.runState, RunState.STOPPED);
  assert.equal(after.sessionsById.owner.runState, RunState.RECOVERING);
  assert.equal(after.sessionsById.owner.tasksById['owner-task'].enabled, false);
  assert.equal(after.sessionsById.owner.operation.operationId, 'owner-op');
  assert.equal(after.sessionsById.owner.operation.targetUrl, 'https://chatgpt.com/c/resume-recovery');
});