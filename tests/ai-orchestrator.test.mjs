import test from 'node:test';
import assert from 'node:assert/strict';
import { AiOrchestrator, DEFAULT_AI_ROUTER_RUNTIME, normalizeAiRouterSettings } from '../src/core/ai-orchestrator.js';
import { deriveAiRouteQualitySubjectRevisionIdV1 } from '../src/core/ai-route-quality-governor.js';
import { BenchmarkAssertionOperator, BenchmarkCaseOutcome } from '../src/core/benchmark-evaluation.js';

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

const QUALITY_START = '2026-09-27T12:00:00.000Z';
const QUALITY_END = '2026-09-27T12:00:01.000Z';
const QUALITY_NOW = Date.parse('2026-09-27T12:00:02.000Z');

function qualityRoute(routeId, overrides = {}) {
  return {
    schemaVersion:1,
    routeId,
    provider:'ollama',
    model:'model-' + routeId,
    roles:['planner'],
    capabilityIds:[],
    priority:0,
    enabled:true,
    locality:'local',
    costClass:'free',
    supportsVision:false,
    maxWorkers:0,
    ...overrides,
  };
}

async function qualityBenchmarkBinding(routeValue, { suffix = 'runtime', pass = true } = {}) {
  const routeId = routeValue.routeId;
  const suiteId = 'route-quality-' + suffix;
  const suiteRevisionId = 'suite-' + suffix;
  const runId = 'run-' + routeId + '-' + suffix;
  const subjectRevisionId = await deriveAiRouteQualitySubjectRevisionIdV1(routeValue);
  const invocationId = 'benchmark-' + routeId + '-' + suffix;
  const artifactId = 'evidence-' + routeId + '-' + suffix;
  const result = {
    caseId:'quality',
    outcome:BenchmarkCaseOutcome.MEASURED,
    metrics:{ score:pass ? 1 : 0 },
    evidenceArtifactIds:[artifactId],
  };
  return {
    routeId,
    maxAgeMs:60_000,
    evaluationRequest:{
      suite:{
        schemaVersion:1,
        suiteId,
        suiteRevisionId,
        title:'Route quality benchmark',
        cases:[{
          caseId:'quality',
          title:'Quality threshold',
          assertions:[{
            metricId:'score',
            operator:BenchmarkAssertionOperator.AT_LEAST,
            threshold:1,
          }],
        }],
      },
      run:{
        schemaVersion:1,
        runId,
        suiteId,
        suiteRevisionId,
        subjectId:routeId,
        subjectRevisionId,
        startedAt:QUALITY_START,
        completedAt:QUALITY_END,
        results:[structuredClone(result)],
      },
      expectedSubject:{ subjectId:routeId, subjectRevisionId },
      trustedExecution:{
        runId,
        suiteId,
        suiteRevisionId,
        subjectId:routeId,
        subjectRevisionId,
        producerInvocationId:invocationId,
        startedAt:QUALITY_START,
        completedAt:QUALITY_END,
        results:[structuredClone(result)],
      },
      trustedEvidenceArtifacts:[{
        schemaVersion:1,
        artifactId,
        kind:'benchmark-evidence',
        uri:'artifact://benchmark/' + artifactId,
        mediaType:'application/json',
        sha256:(pass ? '1' : '2').repeat(64),
        sizeBytes:1,
        createdAt:QUALITY_END,
        producerInvocationId:invocationId,
        sensitive:false,
      }],
    },
  };
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
      { routeId:'a', provider:'openai-compatible', endpointId:'endpoint-a', model:'route-a', roles:['planner'], priority:30, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
      { routeId:'b', provider:'openai', model:'route-b', roles:['planner'], priority:20, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
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
      { routeId:'a', provider:'openai', model:'route-a', roles:['planner'], priority:20, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
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


test('provider-call lifecycle durably admits before gateway I/O and settles after exact success', async () => {
  const events = [];
  const gateway = {
    async complete(req) {
      events.push(['gateway', req.model]);
      return { text:'done', usage:{ inputTokens:5, outputTokens:3, totalTokens:8 } };
    },
  };
  const lifecycle = {
    async beforeProviderCall({ context, route, maxOutputTokens, callNumber }) {
      events.push(['before', context.jobId, route.model, maxOutputTokens, callNumber]);
      return { reservationId:'reservation-1' };
    },
    async afterProviderCall({ context, reservation, route, ok, result }) {
      events.push(['after', context.jobId, reservation.reservationId, route.model, ok, result.usage.totalTokens]);
    },
  };
  const router = new AiOrchestrator({ gatewayClient:gateway, providerCallLifecycle:lifecycle, now:() => 80_000 });
  const result = await router.run(
    settings({ primary:{ provider:'ollama', model:'qwen:8b' } }),
    DEFAULT_AI_ROUTER_RUNTIME,
    'task',
    {
      maxOutputTokens:128,
      providerCallBudgetContext:{ kind:'browser-agent', jobId:'job-1', controlEpoch:2 },
    },
  );
  assert.equal(result.text, 'done');
  assert.deepEqual(events, [
    ['before','job-1','qwen:8b',128,1],
    ['gateway','qwen:8b'],
    ['after','job-1','reservation-1','qwen:8b',true,8],
  ]);
});

test('provider-call lifecycle conservatively settles an admitted failed gateway attempt before failover logic continues', async () => {
  const events = [];
  const gateway = {
    async complete(req) {
      events.push(['gateway', req.model]);
      throw Object.assign(new Error('provider failed'), { code:'AI_POLICY_DENIED', status:403 });
    },
  };
  const lifecycle = {
    async beforeProviderCall({ route }) {
      events.push(['before', route.model]);
      return { reservationId:`reservation-${route.model}` };
    },
    async afterProviderCall({ reservation, route, ok, error }) {
      events.push(['after', reservation.reservationId, route.model, ok, error.message]);
    },
  };
  const router = new AiOrchestrator({ gatewayClient:gateway, providerCallLifecycle:lifecycle, now:() => 81_000 });
  await assert.rejects(
    () => router.run(
      settings({ primary:{ provider:'ollama', model:'qwen:8b' } }),
      DEFAULT_AI_ROUTER_RUNTIME,
      'task',
      {
        maxOutputTokens:128,
        providerCallBudgetContext:{ kind:'browser-agent', jobId:'job-2', controlEpoch:0 },
      },
    ),
    /provider failed/,
  );
  assert.deepEqual(events, [
    ['before','qwen:8b'],
    ['gateway','qwen:8b'],
    ['after','reservation-qwen:8b','qwen:8b',false,'provider failed'],
    ['before','gpt-strong'],
    ['gateway','gpt-strong'],
    ['after','reservation-gpt-strong','gpt-strong',false,'provider failed'],
  ]);
});

test('selected model profile adds only its own prompts to the gateway request', async () => {
  const gateway = new FakeGateway(['coded']);
  const router = new AiOrchestrator({ gatewayClient:gateway, now:() => 1000 });
  const configured = settings({
    routes:[
      { routeId:'mistral-code', provider:'openai-compatible', endpointId:'mistral', model:'codestral-latest', displayName:'Implementer', systemPrompt:'Review access before writing', workerPrompt:'Implement this task', roles:['coder'], priority:10, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
      { routeId:'local-review', provider:'ollama', model:'qwen', displayName:'Reviewer', systemPrompt:'Review independently', workerPrompt:'Critique this task', roles:['verifier'], priority:5 },
    ],
  });
  const result = await router.run(configured, DEFAULT_AI_ROUTER_RUNTIME, 'Fix parser', { systemPrompt:'Project rules', taskRole:'coder' });
  assert.equal(result.text, 'coded');
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].endpointId, 'mistral');
  assert.equal(gateway.calls[0].systemPrompt, 'Project rules\n\nReview access before writing');
  assert.equal(gateway.calls[0].prompt, 'Implement this task\n\nFix parser');
  assert.equal(gateway.calls[0].prompt.includes('Critique this task'), false);
  assert.equal(configured.routes[0].displayName, 'Implementer');
});

test('model profile prompts are bounded and legacy routes remain compatible', () => {
  assert.throws(() => settings({ routes:[{ routeId:'a', provider:'ollama', model:'qwen', systemPrompt:'x'.repeat(8001) }] }), /too long/);
  const legacy = settings({ routes:[{ routeId:'a', provider:'ollama', model:'qwen' }] });
  assert.equal(legacy.routes[0].systemPrompt, '');
  assert.equal(legacy.routes[0].workerPrompt, '');
});


test('trusted route-quality evidence can reorder only equal-owner canonical candidates', async () => {
  const routes = [qualityRoute('route-a'), qualityRoute('route-b')];
  const gateway = new FakeGateway(['quality-selected']);
  let resolverRequest = null;
  const router = new AiOrchestrator({
    gatewayClient:gateway,
    now:() => QUALITY_NOW,
    routeQualityEvidenceResolver:async request => {
      resolverRequest = request;
      return [await qualityBenchmarkBinding(routes[1], { suffix:'prefer-b' })];
    },
  });

  const result = await router.run(settings({ routes }), DEFAULT_AI_ROUTER_RUNTIME, 'task', { taskRole:'planner' });
  assert.equal(result.routing.selectedRouteId, 'route-b');
  assert.equal(gateway.calls[0].model, 'model-route-b');
  assert.deepEqual(resolverRequest.routeIds, ['route-a', 'route-b']);
  assert.equal(resolverRequest.role, 'planner');
  assert.equal(resolverRequest.requiresVision, false);
  assert.equal(Object.isFrozen(resolverRequest), true);
  assert.equal(Object.isFrozen(resolverRequest.routeIds), true);
});

test('owner priority remains stronger than trusted route-quality evidence at runtime', async () => {
  const routes = [
    qualityRoute('owner-first', { priority:100 }),
    qualityRoute('quality-pass', { priority:1 }),
  ];
  const gateway = new FakeGateway(['owner-selected']);
  const router = new AiOrchestrator({
    gatewayClient:gateway,
    now:() => QUALITY_NOW,
    routeQualityEvidenceResolver:async () => [
      await qualityBenchmarkBinding(routes[1], { suffix:'priority-pass' }),
    ],
  });

  const result = await router.run(settings({ routes }), DEFAULT_AI_ROUTER_RUNTIME, 'task', { taskRole:'planner' });
  assert.equal(result.routing.selectedRouteId, 'owner-first');
  assert.equal(gateway.calls[0].model, 'model-owner-first');
});

test('malformed or unavailable quality evidence falls back to canonical baseline routing', async () => {
  const routes = [qualityRoute('route-a'), qualityRoute('route-b')];

  for (const resolver of [
    async () => [{ unexpected:true }],
    async () => { throw new Error('quality store unavailable'); },
  ]) {
    const gateway = new FakeGateway(['baseline']);
    const router = new AiOrchestrator({
      gatewayClient:gateway,
      now:() => QUALITY_NOW,
      routeQualityEvidenceResolver:resolver,
    });
    const result = await router.run(settings({ routes }), DEFAULT_AI_ROUTER_RUNTIME, 'task', { taskRole:'planner' });
    assert.equal(result.routing.selectedRouteId, 'route-a');
    assert.equal(gateway.calls.length, 1);
    assert.equal(gateway.calls[0].model, 'model-route-a');
  }
});

test('canonical route eligibility is refreshed after asynchronous quality evidence resolution', async () => {
  const routes = [
    qualityRoute('route-a', { priority:100 }),
    qualityRoute('route-b', { priority:20 }),
    qualityRoute('route-c', { priority:10 }),
  ];
  let clock = QUALITY_NOW;
  let resolverRouteIds = null;
  const gateway = new FakeGateway(['fresh-selection']);
  const router = new AiOrchestrator({
    gatewayClient:gateway,
    now:() => clock,
    routeQualityEvidenceResolver:async request => {
      resolverRouteIds = [...request.routeIds];
      clock += 100;
      return [];
    },
  });
  const runtime = {
    ...DEFAULT_AI_ROUTER_RUNTIME,
    routeStates:{
      'route-a':{
        consecutiveFailures:1,
        successes:0,
        failures:1,
        backoffUntil:QUALITY_NOW + 50,
        circuitOpenUntil:0,
        lastErrorCode:'HTTP_429',
        lastErrorCategory:'quota-or-rate',
        lastErrorAt:QUALITY_NOW - 100,
        lastSuccessAt:0,
        lastLatencyMs:1,
      },
    },
  };

  const result = await router.run(settings({ routes }), runtime, 'task', { taskRole:'planner' });
  assert.deepEqual(resolverRouteIds, ['route-b', 'route-c']);
  assert.equal(result.routing.selectedRouteId, 'route-a');
  assert.equal(gateway.calls[0].model, 'model-route-a');
});

test('pinned canonical route bypasses advisory lookup and cannot be widened by quality', async () => {
  const routes = [qualityRoute('route-a'), qualityRoute('route-b')];
  let resolverCalls = 0;
  const gateway = new FakeGateway(['pinned']);
  const router = new AiOrchestrator({
    gatewayClient:gateway,
    now:() => QUALITY_NOW,
    routeQualityEvidenceResolver:async () => {
      resolverCalls += 1;
      return [await qualityBenchmarkBinding(routes[1], { suffix:'must-not-run' })];
    },
  });

  const result = await router.run(
    settings({ routes, routePolicy:{ pinnedRouteId:'route-a' } }),
    DEFAULT_AI_ROUTER_RUNTIME,
    'task',
    { taskRole:'planner' },
  );
  assert.equal(result.routing.selectedRouteId, 'route-a');
  assert.equal(resolverCalls, 0);
});

test('quality-first retryable failure preserves canonical failover and durable backoff', async () => {
  const routes = [qualityRoute('route-a'), qualityRoute('route-b')];
  const calls = [];
  const gateway = {
    async complete(req) {
      calls.push(req.model);
      if (req.model === 'model-route-b') {
        throw Object.assign(
          new Error('quality-selected provider unavailable'),
          { code:'AI_PROVIDER_UNAVAILABLE', status:503 },
        );
      }
      return { text:'canonical failover recovered' };
    },
  };
  const router = new AiOrchestrator({
    gatewayClient:gateway,
    now:() => QUALITY_NOW,
    routeQualityEvidenceResolver:async () => [
      await qualityBenchmarkBinding(routes[1], { suffix:'quality-first-failover' }),
    ],
  });

  const result = await router.run(
    settings({
      routes,
      routePolicy:{
        retryBackoffSeconds:60,
        circuitBreakerFailures:2,
        circuitBreakerSeconds:300,
      },
    }),
    DEFAULT_AI_ROUTER_RUNTIME,
    'same logical task',
    { taskRole:'planner', maxModelCallsForRequest:2 },
  );

  assert.deepEqual(calls, ['model-route-b', 'model-route-a']);
  assert.equal(result.routing.selectedRouteId, 'route-a');
  assert.deepEqual(
    result.routing.failoverChain.map(item => `${item.routeId}:${item.outcome}`),
    ['route-b:FAILED', 'route-a:SUCCESS'],
  );
  assert.equal(
    result.runtime.routeStates['route-b'].backoffUntil,
    QUALITY_NOW + 60_000,
  );
});

test('owner autoSwitch false remains stronger than quality and stops after one retryable provider attempt', async () => {
  const routes = [qualityRoute('route-a'), qualityRoute('route-b')];
  const calls = [];
  let resolverCalls = 0;
  const gateway = {
    async complete(req) {
      calls.push(req.model);
      throw Object.assign(
        new Error('first owner-selected provider unavailable'),
        { code:'AI_PROVIDER_UNAVAILABLE', status:503 },
      );
    },
  };
  const router = new AiOrchestrator({
    gatewayClient:gateway,
    now:() => QUALITY_NOW,
    routeQualityEvidenceResolver:async () => {
      resolverCalls += 1;
      return [await qualityBenchmarkBinding(routes[1], { suffix:'must-not-widen-owner-policy' })];
    },
  });

  await assert.rejects(
    () => router.run(
      settings({
        routes,
        routePolicy:{
          autoSwitch:false,
          retryBackoffSeconds:60,
          circuitBreakerFailures:2,
          circuitBreakerSeconds:300,
        },
      }),
      DEFAULT_AI_ROUTER_RUNTIME,
      'same logical task',
      { taskRole:'planner', maxModelCallsForRequest:2 },
    ),
    error => {
      assert.equal(error.modelCallsUsed, 1);
      assert.equal(error.retryAt, QUALITY_NOW + 60_000);
      assert.deepEqual(
        error.routerRuntime.lastFailoverChain.map(
          item => `${item.routeId}:${item.outcome}`,
        ),
        ['route-a:FAILED'],
      );
      assert.equal(
        error.routerRuntime.routeStates['route-a'].backoffUntil,
        QUALITY_NOW + 60_000,
      );
      return true;
    },
  );

  assert.deepEqual(calls, ['model-route-a']);
  assert.equal(resolverCalls, 0);
});

test('route-quality lookup timeout falls back to freshly reselected canonical candidates', async () => {
  const routes = [
    qualityRoute('route-a', { priority:100 }),
    qualityRoute('route-b', { priority:20 }),
    qualityRoute('route-c', { priority:10 }),
  ];
  let nowReads = 0;
  let resolverRouteIds = null;
  const gateway = new FakeGateway(['timeout-baseline']);
  const router = new AiOrchestrator({
    gatewayClient:gateway,
    now:() => {
      nowReads += 1;
      return nowReads <= 2 ? QUALITY_NOW : QUALITY_NOW + 100;
    },
    routeQualityEvidenceTimeoutMs:5,
    routeQualityEvidenceResolver:request => {
      resolverRouteIds = [...request.routeIds];
      return new Promise(() => {});
    },
  });
  const runtime = {
    ...DEFAULT_AI_ROUTER_RUNTIME,
    routeStates:{
      'route-a':{
        consecutiveFailures:1,
        successes:0,
        failures:1,
        backoffUntil:QUALITY_NOW + 50,
        circuitOpenUntil:0,
        lastErrorCode:'HTTP_429',
        lastErrorCategory:'quota-or-rate',
        lastErrorAt:QUALITY_NOW - 100,
        lastSuccessAt:0,
        lastLatencyMs:1,
      },
    },
  };

  const result = await router.run(settings({ routes }), runtime, 'task', { taskRole:'planner' });
  assert.deepEqual(resolverRouteIds, ['route-b', 'route-c']);
  assert.equal(result.routing.selectedRouteId, 'route-a');
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].model, 'model-route-a');
});

test('late route-quality fulfillment after timeout has zero effect on baseline dispatch', async () => {
  const routes = [qualityRoute('route-a'), qualityRoute('route-b')];
  const lateEvidence = [
    await qualityBenchmarkBinding(routes[1], { suffix:'late-after-timeout' }),
  ];
  let resolveEvidence;
  const resolverPromise = new Promise(resolve => {
    resolveEvidence = resolve;
  });
  const gateway = new FakeGateway(['baseline-before-late-evidence']);
  const router = new AiOrchestrator({
    gatewayClient:gateway,
    now:() => QUALITY_NOW,
    routeQualityEvidenceTimeoutMs:5,
    routeQualityEvidenceResolver:() => resolverPromise,
  });

  const result = await router.run(
    settings({ routes }),
    DEFAULT_AI_ROUTER_RUNTIME,
    'task',
    { taskRole:'planner' },
  );
  assert.equal(result.routing.selectedRouteId, 'route-a');
  assert.deepEqual(gateway.calls.map(call => call.model), ['model-route-a']);

  resolveEvidence(lateEvidence);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(result.routing.selectedRouteId, 'route-a');
  assert.deepEqual(gateway.calls.map(call => call.model), ['model-route-a']);
});

test('route-quality lookup deadline is exact and bounded', () => {
  for (const value of [0, -0, 1.5, 5_001, Number.NaN]) {
    assert.throws(
      () => new AiOrchestrator({
        gatewayClient:new FakeGateway(),
        routeQualityEvidenceTimeoutMs:value,
      }),
      /quality evidence timeout must be a whole number from 1 to 5000 milliseconds/u,
    );
  }
  assert.doesNotThrow(
    () => new AiOrchestrator({
      gatewayClient:new FakeGateway(),
      routeQualityEvidenceTimeoutMs:1,
    }),
  );
  assert.doesNotThrow(
    () => new AiOrchestrator({
      gatewayClient:new FakeGateway(),
      routeQualityEvidenceTimeoutMs:5_000,
    }),
  );
});

test('route-quality resolver dependency must be an explicit function', () => {
  assert.throws(
    () => new AiOrchestrator({ gatewayClient:new FakeGateway(), routeQualityEvidenceResolver:{} }),
    /quality evidence resolver must be a function/u,
  );
});
