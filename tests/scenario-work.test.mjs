import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ScenarioWorkMode,
  ScenarioTimeoutPolicy,
  ScenarioPhase,
  ScenarioParticipantState,
  createScenarioWorkRuntime,
  normalizeScenarioWorkConfig,
  startScenarioWork,
  activateScheduledScenarioWork,
  pauseScenarioWork,
  resumeScenarioWork,
  planScenarioWorkActions,
  applyScenarioLaunch,
  applyScenarioCompletion,
  applyScenarioTimeout,
} from '../src/core/scenario-work.js';

function launchOne(config, runtime, now = 1_000) {
  const planned = planScenarioWorkActions(config, runtime, now);
  assert.equal(planned.actions.length, 1);
  const action = planned.actions[0];
  return { action, runtime: applyScenarioLaunch(runtime, action, { sessionId: `s:${action.participantKey}`, taskId: `t:${action.participantKey}`, now }) };
}

function complete(config, runtime, key, now = 2_000, chatUrl = 'https://chatgpt.com/c/test') {
  return applyScenarioCompletion(config, runtime, key, { now, chatUrl });
}

test('chat cycle repeats arbitrary prompt counts and starts a new chat generation after configured rounds', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'cycle', mode: ScenarioWorkMode.CHAT_CYCLE, roundsPerGeneration: 2, maxGenerations: 2,
    steps: [
      { prompt: '1', repeat: 1 },
      { prompt: '2', repeat: 2 },
      { prompt: '3', repeat: 1 },
    ],
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  const prompts = [];
  for (let i = 0; i < 8; i += 1) {
    const { action, runtime: launched } = launchOne(config, runtime, 1_000 + i * 10);
    prompts.push(action.prompt);
    runtime = complete(config, launched, 'chat', 1_005 + i * 10, 'https://chatgpt.com/c/shared');
  }
  assert.deepEqual(prompts, ['1','2','2','3','1','2','2','3']);
  assert.equal(runtime.generation, 2);
  assert.equal(runtime.round, 0);
  assert.equal(runtime.chat.chatUrl, '');
  assert.equal(runtime.chat.state, ScenarioParticipantState.NEW);
});

test('pair keeps strict auditor-worker affinity and independent rounds', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'pairs', mode: ScenarioWorkMode.PAIRS, pairCount: 2, roundsPerGeneration: 2,
    auditorBootstrapPrompt: 'A0', workerBootstrapPrompt: 'W0', auditorCyclePrompt: 'A', workerCyclePrompt: 'W',
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  let planned = planScenarioWorkActions(config, runtime, 100);
  assert.deepEqual(planned.actions.map(a => a.participantKey).sort(), ['pair:1:auditor','pair:2:auditor']);
  for (const action of planned.actions) runtime = applyScenarioLaunch(runtime, action, { sessionId: `s-${action.participantKey}`, taskId: 't', now: 100 });
  runtime = complete(config, runtime, 'pair:2:auditor', 200, 'https://chatgpt.com/c/a2');
  planned = planScenarioWorkActions(config, runtime, 201);
  assert.deepEqual(planned.actions.map(a => a.participantKey), ['pair:2:worker']);
});

test('auditor group waits for every worker before advancing the barrier', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'group', mode: ScenarioWorkMode.AUDITOR_GROUP, workerCount: 3, roundsPerGeneration: 2,
    auditorBootstrapPrompt: 'A0', workerBootstrapPrompt: 'W0', auditorCyclePrompt: 'A', workerCyclePrompt: 'W',
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  let step = launchOne(config, runtime, 100); runtime = step.runtime;
  runtime = complete(config, runtime, 'group:auditor', 200, 'https://chatgpt.com/c/a');
  let planned = planScenarioWorkActions(config, runtime, 201);
  assert.equal(planned.actions.length, 3);
  for (const action of planned.actions) runtime = applyScenarioLaunch(runtime, action, { sessionId: `s-${action.participantKey}`, taskId: 't', now: 201 });
  runtime = complete(config, runtime, 'group:worker:1', 300, 'https://chatgpt.com/c/w1');
  runtime = complete(config, runtime, 'group:worker:2', 301, 'https://chatgpt.com/c/w2');
  assert.equal(runtime.group.phase, ScenarioPhase.BOOTSTRAP_WORKERS);
  runtime = complete(config, runtime, 'group:worker:3', 302, 'https://chatgpt.com/c/w3');
  assert.equal(runtime.group.phase, ScenarioPhase.AUDITOR_WORK);
});

