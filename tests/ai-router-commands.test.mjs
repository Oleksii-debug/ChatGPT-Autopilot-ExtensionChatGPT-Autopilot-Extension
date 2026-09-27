import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher } from '../src/core/commands.js';
import { AiOrchestrator } from '../src/core/ai-orchestrator.js';
import { createEmptyState, validateState } from '../src/core/schema.js';

class MemoryRepo {
  constructor(state = createEmptyState(1000)) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    this.state = await mutator(draft) || draft;
    this.state.revision += 1;
    validateState(this.state);
    return structuredClone(this.state);
  }
}

test('model discovery forwards exact compatible endpoint identity to Gateway', async () => {
  let request;
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiGatewayClient: { async listModels(input) { request = input; return { models:['mistral-model'] }; } },
  });
  const result = await dispatcher.execute('LIST_AI_ROUTER_MODELS', { provider:'openai-compatible', endpointId:'mistral' });
  assert.equal(request.provider, 'openai-compatible');
  assert.equal(request.endpointId, 'mistral');
  assert.deepEqual(result.result.models, ['mistral-model']);
});

test('Agent pins its own Mistral route and passes endpointId to Gateway without changing global routing', async () => {
  const calls = [];
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, {
    aiOrchestrator: new AiOrchestrator({ gatewayClient: { async complete(request) {
      calls.push(request);
      return { text:'done', usage:{ inputTokens:1, outputTokens:1, totalTokens:2 } };
    } } }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true, mode:'primary', routes:[
      { routeId:'local', provider:'ollama', model:'local-model', priority:100 },
      { routeId:'mistral-agent', provider:'openai-compatible', endpointId:'mistral', model:'mistral-small-latest',
        displayName:'Agent Implementer', systemPrompt:'Profile system', workerPrompt:'Profile worker',
        priority:1, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
    ],
  } });
  const before = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  const result = await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task', systemPrompt:'Agent project rules', isolatedRuntime:true, routerOverride:{ routeId:'mistral-agent' },
  });
  assert.equal(result.result.text, 'done');
  assert.deepEqual(calls.map(call => [call.provider, call.endpointId, call.model]),
    [['openai-compatible','mistral','mistral-small-latest']]);
  assert.equal(calls[0].systemPrompt, 'Agent project rules\n\nProfile system');
  assert.equal(calls[0].prompt, 'Profile worker\n\nagent task');
  const after = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.deepEqual(after, before, 'Agent route binding cannot mutate global config or runtime');
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task', isolatedRuntime:true, routerOverride:{ routeId:'removed-route' },
  }), /missing or disabled/);
  assert.equal(calls.length, 1, 'missing route must never silently call another provider');
});

test('Agent route binding respects a conflicting global pin', async () => {
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, { aiOrchestrator: { async run() { throw new Error('must not call provider'); } } });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true, routes:[
      { routeId:'local', provider:'ollama', model:'local-model' },
      { routeId:'mistral-agent', provider:'openai-compatible', endpointId:'mistral', model:'mistral-small-latest',
        costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
    ], routePolicy:{ pinnedRouteId:'local' },
  } });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task', isolatedRuntime:true, routerOverride:{ routeId:'mistral-agent' },
  }), /conflicts with the global pinned route/);
});

