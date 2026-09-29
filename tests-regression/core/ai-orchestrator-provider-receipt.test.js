import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AiOrchestrator,
  DEFAULT_AI_ROUTER_RUNTIME,
  normalizeAiRouterSettings,
} from '../../src/core/ai-orchestrator.js';

function settings(routes = [{
  routeId: 'route.receipt',
  provider: 'openai',
  model: 'receipt-model',
  roles: ['planner'],
  priority: 10,
  costClass: 'paid',
  inputPricePerMillionUsd: 1,
  outputPricePerMillionUsd: 2,
}]) {
  return normalizeAiRouterSettings({
    enabled: true,
    gatewayUrl: 'http://127.0.0.1:17621',
    timeoutSeconds: 180,
    mode: 'primary',
    primary: { provider: 'openai', model: 'receipt-model' },
    strong: { provider: 'openai', model: 'strong-model' },
    routes,
  });
}

function reservation(overrides = {}) {
  return {
    reservationId: 'job.receipt:model-budget:1',
    controlEpoch: 7,
    modelCalls: 1,
    inputTokens: 10,
    outputTokens: 128,
    totalTokens: 138,
    estimatedCostUsd: 0.001,
    createdAt: 1000,
    routeId: 'route.receipt',
    provider: 'openai',
    model: 'receipt-model',
    callNumber: 1,
    ...overrides,
  };
}

test('selected provider result carries the exact pre-I/O durable reservation snapshot', async () => {
  const admitted = reservation();
  let settled = null;
  const gateway = {
    async complete() {
      admitted.reservationId = 'forged-after-admission';
      admitted.routeId = 'route.forged';
      return {
        text: 'bounded result',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        providerReservation: { reservationId: 'provider-injected' },
      };
    },
  };
  const lifecycle = {
    async beforeProviderCall() {
      return admitted;
    },
    async afterProviderCall({ reservation: settledReservation, ok }) {
      assert.equal(ok, true);
      settled = settledReservation;
    },
  };
  const router = new AiOrchestrator({
    gatewayClient: gateway,
    providerCallLifecycle: lifecycle,
    now: () => 1000,
  });

  const result = await router.run(
    settings(),
    DEFAULT_AI_ROUTER_RUNTIME,
    'repair one node',
    {
      maxOutputTokens: 128,
      maxModelCallsForRequest: 1,
      providerCallBudgetContext: {
        kind: 'browser-agent',
        jobId: 'job.receipt',
        controlEpoch: 7,
      },
    },
  );

  assert.equal(result.text, 'bounded result');
  assert.equal(result.providerReservation.reservationId, 'job.receipt:model-budget:1');
  assert.equal(result.providerReservation.routeId, 'route.receipt');
  assert.equal(result.providerReservation.provider, 'openai');
  assert.equal(result.providerReservation.model, 'receipt-model');
  assert.deepEqual({ ...result.providerReservation }, reservation());
  assert.deepEqual({ ...settled }, reservation());
  assert.equal(Object.isFrozen(result.providerReservation), true);
  assert.equal(Object.isFrozen(settled), true);
  assert.equal(result.providerReservation, settled);
  assert.notEqual(settled, admitted);
});

test('hostile reservation accessors fail closed before gateway I/O without executing getters', async () => {
  let getterCalls = 0;
  let gatewayCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'reservationId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'job.receipt:model-budget:1';
    },
  });
  const router = new AiOrchestrator({
    gatewayClient: {
      async complete() {
        gatewayCalls += 1;
        return { text: 'must not run' };
      },
    },
    providerCallLifecycle: {
      async beforeProviderCall() {
        return hostile;
      },
      async afterProviderCall() {
        throw new Error('must not settle an unadmitted provider call');
      },
    },
    now: () => 1000,
  });

  await assert.rejects(
    () => router.run(
      settings(),
      DEFAULT_AI_ROUTER_RUNTIME,
      'repair one node',
      {
        maxOutputTokens: 128,
        maxModelCallsForRequest: 1,
        providerCallBudgetContext: {
          kind: 'browser-agent',
          jobId: 'job.receipt',
          controlEpoch: 7,
        },
      },
    ),
    error => {
      assert.equal(error.code, 'AI_PROVIDER_BUDGET_RESERVATION_MISSING');
      assert.match(error.message, /enumerable own data property/u);
      return true;
    },
  );

  assert.equal(getterCalls, 0);
  assert.equal(gatewayCalls, 0);
});

