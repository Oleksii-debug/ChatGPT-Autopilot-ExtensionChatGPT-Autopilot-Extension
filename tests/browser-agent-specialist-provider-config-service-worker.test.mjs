import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);

test('provider config read commands are read-only while set/clear remain mutation-only', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  assert.match(block, /'LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIGS'/);
  assert.match(block, /'GET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(block, /'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.doesNotMatch(block, /'SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.doesNotMatch(block, /'CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
});

test('provider config commands delegate only to BrowserAgentManager durable authority', () => {
  assert.match(
    source,
    /message\.command === 'LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIGS'[\s\S]*?browserAgent\.listSpecialistProviderConfigs\(\)/,
  );
  assert.match(
    source,
    /message\.command === 'GET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'[\s\S]*?browserAgent\.getSpecialistProviderConfig\(message\.payload\?\.providerId \|\| ''\)/,
  );
  assert.match(
    source,
    /message\.command === 'SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'[\s\S]*?browserAgent\.setSpecialistProviderConfig\(message\.payload \|\| \{\}\)/,
  );
  assert.match(
    source,
    /message\.command === 'CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'[\s\S]*?browserAgent\.clearSpecialistProviderConfig\(message\.payload \|\| \{\}\)/,
  );
});


test('provider probe is harmless, owner-config-bound, and cannot dispatch Specialist work', () => {
  assert.match(source, /OpenHandsCodingSpecialistClient/);
  assert.match(source, /probeOpenHandsSpecialistProviderConfigV1/);
  const probeBranch = source.match(
    /} else if \(message\.command === 'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'\) \{([\s\S]*?)\n  } else if \(message\.command === 'SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'\) \{/,
  );
  assert.ok(probeBranch, 'probe command branch must remain structurally identifiable');
  assert.match(probeBranch[1], /browserAgent\.getSpecialistProviderConfig\(providerId\)/);
  assert.match(probeBranch[1], /probeOpenHandsSpecialistProviderConfigV1/);
  assert.match(probeBranch[1], /config changed during readiness probe/);
  assert.doesNotMatch(
    probeBranch[1],
    /claimSpecialistHandoffs|prepareClaimedSpecialistProviderExecution|openHandsSpecialistClient\.execute|completeSpecialistHandoff/,
  );
});
