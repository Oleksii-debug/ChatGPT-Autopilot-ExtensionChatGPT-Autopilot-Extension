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

test('OpenHands provider config controls are native-labeled and expose no implicit readiness claim', () => {
  for (const id of [
    'specialist-provider-config-provider-id',
    'specialist-openhands-server-url',
    'specialist-openhands-server-version',
    'specialist-openhands-profile-id',
    'specialist-openhands-profile-revision',
    'specialist-openhands-workspace-path',
    'specialist-openhands-capabilities',
    'specialist-openhands-request-timeout',
    'specialist-openhands-max-execution',
    'specialist-openhands-poll-interval',
    'specialist-openhands-max-iterations',
    'specialist-openhands-max-response-bytes',
    'specialist-openhands-auth-mode',
  ]) {
    assert.ok(html.includes(`<label for="${id}">`), `${id} needs a persistent native label`);
    assert.ok(html.includes(`id="${id}"`), `${id} control is missing`);
  }
  assert.match(html, /id="specialist-provider-config-status" role="status"/u);
  assert.match(html, /Збереження не запускає provider і не означає readiness/u);
  assert.match(options, /normalizeOpenHandsCodingSpecialistConfigV1/u);
  assert.match(options, /OPENHANDS_AGENT_SERVER_VERSION/u);
  assert.match(options, /OPENHANDS_CODING_PROVIDER_ID/u);
});


test('readiness button probes only the saved canonical provider config and grants no execution authority', () => {
  assert.match(html, /id="specialist-provider-config-probe-button"[^>]*disabled/u);
  assert.match(html, /Перевірити readiness збереженого config/u);
  const probe = functionBody('probeSpecialistProviderConfig');
  assert.match(probe, /PROBE_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);
  assert.match(probe, /providerId: OPENHANDS_CODING_PROVIDER_ID/u);
  assert.match(probe, /result\?\.configRevision !== current\.revision/u);
  assert.match(probe, /ui\.specialistProviderConfig\?\.revision !== current\.revision/u);
  assert.match(probe, /ui\.specialistProviderConfig !== current[\s\S]*?ui\.specialistProviderQuarantined\) return;/u);
  assert.match(probe, /GET-only probe без claim або provider execution/u);
  assert.match(probe, /не резервує capacity і не дає execution\/completion authority/u);
  assert.doesNotMatch(
    probe,
    /CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION|COMPLETE_BROWSER_AGENT_SPECIALIST_HANDOFF|VERIFY_BROWSER_AGENT_SPECIALIST_HANDOFF/u,
  );
});

test('provider config load, save and clear reuse only canonical backend config authority', () => {
  const load = functionBody('loadSpecialistProviderConfig');
  assert.match(load, /LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIGS/u);
  assert.match(load, /GET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);
  assert.match(load, /generation = \+\+ui\.specialistProviderConfigLoadGeneration/u);
  assert.match(load, /ui\.specialistProviderConfigLoadGeneration !== generation\) return;/u);
  assert.doesNotMatch(load, /RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS/u);

  const save = functionBody('saveSpecialistProviderConfig');
  assert.match(save, /SET_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);
  assert.match(save, /expectedRevision = ui\.specialistProviderConfig\?\.revision \|\| 0/u);
  assert.match(save, /SpecialistProviderConfigKind\.OPENHANDS_AGENT_SERVER/u);
  assert.doesNotMatch(save, /RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS/u);

  const clear = functionBody('clearSpecialistProviderConfig');
  assert.match(clear, /CLEAR_BROWSER_AGENT_SPECIALIST_PROVIDER_CONFIG/u);
  assert.match(clear, /expectedRevision: current\.revision/u);
});

