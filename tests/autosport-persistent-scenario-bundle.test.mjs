import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  normalizeScenarioWorkConfig,
  createScenarioWorkRuntime,
  startScenarioWork,
  planScenarioWorkActions,
  applyScenarioLaunch,
  applyScenarioCompletion,
  applyScenarioTimeout,
} from '../src/core/scenario-work.js';

const bundle = JSON.parse(fs.readFileSync(
  new URL('../src/config/autosport-5-persistent-workers-scenario-bundle.json', import.meta.url),
  'utf8',
));

test('Autosport persistent-worker bundle is five unlimited 17-send chat cycles', () => {
  assert.equal(bundle.kind, 'chatgpt-autopilot-scenario-work-bundle');
  assert.equal(bundle.version, 1);
  assert.equal(bundle.scenarios.length, 5);

  for (const [workerIndex, item] of bundle.scenarios.entries()) {
    const config = normalizeScenarioWorkConfig(item.config);
    assert.equal(config.mode, 'CHAT_CYCLE');
    assert.equal(config.roundsPerGeneration, 1);
    assert.equal(config.maxGenerations, 0);
    assert.equal(config.responseTimeoutMinutes, 40);
    assert.equal(config.pollSeconds, 5);
    assert.equal(config.preSendDelaySeconds, 10);
    assert.equal(config.restartCurrentRoundOnTimeout, true);
    assert.deepEqual(config.steps.map(step => step.repeat), [1, 15, 1]);
    assert.ok(config.steps[0].prompt.length > 180);

    let now = 1_000_000 + workerIndex * 100_000;
    let runtime = startScenarioWork(config, createScenarioWorkRuntime(config, now), now);
    const sentPrompts = [];

    for (let turn = 0; turn < 17; turn += 1) {
      const planned = planScenarioWorkActions(config, runtime, now);
      assert.equal(planned.actions.length, 1);
      const action = planned.actions[0];
      assert.equal(action.type, 'LAUNCH');
      sentPrompts.push(action.prompt);
      runtime = applyScenarioLaunch(runtime, action, {
        sessionId: `session-${workerIndex}-${turn}`,
        taskId: `task-${workerIndex}-${turn}`,
        now,
      });
      runtime = applyScenarioCompletion(config, runtime, 'chat', {
        chatUrl: `https://chatgpt.com/c/worker-${workerIndex}-generation-1`,
        now: now + 1,
      });
      now += 100;
    }

    assert.equal(sentPrompts.length, 17);
    assert.match(sentPrompts[0], /TIME_TO_WHOLE_FINISHED_PRODUCT/);
    assert.deepEqual(sentPrompts.slice(1, 16), Array(15).fill('Продовжуй розробку.'));
    assert.match(sentPrompts[16], /Заверши це покоління чату/);
    assert.equal(runtime.generation, 2);
    assert.equal(runtime.round, 0);
    assert.equal(runtime.stepIndex, 0);
    assert.equal(runtime.repeatIndex, 0);
    assert.equal(runtime.chat.chatUrl, '');
    assert.equal(runtime.runState, 'RUNNING');

    const next = planScenarioWorkActions(config, runtime, now);
    assert.equal(next.actions.length, 1);
    assert.match(next.actions[0].prompt, /TIME_TO_WHOLE_FINISHED_PRODUCT/);

    runtime = applyScenarioLaunch(runtime, next.actions[0], {
      sessionId: `timeout-session-${workerIndex}`,
      taskId: `timeout-task-${workerIndex}`,
      now,
    });
    runtime = applyScenarioTimeout(config, runtime, 'chat', { now: now + 40 * 60_000 });
    assert.equal(runtime.chat.chatUrl, '');
    assert.equal(runtime.stepIndex, 0);
    assert.equal(runtime.repeatIndex, 0);
    assert.equal(runtime.chat.replacementCount, 1);
  }
});
