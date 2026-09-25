import test from 'node:test';
import assert from 'node:assert/strict';
import { AiOrchestrator, DEFAULT_AI_ROUTER_RUNTIME, normalizeAiRouterSettings } from '../src/core/ai-orchestrator.js';

class FakeGateway {
  constructor(responses = []) { this.responses = [...responses]; this.calls = []; }
  async complete(args) {
    this.calls.push(structuredClone(args));
    const text = this.responses.shift() ?? `${args.provider}/${args.model}:${args.prompt}`;
    return { ok: true, provider: args.provider, model: args.model, text };
  }
}

function settings(overrides = {}) {
  return normalizeAiRouterSettings({
    enabled: true,
    gatewayUrl: 'http://127.0.0.1:17621',
    timeoutSeconds: 180,
    mode: 'primary',
    primary: { provider: 'ollama', model: 'qwen:8b' },
    strong: { provider: 'openai', model: 'gpt-strong' },
    strongEveryNRequests: 3,
    strongEveryMinutes: 0,
    carryStrongResultToPrimary: true,
    handoffMaxChars: 12000,
    ...overrides,
  });
}

test('primary mode uses only the primary model', async () => {
  const gateway = new FakeGateway(['primary answer']);
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 1000 });
  const result = await router.run(settings(), DEFAULT_AI_ROUTER_RUNTIME, 'task');
  assert.equal(result.text, 'primary answer');
  assert.equal(result.route, 'primary');
  assert.equal(result.runtime.requestCount, 1);
  assert.equal(result.runtime.primaryCount, 1);
  assert.equal(result.runtime.strongCount, 0);
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].provider, 'ollama');
});

test('strong mode uses only the strong model', async () => {
  const gateway = new FakeGateway(['strong answer']);
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 1000 });
  const result = await router.run(settings({ mode: 'strong' }), DEFAULT_AI_ROUTER_RUNTIME, 'task');
  assert.equal(result.route, 'strong');
  assert.equal(result.runtime.primaryCount, 0);
  assert.equal(result.runtime.strongCount, 1);
  assert.equal(gateway.calls[0].provider, 'openai');
});

test('hybrid rules runs primary first and strong every N requests with handoff', async () => {
  const gateway = new FakeGateway(['draft', 'reviewed']);
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 5000 });
  const runtime = { ...DEFAULT_AI_ROUTER_RUNTIME, requestCount: 2, primaryCount: 2 };
  const result = await router.run(settings({ mode: 'hybrid-rules', strongEveryNRequests: 3 }), runtime, 'original task');
  assert.equal(result.route, 'strong');
  assert.equal(result.trigger, 'scheduled-review');
  assert.equal(gateway.calls.length, 2);
  assert.match(gateway.calls[1].prompt, /ORIGINAL TASK:\noriginal task/);
  assert.match(gateway.calls[1].prompt, /PRIMARY\/LOCAL WORKER REPORT OR DRAFT:\ndraft/);
  assert.equal(result.runtime.requestCount, 3);
  assert.equal(result.runtime.primaryCount, 3);
  assert.equal(result.runtime.strongCount, 1);
  assert.equal(result.runtime.lastStrongResult, 'reviewed');
});

test('hybrid rules supports time-based strong review', async () => {
  const gateway = new FakeGateway(['draft', 'reviewed']);
  const now = 10 * 60_000;
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => now });
  const runtime = { ...DEFAULT_AI_ROUTER_RUNTIME, requestCount: 1, startedAt: 1 * 60_000, lastStrongAt: 1 * 60_000 };
  const result = await router.run(settings({ mode: 'hybrid-rules', strongEveryNRequests: 0, strongEveryMinutes: 5 }), runtime, 'task');
  assert.equal(result.route, 'strong');
  assert.equal(gateway.calls.length, 2);
});

test('hybrid auto lets primary request escalation with exact marker', async () => {
  const gateway = new FakeGateway(['[[ESCALATE]] uncertain about invariant X', 'strong resolution']);
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 9000 });
  const result = await router.run(settings({ mode: 'hybrid-auto' }), DEFAULT_AI_ROUTER_RUNTIME, 'hard task');
  assert.equal(result.route, 'strong');
  assert.equal(result.trigger, 'primary-requested-escalation');
  assert.equal(result.text, 'strong resolution');
  assert.match(gateway.calls[0].systemPrompt, /\[\[ESCALATE\]\]/);
  assert.doesNotMatch(gateway.calls[1].prompt, /\[\[ESCALATE\]\]/);
});

