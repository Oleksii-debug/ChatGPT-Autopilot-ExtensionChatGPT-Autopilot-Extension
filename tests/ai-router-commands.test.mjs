import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher } from '../src/core/commands.js';
import { AiOrchestrator } from '../src/core/ai-orchestrator.js';
import {
  AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
} from '../src/core/agent-model-orchestrator-envelope.js';
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


test('AI route-pool revision advances only when normalized route pool changes', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  const initial = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.equal(initial.routePoolRevision, 1);

  const routeA = {
    routeId: 'route.revision-a',
    provider: 'ollama',
    model: 'model-a',
    priority: 10,
    costClass: 'free',
    locality: 'local',
  };
  const changed = await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', {
    settings: {
      ...initial.settings,
      enabled: false,
      routes: [routeA],
      routePolicy: {},
    },
  });
  assert.equal(changed.routePoolRevision, 2);
  assert.equal((await dispatcher.execute('GET_AI_ROUTER_SETTINGS')).routePoolRevision, 2);

  const policyOnly = await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', {
    settings: {
      ...changed.settings,
      routePolicy: { allowRouteIds: ['route.revision-a'], freeOnly: true },
    },
  });
  assert.equal(policyOnly.routePoolRevision, 2, 'policy-only changes must not invent a new route-pool identity');

  const identityChanged = await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', {
    settings: {
      ...policyOnly.settings,
      routes: [{ ...routeA, model: 'model-b' }],
    },
  });
  assert.equal(identityChanged.routePoolRevision, 3);
  const loaded = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.equal(loaded.routePoolRevision, 3);
  assert.equal(loaded.settings.routes[0].model, 'model-b');
});

test('AI route-pool revision fails closed instead of overflowing canonical safe integer identity', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  await repo.update(draft => {
    draft.profile.aiRoutePoolRevision = Number.MAX_SAFE_INTEGER;
    return draft;
  });
  const before = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  await assert.rejects(
    dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', {
      settings: {
        ...before.settings,
        enabled: false,
        routes: [{
          routeId: 'route.revision-overflow',
          provider: 'ollama',
          model: 'model-overflow',
          priority: 1,
        }],
      },
    }),
    /route-pool revision exhausted/,
  );
  const after = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.equal(after.routePoolRevision, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(after.settings, before.settings);
});

test('routed prompt cannot silently replace durable Router topology or route-pool revision', async () => {
  const repo = new MemoryRepo();
  const seen = [];
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, {
    aiOrchestrator: {
      async run(settings, runtime) {
        seen.push(structuredClone(settings));
        return {
          text: 'one-shot',
          route: 'primary',
          trigger: 'primary-only',
          primary: { provider: settings.primary.provider, model: settings.primary.model, text: 'one-shot' },
          strong: null,
          runtime: { ...runtime, requestCount: runtime.requestCount + 1, primaryCount: runtime.primaryCount + 1 },
        };
      },
    },
  });

  const durable = await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', {
    settings: {
      enabled: true,
      mode: 'primary',
      primary: { provider: 'ollama', model: 'durable-model' },
      routes: [{
        routeId: 'route.durable',
        provider: 'ollama',
        model: 'durable-model',
        priority: 10,
        locality: 'local',
        costClass: 'free',
      }],
    },
  });
  assert.equal(durable.routePoolRevision, 2);
  const before = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');

  const result = await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt: 'one-shot settings',
    settings: {
      ...before.settings,
      primary: { provider: 'ollama', model: 'ephemeral-model' },
      routes: [{
        routeId: 'route.ephemeral',
        provider: 'ollama',
        model: 'ephemeral-model',
        priority: 1,
        locality: 'local',
        costClass: 'free',
      }],
    },
  });
  assert.equal(result.result.text, 'one-shot');
  assert.equal(seen[0].routes[0].routeId, 'route.ephemeral');

  const after = await dispatcher.execute('GET_AI_ROUTER_SETTINGS');
  assert.deepEqual(after.settings, before.settings, 'execution input must not become durable Router configuration');
  assert.equal(after.routePoolRevision, before.routePoolRevision, 'execution must not silently mint or bypass route-pool identity');
  assert.equal(after.runtime.requestCount, before.runtime.requestCount + 1, 'execution telemetry remains durable');
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