test('Agent route pin stays fail-closed under global owner policy, role filtering and durable backoff', async () => {
  const calls = [];
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, {
    aiOrchestrator: new AiOrchestrator({
      now: () => 5000,
      gatewayClient: { async complete(request) {
        calls.push(request);
        return { text:'unexpected', usage:{ inputTokens:1, outputTokens:1, totalTokens:2 } };
      } },
    }),
  });
  const routes = [
    { routeId:'local', provider:'ollama', model:'local-model', priority:100, roles:['planner','verifier'] },
    { routeId:'mistral-agent', provider:'openai-compatible', endpointId:'mistral', model:'mistral-small-latest',
      priority:1, roles:['planner'], costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
  ];
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true, mode:'primary', routes, routePolicy:{ denyRouteIds:['mistral-agent'] },
  } });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task', isolatedRuntime:true, routerOverride:{ routeId:'mistral-agent' },
  }), /No AI route satisfies/u);
  assert.equal(calls.length, 0, 'global deny policy must block the Agent pin before provider I/O');

  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true, mode:'primary', routes, routePolicy:{ denyRouteIds:[] },
  } });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'verify agent outcome', isolatedRuntime:true, taskRole:'verifier',
    routerOverride:{ routeId:'mistral-agent' },
  }), /No AI route satisfies/u);
  assert.equal(calls.length, 0, 'role-incompatible pinned route must not fall back to another model');

  const backoffState = {
    consecutiveFailures:1, successes:0, failures:1,
    backoffUntil:10000, circuitOpenUntil:0,
    lastErrorCode:'HTTP_429', lastErrorCategory:'quota-or-rate',
    lastErrorAt:4000, lastSuccessAt:0, lastLatencyMs:10,
  };
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task', isolatedRuntime:true,
    routerOverride:{ routeId:'mistral-agent' },
    routerRuntime:{ routeStates:{ 'mistral-agent':backoffState } },
  }), error => {
    assert.equal(error?.code, 'AI_ROUTE_POOL_EXHAUSTED');
    assert.equal(error?.retryAt, 10000);
    return true;
  });
  assert.equal(calls.length, 0, 'durable backoff on a pinned Agent route must not silently use another route');
});

test('fresh retryable Agent route failure preserves durable retryAt and blocks legacy strong fallback', async () => {
  const calls = [];
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, {
    aiOrchestrator: new AiOrchestrator({
      now: () => 5000,
      gatewayClient: { async complete(request) {
        calls.push(request);
        const error = new Error('provider quota exhausted');
        error.status = 429;
        throw error;
      } },
    }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    mode:'primary',
    routes:[{
      routeId:'mistral-agent',
      provider:'openai-compatible',
      endpointId:'mistral',
      model:'mistral-small-latest',
      roles:['planner'],
      costClass:'paid',
      inputPricePerMillionUsd:1,
      outputPricePerMillionUsd:2,
    }],
  } });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task',
    isolatedRuntime:true,
    routerOverride:{ routeId:'mistral-agent' },
  }), error => {
    assert.equal(error?.code, 'AI_ROUTE_POOL_EXHAUSTED');
    assert.equal(error?.retryAt, 65000);
    assert.equal(error?.routerRuntime?.routeStates?.['mistral-agent']?.backoffUntil, 65000);
    assert.equal(error?.routerRuntime?.routeStates?.['mistral-agent']?.lastErrorCategory, 'quota-or-rate');
    return true;
  });
  assert.equal(calls.length, 1, 'pinned Agent must not issue a legacy strong fallback call after a retryable provider failure');
});

test('autoSwitch=false preserves provider retryAt without issuing a second route call', async () => {
  const calls = [];
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, {
    aiOrchestrator: new AiOrchestrator({
      now: () => 5000,
      gatewayClient: { async complete(request) {
        calls.push(request);
        const error = new Error('provider quota exhausted');
        error.status = 429;
        throw error;
      } },
    }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    mode:'primary',
    routes:[{
      routeId:'mistral-agent',
      provider:'openai-compatible',
      endpointId:'mistral',
      model:'mistral-small-latest',
      roles:['planner'],
      costClass:'paid',
      inputPricePerMillionUsd:1,
      outputPricePerMillionUsd:2,
    }, {
      routeId:'verifier-fallback',
      provider:'openai-compatible',
      endpointId:'mistral',
      model:'mistral-small-latest',
      roles:['verifier'],
      costClass:'paid',
      inputPricePerMillionUsd:1,
      outputPricePerMillionUsd:2,
    }],
    routePolicy:{ autoSwitch:false, retryBackoffSeconds:60 },
  } });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task',
    isolatedRuntime:true,
    routerOverride:{ routeId:'mistral-agent' },
  }), error => {
    assert.notEqual(error?.code, 'AI_ROUTE_POOL_EXHAUSTED', 'no-switch keeps the original provider failure identity');
    assert.equal(error?.retryAt, 65000);
    assert.equal(error?.routerRuntime?.routeStates?.['mistral-agent']?.backoffUntil, 65000);
    assert.equal(error?.routerRuntime?.routeStates?.['mistral-agent']?.lastErrorCategory, 'quota-or-rate');
    return true;
  });
  assert.equal(calls.length, 1, 'pinned Agent failure must not call the eligible verifier route through legacy strong fallback');
});