test('hybrid auto stays on primary when no escalation is requested', async () => {
  const gateway = new FakeGateway(['done locally']);
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 9000 });
  const result = await router.run(settings({ mode: 'hybrid-auto' }), DEFAULT_AI_ROUTER_RUNTIME, 'easy task');
  assert.equal(result.route, 'primary');
  assert.equal(gateway.calls.length, 1);
});

test('strong result can be handed back to the next primary request', async () => {
  const gateway = new FakeGateway(['primary next']);
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 12000 });
  const runtime = { ...DEFAULT_AI_ROUTER_RUNTIME, lastStrongResult: 'important strong conclusion' };
  await router.run(settings(), runtime, 'next task');
  assert.match(gateway.calls[0].systemPrompt, /important strong conclusion/);
});


test('time rule does not invoke strong model immediately on the first request', async () => {
  const gateway = new FakeGateway(['first primary']);
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 10 * 60_000 });
  const result = await router.run(settings({ mode: 'hybrid-rules', strongEveryNRequests: 0, strongEveryMinutes: 120 }), DEFAULT_AI_ROUTER_RUNTIME, 'first task');
  assert.equal(result.route, 'primary');
  assert.equal(gateway.calls.length, 1);
  assert.equal(result.runtime.startedAt, 10 * 60_000);
});

test('primary failure can automatically fall back to strong model', async () => {
  const gateway = {
    calls: [],
    async complete(req) {
      this.calls.push(req);
      if (req.model === 'primary') throw new Error('primary offline');
      return { provider: req.provider, model: req.model, text: 'strong fallback result' };
    },
  };
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 20000 });
  const result = await router.run(settings({
    mode: 'primary',
    primary: { provider: 'ollama', model: 'primary' },
    strong: { provider: 'openai', model: 'strong' },
    fallbackToStrongOnPrimaryError: true,
  }), DEFAULT_AI_ROUTER_RUNTIME, 'task');
  assert.equal(result.route, 'strong');
  assert.equal(result.trigger, 'primary-error-fallback-to-strong');
  assert.match(result.primaryError, /primary offline/);
  assert.equal(result.text, 'strong fallback result');
});

test('scheduled strong review failure keeps primary result when configured', async () => {
  const gateway = {
    async complete(req) {
      if (req.model === 'strong') throw new Error('strong unavailable');
      return { provider: req.provider, model: req.model, text: 'useful primary result' };
    },
  };
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 30000 });
  const runtime = { ...DEFAULT_AI_ROUTER_RUNTIME, requestCount: 1, primaryCount: 1, startedAt: 1000 };
  const result = await router.run(settings({
    mode: 'hybrid-rules',
    strongEveryNRequests: 2,
    primary: { provider: 'ollama', model: 'primary' },
    strong: { provider: 'openai', model: 'strong' },
    keepPrimaryIfStrongFails: true,
  }), runtime, 'task');
  assert.equal(result.route, 'primary');
  assert.equal(result.text, 'useful primary result');
  assert.match(result.trigger, /strong-failed-primary-used/);
  assert.match(result.strongError, /strong unavailable/);
});

test('automatic strong escalation respects minimum-gap cost guard and stays on primary', async () => {
  const gateway = new FakeGateway(['[[ESCALATE]] need review']);
  const now = 30 * 60_000;
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => now });
  const runtime = {
    ...DEFAULT_AI_ROUTER_RUNTIME,
    requestCount: 4,
    primaryCount: 4,
    lastStrongAt: now - 5 * 60_000,
    strongHistoryAt: [now - 5 * 60_000],
  };
  const result = await router.run(settings({ mode: 'hybrid-auto', strongMinGapMinutes: 30 }), runtime, 'task');
  assert.equal(result.route, 'primary');
  assert.equal(gateway.calls.length, 1);
  assert.match(result.trigger, /strong-min-gap-deferred/);
});

test('automatic strong escalation respects hourly call budget', async () => {
  const gateway = new FakeGateway(['draft']);
  const now = 90 * 60_000;
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => now });
  const runtime = {
    ...DEFAULT_AI_ROUTER_RUNTIME,
    requestCount: 1,
    primaryCount: 1,
    startedAt: now - 60 * 60_000,
    strongHistoryAt: [now - 10 * 60_000, now - 20 * 60_000],
  };
  const result = await router.run(settings({
    mode: 'hybrid-rules',
    strongEveryNRequests: 2,
    strongMaxPerHour: 2,
  }), runtime, 'task');
  assert.equal(result.route, 'primary');
  assert.equal(gateway.calls.length, 1);
  assert.match(result.trigger, /strong-hourly-limit-deferred/);
});

