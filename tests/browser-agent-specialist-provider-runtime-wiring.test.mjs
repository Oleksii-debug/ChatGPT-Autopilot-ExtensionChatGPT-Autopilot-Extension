import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeSpecialistSelectionV1 } from '../src/core/specialist-registry.js';

test('service worker composes one trusted durable Specialist readiness path', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

  assert.match(source, /SpecialistProviderReadinessResolverV1/);
  assert.match(source, /createOpenHandsSpecialistReadinessBindingV1/);
  assert.match(source, /probeOpenHandsSpecialistProviderConfigV1/);
  assert.match(source, /OpenHandsCodingSpecialistClient/);
  assert.match(source, /browserAgent\.getSpecialistProviderConfig\(providerId\)/);
  assert.match(source, /specialistProviderReadinessResolver/);
  // Owner config equality is not live OpenHands readiness: the exact
  // resolver that issued the observation must repeat a harmless provider
  // health/identity probe before the existing durable admission boundary.
  assert.match(source, /specialistReadinessConfigProvenance\.set\(readiness,[\s\S]*?configSnapshot:[\s\S]*?resolver,/);
  assert.match(source, /await provenance\.resolver\.assertCurrent\(readiness\)/);
  assert.match(
    source,
    /await provenance\.resolver\.assertCurrent\(readiness\)[\s\S]*?const afterProbe = await browserAgent\.getSpecialistProviderConfig\(provenance\.providerId\)[\s\S]*?changed during readiness revalidation/,
  );
  assert.doesNotMatch(
    source,
    /Specialist provider config changed after readiness probe'[\s\S]{0,120}return true;/,
  );
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
  // Scope the negative-effect check to the actual probe branch. A fixed
  // character window can incorrectly match subsequent independent command
  // branches as new provider integrations are inserted nearby.
  const probeProviderCommand = source.match(
    /} else if \(message\.command === 'PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'\) \{([\s\S]*?)\n  } else if \(message\.command === 'SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG'\) \{/,
  );
  assert.ok(probeProviderCommand, 'readiness probe command must remain structurally identifiable');
  assert.doesNotMatch(
    probeProviderCommand[1],
    /claimSpecialistHandoffsAcrossJobs|prepareClaimedSpecialistProviderExecution|openHandsSpecialistClient\.execute|completeSpecialistHandoff/u,
    'readiness probe must not dispatch a provider effect or grant claim/completion authority',
  );
  assert.equal(
    (source.match(/autopilotBrowserAgentV1/g) || []).length,
    0,
    'service worker must not own a second Browser Agent persistence implementation',
  );
});


test('service worker refuses getter-backed Specialist selection before provider config lookup', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ normalizeSpecialistSelectionV1 \} from '\.\.\/core\/specialist-registry\.js'/u);
  const match = source.match(
    /const specialistProviderReadinessResolver = Object\.freeze\(\{\s*async resolve\(selectionInput\) \{([\s\S]*?)\n  \},\s*async assertCurrent/u,
  );
  assert.ok(match, 'one canonical service-worker Specialist resolver entrypoint must exist');
  const body = match[1];
  const normalized = body.indexOf('normalizeSpecialistSelectionV1(selectionInput)');
  const identity = body.indexOf('selection.providerId');
  const providerRead = body.indexOf('getSpecialistProviderConfig');
  assert.ok(normalized >= 0 && normalized < identity && identity < providerRead,
    'validate the entire caller selection before provider ID lookup or provider config I/O');
  assert.doesNotMatch(body, /selectionInput\?\.|selectionInput\.providerId/u);

  let getterReads = 0;
  const getterSelection = { schemaVersion: 1 };
  Object.defineProperty(getterSelection, 'providerId', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error('SECRET_SELECTION_GETTER_MUST_NOT_EXECUTE');
    },
  });
  assert.throws(
    () => normalizeSpecialistSelectionV1(getterSelection),
    e => !e.message.includes('SECRET_SELECTION_GETTER_MUST_NOT_EXECUTE'),
  );
  assert.equal(getterReads, 0);

  const hostileProxy = new Proxy({ schemaVersion: 1 }, {
    ownKeys() { throw new Error('SECRET_REFLECTION_20261010'); },
  });
  assert.throws(
    () => normalizeSpecialistSelectionV1(hostileProxy),
    e => /cannot be inspected safely/u.test(e.message)
      && !e.message.includes('SECRET_REFLECTION_20261010'),
  );
});