test('timed out worker sends special auditor recovery turn before replacement worker bootstrap', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'group-timeout', mode: ScenarioWorkMode.AUDITOR_GROUP, workerCount: 2,
    timeoutPolicy: ScenarioTimeoutPolicy.REPLACE_MEMBER,
    timeoutAuditorPrompt: 'SPECIAL', workerBootstrapPrompt: 'WORKER-BOOT', auditorCyclePrompt: 'AUDIT', workerCyclePrompt: 'WORK',
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  runtime.group.phase = ScenarioPhase.WORKERS_WORK;
  runtime.group.auditor.state = ScenarioParticipantState.READY;
  runtime.group.auditor.chatUrl = 'https://chatgpt.com/c/a';
  runtime.group.workers['1'].state = ScenarioParticipantState.WAITING;
  runtime.group.workers['1'].stage = 'WORKER_WORK';
  runtime.group.workers['1'].deadlineAt = 100;
  runtime.group.workers['2'].state = ScenarioParticipantState.READY;
  let planned = planScenarioWorkActions(config, runtime, 101);
  assert.equal(planned.actions[0].type, 'TIMEOUT');
  runtime = applyScenarioTimeout(config, runtime, planned.actions[0].participantKey, { now: 101 });
  planned = planScenarioWorkActions(config, runtime, 102);
  assert.equal(planned.actions[0].prompt, 'SPECIAL');
  runtime = applyScenarioLaunch(runtime, planned.actions[0], { sessionId: 'audit-recovery', taskId: 't', now: 102 });
  runtime = complete(config, runtime, 'group:auditor', 200, 'https://chatgpt.com/c/a');
  planned = planScenarioWorkActions(config, runtime, 201);
  assert.equal(planned.actions[0].participantKey, 'group:worker:1');
  assert.equal(planned.actions[0].prompt, 'WORKER-BOOT');
});

test('restart-group timeout rebuilds whole team only after recovery auditor turn', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'restart', mode: ScenarioWorkMode.AUDITOR_GROUP, workerCount: 2,
    timeoutPolicy: ScenarioTimeoutPolicy.RESTART_GROUP,
    timeoutAuditorPrompt: 'TIMEOUT', replacementAuditorPrompt: 'NEW AUDITOR', workerBootstrapPrompt: 'NEW WORKER',
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  runtime.group.phase = ScenarioPhase.WORKERS_WORK;
  runtime.group.auditor.state = ScenarioParticipantState.READY;
  runtime.group.auditor.chatUrl = 'https://chatgpt.com/c/a';
  runtime.group.workers['1'].state = ScenarioParticipantState.WAITING;
  runtime.group.workers['1'].deadlineAt = 100;
  runtime.group.workers['2'].state = ScenarioParticipantState.READY;
  runtime = applyScenarioTimeout(config, runtime, 'group:worker:1', { now: 101 });
  let planned = planScenarioWorkActions(config, runtime, 102);
  assert.equal(planned.actions[0].prompt, 'TIMEOUT');
  runtime = applyScenarioLaunch(runtime, planned.actions[0], { sessionId: 'recovery', taskId: 't', now: 102 });
  runtime = complete(config, runtime, 'group:auditor', 200, 'https://chatgpt.com/c/a');
  assert.equal(runtime.group.phase, ScenarioPhase.REPLACEMENT_BOOTSTRAP);
  assert.equal(runtime.group.auditor.state, ScenarioParticipantState.NEW);
  assert.equal(runtime.group.workers['1'].state, ScenarioParticipantState.NEW);
  assert.equal(runtime.group.workers['2'].state, ScenarioParticipantState.NEW);
});