test('isolated Agent router override snapshots nested policy before asynchronous settings load', async () => {
  const repo = new MemoryRepo();
  const seen = [];
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, {
    aiOrchestrator: {
      async run(settings, runtime) {
        seen.push(structuredClone(settings));
        return {
          text: 'isolated',
          route: 'primary',
          trigger: 'primary-only',
          primary: { provider: 'ollama', model: 'model-a', text: 'isolated' },
          strong: null,
          runtime: { ...runtime, requestCount: runtime.requestCount + 1, primaryCount: runtime.primaryCount + 1 },
        };
      },
    },
  });

  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled: true,
    mode: 'primary',
    routes: [
      { routeId: 'route-a', provider: 'ollama', model: 'model-a', priority: 10 },
      { routeId: 'route-b', provider: 'ollama', model: 'model-b', priority: 20 },
    ],
    routePolicy: { allowRouteIds: ['route-a', 'route-b'] },
  } });

  const originalLoad = repo.load.bind(repo);
  let releaseLoad;
  let markLoadEntered;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const loadEntered = new Promise(resolve => { markLoadEntered = resolve; });
  repo.load = async () => {
    markLoadEntered();
    await loadGate;
    return originalLoad();
  };

  const routePolicy = {
    allowRouteIds: ['route-a'],
    orderedRouteIds: ['route-a'],
    freeOnly: true,
  };
  const routerOverride = { routePolicy };
  const pending = dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt: 'agent task',
    isolatedRuntime: true,
    routerOverride,
  });

  await loadEntered;
  routePolicy.allowRouteIds[0] = 'route-b';
  routePolicy.orderedRouteIds[0] = 'route-b';
  routePolicy.freeOnly = false;
  routerOverride.routePolicy = { allowRouteIds: ['route-b'] };
  releaseLoad();

  const result = await pending;
  assert.equal(result.result.text, 'isolated');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].routePolicy.allowRouteIds, ['route-a']);
  assert.deepEqual(seen[0].routePolicy.orderedRouteIds, ['route-a']);
  assert.equal(seen[0].routePolicy.freeOnly, true);
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

test('Agent route policy can only tighten global resilience controls', async () => {
  const seen = [];
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2000, {
    aiOrchestrator: {
      async run(settings, runtime) {
        seen.push(structuredClone(settings.routePolicy));
        return { text:'ok', runtime };
      },
    },
  });
  await dispatcher.execute('UPDATE_AI_ROUTER_SETTINGS', { settings: {
    enabled:true,
    routes:[{ routeId:'local', provider:'ollama', model:'local' }],
    routePolicy:{
      retryBackoffSeconds:90,
      circuitBreakerFailures:4,
      circuitBreakerSeconds:300,
    },
  } });

  await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'stricter', isolatedRuntime:true,
    routerOverride:{ routePolicy:{
      retryBackoffSeconds:120,
      circuitBreakerFailures:2,
      circuitBreakerSeconds:600,
    } },
  });
  assert.equal(seen[0].retryBackoffSeconds, 120);
  assert.equal(seen[0].circuitBreakerFailures, 2);
  assert.equal(seen[0].circuitBreakerSeconds, 600);

  await dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
    prompt:'cannot-weaken', isolatedRuntime:true,
    routerOverride:{ routePolicy:{
      retryBackoffSeconds:30,
      circuitBreakerFailures:10,
      circuitBreakerSeconds:60,
    } },
  });
  assert.equal(seen[1].retryBackoffSeconds, 90);
  assert.equal(seen[1].circuitBreakerFailures, 4);
  assert.equal(seen[1].circuitBreakerSeconds, 300);
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


