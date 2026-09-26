import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CHAT_CYCLE presents one prompt sequence per physical chat without duplicate round controls', async () => {
  const html = await readFile(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(html, /id="scenario-work-round-generation-settings"/u);
  assert.match(html, /id="scenario-cycle-replacement-budget"/u);
  assert.doesNotMatch(html, /Один фізичний чат виконує цю послідовність рівно один раз/u);
  assert.match(html, /id="scenario-cycle-message-count"[^>]*role="status"/u);
  assert.match(js, /roundsPerGeneration: mode === 'CHAT_CYCLE' \? 1 : scenarioWorkInt/u);
  assert.match(js, /maxGenerations: mode === 'CHAT_CYCLE' \? 1 : scenarioWorkInt/u);
  assert.match(js, /'scenario-work-round-generation-settings'\)\.hidden = config\.mode === 'CHAT_CYCLE'/u);
  assert.match(js, /Фізичний чат у цьому слоті/u);
  assert.match(js, /фізичний чат №\$\{row\.generation\}/u);
  assert.doesNotMatch(js, /стан \$\{row\.category\}/u);
});
test('scenario cycle message count is recalculated after prompt edits', async () => {
  const js = await readFile(new URL('../../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(js, /function updateScenarioCycleMessageCount\(\)/u);
  assert.match(js, /'scenario-cycle-steps'\)\.addEventListener\('input', updateScenarioCycleMessageCount\)/u);
  assert.match(js, /Повідомлень у кожному чаті/u);
});