test('autoSwitch=false blocks outer route fallback without requiring an Agent pin', async () => {
  const calls = [];
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, {
    aiOrchestrator: new AiOrchestrator({
      now: () => 5000,
      gatewayClient: { async complete(request) {
        calls.push(structuredClone(request));
        if (request.model === 'planner-model') {
          const error = new Error('planner provider quota exhausted');
          error.status = 429;
          throw error;
        }
        return { text:'verifier fallback must not run' };
      } },
    }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    mode:'primary',
    routes:[{
      routeId:'planner-route',
      provider:'openai-compatible',
      endpointId:'mistral',
      model:'planner-model',
      roles:['planner'],
      costClass:'paid',
      inputPricePerMillionUsd:1,
      outputPricePerMillionUsd:2,
    }, {
      routeId:'verifier-route',
      provider:'openai-compatible',
      endpointId:'mistral',
      model:'verifier-model',
      roles:['verifier'],
      costClass:'paid',
      inputPricePerMillionUsd:1,
      outputPricePerMillionUsd:2,
    }],
    routePolicy:{ autoSwitch:false, retryBackoffSeconds:60 },
  } });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task',
    isolatedRuntime:true,
  }), error => {
    assert.notEqual(error?.code, 'AI_ROUTE_POOL_EXHAUSTED', 'no-switch keeps the original provider failure identity');
    assert.equal(error?.retryAt, 65000);
    assert.equal(error?.routerRuntime?.routeStates?.['planner-route']?.backoffUntil, 65000);
    assert.equal(error?.routerRuntime?.routeStates?.['planner-route']?.lastErrorCategory, 'quota-or-rate');
    return true;
  });
  assert.equal(calls.length, 1, 'autoSwitch=false must not enter an outer verifier fallback');
  assert.equal(calls[0].model, 'planner-model');
});

test('AI router settings persist and old states without router fields stay valid', async () => {
  const old = createEmptyState(1000);
  delete old.profile.aiRouter;
  delete old.profile.aiRouterRuntime;
  assert.doesNotThrow(() => validateState(old));
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  const settings = {
    enabled: true,
    gatewayUrl: 'http://127.0.0.1:17621',
    timeoutSeconds: 200,
    mode: 'hybrid-rules',
    primary: { provider: 'ollama', model: 'qwen' },
    strong: { provider: 'openai', model: 'strong' },
    strongEveryNRequests: 5,
    strongEveryMinutes: 60,
    carryStrongResultToPrimary: true,
    handoffMaxChars: 10000,
  };
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings });
  const loaded = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.equal(loaded.settings.mode, 'hybrid-rules');
  assert.equal(loaded.settings.primary.model, 'qwen');
});

test('routed prompt persists hybrid runtime', async () => {
  const repo = new MemoryRepo();
  const fakeOrchestrator = {
    async run(settings, runtime, prompt) {
      assert.equal(prompt, 'task');
      return { ok: true, text: 'result', route: 'primary', trigger: 'primary-only', primary: { provider: 'ollama', model: 'qwen', text: 'result' }, strong: null, runtime: { ...runtime, requestCount: runtime.requestCount + 1, primaryCount: runtime.primaryCount + 1 } };
    },
  };
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, { aiOrchestrator: fakeOrchestrator });
  await repo.update(d => { d.profile.aiRouter.enabled = true; d.profile.aiRouter.primary.model = 'qwen'; return d; });
  const result = await dispatcher.execute('RUN_AI_ROUTED_PROMPT', { prompt: 'task' });
  assert.equal(result.result.text, 'result');
  const loaded = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.equal(loaded.runtime.requestCount, 1);
  assert.equal(loaded.runtime.primaryCount, 1);
});