test('Agent runtime route policy rejects coercive aliases before provider I/O', async () => {
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
    routes:[{ routeId:'local', provider:'ollama', model:'local', costClass:'free', locality:'local' }],
  } });

  for (const routePolicy of [
    { autoSwitch:'false' },
    { freeOnly:1 },
    { locality:' local ' },
    { maxInputPricePerMillionUsd:'0' },
    { maxOutputPricePerMillionUsd:-0 },
    { retryBackoffSeconds:'120' },
    { retryBackoffSeconds:-0 },
    { circuitBreakerFailures:'2' },
    { circuitBreakerFailures:-0 },
    { circuitBreakerSeconds:'600' },
    { circuitBreakerSeconds:-0 },
    { allowRouteIds:[' local '] },
  ]) {
    await assert.rejects(
      () => dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
        prompt:'agent task',
        isolatedRuntime:true,
        routerOverride:{ routePolicy },
      }),
      /must already be canonical|invalid/u,
    );
  }
  assert.equal(calls.length, 0);
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


function internalAgentEnvelope(overrides = {}) {
  const route = {
    schemaVersion: 1,
    routeId: 'route.agent',
    provider: 'openai',
    model: 'agent-model',
    endpointId: '',
    displayName: 'Agent model',
    systemPrompt: '',
    workerPrompt: '',
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
  };
  return {
    schemaVersion: 1,
    jobId: 'agent.job.1',
    projectId: 'project.alpha',
    definitionModelPolicyBindingKey: 'definition.binding',
    modelPolicyBindingKey: 'model.binding',
    routePoolRevision: 9,
    role: 'coder',
    capabilityIds: ['cap.reason'],
    requiresVision: false,
    preparedAt: 1_000,
    revalidatedAt: 1_500,
    routeId: 'route.agent',
    settings: {
      enabled: true,
      gatewayUrl: 'http://127.0.0.1:3210',
      timeoutSeconds: 180,
      mode: 'primary',
      primary: { provider: 'openai', model: 'agent-model' },
      strong: { provider: 'openai', model: 'agent-model' },
      strongEveryNRequests: 0,
      strongEveryMinutes: 0,
      strongMinGapMinutes: 0,
      strongMaxPerHour: 0,
      carryStrongResultToPrimary: false,
      fallbackToStrongOnPrimaryError: false,
      keepPrimaryIfStrongFails: true,
      routes: [route],
      routePolicy: {
        autoSwitch: false,
        pinnedRouteId: 'route.agent',
        orderedRouteIds: ['route.agent'],
        allowRouteIds: ['route.agent'],
        denyRouteIds: [],
        freeOnly: false,
        locality: 'remote',
        maxInputPricePerMillionUsd: 4,
        maxOutputPricePerMillionUsd: 5,
      },
    },
    runtime: {
      requestCount: 7,
      routeStates: {
        'route.agent': {
          consecutiveFailures: 0,
          successes: 2,
          failures: 0,
          backoffUntil: 0,
          circuitOpenUntil: 0,
          lastErrorCode: '',
          lastErrorCategory: '',
          lastErrorAt: 0,
          lastSuccessAt: 1_400,
          lastLatencyMs: 12,
        },
      },
      lastRouteId: 'route.agent',
      lastFailoverChain: [],
    },
    authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
    ...overrides,
  };
}

function internalAgentBudgetContext(jobId = 'agent.job.1') {
  return { kind: 'browser-agent', jobId, controlEpoch: 7 };
}

