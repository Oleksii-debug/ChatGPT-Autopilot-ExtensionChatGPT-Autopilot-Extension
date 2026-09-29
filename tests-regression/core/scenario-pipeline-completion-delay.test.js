import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPipelineRuntime,
  normalizePipelineConfig,
  planPipelineActions,
  applyPipelineLaunch,
  applyPipelineAssistantCompletion,
} from '../../src/core/scenario-pipeline.js';

function config(overrides = {}) {
  return normalizePipelineConfig({
    id: 'pipeline-delay',
    firstCount: 1,
    secondCount: 0,
    auditTimeboxMinutes: 30,
    maxCorrectionAttempts: 2,
    maxReplacementAttempts: 1,
    firstWorkerPrompt: 'Do first work.',
    secondWorkerPrompt: 'Do second work.',
    auditorPrompt: 'Audit.',
    ...overrides,
  }, {
    id: 'pipeline-delay',
    name: 'Pipeline delay',
    mode: 'AUDITOR_PIPELINE',
    enabled: true,
    roundsPerGeneration: 2,
    maxGenerations: 1,
    responseTimeoutMinutes: 40,
    pollSeconds: 15,
    minimumLaunchGapSeconds: 60,
    preSendDelaySeconds: 1,
    busyCheckDelaySeconds: 1,
    retryBackoffSeconds: 5,
    workerLaunchUrl: 'https://chatgpt.com/',
    auditorLaunchUrl: 'https://chatgpt.com/',
    workerCyclePrompt: 'Work.',
    auditorCyclePrompt: 'Audit.',
  });
}

test('Scenario pipeline invalid completed answer delays correction from completion time', () => {
  const cfg = config();
  let runtime = createPipelineRuntime(cfg, 1_000, {
    scenarioId: cfg.id,
    runState: 'RUNNING',
    generation: 1,
    createdAt: 1_000,
    totalLaunches: 0,
    totalCompletedTurns: 0,
  });

  let planned = planPipelineActions(cfg, runtime, 1_000);
  assert.equal(planned.actions.length, 1);
  const first = planned.actions[0];
  runtime = applyPipelineLaunch(planned.runtime, first, {
    sessionId: 'pipeline-worker-1',
    taskId: 'pipeline-worker-1:task',
    now: 1_000,
  });

  runtime = applyPipelineAssistantCompletion(cfg, runtime, first.participantKey, {
    assistantText: 'not a valid machine result',
    chatUrl: 'https://chatgpt.com/c/44444444-4444-4444-8444-444444444444',
    now: 31_000,
  });

  assert.equal(runtime.nextLaunchAt, 91_000);
  assert.equal(runtime.firstSlots['1'].correctionPending, true);
  assert.deepEqual(planPipelineActions(cfg, runtime, 90_999).actions, []);

  planned = planPipelineActions(cfg, runtime, 91_000);
  assert.equal(planned.actions.length, 1);
  assert.match(planned.actions[0].stage, /CORRECTION$/);
});

test('Scenario pipeline zero gap makes correction immediately eligible', () => {
  const cfg = config({ minimumLaunchGapSeconds: 0 });
  cfg.minimumLaunchGapSeconds = 0;
  let runtime = createPipelineRuntime(cfg, 1_000, {
    scenarioId: cfg.id,
    runState: 'RUNNING',
    generation: 1,
    createdAt: 1_000,
    totalLaunches: 0,
    totalCompletedTurns: 0,
  });

  let planned = planPipelineActions(cfg, runtime, 1_000);
  runtime = applyPipelineLaunch(planned.runtime, planned.actions[0], {
    sessionId: 'pipeline-worker-1',
    taskId: 'pipeline-worker-1:task',
    now: 1_000,
  });
  runtime = applyPipelineAssistantCompletion(cfg, runtime, planned.actions[0].participantKey, {
    assistantText: 'invalid',
    chatUrl: 'https://chatgpt.com/c/55555555-5555-4555-8555-555555555555',
    now: 31_000,
  });

  assert.equal(runtime.nextLaunchAt, 0);
  planned = planPipelineActions(cfg, runtime, 31_000);
  assert.equal(planned.actions.length, 1);
  assert.match(planned.actions[0].stage, /CORRECTION$/);
});