test('manual force-strong bypasses automatic cost guard by explicit user action', async () => {
  const gateway = new FakeGateway(['manual strong result']);
  const now = 90 * 60_000;
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => now });
  const runtime = {
    ...DEFAULT_AI_ROUTER_RUNTIME,
    lastStrongAt: now - 1_000,
    strongHistoryAt: [now - 1_000, now - 2_000],
  };
  const result = await router.run(settings({ strongMinGapMinutes: 60, strongMaxPerHour: 1 }), runtime, 'task', { forceStrong: true });
  assert.equal(result.route, 'strong');
  assert.equal(result.trigger, 'manual-force-strong');
  assert.equal(result.text, 'manual strong result');
  assert.equal(result.runtime.strongHistoryAt.at(-1), now);
});

test('primary-error automatic fallback also respects strong cost guard', async () => {
  const now = 20 * 60_000;
  const gateway = {
    calls: [],
    async complete(req) {
      this.calls.push(req);
      if (req.model === 'primary') throw new Error('primary offline');
      return { provider: req.provider, model: req.model, text: 'should not be called' };
    },
  };
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => now });
  const runtime = {
    ...DEFAULT_AI_ROUTER_RUNTIME,
    lastStrongAt: now - 60_000,
    strongHistoryAt: [now - 60_000],
  };
  await assert.rejects(
    () => router.run(settings({
      mode: 'primary',
      primary: { provider: 'ollama', model: 'primary' },
      strong: { provider: 'openai', model: 'strong' },
      fallbackToStrongOnPrimaryError: true,
      strongMinGapMinutes: 60,
    }), runtime, 'task'),
    /Automatic strong fallback blocked by strong-min-gap/,
  );
  assert.equal(gateway.calls.length, 1);
});

test('hybrid escalation cannot exceed an exact per-request model-call ceiling', async () => {
  const gateway = new FakeGateway(['[[ESCALATE]] need strong review', 'must never be consumed']);
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 40_000 });
  const result = await router.run(
    settings({ mode: 'hybrid-auto', keepPrimaryIfStrongFails: true }),
    DEFAULT_AI_ROUTER_RUNTIME,
    'hard task',
    { maxModelCallsForRequest: 1 },
  );
  assert.equal(gateway.calls.length, 1);
  assert.equal(result.route, 'primary');
  assert.equal(result.usage.modelCalls, 1);
  assert.match(result.trigger, /strong-failed-primary-used/);
  assert.match(result.strongError, /model-call budget exhausted/i);
});

test('primary failure cannot spend a second fallback call when the exact call ceiling is one', async () => {
  const gateway = {
    calls: [],
    async complete(req) {
      this.calls.push(structuredClone(req));
      if (req.model === 'primary') throw new Error('primary offline');
      return { text: 'strong should not run' };
    },
  };
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 41_000 });
  await assert.rejects(
    () => router.run(settings({
      mode: 'primary',
      primary: { provider: 'ollama', model: 'primary' },
      strong: { provider: 'openai', model: 'strong' },
      fallbackToStrongOnPrimaryError: true,
    }), DEFAULT_AI_ROUTER_RUNTIME, 'task', { maxModelCallsForRequest: 1 }),
    error => {
      assert.match(error.message, /model-call budget exhausted/i);
      assert.equal(error.modelCallsUsed, 1);
      return true;
    },
  );
  assert.equal(gateway.calls.length, 1);
});

test('successful primary-error fallback reports both actual provider attempts', async () => {
  const gateway = {
    calls: [],
    async complete(req) {
      this.calls.push(structuredClone(req));
      if (req.model === 'primary') throw new Error('primary offline');
      return { text: 'strong fallback', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, modelCalls: 1 } };
    },
  };
  const router = new AiOrchestrator({ gatewayClient: gateway, now: () => 42_000 });
  const result = await router.run(settings({
    mode: 'primary',
    primary: { provider: 'ollama', model: 'primary' },
    strong: { provider: 'openai', model: 'strong' },
    fallbackToStrongOnPrimaryError: true,
  }), DEFAULT_AI_ROUTER_RUNTIME, 'task', { maxModelCallsForRequest: 2 });
  assert.equal(gateway.calls.length, 2);
  assert.equal(result.usage.modelCalls, 2);
});

