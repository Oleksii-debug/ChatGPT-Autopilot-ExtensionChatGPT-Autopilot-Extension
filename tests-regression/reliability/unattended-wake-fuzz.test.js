import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextWake } from '../../src/core/recovery.js';
import { createEmptyState, createSession, createTask, OperationPhase, RunMode, RunState } from '../../src/core/schema.js';

function lcg(seed) {
  let x = seed >>> 0;
  return () => ((x = (1664525 * x + 1013904223) >>> 0) / 0x100000000);
}

test('20000 randomized unattended active states always retain a finite wake when work remains', () => {
  const rnd = lcg(0x12c0ffee);
  const phases = [
    OperationPhase.NONE, OperationPhase.FAILED_SAFE, OperationPhase.SENT_VERIFIED,
    OperationPhase.CHECKING, OperationPhase.READY, OperationPhase.INSERTING,
    OperationPhase.INSERTED, OperationPhase.PRE_SEND_WAIT, OperationPhase.AMBIGUOUS,
  ];
  for (let iteration = 0; iteration < 20000; iteration++) {
    const now = 1_000_000 + iteration;
    const tasks = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => {
      const t = createTask({ id: `t${i}`, url: 'https://chatgpt.com/' });
      t.retryAfterAt = rnd() < 0.55 ? 0 : now + 1 + Math.floor(rnd() * 120_000);
      return t;
    });
    const session = createSession({
      id: 's', name: 'Fuzz', tasks, sharedPrompt: 'p',
      runMode: rnd() < 0.5 ? RunMode.ONE_PASS : RunMode.CONTINUOUS,
      minimumSendIntervalMs: 60_000, retryBackoffMs: 15_000, now: 0,
    });
    session.retryPolicy = 'safe';
    session.urlMode = 'shared';
    session.runState = rnd() < 0.5 ? RunState.RUNNING : RunState.RECOVERING;
    session.currentTaskIndex = Math.floor(rnd() * tasks.length);
    session.nextAllowedSendAt = rnd() < 0.35 ? now + 1 + Math.floor(rnd() * 60_000) : 0;

    // Keep at least one enabled, not-completed task so an active unattended
    // session has real work and therefore must never become alarm-less.
    const liveTask = session.tasksById[session.taskOrder[session.currentTaskIndex]];
    liveTask.enabled = true;
    liveTask.manualReviewReason = '';
    session.onePassCompletedTaskIds = session.taskOrder.filter(id => id !== liveTask.id && rnd() < 0.25);

    const phase = phases[Math.floor(rnd() * phases.length)];
    if (phase !== OperationPhase.NONE) {
      session.operation = {
        operationId: `op-${iteration}`, sessionId: 's', taskId: liveTask.id,
        promptFingerprint: `fp-${iteration}`, promptText: 'p', targetUrl: liveTask.normalizedUrl,
        phase, createdAt: now - 1000, updatedAt: now - 500,
        preSendDeadline: phase === OperationPhase.PRE_SEND_WAIT ? now + Math.floor(rnd() * 30_000) : 0,
        submitStartedAt: phase === OperationPhase.AMBIGUOUS ? now - 500 : 0,
        verificationDeadline: phase === OperationPhase.AMBIGUOUS ? now + 30_000 : 0,
      };
    }

    const state = createEmptyState(0);
    state.sessionsById.s = session;
    state.sessionOrder = ['s'];
    if (rnd() < 0.2) state.sendArbiter.profileNextAllowedSendAt = now + 1 + Math.floor(rnd() * 60_000);
    const wake = computeNextWake(state, now);
    assert.equal(Number.isFinite(wake), true, `iteration=${iteration}, phase=${phase}, run=${session.runState}`);
    assert.ok(wake >= now, `wake must not be in the past at iteration=${iteration}`);
  }
});