test('isolated routed prompt applies per-Agent override without mutating global router settings/runtime', async () => {
  const repo = new MemoryRepo();
  const seen = [];
  const fakeOrchestrator = {
    async run(settings, runtime, prompt) {
      seen.push({ settings: structuredClone(settings), runtime: structuredClone(runtime), prompt });
      return {
        text: 'isolated', route: 'strong', trigger: 'strong-only', primary: null,
        strong: { provider: settings.strong.provider, model: settings.strong.model, text: 'isolated' },
        runtime: { ...runtime, requestCount: runtime.requestCount + 1, strongCount: runtime.strongCount + 1, lastRoute: 'strong' },
      };
    },
  };
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, { aiOrchestrator: fakeOrchestrator });
  await repo.update(d => {
    d.profile.aiRouter.enabled = true;
    d.profile.aiRouter.mode = 'primary';
    d.profile.aiRouter.primary = { provider: 'ollama', model: 'global-local' };
    d.profile.aiRouter.strong = { provider: 'openai', model: 'global-strong' };
    return d;
  });
  const before = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  const result = await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt: 'agent task',
    isolatedRuntime: true,
    routerRuntime: { requestCount: 7, strongCount: 2, lastRoute: 'primary' },
    routerOverride: { mode: 'strong', strong: { provider: 'openai-compatible', model: 'job-strong' } },
  });
  assert.equal(result.result.text, 'isolated');
  assert.equal(result.result.runtime.requestCount, 8);
  assert.equal(seen[0].settings.mode, 'strong');
  assert.equal(seen[0].settings.strong.provider, 'openai-compatible');
  assert.equal(seen[0].settings.strong.model, 'job-strong');
  assert.equal(seen[0].settings.primary.model, 'global-local');
  assert.equal(seen[0].runtime.requestCount, 7);
  const after = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.deepEqual(after.settings, before.settings, 'isolated Agent override must not rewrite the global router configuration');
  assert.deepEqual(after.runtime, before.runtime, 'isolated Agent route must not mutate profile-wide router runtime');
});

test('disabled AI router may persist an incomplete model draft', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  const result = await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled: false,
    mode: 'hybrid-auto',
    primary: { provider: 'ollama', model: '' },
    strong: { provider: 'openai', model: '' },
  } });
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.primary.model, '');
  assert.equal(result.settings.strong.model, '');
});

test('enabled primary mode fails closed when primary model is missing', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  await assert.rejects(
    dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
      enabled: true,
      mode: 'primary',
      primary: { provider: 'ollama', model: '' },
      strong: { provider: 'openai', model: 'strong' },
    } }),
    /Primary AI model must be selected/
  );
});

test('enabled strong mode fails closed when strong model is missing', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  await assert.rejects(
    dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
      enabled: true,
      mode: 'strong',
      primary: { provider: 'ollama', model: 'local' },
      strong: { provider: 'openai', model: '' },
    } }),
    /Strong AI model must be selected/
  );
});

test('enabled hybrid modes require both primary and strong models', async () => {
  for (const mode of ['hybrid-auto', 'hybrid-rules']) {
    const repo = new MemoryRepo();
    const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
    await assert.rejects(
      dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
        enabled: true,
        mode,
        primary: { provider: 'ollama', model: 'local' },
        strong: { provider: 'openai', model: '' },
      } }),
      /Strong AI model must be selected/
    );
  }
});

test('route pool settings and successful route health persist in the existing router state', async () => {
  const repo = new MemoryRepo();
  const fakeOrchestrator = { async run(_settings, runtime) { return {
    text:'done', route:'primary', primary:{ provider:'ollama', model:'local', routeId:'local' }, strong:null,
    runtime:{ ...runtime, requestCount:runtime.requestCount + 1, primaryCount:runtime.primaryCount + 1, lastRoute:'primary', lastRouteId:'local', lastFailoverChain:[{ routeId:'local', outcome:'SUCCESS', code:'', category:'' }], routeStates:{ local:{ consecutiveFailures:0, successes:1, failures:0, backoffUntil:0, circuitOpenUntil:0, lastErrorCode:'', lastErrorCategory:'', lastErrorAt:0, lastSuccessAt:2000, lastLatencyMs:10 } } },
  }; } };
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, { aiOrchestrator:fakeOrchestrator });
  const settings = {
    enabled:true, mode:'primary', primary:{ provider:'ollama', model:'' }, strong:{ provider:'openai', model:'' },
    routes:[{ routeId:'local', provider:'ollama', model:'local', roles:['planner'], priority:10 }],
    routePolicy:{ pinnedRouteId:'local', autoSwitch:true },
  };
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings });
  await dispatcher.execute('RUN_AI_ROUTED_PROMPT', { prompt:'task' });
  const loaded = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.equal(loaded.settings.routes[0].routeId, 'local');
  assert.equal(loaded.settings.routePolicy.pinnedRouteId, 'local');
  assert.equal(loaded.runtime.lastRouteId, 'local');
  assert.equal(loaded.runtime.routeStates.local.successes, 1);
});

