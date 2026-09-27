import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('service worker composes one trusted durable Specialist readiness path', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

  assert.match(source, /SpecialistProviderReadinessResolverV1/);
  assert.match(source, /createOpenHandsSpecialistReadinessBindingV1/);
  assert.match(source, /OpenHandsCodingSpecialistClient/);
  assert.match(source, /browserAgent\.getSpecialistProviderConfig\(providerId\)/);
  assert.match(source, /specialistProviderReadinessResolver/);
  assert.match(source, /automaticSpecialistDelegationDependencies/);

  assert.match(source, /'LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIGS'/);
  assert.match(source, /'GET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(source, /'SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(source, /'CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(source, /browserAgent\.listSpecialistProviderConfigs\(\)/);
  assert.match(source, /browserAgent\.getSpecialistProviderConfig\(message\.payload\?\.providerId \|\| ''\)/);
  assert.match(source, /browserAgent\.setSpecialistProviderConfig\(message\.payload \|\| \{\}\)/);
  assert.match(source, /browserAgent\.clearSpecialistProviderConfig\(message\.payload \|\| \{\}\)/);

  assert.match(
    source,
    /browserAgent\.autoPrepareSpecialistHandoff\([\s\S]*?automaticSpecialistDelegationDependencies,[\s\S]*?\);/,
  );
  assert.match(
    source,
    /browserAgent\.claimSpecialistHandoffsAcrossJobs\([\s\S]*?automaticSpecialistDelegationDependencies,[\s\S]*?\);/,
  );
  assert.doesNotMatch(
    source,
    /message\.command === 'CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS'[\s\S]{0,500}browserAgent\.claimSpecialistHandoffs\(/,
  );
  assert.equal(
    (source.match(/autopilotBrowserAgentV1/g) || []).length,
    0,
    'service worker must not own a second Browser Agent persistence implementation',
  );
});
