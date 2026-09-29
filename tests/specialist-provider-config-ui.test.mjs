import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const options = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');

function functionBody(name) {
  const syncStart = options.indexOf(`function ${name}(`);
  const asyncStart = options.indexOf(`async function ${name}(`);
  const starts = [syncStart, asyncStart].filter(index => index >= 0);
  assert.ok(starts.length, `${name} must exist`);
  const start = Math.min(...starts);
  const candidates = [
    options.indexOf('\nfunction ', start + 1),
    options.indexOf('\nasync function ', start + 1),
  ].filter(index => index > start);
  return options.slice(start, candidates.length ? Math.min(...candidates) : options.length);
}

test('OpenHands owner configuration is keyboard-native and persistently labeled', () => {
  for (const id of [
    'openhands-provider-server-url',
    'openhands-provider-profile-id',
    'openhands-provider-profile-revision',
    'openhands-provider-workspace-path',
    'openhands-provider-capabilities',
    'openhands-provider-request-timeout',
    'openhands-provider-max-execution',
    'openhands-provider-poll-interval',
    'openhands-provider-max-iterations',
    'openhands-provider-max-response-bytes',
  ]) {
    assert.ok(html.includes(`<label for="${id}">`), `${id} needs a persistent native label`);
    assert.ok(html.includes(`id="${id}"`), `${id} control is missing`);
  }
  assert.match(html, /id="openhands-provider-status" role="status"/u);
  assert.match(html, /LOCAL_UNAUTHENTICATED/u);
  assert.match(html, /1\.49\.5/u);
});

test('provider config load/save/clear use only canonical BrowserAgent config authority', () => {
  const load = functionBody('loadOpenHandsProviderConfig');
  assert.match(load, /LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIGS/u);

  const save = functionBody('saveOpenHandsProviderConfig');
  assert.match(save, /buildOpenHandsSpecialistProviderConfigRequestV1/u);
  assert.match(save, /expectedRevision: current\?\.revision \|\| 0/u);
  assert.match(save, /SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);

  const clear = functionBody('clearOpenHandsProviderConfig');
  assert.match(clear, /expectedRevision: current\.revision/u);
  assert.match(clear, /CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);

  for (const body of [load, save, clear]) {
    assert.doesNotMatch(body, /CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION|VERIFY_BROWSER_AGENT_SPECIALIST_HANDOFF|COMPLETE_BROWSER_AGENT_SPECIALIST_HANDOFF/u);
  }
});

test('readiness probe is saved-config read-only and revision fenced', () => {
  const body = functionBody('probeOpenHandsProviderConfig');
  assert.match(body, /PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);
  assert.match(body, /providerId: 'openhands-agent-server'/u);
  assert.match(body, /result\?\.configRevision !== expectedRevision/u);
  assert.doesNotMatch(body, /SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG|CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION/u);
});

test('quarantined provider config disables all owner mutations and probe', () => {
  const body = functionBody('fillOpenHandsProviderConfigForm');
  assert.match(body, /save-button'\)\.disabled = quarantined/u);
  assert.match(body, /probe-button'\)\.disabled = quarantined \|\| !current/u);
  assert.match(body, /clear-button'\)\.disabled = quarantined \|\| !current/u);
});

test('initial load and buttons wire owner provider config projection', () => {
  assert.match(options, /await loadOpenHandsProviderConfig\(\);/u);
  assert.match(options, /openhands-provider-save-button'\)\.addEventListener\('click', saveOpenHandsProviderConfig\)/u);
  assert.match(options, /openhands-provider-probe-button'\)\.addEventListener\('click', probeOpenHandsProviderConfig\)/u);
  assert.match(options, /openhands-provider-clear-button'\)\.addEventListener\('click', clearOpenHandsProviderConfig\)/u);
});