test('failed route health persists for restart without counting a completed request', async () => {
  const repo = new MemoryRepo();
  const failureRuntime = { requestCount:0, primaryCount:0, strongCount:0, routeStates:{ a:{ consecutiveFailures:1, successes:0, failures:1, backoffUntil:62_000, circuitOpenUntil:0, lastErrorCode:'HTTP_429', lastErrorCategory:'quota-or-rate', lastErrorAt:2000, lastSuccessAt:0, lastLatencyMs:5 } }, lastRouteId:'', lastFailoverChain:[{ routeId:'a', outcome:'FAILED', code:'HTTP_429', category:'quota-or-rate' }] };
  const fakeOrchestrator = { async run() { const error = new Error('all routes exhausted'); error.routerRuntime = failureRuntime; error.modelCallsUsed = 1; throw error; } };
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, { aiOrchestrator:fakeOrchestrator });
  await repo.update(draft => { draft.profile.aiRouter.enabled = true; draft.profile.aiRouter.primary.model = 'legacy'; return draft; });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', { prompt:'task' }), /exhausted/);
  const loaded = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.equal(loaded.runtime.requestCount, 0);
  assert.equal(loaded.runtime.routeStates.a.backoffUntil, 62_000);
  assert.equal(loaded.runtime.lastFailoverChain[0].routeId, 'a');
});

test('route profile names and prompts persist through the canonical router settings boundary', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  const settings = {
    enabled: false,
    mode: 'primary',
    primary: { provider: 'ollama', model: '' },
    strong: { provider: 'openai', model: '' },
    routes: [{
      routeId: 'implementer',
      provider: 'ollama',
      model: 'qwen',
      displayName: 'Implementer',
      systemPrompt: '  Preserve project policy.\nKeep spacing.  ',
      workerPrompt: '\nImplement the assigned slice.  ',
      roles: ['coder'],
      priority: 10,
    }],
  };
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings });
  const loaded = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.equal(loaded.settings.routes[0].displayName, 'Implementer');
  assert.equal(loaded.settings.routes[0].systemPrompt, '  Preserve project policy.\nKeep spacing.  ');
  assert.equal(loaded.settings.routes[0].workerPrompt, '\nImplement the assigned slice.  ');
});

test('pinned Agent route cannot bypass requested-role filtering through strong fallback', async () => {
  const calls = [];
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: new AiOrchestrator({
      now: () => 5000,
      gatewayClient: { async complete(request) {
        calls.push(request);
        return { text:'unexpected', usage:{ inputTokens:1, outputTokens:1, totalTokens:2 } };
      } },
    }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    mode:'primary',
    routes:[{
      routeId:'verifier-only',
      provider:'ollama',
      model:'qwen',
      roles:['verifier'],
      priority:10,
    }],
  } });
  await assert.rejects(
    () => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
      prompt:'plan this task',
      isolatedRuntime:true,
      taskRole:'planner',
      routerOverride:{ routeId:'verifier-only' },
    }),
    error => error?.code === 'AI_ROUTE_POOL_EXHAUSTED' && error?.retryAt === 0,
  );
  assert.equal(calls.length, 0, 'pinned route role mismatch must fail before provider I/O rather than being reclassified as verifier fallback');
});