test('minimum launch gap serializes otherwise parallel group launches', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'gap', mode: ScenarioWorkMode.AUDITOR_GROUP, workerCount: 4, minimumLaunchGapSeconds: 10,
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  runtime.group.phase = ScenarioPhase.BOOTSTRAP_WORKERS;
  runtime.group.auditor.state = ScenarioParticipantState.READY;
  let planned = planScenarioWorkActions(config, runtime, 1000);
  assert.equal(planned.actions.length, 1);
  runtime = applyScenarioLaunch(runtime, planned.actions[0], { sessionId: 's1', taskId: 't1', now: 1000 });
  planned = planScenarioWorkActions(config, runtime, 5000);
  assert.equal(planned.actions.length, 0);
  planned = planScenarioWorkActions(config, runtime, 11000);
  assert.equal(planned.actions.length, 1);
});

test('participant timeout is detected even while minimum launch gap is still closed', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'timeout-before-gap', mode: ScenarioWorkMode.AUDITOR_GROUP, workerCount: 1,
    minimumLaunchGapSeconds: 60,
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  runtime.lastLaunchAt = 90_000;
  runtime.group.phase = ScenarioPhase.WORKERS_WORK;
  runtime.group.auditor.state = ScenarioParticipantState.READY;
  runtime.group.workers['1'].state = ScenarioParticipantState.WAITING;
  runtime.group.workers['1'].stage = 'WORKER_WORK';
  runtime.group.workers['1'].deadlineAt = 100_000;

  const planned = planScenarioWorkActions(config, runtime, 100_001);
  assert.deepEqual(planned.actions, [{ type: 'TIMEOUT', participantKey: 'group:worker:1' }]);
});

test('pair replacement auditor resumes auditor work when worker is already bootstrapped', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'pair-auditor-replace', mode: ScenarioWorkMode.PAIRS, pairCount: 1,
    auditorCyclePrompt: 'AUDIT', replacementAuditorPrompt: 'NEW AUDITOR',
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  const pair = runtime.pairs['1'];
  pair.phase = ScenarioPhase.AUDITOR_WORK;
  pair.worker.state = ScenarioParticipantState.READY;
  pair.worker.chatUrl = 'https://chatgpt.com/c/worker';
  pair.auditor.state = ScenarioParticipantState.WAITING;
  pair.auditor.stage = 'AUDITOR_WORK';
  pair.auditor.deadlineAt = 100;

  runtime = applyScenarioTimeout(config, runtime, pair.auditor.key, { now: 101 });
  let planned = planScenarioWorkActions(config, runtime, 102);
  assert.equal(planned.actions[0].stage, 'REPLACEMENT_AUDITOR');
  runtime = applyScenarioLaunch(runtime, planned.actions[0], { sessionId: 'replacement-auditor', taskId: 't', now: 102 });
  runtime = complete(config, runtime, pair.auditor.key, 103, 'https://chatgpt.com/c/new-auditor');
  assert.equal(runtime.pairs['1'].phase, ScenarioPhase.AUDITOR_WORK);

  planned = planScenarioWorkActions(config, runtime, 104);
  assert.equal(planned.actions[0].participantKey, pair.auditor.key);
  assert.equal(planned.actions[0].stage, 'AUDITOR_WORK');
});

