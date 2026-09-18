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
