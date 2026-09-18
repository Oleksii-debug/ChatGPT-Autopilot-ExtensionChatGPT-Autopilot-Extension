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
