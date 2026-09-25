import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../../src/ui/options.js', import.meta.url), 'utf8');

test('Scenario Work is a first-class top-level accessible mode', () => {
  assert.match(html, /id="mode-scenario-work"[^>]*role="tab"[^>]*>Сценарна робота<\/button>/);
  assert.match(html, /data-app-mode="scenario-work"/);
  assert.match(js, /const UI_MODES = new Set\(\['sessions', 'simplified', 'orchestration', 'scenario-work', 'agent', 'ai'\]\)/);
  assert.match(js, /const ordered = \['sessions', 'simplified', 'orchestration', 'scenario-work', 'agent', 'ai'\]/);
});

test('Scenario Work exposes four keyboard-navigable sub-tabs', () => {
  for (const id of ['scenario-work-tab-cycle','scenario-work-tab-pairs','scenario-work-tab-group','scenario-work-tab-state']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.match(js, /const SCENARIO_WORK_PANELS = \['cycle', 'pairs', 'group', 'state'\]/);
  assert.match(js, /\$\('scenario-work-tabs'\)\.addEventListener\('keydown'/);
  assert.match(js, /setScenarioWorkPanel\(SCENARIO_WORK_PANELS\[index\], \{ focus: true \}\)/);
});

test('chat-cycle UI supports arbitrary prompts with independent repeat counts', () => {
  assert.ok(html.includes('id="scenario-cycle-steps"'));
  assert.ok(html.includes('id="scenario-cycle-add-step"'));
  assert.match(js, /function createScenarioCycleStep\(step = \{\}, index = 0\)/);
  assert.match(js, /repeat\.dataset\.scenarioStepRepeat = 'true'/);
  assert.match(js, /prompt\.dataset\.scenarioStepPrompt = 'true'/);
  assert.match(js, /repeat: parseStrictBoundedInteger/);
});

test('pair and auditor-group recovery controls are present', () => {
  for (const id of [
    'scenario-pair-count','scenario-pair-timeout-auditor','scenario-pair-replacement-auditor',
    'scenario-group-worker-count','scenario-group-timeout-auditor','scenario-group-replacement-auditor',
    'scenario-work-timeout','scenario-work-timeout-policy'
  ]) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  assert.match(js, /timeoutAuditorPrompt:/);
  assert.match(js, /replacementAuditorPrompt:/);
});

test('Scenario Work UI delegates lifecycle and execution to background Core commands', () => {
  for (const command of [
    'LIST_SCENARIO_WORK','GET_SCENARIO_WORK','CREATE_SCENARIO_WORK','SELECT_SCENARIO_WORK',
    'UPDATE_SCENARIO_WORK','START_SCENARIO_WORK','PAUSE_SCENARIO_WORK','RESUME_SCENARIO_WORK',
    'STOP_SCENARIO_WORK','DELETE_SCENARIO_WORK','RUN_SCENARIO_WORK_NOW'
  ]) assert.ok(js.includes(`'${command}'`), `missing ${command}`);
  assert.doesNotMatch(js, /chrome\.tabs/);
  assert.doesNotMatch(js, /chrome\.alarms/);
});

test('Scenario Work renders persistent state including participants', () => {
  assert.ok(html.includes('id="scenario-work-state"'));
  assert.ok(html.includes('id="scenario-work-summary" role="status"'));
  assert.match(js, /function renderScenarioWorkState\(item\)/);
  assert.match(js, /addScenarioStateLine\('Учасники'/);
  assert.match(js, /participant\.chatUrl \? 'чат збережено' : 'новий чат'/);
});

test('auditor pipeline UI exposes semantic barriers, correction controls and diagnostics', () => {
  for (const id of [
    'new-scenario-pipeline-button','scenario-pipeline-settings','scenario-pipeline-first-count',
    'scenario-pipeline-second-count','scenario-pipeline-barrier-policy','scenario-pipeline-audit-timebox',
    'scenario-pipeline-max-corrections','scenario-pipeline-first-prompt','scenario-pipeline-second-prompt',
    'scenario-pipeline-auditor-prompt','scenario-pipeline-worker-correction','scenario-pipeline-auditor-correction'
  ]) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  assert.match(js, /AUDITOR_PIPELINE: 'FIRST → аудитор → SECOND'/);
  assert.match(js, /barrierPolicy: \$\('scenario-pipeline-barrier-policy'\)\.value/);
  assert.match(js, /addScenarioStateLine\('Заблоковано залежностями'/);
  assert.match(js, /addScenarioStateLine\('Allocation'/);
  assert.match(js, /addScenarioStateLine\('Оренда аудитора'/);
  assert.match(js, /createScenarioWork\('AUDITOR_PIPELINE'\)/);
});