test('Agent route policy can narrow global Models policy without mutating it', async () => {
  const calls = [];
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, {
    aiOrchestrator: new AiOrchestrator({ gatewayClient: { async complete(request) {
      calls.push(request);
      return { text:'done', usage:{ inputTokens:1, outputTokens:1, totalTokens:2 } };
    } } }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    mode:'primary',
    routes:[
      { routeId:'local-a', provider:'ollama', model:'local-a', priority:10, costClass:'free', locality:'local' },
      { routeId:'local-b', provider:'ollama', model:'local-b', priority:20, costClass:'free', locality:'local' },
      { routeId:'paid', provider:'openai', model:'paid', priority:1, costClass:'paid',
        inputPricePerMillionUsd:2, outputPricePerMillionUsd:4, locality:'remote' },
    ],
    routePolicy:{ allowRouteIds:['local-a','local-b','paid'], maxInputPricePerMillionUsd:5 },
  } });
  const before = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  const result = await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task',
    isolatedRuntime:true,
    routerOverride:{
      routePolicy:{
        autoSwitch:false,
        allowRouteIds:['local-b'],
        freeOnly:true,
        locality:'local',
        maxInputPricePerMillionUsd:1,
      },
    },
  });
  assert.equal(result.result.text, 'done');
  assert.deepEqual(calls.map(call => call.model), ['local-b']);
  const after = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.deepEqual(after, before, 'per-Agent policy must never mutate global Models settings');
});

test('Agent route policy fails closed before real provider I/O when Models has no route pool', async () => {
  const calls = [];
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: new AiOrchestrator({ gatewayClient: { async complete(request) {
      calls.push(request);
      return { text:'must-not-run', usage:{ inputTokens:1, outputTokens:1, totalTokens:2 } };
    } } }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    mode:'primary',
    primary:{ provider:'openai', model:'legacy-paid' },
    strong:{ provider:'openai', model:'legacy-strong' },
    routes:[],
  } });

  for (const routePolicy of [
    { freeOnly:true, locality:'local', maxInputPricePerMillionUsd:0, maxOutputPricePerMillionUsd:0 },
    { autoSwitch:false },
  ]) {
    await assert.rejects(
      () => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
        prompt:'agent task',
        isolatedRuntime:true,
        routerOverride:{ routePolicy },
      }),
      /requires a configured Models route pool/u,
    );
  }
  assert.equal(calls.length, 0, 'legacy primary/strong slots must not bypass per-Agent route policy or no-switch semantics');
});

test('Agent route policy fails closed when it widens global allow-list, locality or pin authority', async () => {
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: { async run() { throw new Error('provider must not run'); } },
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    routes:[
      { routeId:'local', provider:'ollama', model:'local', costClass:'free', locality:'local' },
      { routeId:'remote', provider:'openai', model:'remote', costClass:'paid', locality:'remote',
        inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
    ],
    routePolicy:{ allowRouteIds:['local'], locality:'local', pinnedRouteId:'local' },
  } });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'x', isolatedRuntime:true,
    routerOverride:{ routePolicy:{ allowRouteIds:['remote'] } },
  }), /exceeds the global allow-list/);
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'x', isolatedRuntime:true,
    routerOverride:{ routePolicy:{ locality:'remote' } },
  }), /exceeds the global locality policy/);
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'x', isolatedRuntime:true,
    routerOverride:{ routePolicy:{ pinnedRouteId:'remote' } },
  }), /conflicts with the global pinned route/);
});

test('Agent route policy rejects resilience controls and hostile fields instead of creating policy authority', async () => {
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: { async run() { throw new Error('provider must not run'); } },
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    routes:[{ routeId:'local', provider:'ollama', model:'local' }],
  } });
  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'x', isolatedRuntime:true,
    routerOverride:{ routePolicy:{ retryBackoffSeconds:1 } },
  }), /unsupported field/);
});


test('Agent route policy composes with legacy per-Agent route pin without mutating frozen policy', async () => {
  const calls = [];
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: new AiOrchestrator({ gatewayClient: { async complete(request) {
      calls.push(request);
      return { text:'done', usage:{ inputTokens:1, outputTokens:1, totalTokens:2 } };
    } } }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    mode:'primary',
    routes:[
      { routeId:'local-a', provider:'ollama', model:'local-a', priority:1, costClass:'free', locality:'local' },
      { routeId:'local-b', provider:'ollama', model:'local-b', priority:2, costClass:'free', locality:'local' },
    ],
  } });
  const result = await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task',
    isolatedRuntime:true,
    routerOverride:{
      routePolicy:{ allowRouteIds:['local-b'], freeOnly:true, locality:'local' },
      routeId:'local-b',
    },
  });
  assert.equal(result.result.text, 'done');
  assert.deepEqual(calls.map(call => call.model), ['local-b']);
});


