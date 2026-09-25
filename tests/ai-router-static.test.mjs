import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const optionsJs = fs.readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');
const protocol = fs.readFileSync(new URL('../src/shared/protocol.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('AI coordinator UI exposes mode, two provider/model slots and schedule rules', () => {
  for (const id of ['ai-router-enabled','ai-router-mode','ai-router-primary-provider','ai-router-primary-model','ai-router-strong-provider','ai-router-strong-model','ai-router-every-n','ai-router-every-minutes','ai-router-carry-strong','run-ai-router-test-button','run-ai-router-strong-button']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /hybrid-auto/);
  assert.match(html, /hybrid-rules/);
});

test('AI coordinator commands are declared and extension only needs localhost gateway hosts', () => {
  for (const command of ['GET_AI_ROUTER_SETTINGS','UPDATE_AI_ROUTER_SETTINGS','TEST_AI_GATEWAY','LIST_AI_ROUTER_MODELS','RUN_AI_ROUTED_PROMPT','RESET_AI_ROUTER_RUNTIME']) {
    assert.match(protocol, new RegExp(command));
  }
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'));
  assert.equal(manifest.host_permissions.some(item => item.includes('api.openai.com')), false);
});


test('hybrid cost-guard controls are present', () => {
  for (const id of ['ai-router-strong-min-gap', 'ai-router-strong-max-hour']) assert.match(html, new RegExp(`id="${id}"`));
});


test('AI Gateway diagnostics expose compatible endpoint and credential presence without exposing the credential', () => {
  assert.match(optionsJs, /compatibleApiKeyConfigured/);
  assert.match(optionsJs, /compatibleBaseUrl/);
  assert.match(optionsJs, /OpenAI-compatible endpoint/);
  assert.doesNotMatch(optionsJs, /COMPATIBLE_API_KEY/);
});


test('AI router UI describes OpenAI-compatible as local or remote HTTPS rather than localhost-only', () => {
  assert.match(html, /OpenAI-compatible \/ LM Studio \/ remote HTTPS/);
  assert.doesNotMatch(html, /OpenAI-compatible localhost/);
});

test('OpenAI API UI exposes real model selection and keeps the secret out of extension storage', () => {
  assert.match(html, /<select id="ai-router-primary-model"/);
  assert.match(html, /<select id="ai-router-strong-model"/);
  assert.match(optionsJs, /gpt-5\.6-sol/);
  assert.match(optionsJs, /gpt-5\.6-terra/);
  assert.match(optionsJs, /gpt-5\.6-luna/);
  assert.match(html, /Windows DPAPI/);
  assert.match(html, /НАЛАШТУВАТИ OPENAI API КЛЮЧ\.ps1/);
  assert.doesNotMatch(html, /type="password"[^>]*openai/i);
  assert.doesNotMatch(optionsJs, /OPENAI_API_KEY/);
});

test('route-pool owner controls are native, keyboard accessible and persist every safety policy', () => {
  for (const id of ['ai-router-route-list','ai-router-add-route-button','ai-router-auto-switch','ai-router-pinned-route','ai-router-free-only','ai-router-locality','ai-router-max-input-price','ai-router-max-output-price','ai-router-backoff-seconds','ai-router-circuit-failures','ai-router-circuit-seconds','ai-router-allow-routes','ai-router-deny-routes']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const role of ['planner','coder','fast-worker','verifier','critic','vision']) assert.match(html, new RegExp(`data-route-role="${role}"`));
  for (const action of ['up','down','remove']) assert.match(html, new RegExp(`data-route-action="${action}"`));
  assert.match(optionsJs, /orderedRouteIds:routes\.map/);
  assert.match(optionsJs, /lastFailoverChain/);
  assert.match(optionsJs, /routeStates/);
  assert.doesNotMatch(html, /textarea[^>]+route-pool/i);
});


test('route model profiles expose bounded native controls and round-trip form wiring', () => {
  for (const field of ['displayName', 'systemPrompt', 'workerPrompt']) {
    assert.match(html, new RegExp(`data-label-for="${field}"`));
    assert.match(html, new RegExp(`data-route-field="${field}"`));
  }
  assert.match(html, /data-route-field="displayName"[^>]*maxlength="160"/);
  assert.match(html, /data-route-field="systemPrompt"[^>]*maxlength="8000"/);
  assert.match(html, /data-route-field="workerPrompt"[^>]*maxlength="8000"/);
  assert.match(optionsJs, /displayName:text\('displayName'\)/);
  assert.match(optionsJs, /systemPrompt:text\('systemPrompt'\)/);
  assert.match(optionsJs, /workerPrompt:text\('workerPrompt'\)/);
  assert.match(optionsJs, /displayName:route\.displayName \|\| ''/);
  assert.match(optionsJs, /systemPrompt:route\.systemPrompt \|\| ''/);
  assert.match(optionsJs, /workerPrompt:route\.workerPrompt \|\| ''/);
});