test('internal Agent envelope reaches canonical AiOrchestrator as isolated one-route execution', async () => {
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const before = structuredClone(repo.state.profile.aiRouter);
  const beforeRuntime = structuredClone(repo.state.profile.aiRouterRuntime);
  const seen = [];
  const fakeOrchestrator = {
    async run(settings, runtime, prompt, options) {
      seen.push({
        settings: structuredClone(settings),
        runtime: structuredClone(runtime),
        prompt,
        options: structuredClone(options),
      });
      return {
        text: 'agent result',
        route: 'route.agent',
        primary: { provider: 'openai', model: 'agent-model', routeId: 'route.agent' },
        strong: null,
        runtime: {
          ...runtime,
          requestCount: runtime.requestCount + 1,
          lastRouteId: 'route.agent',
        },
      };
    },
  };
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: fakeOrchestrator,
  });

  const result = await dispatcher.execute(
    'RUN_AI_ROUTED_PROMPT',
    {
      prompt: 'bounded Agent task',
      systemPrompt: 'Stay inside the task.',
      maxOutputTokens: 512,
      maxModelCallsForRequest: 1,
    },
    {
      agentModelOrchestratorEnvelope: envelope,
      providerCallBudgetContext: internalAgentBudgetContext(),
    },
  );

  assert.equal(result.result.text, 'agent result');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].settings.routes.map(route => route.routeId), ['route.agent']);
  assert.equal(seen[0].settings.routePolicy.pinnedRouteId, 'route.agent');
  assert.equal(seen[0].runtime.requestCount, 7);
  assert.equal(seen[0].options.taskRole, 'coder');
  assert.equal(seen[0].options.strongTaskRole, 'coder');
  assert.deepEqual(seen[0].options.capabilityIds, ['cap.reason']);
  assert.equal(seen[0].options.forceStrong, false);
  assert.equal(seen[0].options.maxModelCallsForRequest, 1);
  assert.deepEqual(seen[0].options.providerCallBudgetContext, {
    kind: 'browser-agent',
    jobId: 'agent.job.1',
    controlEpoch: 7,
  });
  assert.deepEqual(repo.state.profile.aiRouter, before);
  assert.deepEqual(repo.state.profile.aiRouterRuntime, beforeRuntime);
});

test('Agent orchestrator envelope is internal-only and cannot be injected through UI payload', async () => {
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2_000, {
    aiOrchestrator: { async run() { throw new Error('must not run'); } },
  });
  await assert.rejects(
    dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
      prompt: 'forged',
      agentModelOrchestratorEnvelope: internalAgentEnvelope(),
    }),
    /internal-only/u,
  );
});

test('internal Agent envelope cannot be mixed with caller Router or role aliases', async () => {
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2_000, {
    aiOrchestrator: { async run() { throw new Error('must not run'); } },
  });
  for (const alias of [
    { routerOverride: { mode: 'strong' } },
    { routerRuntime: { requestCount: 999 } },
    { isolatedRuntime: false },
    { forceStrong: true },
    { taskRole: 'planner' },
    { strongTaskRole: 'verifier' },
    { capabilityIds: ['forged'] },
  ]) {
    await assert.rejects(
      dispatcher.execute(
        'RUN_AI_ROUTED_PROMPT',
        { prompt: 'agent', ...alias },
        { agentModelOrchestratorEnvelope: internalAgentEnvelope() },
      ),
      /cannot be mixed with payload Router aliases/u,
    );
  }
});