test('restart-group rebuilds workers and replacement auditor before returning to normal work', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'restart-full-team', mode: ScenarioWorkMode.AUDITOR_GROUP, workerCount: 2,
    timeoutPolicy: ScenarioTimeoutPolicy.RESTART_GROUP,
    timeoutAuditorPrompt: 'RECOVER', replacementAuditorPrompt: 'NEW AUDITOR',
    workerBootstrapPrompt: 'NEW WORKER', auditorCyclePrompt: 'AUDIT',
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  runtime.group.phase = ScenarioPhase.WORKERS_WORK;
  runtime.group.auditor.state = ScenarioParticipantState.READY;
  runtime.group.auditor.chatUrl = 'https://chatgpt.com/c/a';
  runtime.group.workers['1'].state = ScenarioParticipantState.WAITING;
  runtime.group.workers['1'].stage = 'WORKER_WORK';
  runtime.group.workers['1'].deadlineAt = 100;
  runtime.group.workers['2'].state = ScenarioParticipantState.READY;

  runtime = applyScenarioTimeout(config, runtime, 'group:worker:1', { now: 101 });
  let planned = planScenarioWorkActions(config, runtime, 102);
  assert.equal(planned.actions[0].stage, 'TIMEOUT_AUDITOR');
  runtime = applyScenarioLaunch(runtime, planned.actions[0], { sessionId: 'recover', taskId: 't', now: 102 });
  runtime = complete(config, runtime, 'group:auditor', 103, 'https://chatgpt.com/c/a');
  assert.equal(runtime.group.phase, ScenarioPhase.REPLACEMENT_BOOTSTRAP);

  planned = planScenarioWorkActions(config, runtime, 104);
  assert.equal(planned.actions.length, 2);
  assert.ok(planned.actions.every(action => action.stage === 'REPLACEMENT_WORKER'));
  for (const action of planned.actions) {
    runtime = applyScenarioLaunch(runtime, action, { sessionId: `s:${action.participantKey}`, taskId: `t:${action.participantKey}`, now: 104 });
  }
  runtime = complete(config, runtime, 'group:worker:1', 105, 'https://chatgpt.com/c/w1-new');
  runtime = complete(config, runtime, 'group:worker:2', 106, 'https://chatgpt.com/c/w2-new');
  assert.equal(runtime.group.phase, ScenarioPhase.REPLACEMENT_BOOTSTRAP);
  assert.equal(runtime.group.auditor.state, ScenarioParticipantState.NEW);

  planned = planScenarioWorkActions(config, runtime, 107);
  assert.equal(planned.actions.length, 1);
  assert.equal(planned.actions[0].stage, 'REPLACEMENT_AUDITOR');
  runtime = applyScenarioLaunch(runtime, planned.actions[0], { sessionId: 'new-auditor', taskId: 'ta', now: 107 });
  runtime = complete(config, runtime, 'group:auditor', 108, 'https://chatgpt.com/c/a-new');
  assert.equal(runtime.group.phase, ScenarioPhase.AUDITOR_WORK);

  planned = planScenarioWorkActions(config, runtime, 109);
  assert.equal(planned.actions.length, 1);
  assert.equal(planned.actions[0].stage, 'AUDITOR_WORK');
});

test('worker timeout discovered while recovery auditor is busy is not lost when auditor completes', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'busy-recovery-auditor', mode: ScenarioWorkMode.AUDITOR_GROUP, workerCount: 2,
    timeoutPolicy: ScenarioTimeoutPolicy.REPLACE_MEMBER,
    timeoutAuditorPrompt: 'RECOVER',
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  runtime.group.phase = ScenarioPhase.TIMEOUT_AUDITOR;
  runtime.group.auditor.state = ScenarioParticipantState.WAITING;
  runtime.group.auditor.stage = 'TIMEOUT_AUDITOR';
  runtime.group.auditor.sessionId = 'auditor-recovery';
  runtime.group.auditor.deadlineAt = 1_000;
  runtime.group.workers['1'].state = ScenarioParticipantState.TIMED_OUT;
  runtime.group.timedOutWorkerIndexes = [1];
  runtime.group.workers['2'].state = ScenarioParticipantState.WAITING;
  runtime.group.workers['2'].stage = 'WORKER_WORK';
  runtime.group.workers['2'].deadlineAt = 100;

  runtime = applyScenarioTimeout(config, runtime, 'group:worker:2', { now: 101 });
  assert.deepEqual(runtime.group.timedOutWorkerIndexes.sort(), [1, 2]);
  assert.equal(runtime.group.auditor.state, ScenarioParticipantState.WAITING);

  runtime = complete(config, runtime, 'group:auditor', 200, 'https://chatgpt.com/c/a');
  assert.equal(runtime.group.phase, ScenarioPhase.REPLACEMENT_BOOTSTRAP);
  assert.equal(runtime.group.workers['1'].state, ScenarioParticipantState.NEW);
  assert.equal(runtime.group.workers['2'].state, ScenarioParticipantState.NEW);
});