test('runtime view joins durable handoffs and provider execution evidence for the selected job', () => {
  for (const id of [
    'specialist-provider-max-concurrent-handoffs',
    'specialist-provider-handoff-list',
    'specialist-provider-execution-list',
  ]) {
    assert.ok(html.includes(`<label for="${id}">`), `${id} needs a persistent native label`);
  }
  assert.match(html, /id="specialist-provider-runtime-status" role="status"/u);
  const load = functionBody('loadSpecialistProviderRuntime');
  assert.match(load, /LIST_BROWSER_AGENT_SPECIALIST_HANDOFFS/u);
  assert.match(load, /LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTIONS/u);
  assert.match(load, /generation = \+\+ui\.specialistProviderRuntimeLoadGeneration/u);
  assert.match(load, /ui\.specialistProviderRuntimeLoadGeneration !== generation[\s\S]*?ui\.selectedBrowserAgentId !== jobId/u);
  assert.match(load, /catch \(error\)[\s\S]*?ui\.specialistProviderRuntimeLoadGeneration !== generation[\s\S]*?ui\.selectedBrowserAgentId !== jobId[\s\S]*?return;/u);
});

test('claim keeps product-wide capacity explicit and delegates lease policy to canonical backend defaults', () => {
  const claim = functionBody('claimSpecialistProviderHandoffs');
  assert.match(claim, /Product-wide Specialist capacity/u);
  assert.match(claim, /min: 0, max: 256/u);
  assert.match(claim, /CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS/u);
  assert.match(claim, /claim: \{ maxConcurrentHandoffs \}/u);
  assert.match(claim, /button\.disabled = true/u);
  assert.match(claim, /ui\.selectedBrowserAgentId !== jobId[\s\S]*?return;[\s\S]*?loadBrowserAgentJobs/u);
  assert.doesNotMatch(claim, /leaseSeconds|maxChildrenPerAgent|maxDepth/u);
});

test('provider run requires a current LEASED handoff and never grants completion or verification in UI', () => {
  const run = functionBody('runSelectedSpecialistProviderExecution');
  assert.match(run, /handoff\.state !== 'LEASED'/u);
  assert.match(run, /RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION/u);
  assert.match(run, /completionAuthorized=ні/u);
  assert.match(run, /ui\.selectedBrowserAgentId !== jobId[\s\S]*?return;[\s\S]*?loadBrowserAgentJobs/u);
  assert.match(run, /if \(ui\.selectedBrowserAgentId === jobId\) renderSpecialistProviderRuntime\(\)/u);
  assert.doesNotMatch(run, /COMPLETE_BROWSER_AGENT_SPECIALIST_HANDOFF|VERIFY_BROWSER_AGENT_SPECIALIST_HANDOFF|AUTHORIZE_BROWSER_AGENT_SPECIALIST_SAFE_RETRY/u);
  assert.match(html, /Provider terminal status не завершує Specialist автоматично/u);
  assert.match(html, /canonical independent verifier provenance/u);
});

test('stale Specialist async results cannot overwrite the current owner context', () => {
  assert.match(options, /specialistProviderConfigLoadGeneration:\s*0/u);
  assert.match(options, /specialistProviderRuntimeLoadGeneration:\s*0/u);

  const configLoad = functionBody('loadSpecialistProviderConfig');
  assert.match(
    configLoad,
    /const generation = \+\+ui\.specialistProviderConfigLoadGeneration[\s\S]*?if \(ui\.specialistProviderConfigLoadGeneration !== generation\) return;/u,
  );
  assert.match(
    configLoad,
    /catch \(error\)[\s\S]*?if \(ui\.specialistProviderConfigLoadGeneration !== generation\) return;/u,
  );

  const runtimeLoad = functionBody('loadSpecialistProviderRuntime');
  assert.match(
    runtimeLoad,
    /const generation = \+\+ui\.specialistProviderRuntimeLoadGeneration[\s\S]*?ui\.specialistProviderRuntimeLoadGeneration !== generation[\s\S]*?ui\.selectedBrowserAgentId !== jobId/u,
  );

  const probe = functionBody('probeSpecialistProviderConfig');
  assert.match(
    probe,
    /catch \(error\)[\s\S]*?ui\.specialistProviderConfig !== current[\s\S]*?ui\.specialistProviderConfig\?\.revision !== current\.revision[\s\S]*?ui\.specialistProviderQuarantined\) return;/u,
  );
});