test('internal Agent authority options reject accessors without executing getters', async () => {
  let calls = 0;
  let reads = 0;
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });

  const envelopeAccessor = {};
  Object.defineProperty(envelopeAccessor, 'agentModelOrchestratorEnvelope', {
    enumerable:true,
    get() {
      reads += 1;
      return internalAgentEnvelope();
    },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:1 },
      envelopeAccessor,
    ),
    /orchestrator envelope must be an enumerable own data property/u,
  );

  const budgetAccessor = {
    agentModelOrchestratorEnvelope: internalAgentEnvelope(),
  };
  Object.defineProperty(budgetAccessor, 'providerCallBudgetContext', {
    enumerable:true,
    get() {
      reads += 1;
      return internalAgentBudgetContext();
    },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:1 },
      budgetAccessor,
    ),
    /provider budget context must be an enumerable own data property/u,
  );

  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('internal Agent envelope rejects image input that does not match durable vision intent before provider use', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const nonVision = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(nonVision.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(nonVision.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });

  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:1, imageDataUrl:'data:image/png;base64,AAAA' },
      {
        agentModelOrchestratorEnvelope: nonVision,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /image input does not match durable requiresVision intent/u,
  );

  const vision = internalAgentEnvelope({ requiresVision:true });
  vision.settings.routes[0].supportsVision = true;
  repo.state.profile.aiRouter = structuredClone(vision.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(vision.runtime);
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:1 },
      {
        agentModelOrchestratorEnvelope: vision,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /image input does not match durable requiresVision intent/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent envelope preserves exact canonical vision input into AiOrchestrator', async () => {
  const seen = [];
  const repo = new MemoryRepo();
  const vision = internalAgentEnvelope({ requiresVision:true });
  vision.settings.routes[0].supportsVision = true;
  repo.state.profile.aiRouter = structuredClone(vision.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(vision.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: {
      async run(settings, runtime, prompt, options) {
        seen.push(structuredClone(options));
        return { text:'ok', runtime };
      },
    },
  });
  const imageDataUrl = 'data:image/png;base64,AAAA';
  const result = await dispatcher.execute(
    'RUN_AI_ROUTED_PROMPT',
    { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:1, imageDataUrl },
    {
      agentModelOrchestratorEnvelope: vision,
      providerCallBudgetContext: internalAgentBudgetContext(),
    },
  );
  assert.equal(result.result.text, 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].imageDataUrl, imageDataUrl);
});

test('internal Agent dispatcher snapshots validated vision input across async Router revalidation', async () => {
  let releaseLoad;
  let markLoadStarted;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const loadStarted = new Promise(resolve => { markLoadStarted = resolve; });
  class DelayedRepo extends MemoryRepo {
    async load() {
      markLoadStarted();
      await loadGate;
      return super.load();
    }
  }

  const seen = [];
  const repo = new DelayedRepo();
  const vision = internalAgentEnvelope({ requiresVision:true });
  vision.settings.routes[0].supportsVision = true;
  repo.state.profile.aiRouter = structuredClone(vision.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(vision.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: {
      async run(settings, runtime, prompt, options) {
        seen.push(options.imageDataUrl);
        return { text:'ok', runtime };
      },
    },
  });
  const payload = {
    prompt:'agent',
    maxOutputTokens:128, maxModelCallsForRequest:1,
    imageDataUrl:'data:image/png;base64,ORIGINAL',
  };
  const pending = dispatcher.execute(
    'RUN_AI_ROUTED_PROMPT',
    payload,
    {
      agentModelOrchestratorEnvelope: vision,
      providerCallBudgetContext: internalAgentBudgetContext(),
    },
  );
  await loadStarted;
  payload.imageDataUrl = 'data:image/png;base64,MUTATED';
  releaseLoad();
  const result = await pending;
  assert.equal(result.result.text, 'ok');
  assert.deepEqual(seen, ['data:image/png;base64,ORIGINAL']);
});

