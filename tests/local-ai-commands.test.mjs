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

test('old schema-v2 state without localAi remains valid', () => {
  const state = createEmptyState(1000);
  delete state.profile.localAi;
  assert.doesNotThrow(() => validateState(state));
});

test('Local AI settings can be saved and loaded', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, { executionAvailable: true });
  const saved = await dispatcher.execute('UPDATE_LOCAL_AI_SETTINGS', { settings: {
    enabled: true,
    providerType: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1/',
    model: 'my-local-model',
    timeoutSeconds: 120,
  } });
  assert.equal(saved.settings.baseUrl, 'http://localhost:1234/v1');
  const loaded = await dispatcher.execute('GET_LOCAL_AI_SETTINGS');
  assert.deepEqual(loaded.settings, saved.settings);
});

test('connection and prompt commands delegate to LocalAiClient', async () => {
  const calls = [];
  const fakeClient = {
    async listModels(settings) { calls.push(['models', settings]); return { ok: true, models: ['one'] }; },
    async complete(settings, prompt, extras) { calls.push(['complete', settings, prompt, extras]); return { ok: true, model: settings.model, text: 'done' }; },
  };
  const repo = new MemoryRepo();
  await repo.update(draft => {
    draft.profile.localAi = {
      enabled: true,
      providerType: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      timeoutSeconds: 90,
    };
    return draft;
  });
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000, { executionAvailable: true, localAiClient: fakeClient });
  const models = await dispatcher.execute('TEST_LOCAL_AI_CONNECTION');
  assert.deepEqual(models.result.models, ['one']);
  const run = await dispatcher.execute('RUN_LOCAL_AI_PROMPT', { prompt: 'hello', systemPrompt: 'system' });
  assert.equal(run.result.text, 'done');
  assert.equal(calls[0][0], 'models');
  assert.deepEqual(calls[1].slice(0, 4), ['complete', {
    enabled: true,
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    timeoutSeconds: 90,
  }, 'hello', { systemPrompt: 'system' }]);
});
