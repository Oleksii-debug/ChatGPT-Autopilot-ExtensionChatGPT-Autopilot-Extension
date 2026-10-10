import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('service worker composes one trusted durable Specialist readiness path', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

  assert.match(source, /SpecialistProviderReadinessResolverV1/);
  assert.match(source, /createOpenHandsSpecialistReadinessBindingV1/);
  assert.match(source, /probeOpenHandsSpecialistProviderConfigV1/);
  assert.match(source, /OpenHandsCodingSpecialistClient/);
  assert.match(source, /browserAgent\.getSpecialistProviderConfig\(providerId\)/);
  assert.match(source, /specialistProviderReadinessResolver/);
  assert.match(source, /automaticSpecialistDelegationDependencies/);

  assert.match(source, /'LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIGS'/);
  assert.match(source, /'GET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(source, /'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(source, /'SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(source, /'CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'/);
  assert.match(source, /'LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTIONS'/);
  assert.match(source, /'RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION'/);
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
  assert.match(
    source,
    /browserAgent\.prepareClaimedSpecialistProviderExecution\([\s\S]*?automaticSpecialistDelegationDependencies,[\s\S]*?\);/,
  );
  assert.match(source, /openHandsSpecialistClient\.execute\(/);
  assert.match(source, /browserAgent\.recordSpecialistProviderExecutionOutcome\(/);
  assert.match(source, /providerUpdatedAt:\s*providerResult\.providerUpdatedAt \|\| ''/);
  assert.match(source, /providerObservedAt:\s*providerResult\.providerObservedAt \|\| ''/);
  assert.match(source, /providerDispatched = providerResult\.created === true \|\| Boolean\(providerResult\.effectEvidence\)/);
  assert.match(source, /providerDispatched = error\.effectMayHaveOccurred === true/);
  assert.match(source, /providerDispatched,\s*\n\s*completionAuthorized:\s*false/);
  assert.doesNotMatch(source, /providerDispatched:\s*true,\s*\n\s*completionAuthorized:\s*false/);
  assert.match(source, /completionAuthorized:\s*false/);
  const runProviderCommand = source.match(
    /} else if \(message\.command === 'RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION'\) \{([\s\S]*?)\n  } else if \(message\.command === 'AUTHORIZE_BROWSER_AGENT_SPECIALIST_SAFE_RETRY'\) \{/,
  );
  assert.ok(runProviderCommand, 'RUN Specialist provider command branch must remain structurally identifiable');
  assert.doesNotMatch(
    runProviderCommand[1],
    /completeSpecialistHandoff\(/,
    'provider execution may record evidence but must not grant Specialist completion authority',
  );
  assert.match(
    source,
    /message\.command === 'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'[\s\S]*?probeOpenHandsSpecialistProviderConfigV1\([\s\S]*?browserAgent\.getSpecialistProviderConfig\(providerId\)[\s\S]*?config changed during readiness probe/iu,
  );
  // Inspect only this command branch: sibling commands legitimately claim and
  // execute providers, so an unbounded source-level scan is a false positive.
  const probeStart = source.indexOf("} else if (message.command === 'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG') {");
  const probeEnd = source.indexOf("} else if (message.command === 'SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG') {", probeStart);
  assert.ok(probeStart >= 0 && probeEnd > probeStart, 'read-only probe command must remain structurally identifiable');
  const probeBranch = source.slice(probeStart, probeEnd);
  assert.doesNotMatch(
    probeBranch,
    /claimSpecialistHandoffsAcrossJobs|prepareClaimedSpecialistProviderExecution|openHandsSpecialistClient\.execute|completeSpecialistHandoff/u,
    'read-only probe may not claim, execute, or complete a Specialist',
  );
  assert.equal(
    (source.match(/autopilotBrowserAgentV1/g) || []).length,
    0,
    'service worker must not own a second Browser Agent persistence implementation',
  );
});
