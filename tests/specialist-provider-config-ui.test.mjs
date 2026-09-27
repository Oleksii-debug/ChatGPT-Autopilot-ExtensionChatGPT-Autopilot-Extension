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

test('OpenHands provider configuration surface is keyboard-native and persistently labeled', () => {
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

test('provider config load uses only canonical BrowserAgent config authority', () => {
  const body = functionBody('loadOpenHandsProviderConfig');
  assert.match(body, /LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIGS/u);
  assert.doesNotMatch(body, /GET_PROFILE_SETTINGS|UPDATE_PROFILE_SETTINGS|RUN_BROWSER_AGENT|CLAIM_BROWSER_AGENT/u);
});

test('provider config save is exact-revision CAS and never executes or verifies a Specialist', () => {
  const body = functionBody('saveOpenHandsProviderConfig');
  assert.match(body, /buildOpenHandsSpecialistProviderConfigRequestV1/u);
  assert.match(body, /expectedRevision: current\?\.revision \|\| 0/u);
  assert.match(body, /SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);
  assert.doesNotMatch(body, /RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|VERIFY_BROWSER_AGENT_SPECIALIST_HANDOFF|AUTHORIZE_BROWSER_AGENT_SPECIALIST_SAFE_RETRY/u);
});

test('provider config clear binds exact durable revision and quarantined state remains fail-closed', () => {
  const clear = functionBody('clearOpenHandsProviderConfig');
  assert.match(clear, /expectedRevision: current\.revision/u);
  assert.match(clear, /CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);
  assert.doesNotMatch(clear, /RUN_BROWSER_AGENT|CLAIM_BROWSER_AGENT|VERIFY_BROWSER_AGENT/u);

  const fill = functionBody('fillOpenHandsProviderConfigForm');
  assert.match(fill, /saveButton\.disabled = quarantined/u);
  assert.match(fill, /clearButton\.disabled = quarantined \|\| !current/u);
});

test('initial Agent UI load and controls wire the provider config projection', () => {
  assert.match(options, /await loadOpenHandsProviderConfig\(\);/u);
  assert.match(options, /openhands-provider-save-button'\)\.addEventListener\('click', saveOpenHandsProviderConfig\)/u);
  assert.match(options, /openhands-provider-clear-button'\)\.addEventListener\('click', clearOpenHandsProviderConfig\)/u);
});