test('Browser Agent receipt identity must match the exact admitted job epoch call and route before gateway I/O', async () => {
  const cases = [
    ['cross-job', { reservationId: 'job.other:model-budget:1' }, /admitted Browser Agent job/u],
    ['stale-epoch', { controlEpoch: 6 }, /controlEpoch does not match admission/u],
    ['wrong-call', { callNumber: 2 }, /callNumber does not match admission/u],
    ['cross-route', { routeId: 'route.other' }, /routeId does not match admitted route/u],
    ['cross-provider', { provider: 'ollama' }, /provider does not match admitted route/u],
    ['cross-model', { model: 'other-model' }, /model does not match admitted route/u],
    ['multi-call', { modelCalls: 2 }, /exactly one model call/u],
  ];

  for (const [label, overrides, expected] of cases) {
    let gatewayCalls = 0;
    let settlementCalls = 0;
    const router = new AiOrchestrator({
      gatewayClient: {
        async complete() {
          gatewayCalls += 1;
          return { text: 'must not run' };
        },
      },
      providerCallLifecycle: {
        async beforeProviderCall() {
          return reservation(overrides);
        },
        async afterProviderCall() {
          settlementCalls += 1;
        },
      },
      now: () => 1000,
    });

    await assert.rejects(
      () => router.run(
        settings(),
        DEFAULT_AI_ROUTER_RUNTIME,
        'repair one node',
        {
          maxOutputTokens: 128,
          maxModelCallsForRequest: 1,
          providerCallBudgetContext: {
            kind: 'browser-agent',
            jobId: 'job.receipt',
            controlEpoch: 7,
          },
        },
      ),
      error => {
        assert.match(error.message, expected, label);
        return true;
      },
    );
    assert.equal(gatewayCalls, 0, label);
    assert.equal(settlementCalls, 0, label);
  }
});

test('retryable failed reservation is not leaked when canonical failover later succeeds', async () => {
  const routes = [
    {
      routeId: 'route.a',
      provider: 'openai',
      model: 'model-a',
      roles: ['planner'],
      priority: 20,
      costClass: 'paid',
      inputPricePerMillionUsd: 1,
      outputPricePerMillionUsd: 2,
    },
    {
      routeId: 'route.b',
      provider: 'ollama',
      model: 'model-b',
      roles: ['planner'],
      priority: 10,
    },
  ];
  const settled = [];
  const gateway = {
    async complete(request) {
      if (request.model === 'model-a') {
        throw Object.assign(new Error('temporary provider failure'), {
          code: 'AI_PROVIDER_UNAVAILABLE',
          status: 503,
        });
      }
      return {
        text: 'recovered',
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      };
    },
  };
  const lifecycle = {
    async beforeProviderCall({ route, callNumber }) {
      return reservation({
        reservationId: `job.receipt:model-budget:${callNumber}`,
        routeId: route.routeId,
        provider: route.provider,
        model: route.model,
        callNumber,
      });
    },
    async afterProviderCall({ reservation: settledReservation, ok }) {
      settled.push([settledReservation.reservationId, ok]);
    },
  };
  const router = new AiOrchestrator({
    gatewayClient: gateway,
    providerCallLifecycle: lifecycle,
    now: () => 1000,
  });

  const result = await router.run(
    settings(routes),
    DEFAULT_AI_ROUTER_RUNTIME,
    'repair one node',
    {
      maxOutputTokens: 128,
      maxModelCallsForRequest: 2,
      providerCallBudgetContext: {
        kind: 'browser-agent',
        jobId: 'job.receipt',
        controlEpoch: 7,
      },
    },
  );

  assert.equal(result.text, 'recovered');
  assert.equal(result.providerReservation.reservationId, 'job.receipt:model-budget:2');
  assert.equal(result.providerReservation.routeId, 'route.b');
  assert.deepEqual(settled, [
    ['job.receipt:model-budget:1', false],
    ['job.receipt:model-budget:2', true],
  ]);
});

