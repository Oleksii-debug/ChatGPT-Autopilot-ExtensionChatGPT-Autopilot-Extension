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

test('Specialist runtime panel exposes evidence and leased run without manual capacity claim', () => {
  assert.match(html, /id="specialist-provider-runtime-group"/u);
  assert.match(html, /id="specialist-provider-handoff-list"/u);
  assert.match(html, /id="specialist-provider-execution-list"/u);
  assert.match(html, /id="specialist-provider-run-button"/u);
  assert.doesNotMatch(html, /specialist-provider-claim-button|specialist-provider-max-concurrent-handoffs/u);
  assert.match(html, /не claim-ить capacity/u);
  assert.match(html, /Provider terminal status не завершує Specialist автоматично/u);
});

test('runtime evidence comes from the canonical consolidated handoff projection', () => {
  const body = functionBody('loadSpecialistProviderRuntime');
  assert.match(body, /LIST_BROWSER_AGENT_SPECIALIST_HANDOFFS/u);
  assert.match(body, /durable\?\.providerExecutions/u);
  assert.match(body, /durable\?\.providerExecutionQuarantined === true/u);
  assert.doesNotMatch(body, /LIST_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTIONS|CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS/u);
});

test('LEASED-only provider run binds current exact Browser Agent control epoch', () => {
  const body = functionBody('runSelectedSpecialistProviderExecution');
  assert.match(body, /handoff\.state !== 'LEASED'/u);
  assert.match(body, /expectedControlEpoch = ui\.selectedBrowserAgent\?\.runtime\?\.controlEpoch/u);
  assert.match(body, /RUN_BROWSER_AGENT_SPECIALIST_PROVIDER_EXECUTION/u);
  assert.match(body, /expectedControlEpoch,/u);
  assert.doesNotMatch(body, /CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS|VERIFY_BROWSER_AGENT_SPECIALIST_HANDOFF|COMPLETE_BROWSER_AGENT_SPECIALIST_HANDOFF/u);
  assert.doesNotMatch(body, /providerDispatched/u);
  assert.match(body, /Result kind: \$\{result\?\.kind \|\| 'невідомий'\}/u);
});

test('runtime run control is disabled without a canonical epoch or with terminal evidence', () => {
  const body = functionBody('renderSpecialistProviderRuntime');
  assert.match(body, /selected\.state !== 'LEASED'/u);
  assert.match(body, /runState !== 'RUNNING'/u);
  assert.match(body, /Date\.parse\(selected\.leaseExpiresAt\)/u);
  assert.match(body, /leaseExpiresMs > Date\.now\(\)/u);
  assert.match(body, /Number\.isSafeInteger\(controlEpoch\)/u);
  assert.match(body, /PROVIDER_SUCCEEDED/u);
  assert.match(body, /RECONCILE/u);
  assert.match(body, /MANUAL_REVIEW/u);
});

test('job selection and visible Agent mode refresh durable Specialist evidence', () => {
  const select = functionBody('selectBrowserAgentJob');
  assert.match(select, /await loadSpecialistProviderRuntime\(\);/u);
  assert.match(options, /if \(document\.visibilityState === 'visible' && storageGet\(UI_MODE_KEY\) === 'agent'\) void loadSpecialistProviderRuntime\(\);/u);
});
