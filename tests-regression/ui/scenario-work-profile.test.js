import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeScenarioWorkProfile, makeScenarioWorkTemplate, parseScenarioWorkProfile } from '../../src/ui/scenario-work-profile.js';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';

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

test('imported config creates a fresh stopped Core scenario with no inherited counters', async () => {
  const storage = {};
  const chromeApi = { storage: { local: {
    async get(key) { return { [key]: structuredClone(storage[key]) }; },
    async set(value) { Object.assign(storage, structuredClone(value)); },
  } }, alarms: { async create() {}, async clear() {} } };
  const state = { sessionsById: {}, sessionOrder: [], tabHintsByTaskId: {}, logs: {} };
  const coreRepository = {
    async load() { return structuredClone(state); },
    async update(mutator) { await mutator(state); return structuredClone(state); },
  };
  const manager = new ScenarioWorkManager({ coreRepository, chromeApi, createId: () => 'new-id',
    collectAssistantReport: async () => ({ status: 'WAITING', assistantComplete: false }) });
  const profile = makeScenarioWorkProfile({ id: 'old-id', mode: 'CHAT_CYCLE', name: 'Імпорт',
    roundsPerGeneration: 1, steps: [{ prompt: 'Спроба', repeat: 10 }] });
  profile.runtime = { runState: 'RUNNING', totalCompletedTurns: 200 };
  const config = parseScenarioWorkProfile(JSON.stringify(profile));
  const { scenario } = await manager.create({ name: config.name, mode: config.mode, config });
  assert.equal(scenario.id, 'new-id');
  assert.equal(scenario.runtime.runState, 'STOPPED');
  assert.equal(scenario.runtime.totalCompletedTurns, 0);
  assert.equal(scenario.config.steps[0].repeat, 10);
  assert.equal(Object.keys(state.sessionsById).length, 0);
});

test('downloadable scenario template is valid and contains exactly twelve messages per physical chat', () => {
  const profile = makeScenarioWorkTemplate();
  const config = parseScenarioWorkProfile(JSON.stringify(profile));
  assert.equal(config.mode, 'CHAT_CYCLE');
  assert.equal(config.roundsPerGeneration, 1);
  assert.equal(config.maxGenerations, 1);
  assert.equal(config.steps.reduce((sum, step) => sum + step.repeat, 0), 12);
  assert.deepEqual(config.steps.map(step => step.repeat), [1, 10, 1]);
});

test('Scenario Work UI exposes template, import and export controls together', async () => {
  const html = await readFile(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(html, /id="scenario-work-template-button"[^>]*>Завантажити шаблон</u);
  assert.match(html, /id="scenario-work-import-button"[^>]*>Імпортувати файл</u);
  assert.match(html, /id="scenario-work-export-button"[^>]*>Експортувати вибраний сценарій</u);
  assert.match(js, /'scenario-work-template-button'\)\.addEventListener\('click', downloadScenarioWorkTemplate\)/u);
});
