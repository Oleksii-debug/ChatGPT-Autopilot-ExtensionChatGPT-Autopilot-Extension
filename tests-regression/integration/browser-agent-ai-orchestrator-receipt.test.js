import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../../src/core/browser-agent-manager.js';
import {
  AiOrchestrator,
  DEFAULT_AI_ROUTER_RUNTIME,
  normalizeAiRouterSettings,
} from '../../src/core/ai-orchestrator.js';

function storageChrome() {
  const storage = Object.create(null);
  return {
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(storage[key]) };
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
      },
    },
  };
}

function routerSettings() {
  return normalizeAiRouterSettings({
    enabled: true,
    gatewayUrl: 'http://127.0.0.1:17621',
    timeoutSeconds: 180,
    mode: 'primary',
    primary: { provider: 'openai', model: 'receipt-model' },
    strong: { provider: 'openai', model: 'unused' },
    routes: [{
      routeId: 'route.receipt',
      provider: 'openai',
      model: 'receipt-model',
      roles: ['coder'],
      capabilityIds: ['cap.reason'],
      priority: 20,
      enabled: true,
      locality: 'remote',
      costClass: 'paid',
      inputPricePerMillionUsd: 1,
      outputPricePerMillionUsd: 2,
      supportsVision: false,
      maxWorkers: 1,
    }],
    routePolicy: {
      autoSwitch: false,
      pinnedRouteId: 'route.receipt',
      orderedRouteIds: ['route.receipt'],
      allowRouteIds: ['route.receipt'],
      denyRouteIds: [],
      freeOnly: false,
      locality: 'remote',
      maxInputPricePerMillionUsd: 4,
      maxOutputPricePerMillionUsd: 5,
    },
  });
}

test('real BrowserAgent budget lifecycle interoperates with AiOrchestrator receipt snapshot and exact settlement', async () => {
  let clock = 50_000;
  const manager = new BrowserAgentManager({
    chromeApi: storageChrome(),
    routePrompt: async () => ({ text: '{}' }),
    now: () => ++clock,
  });
  await manager.create({
    id: 'job.receipt.integration',
    goal: 'Prove provider receipt interoperability.',
    maxModelCalls: 2,
    maxOutputTokensPerCall: 128,
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
  });
  await manager.update(store => {
    const job = store.byId['job.receipt.integration'];
    job.runtime.runState = 'RUNNING';
    job.runtime.controlEpoch = 7;
    return store;
  });

  const orchestrator = new AiOrchestrator({
    now: () => ++clock,
    gatewayClient: {
      async complete(request) {
        assert.equal(request.provider, 'openai');
        assert.equal(request.model, 'receipt-model');
        assert.equal(request.maxOutputTokens, 128);
        return {
          text: 'verified provider result',
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
          },
        };
      },
    },
    providerCallLifecycle: {
      beforeProviderCall: input => manager.reserveProviderModelBudget({
        jobId: input.context.jobId,
        controlEpoch: input.context.controlEpoch,
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        maxOutputTokens: input.maxOutputTokens,
        route: input.route,
        callNumber: input.callNumber,
      }),
      afterProviderCall: ({ context, reservation, ok, result }) =>
        manager.settleProviderModelBudget({
          jobId: context.jobId,
          reservationId: reservation.reservationId,
          ok,
          result: ok ? result : null,
        }),
    },
  });

  const result = await orchestrator.run(
    routerSettings(),
    DEFAULT_AI_ROUTER_RUNTIME,
    'Repair the bounded failed node.',
    {
      systemPrompt: 'Remain inside the admitted repair scope.',
      taskRole: 'coder',
      capabilityIds: ['cap.reason'],
      maxOutputTokens: 128,
      maxModelCallsForRequest: 1,
      providerCallBudgetContext: {
        kind: 'browser-agent',
        jobId: 'job.receipt.integration',
        controlEpoch: 7,
      },
    },
  );

  assert.equal(result.text, 'verified provider result');
  assert.equal(result.providerReservation.reservationId, 'job.receipt.integration:model-budget:1');
  assert.equal(result.providerReservation.controlEpoch, 7);
  assert.equal(result.providerReservation.routeId, 'route.receipt');
  assert.equal(result.providerReservation.provider, 'openai');
  assert.equal(result.providerReservation.model, 'receipt-model');
  assert.equal(result.providerReservation.outputTokens, 128);
  assert.equal(result.providerReservation.callNumber, 1);
  assert.equal(Object.isFrozen(result.providerReservation), true);

  const current = await manager.get('job.receipt.integration');
  assert.equal(current.job.runtime.modelBudgetReservation, null);
  assert.equal(current.job.runtime.modelCalls, 1);
  assert.equal(current.job.runtime.inputTokens, 11);
  assert.equal(current.job.runtime.outputTokens, 7);
  assert.equal(current.job.runtime.totalTokens, 18);
  assert.equal(current.job.runtime.history.at(-1).type, 'model-budget-settled');
});
