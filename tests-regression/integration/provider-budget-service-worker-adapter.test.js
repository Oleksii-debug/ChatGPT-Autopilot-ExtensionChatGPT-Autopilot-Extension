import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('service-worker propagates canonical provider budget settlement status back to AiOrchestrator', async () => {
  const source = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  const lifecycleStart = source.indexOf('providerCallLifecycle: {');
  assert.notEqual(lifecycleStart, -1);
  const lifecycleEnd = source.indexOf('\n  },\n});', lifecycleStart);
  assert.notEqual(lifecycleEnd, -1);
  const lifecycle = source.slice(lifecycleStart, lifecycleEnd);

  assert.match(
    lifecycle,
    /return browserAgentLifecycle\.current\.settleProviderModelBudget\(\{/u,
  );
  assert.doesNotMatch(
    lifecycle,
    /await browserAgentLifecycle\.current\.settleProviderModelBudget\(\{/u,
  );
});