test('three-route pool fails over on quota and unavailability without changing request identity or budget accounting', async () => {
  const calls = [];
  const gateway = {
    async complete(req) {
      calls.push(structuredClone(req));
      if (req.model === 'route-a') throw Object.assign(new Error('quota exhausted'), { code:'AI_PROVIDER_QUOTA_EXHAUSTED', status:429 });
      if (req.model === 'route-b') throw Object.assign(new Error('provider unavailable'), { code:'AI_PROVIDER_UNAVAILABLE', status:503 });
      return { text:'route-c result', usage:{ inputTokens:7, outputTokens:3, totalTokens:10 } };
    },
  };
  const router = new AiOrchestrator({ gatewayClient:gateway, now:() => 100_000 });
  const result = await router.run(settings({
    routes:[
      { routeId:'a', provider:'openai-compatible', endpointId:'endpoint-a', model:'route-a', roles:['planner'], priority:30, inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
      { routeId:'b', provider:'openai', model:'route-b', roles:['planner'], priority:20, inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
      { routeId:'c', provider:'ollama', model:'route-c', roles:['planner'], priority:10 },
    ],
    routePolicy:{ retryBackoffSeconds:60, circuitBreakerFailures:2, circuitBreakerSeconds:300 },
  }), DEFAULT_AI_ROUTER_RUNTIME, 'same agent node prompt', { taskRole:'planner', maxModelCallsForRequest:3 });
  assert.equal(result.text, 'route-c result');
  assert.equal(result.primary.routeId, 'c');
  assert.equal(result.routing.selectedRouteId, 'c');
  assert.deepEqual(result.routing.failoverChain.map(item => `${item.routeId}:${item.outcome}`), ['a:FAILED','b:FAILED','c:SUCCESS']);
  assert.equal(result.usage.modelCalls, 3);
  assert.equal(result.usage.totalTokens, 10);
  assert.deepEqual(calls.map(call => call.prompt), ['same agent node prompt','same agent node prompt','same agent node prompt']);
  assert.equal(calls[0].endpointId, 'endpoint-a');
  assert.equal(result.runtime.routeStates.a.backoffUntil, 160_000);
  assert.equal(result.runtime.routeStates.b.backoffUntil, 160_000);
});

test('route pool restart skips durable backoff and keeps the same logical task prompt', async () => {
  const calls = [];
  const gateway = { async complete(req) { calls.push(req.model); return { text:`${req.model} result` }; } };
  const configured = settings({
    routes:[
      { routeId:'a', provider:'openai', model:'route-a', roles:['planner'], priority:30 },
      { routeId:'b', provider:'ollama', model:'route-b', roles:['planner'], priority:20 },
    ],
    routePolicy:{ retryBackoffSeconds:60, circuitBreakerFailures:2, circuitBreakerSeconds:300 },
  });
  const runtime = { ...DEFAULT_AI_ROUTER_RUNTIME, routeStates:{ a:{ consecutiveFailures:1, failures:1, successes:0, backoffUntil:160_000, circuitOpenUntil:0, lastErrorCode:'HTTP_429', lastErrorCategory:'quota-or-rate', lastErrorAt:100_000, lastSuccessAt:0, lastLatencyMs:10 } } };
  const router = new AiOrchestrator({ gatewayClient:gateway, now:() => 120_000 });
  const result = await router.run(configured, runtime, 'same plan/node/effect context', { taskRole:'planner' });
  assert.deepEqual(calls, ['route-b']);
  assert.equal(result.routing.selectedRouteId, 'b');
  assert.equal(result.runtime.routeStates.a.backoffUntil, 160_000);
});

test('non-retryable route rejection fails closed without calling another model', async () => {
  const calls = [];
  const gateway = { async complete(req) { calls.push(req.model); throw Object.assign(new Error('policy denied'), { code:'AI_POLICY_DENIED', status:403 }); } };
  const router = new AiOrchestrator({ gatewayClient:gateway, now:() => 100_000 });
  await assert.rejects(() => router.run(settings({
    routes:[
      { routeId:'a', provider:'openai', model:'route-a', roles:['planner'], priority:20, inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
      { routeId:'b', provider:'ollama', model:'route-b', roles:['planner'], priority:10 },
    ],
  }), DEFAULT_AI_ROUTER_RUNTIME, 'task', { taskRole:'planner' }), error => {
    assert.equal(error.code, 'AI_POLICY_DENIED');
    assert.equal(error.modelCallsUsed, 1);
    assert.equal(error.routerRuntime.lastFailoverChain.length, 1);
    return true;
  });
  assert.deepEqual(calls, ['route-a']);
});