test('ordinary calls without a durable provider lifecycle do not expose reservation metadata', async () => {
  const router = new AiOrchestrator({
    gatewayClient: {
      async complete() {
        return {
          text: 'ordinary result',
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      },
    },
    now: () => 1000,
  });

  const result = await router.run(
    settings(),
    DEFAULT_AI_ROUTER_RUNTIME,
    'ordinary task',
    { maxOutputTokens: 128 },
  );

  assert.equal(result.text, 'ordinary result');
  assert.equal(Object.hasOwn(result, 'providerReservation'), false);
});


test('explicit durable settlement rejection fails closed after provider success', async () => {
  let gatewayCalls = 0;
  const router = new AiOrchestrator({
    gatewayClient: {
      async complete() {
        gatewayCalls += 1;
        return {
          text: 'must not escape as success',
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      },
    },
    providerCallLifecycle: {
      async beforeProviderCall() {
        return reservation();
      },
      async afterProviderCall({ ok }) {
        assert.equal(ok, true);
        return { settled: false };
      },
    },
    now: () => 1000,
  });

  await assert.rejects(
    () => router.run(
      settings(),
      DEFAULT_AI_ROUTER_RUNTIME,
      'repair one node',
      {
        maxOutputTokens: 128,
        maxModelCallsForRequest: 1,
        providerCallBudgetContext: {
          kind: 'browser-agent',
          jobId: 'job.receipt',
          controlEpoch: 7,
        },
      },
    ),
    error => {
      assert.equal(error.code, 'AI_PROVIDER_BUDGET_SETTLEMENT_REJECTED');
      assert.match(error.message, /did not settle the durable budget reservation/u);
      return true;
    },
  );

  assert.equal(gatewayCalls, 1);
});

test('explicit failed-call settlement rejection remains local and cannot manufacture failover', async () => {
  const routes = [
    {
      routeId: 'route.a',
      provider: 'openai',
      model: 'model-a',
      roles: ['planner'],
      priority: 20,
      costClass: 'paid',
      inputPricePerMillionUsd: 1,
      outputPricePerMillionUsd: 2,
    },
    {
      routeId: 'route.b',
      provider: 'ollama',
      model: 'model-b',
      roles: ['planner'],
      priority: 10,
    },
  ];
  let gatewayCalls = 0;
  const router = new AiOrchestrator({
    gatewayClient: {
      async complete() {
        gatewayCalls += 1;
        throw Object.assign(new Error('provider failed'), {
          code: 'AI_PROVIDER_UNAVAILABLE',
          status: 503,
        });
      },
    },
    providerCallLifecycle: {
      async beforeProviderCall({ route, callNumber }) {
        return reservation({
          reservationId: `job.receipt:model-budget:${callNumber}`,
          routeId: route.routeId,
          provider: route.provider,
          model: route.model,
          callNumber,
        });
      },
      async afterProviderCall({ ok }) {
        assert.equal(ok, false);
        return { settled: false };
      },
    },
    now: () => 1000,
  });

  await assert.rejects(
    () => router.run(
      settings(routes),
      DEFAULT_AI_ROUTER_RUNTIME,
      'repair one node',
      {
        maxOutputTokens: 128,
        maxModelCallsForRequest: 2,
        providerCallBudgetContext: {
          kind: 'browser-agent',
          jobId: 'job.receipt',
          controlEpoch: 7,
        },
      },
    ),
    error => {
      assert.equal(error.code, 'AI_PROVIDER_BUDGET_SETTLEMENT_REJECTED');
      return true;
    },
  );

  assert.equal(gatewayCalls, 1);
});

test('settlement status accessor fails closed without invoking the getter', async () => {
  let getterCalls = 0;
  const settlement = {};
  Object.defineProperty(settlement, 'settled', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  const router = new AiOrchestrator({
    gatewayClient: {
      async complete() {
        return {
          text: 'must not escape as success',
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      },
    },
    providerCallLifecycle: {
      async beforeProviderCall() {
        return reservation();
      },
      async afterProviderCall() {
        return settlement;
      },
    },
    now: () => 1000,
  });

  await assert.rejects(
    () => router.run(
      settings(),
      DEFAULT_AI_ROUTER_RUNTIME,
      'repair one node',
      {
        maxOutputTokens: 128,
        maxModelCallsForRequest: 1,
        providerCallBudgetContext: {
          kind: 'browser-agent',
          jobId: 'job.receipt',
          controlEpoch: 7,
        },
      },
    ),
    error => {
      assert.equal(error.code, 'AI_PROVIDER_BUDGET_SETTLEMENT_REJECTED');
      assert.match(error.message, /own data property/u);
      return true;
    },
  );

  assert.equal(getterCalls, 0);
});