test('internal Agent dispatcher snapshots prompt and request budgets before async Router revalidation', async () => {
  let releaseLoad;
  let markLoadStarted;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const loadStarted = new Promise(resolve => { markLoadStarted = resolve; });
  class DelayedRepo extends MemoryRepo {
    async load() {
      markLoadStarted();
      await loadGate;
      return super.load();
    }
  }

  const seen = [];
  const repo = new DelayedRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: {
      async run(settings, runtime, prompt, options) {
        seen.push({
          prompt,
          systemPrompt: options.systemPrompt,
          maxOutputTokens: options.maxOutputTokens,
          maxModelCallsForRequest: options.maxModelCallsForRequest,
        });
        return { text:'ok', runtime };
      },
    },
  });
  const payload = {
    prompt:'ORIGINAL_PROMPT',
    systemPrompt:'ORIGINAL_SYSTEM',
    maxOutputTokens:128,
    maxModelCallsForRequest:1,
  };
  const pending = dispatcher.execute(
    'RUN_AI_ROUTED_PROMPT',
    payload,
    {
      agentModelOrchestratorEnvelope: envelope,
      providerCallBudgetContext: internalAgentBudgetContext(),
    },
  );
  await loadStarted;
  payload.prompt = 'MUTATED_PROMPT';
  payload.systemPrompt = 'MUTATED_SYSTEM';
  payload.maxOutputTokens = 999;
  payload.maxModelCallsForRequest = 99;
  releaseLoad();
  const result = await pending;
  assert.equal(result.result.text, 'ok');
  assert.deepEqual(seen, [{
    prompt:'ORIGINAL_PROMPT',
    systemPrompt:'ORIGINAL_SYSTEM',
    maxOutputTokens:128,
    maxModelCallsForRequest:1,
  }]);
});

test('internal Agent invocation rejects input larger than the durable Browser Agent reservation estimator', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });

  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt:'x'.repeat(100_001), maxOutputTokens:128 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /prompt exceeds the durable Browser Agent input-budget bound/u,
  );
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt:'agent', systemPrompt:'x'.repeat(50_001), maxOutputTokens:128 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /systemPrompt exceeds the durable Browser Agent input-budget bound/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent dispatcher rejects accessor-backed prompt and request-budget fields without getter execution', async () => {
  let calls = 0;
  let reads = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });

  for (const field of ['prompt', 'systemPrompt', 'maxOutputTokens', 'maxModelCallsForRequest']) {
    const payload = {
      prompt:'agent',
      systemPrompt:'',
      maxOutputTokens:128,
      maxModelCallsForRequest:1,
    };
    Object.defineProperty(payload, field, {
      enumerable:true,
      get() {
        reads += 1;
        return field.includes('Tokens') || field.includes('Calls') ? 128 : 'hostile';
      },
    });
    await assert.rejects(
      dispatcher.execute(
        'RUN_AI_ROUTED_PROMPT',
        payload,
        {
          agentModelOrchestratorEnvelope: envelope,
          providerCallBudgetContext: internalAgentBudgetContext(),
        },
      ),
      /enumerable own text data property|canonical bounded maxOutputTokens|maxModelCallsForRequest must be canonical/u,
    );
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('internal Agent image boundary rejects coercive text and accessors without executing getters', async () => {
  let calls = 0;
  let reads = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });

  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:1, imageDataUrl:' data:image/png;base64,AAAA ' },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /imageDataUrl must already be canonical text/u,
  );

  const payload = { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:1 };
  Object.defineProperty(payload, 'imageDataUrl', {
    enumerable:true,
    get() {
      reads += 1;
      return 'data:image/png;base64,AAAA';
    },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      payload,
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /imageDataUrl must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('internal Agent envelope authority widening fails before model invocation', async () => {
  let calls = 0;
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  const widened = internalAgentEnvelope({
    authority: {
      ...AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
      providerCallAuthorized: true,
    },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent' },
      { agentModelOrchestratorEnvelope: widened },
    ),
    /authority is invalid/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent envelope rejects route-state leakage before model invocation', async () => {
  let calls = 0;
  const dispatcher = new CoreCommandDispatcher(new MemoryRepo(), () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  const envelope = internalAgentEnvelope();
  envelope.runtime.routeStates['route.other'] = {
    consecutiveFailures: 0,
    successes: 0,
    failures: 0,
    backoffUntil: 0,
    circuitOpenUntil: 0,
    lastErrorCode: '',
    lastErrorCategory: '',
    lastErrorAt: 0,
    lastSuccessAt: 0,
    lastLatencyMs: 0,
  };
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /unknown route state|runtime leaks another route/u,
  );
  assert.equal(calls, 0);
});


test('internal Agent envelope rechecks live canonical Router deny before provider invocation', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouter.routePolicy.denyRouteIds = ['route.agent'];
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /no longer authorized by current canonical Router/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent envelope rechecks live route identity before provider invocation', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouter.routes[0].model = 'changed-model';
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /route identity drifted before provider invocation/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent envelope rechecks live route backoff before provider invocation', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  repo.state.profile.aiRouterRuntime.routeStates['route.agent'].backoffUntil = 3_000;
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /no longer authorized by current canonical Router/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent envelope fails closed when live canonical Router is disabled', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouter.enabled = false;
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /Current canonical AI Router is disabled/u,
  );
  assert.equal(calls, 0);
});


test('internal Agent invocation requires the existing durable browser-agent budget lifecycle', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });

  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      { agentModelOrchestratorEnvelope: envelope },
    ),
    /provider budget context must be an enumerable own data property/u,
  );
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: { kind:'self-repair', jobId:'agent.job.1', controlEpoch:7 },
      },
    ),
    /requires an existing durable provider budget lifecycle/u,
  );
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext('other.job'),
      },
    ),
    /budget owner does not match envelope job identity/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent invocation requires a bounded output-token reservation', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent' },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /requires canonical bounded maxOutputTokens/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent invocation rejects coercive maxOutputTokens aliases before provider use', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  for (const maxOutputTokens of ['128', true, 128.5, -0]) {
    await assert.rejects(
      dispatcher.execute(
        'RUN_AI_ROUTED_PROMPT',
        { prompt:'agent', maxOutputTokens },
        {
          agentModelOrchestratorEnvelope: envelope,
          providerCallBudgetContext: internalAgentBudgetContext(),
        },
      ),
      /requires canonical bounded maxOutputTokens/u,
    );
  }
  assert.equal(calls, 0);
});

