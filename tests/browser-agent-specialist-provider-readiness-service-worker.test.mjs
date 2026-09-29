import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);

test('owner-qualified provider probe is read-only and never accepts caller config', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  assert.match(block, /'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(
    source,
    /message\.command === 'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'[\s\S]*?message\.payload\?\.providerId \|\| ''/,
  );
  assert.doesNotMatch(
    source,
    /PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'[\s\S]{0,2000}message\.payload\?\.config/,
  );
});

test('provider probe reads durable config before and after harmless OpenHands probe', () => {
  const marker = "message.command === 'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const end = source.indexOf("message.command === 'SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'", start);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  assert.match(block, /browserAgent\.getSpecialistProviderConfig\(providerId\)/);
  assert.match(block, /probeOpenHandsSpecialistProviderConfigV1\(\{/);
  assert.match(block, /config: beforeProbe\.config\.config/);
  assert.match(block, /client: openHandsSpecialistClient/);
  assert.match(block, /JSON\.stringify\(afterProbe\.config\) !== configSnapshot/);
  assert.doesNotMatch(block, /\.execute\(/);
  assert.doesNotMatch(block, /createConversation|resumeConversation|\/api\/conversations/);
});

test('OpenHands readiness client is owner-constructed from extension fetch only', () => {
  assert.match(
    source,
    /const openHandsSpecialistClient = new OpenHandsCodingSpecialistClient\(\{[\s\S]*?fetchFn: \(\.\.\.args\) => fetch\(\.\.\.args\)[\s\S]*?\}\);/,
  );
});
