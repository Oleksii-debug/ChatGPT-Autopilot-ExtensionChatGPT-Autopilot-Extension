import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher } from '../src/core/commands.js';
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