test('internal Agent invocation requires an explicit positive model-call ceiling', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });

  for (const payload of [
    { prompt:'agent', maxOutputTokens:128 },
    { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:0 },
    { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:-0 },
    { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:'1' },
    { prompt:'agent', maxOutputTokens:128, maxModelCallsForRequest:1.5 },
  ]) {
    await assert.rejects(
      dispatcher.execute(
        'RUN_AI_ROUTED_PROMPT',
        payload,
        {
          agentModelOrchestratorEnvelope: envelope,
          providerCallBudgetContext: internalAgentBudgetContext(),
        },
      ),
      /requires canonical bounded maxModelCallsForRequest/u,
    );
  }
  assert.equal(calls, 0);
});

test('internal Agent invocation rejects a model-call ceiling accessor without executing it', async () => {
  let calls = 0;
  let reads = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  const payload = { prompt:'agent', maxOutputTokens:128 };
  Object.defineProperty(payload, 'maxModelCallsForRequest', {
    enumerable: true,
    get() {
      reads += 1;
      return 1;
    },
  });

  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      payload,
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /requires canonical bounded maxModelCallsForRequest/u,
  );
  assert.equal(reads, 0, 'model-call ceiling validation must inspect descriptors without invoking getters');
  assert.equal(calls, 0);
});

test('internal Agent invocation time cannot precede envelope revalidation', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 1_499, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /invocation time is stale or invalid/u,
  );
  assert.equal(calls, 0);
});

test('internal Agent invocation rejects live Gateway identity drift', async () => {
  let calls = 0;
  const repo = new MemoryRepo();
  const envelope = internalAgentEnvelope();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouter.gatewayUrl = 'http://127.0.0.1:9999';
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: { async run() { calls += 1; return {}; } },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'agent', maxOutputTokens: 128, maxModelCallsForRequest: 1 },
      {
        agentModelOrchestratorEnvelope: envelope,
        providerCallBudgetContext: internalAgentBudgetContext(),
      },
    ),
    /Gateway identity drifted before provider invocation/u,
  );
  assert.equal(calls, 0);
});