test('auditor timeout during worker recovery preserves recovery after replacement auditor bootstrap', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'recovery-auditor-timeout', mode: ScenarioWorkMode.AUDITOR_GROUP, workerCount: 1,
    timeoutPolicy: ScenarioTimeoutPolicy.REPLACE_MEMBER,
    timeoutAuditorPrompt: 'RECOVER', replacementAuditorPrompt: 'NEW AUDITOR',
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 0), 0);
  runtime.group.phase = ScenarioPhase.TIMEOUT_AUDITOR;
  runtime.group.workers['1'].state = ScenarioParticipantState.TIMED_OUT;
  runtime.group.timedOutWorkerIndexes = [1];
  runtime.group.auditor.state = ScenarioParticipantState.WAITING;
  runtime.group.auditor.stage = 'TIMEOUT_AUDITOR';
  runtime.group.auditor.deadlineAt = 100;

  runtime = applyScenarioTimeout(config, runtime, 'group:auditor', { now: 101 });
  let planned = planScenarioWorkActions(config, runtime, 102);
  assert.equal(planned.actions[0].stage, 'REPLACEMENT_AUDITOR');
  runtime = applyScenarioLaunch(runtime, planned.actions[0], { sessionId: 'new-auditor', taskId: 'ta', now: 102 });
  runtime = complete(config, runtime, 'group:auditor', 103, 'https://chatgpt.com/c/a2');
  assert.equal(runtime.group.phase, ScenarioPhase.TIMEOUT_AUDITOR);

  planned = planScenarioWorkActions(config, runtime, 104);
  assert.equal(planned.actions.length, 1);
  assert.equal(planned.actions[0].stage, 'TIMEOUT_AUDITOR');
});


test('scenario delayed start waits durably and resumes into RUNNING only when due', () => {
  const config = normalizeScenarioWorkConfig({
    id: 'scheduled',
    mode: ScenarioWorkMode.CHAT_CYCLE,
    startNotBeforeAt: 10_000,
    steps: [{ prompt: 'ONE' }],
  });
  let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, 1_000), 1_000);
  assert.equal(runtime.runState, ScenarioWorkRunState.WAITING_SCHEDULE);
  assert.equal(runtime.scheduledStartAt, 10_000);
  assert.deepEqual(planScenarioWorkActions(config, runtime, 5_000).actions, []);

  runtime = pauseScenarioWork(runtime, 5_001);
  assert.equal(runtime.runState, ScenarioWorkRunState.PAUSED);
  runtime = resumeScenarioWork(runtime, 5_002);
  assert.equal(runtime.runState, ScenarioWorkRunState.WAITING_SCHEDULE);

  runtime = activateScheduledScenarioWork(runtime, 9_999);
  assert.equal(runtime.runState, ScenarioWorkRunState.WAITING_SCHEDULE);
  runtime = activateScheduledScenarioWork(runtime, 10_000);
  assert.equal(runtime.runState, ScenarioWorkRunState.RUNNING);
  assert.equal(runtime.scheduledStartAt, 0);
  assert.equal(planScenarioWorkActions(config, runtime, 10_000).actions.length, 1);
});
