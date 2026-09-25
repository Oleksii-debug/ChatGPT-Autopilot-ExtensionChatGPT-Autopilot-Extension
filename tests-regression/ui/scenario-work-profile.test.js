import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeScenarioWorkProfile, parseScenarioWorkProfile } from '../../src/ui/scenario-work-profile.js';

for (const [mode, extra] of [
  ['CHAT_CYCLE', { launchUrl: 'https://chatgpt.com/', steps: [{ prompt: 'Перший', repeat: 1 }, { prompt: 'Далі', repeat: 29 }] }],
  ['PAIRS', { pairCount: 3 }],
  ['AUDITOR_GROUP', { workerCount: 15 }],
  ['AUDITOR_PIPELINE', { firstCount: 10, secondCount: 9 }],
]) {
  test(`${mode} profile round-trip imports configuration, not runtime or old identity`, () => {
    const profile = makeScenarioWorkProfile({ id: 'old-id', name: 'Проба', mode, ...extra });
    profile.runtime = { runState: 'RUNNING', totalCompletedTurns: 999 };
    profile.config.id = 'old-id';
    const config = parseScenarioWorkProfile(JSON.stringify(profile));
    assert.equal(config.id, undefined);
    assert.equal(config.runtime, undefined);
    assert.equal(config.mode, mode);
    if (mode === 'CHAT_CYCLE') assert.equal(config.steps.reduce((n, step) => n + step.repeat, 0), 30);
  });
}

test('invalid and oversized profiles cannot be admitted', () => {
  const valid = makeScenarioWorkProfile({ mode: 'CHAT_CYCLE', steps: [{ prompt: 'Привіт', repeat: 1 }] });
  const bad = [
    '{', JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, config: { ...valid.config, mode: 'BOGUS' } }),
    JSON.stringify({ ...valid, config: { ...valid.config, roundsPerGeneration: -1 } }),
    JSON.stringify({ ...valid, config: { ...valid.config, steps: [{ prompt: ' ', repeat: 1 }] } }),
    JSON.stringify({ ...valid, config: { ...valid.config, steps: [{ prompt: 'X', repeat: 0 }] } }),
    ' '.repeat(10_000_001),
  ];
  for (const value of bad) assert.throws(() => parseScenarioWorkProfile(value));
});

test('scenario import remains reachable from every scenario sub-tab', async () => {
  const html = await readFile(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../../src/ui/options.js', import.meta.url), 'utf8');
  const importIndex = html.indexOf('id="scenario-work-profile-file"');
  const tabsIndex = html.indexOf('id="scenario-work-tabs"');
  assert.ok(importIndex > 0 && importIndex < tabsIndex);
  assert.match(html, /<label for="scenario-work-profile-file">JSON-файл сценарію<\/label>/);
  assert.match(js, /'scenario-work-import-button'\)\.addEventListener\('click', importScenarioWorkProfile\)/);
  assert.match(js, /core\('CREATE_SCENARIO_WORK', \{ name: config\.name, mode: config\.mode, config \}\)/);
});