test('Agent router override boundary rejects accessors without executing them', async () => {
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: { async run() { throw new Error('provider must not run'); } },
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    routes:[{ routeId:'local', provider:'ollama', model:'local' }],
  } });

  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'routeId', {
    enumerable:true,
    get() {
      reads += 1;
      return 'local';
    },
  });
  await assert.rejects(
    () => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
      prompt:'x',
      isolatedRuntime:true,
      routerOverride:hostile,
    }),
    /data-only fields/,
  );
  assert.equal(reads, 0);

  const hostileSlot = {};
  Object.defineProperty(hostileSlot, 'model', {
    enumerable:true,
    get() {
      reads += 1;
      return 'local';
    },
  });
  await assert.rejects(
    () => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
      prompt:'x',
      isolatedRuntime:true,
      routerOverride:{ primary: hostileSlot },
    }),
    /data-only fields/,
  );
  assert.equal(reads, 0);
});


test('Agent route policy cannot weaken global deny, free-only or price ceilings', async () => {
  const calls = [];
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: new AiOrchestrator({ gatewayClient: { async complete(request) {
      calls.push(request);
      return { text:'done', usage:{ inputTokens:1, outputTokens:1, totalTokens:2 } };
    } } }),
  });
  const routes = [
    { routeId:'local-free', provider:'ollama', model:'local-free', priority:20, costClass:'free', locality:'local' },
    { routeId:'paid-cheap', provider:'openai', model:'paid-cheap', priority:1, costClass:'paid', locality:'remote',
      inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
    { routeId:'paid-expensive', provider:'openai', model:'paid-expensive', priority:0, costClass:'paid', locality:'remote',
      inputPricePerMillionUsd:10, outputPricePerMillionUsd:20 },
  ];
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    routes,
    routePolicy:{
      denyRouteIds:['paid-cheap'],
      freeOnly:true,
      maxInputPricePerMillionUsd:5,
      maxOutputPricePerMillionUsd:5,
    },
  } });
  const result = await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task',
    isolatedRuntime:true,
    routerOverride:{
      routePolicy:{
        autoSwitch:true,
        allowRouteIds:['local-free'],
        freeOnly:false,
        locality:'any',
        maxInputPricePerMillionUsd:null,
        maxOutputPricePerMillionUsd:null,
      },
    },
  });
  assert.equal(result.result.text, 'done');
  assert.deepEqual(calls.map(call => call.model), ['local-free']);

  await assert.rejects(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task',
    isolatedRuntime:true,
    routerOverride:{ routePolicy:{ allowRouteIds:['paid-cheap'] } },
  }), /No AI route satisfies|exceeds the global allow-list/);
  assert.equal(calls.length, 1);
});

test('Agent price ceiling takes the stricter minimum of global and per-Agent caps', async () => {
  const calls = [];
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: new AiOrchestrator({ gatewayClient: { async complete(request) {
      calls.push(request);
      return { text:'done', usage:{ inputTokens:1, outputTokens:1, totalTokens:2 } };
    } } }),
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    routes:[
      { routeId:'cheap', provider:'openai', model:'cheap', priority:20, costClass:'paid', locality:'remote',
        inputPricePerMillionUsd:1, outputPricePerMillionUsd:1 },
      { routeId:'mid', provider:'openai', model:'mid', priority:1, costClass:'paid', locality:'remote',
        inputPricePerMillionUsd:4, outputPricePerMillionUsd:4 },
    ],
    routePolicy:{ maxInputPricePerMillionUsd:5, maxOutputPricePerMillionUsd:5 },
  } });
  const result = await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'agent task',
    isolatedRuntime:true,
    routerOverride:{ routePolicy:{ maxInputPricePerMillionUsd:2, maxOutputPricePerMillionUsd:2 } },
  });
  assert.equal(result.result.text, 'done');
  assert.deepEqual(calls.map(call => call.model), ['cheap']);
});
