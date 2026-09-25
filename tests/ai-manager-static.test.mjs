import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const protocol = fs.readFileSync(new URL('../src/shared/protocol.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const executor = fs.readFileSync(new URL('../src/core/automatic-executor.js', import.meta.url), 'utf8');
const execution = fs.readFileSync(new URL('../src/core/execution.js', import.meta.url), 'utf8');
const options = fs.readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');

test('AI Manager UI exposes durable trigger and safe-action controls', () => {
  for (const id of [
    'ai-manager-enabled','ai-manager-auto-apply','ai-manager-every-n','ai-manager-every-minutes',
    'ai-manager-on-complete','ai-manager-on-errors','ai-manager-error-threshold','ai-manager-handoff-enabled','ai-manager-restart-completed','ai-manager-session-tuning','ai-manager-failure-retry',
    'save-ai-manager-button','run-ai-manager-now-button','reset-ai-manager-runtime-button','ai-manager-runtime',
  ]) assert.match(html, new RegExp(`id="${id}"`));
});

test('AI Manager commands and background runtime integration are wired', () => {
  for (const command of ['GET_AI_MANAGER_SETTINGS','UPDATE_AI_MANAGER_SETTINGS','RUN_AI_MANAGER_NOW','RESET_AI_MANAGER_RUNTIME']) {
    assert.match(protocol, new RegExp(command));
  }
  assert.match(worker, /new AiAutonomyManager/);
  assert.match(worker, /aiManager\.capture\(result\.outcomes/);
  assert.match(worker, /aiManager\.process\(\)/);
  assert.match(worker, /autopilot-ai-manager-wake/);
  assert.match(worker, /aiManager\.nextDecisionWakeAt\(\)/);
});

test('single-use manager handoff is appended before send and cleared only on verified send', () => {
  assert.match(executor, /ЛОКАЛЬНИЙ AI-КООРДИНАТОР: HANDOFF ДЛЯ ЦЬОГО ЗАПУСКУ/);
  assert.match(execution, /session\.aiCoordinatorHandoff = ''/);
  assert.match(execution, /case InteractionResult\.SENT_VERIFIED/);
});


test('AI Manager decision history is exposed accessibly', () => {
  assert.match(html, /id="ai-manager-history"/);
  assert.match(options, /decisionHistory/);
});
