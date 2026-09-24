import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAiRouterSettings, validateAiRouterReadiness } from '../src/core/ai-orchestrator.js';

test('canonical AI router settings persist model-worker policy with route validation', () => {
  const settings = normalizeAiRouterSettings({
    routes: [
      { routeId:'mistral-code', provider:'openai-compatible', endpointId:'mistral', model:'codestral-latest', roles:['fast-worker'], maxWorkers:4 },
      { routeId:'local-fast', provider:'ollama', model:'qwen3:8b', roles:['fast-worker'], maxWorkers:2 },
    ],
    workerPolicy: {
      allocationMode:'manual',
      maxParallelWorkers:5,
      manualRouteWorkers:{ 'mistral-code':3, 'local-fast':2 },
    },
  });
  assert.deepEqual(settings.workerPolicy, {
    allocationMode:'manual',
    maxParallelWorkers:5,
    manualRouteWorkers:{ 'mistral-code':3, 'local-fast':2 },
  });
  assert.equal(settings.routes[0].maxWorkers, 4);
});

test('canonical readiness validation rejects invalid worker allocations instead of dropping them', () => {
  assert.throws(() => validateAiRouterReadiness({
    enabled:false,
    routes:[{ routeId:'mistral-code', provider:'openai-compatible', endpointId:'mistral', model:'codestral-latest', roles:['fast-worker'], maxWorkers:2 }],
    workerPolicy:{ allocationMode:'manual', maxParallelWorkers:2, manualRouteWorkers:{ 'mistral-code':3 } },
  }), /maxWorkers/);
});

test('legacy settings receive a bounded automatic worker policy', () => {
  const settings = normalizeAiRouterSettings({ routes:[] });
  assert.equal(settings.workerPolicy.allocationMode, 'auto');
  assert.equal(settings.workerPolicy.maxParallelWorkers, 8);
  assert.deepEqual(settings.workerPolicy.manualRouteWorkers, {});
});
