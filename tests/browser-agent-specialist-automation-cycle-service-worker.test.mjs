import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);

function automationCycleSource() {
  const start = source.indexOf('export function runBrowserAgentAutomationCycle()');
  const end = source.indexOf('\nconst runSafely =', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test('Browser Agent automation cycle reuses canonical cycle, policy claim and trusted readiness authorities', () => {
  const block = automationCycleSource();
  assert.match(block, /browserAgent\.cycleAll\(\)/);
  assert.match(block, /browserAgent\.claimSpecialistHandoffsAcrossJobsFromAutomationPolicy\(\{[\s\S]*?specialistProviderReadinessResolver/);
  assert.match(block, /claim\?\.kind === 'AUTOMATION_CLAIM'/);
  assert.doesNotMatch(block, /maxConcurrentHandoffs\s*:\s*[1-9]/);
});

test('automatic dispatch resumes PREPARED but never redispatches terminal provider records', () => {
  const block = automationCycleSource();
  assert.match(block, /execution && execution\.status !== 'PREPARED'\) continue/);
  assert.match(block, /recoverPrepared:\s*execution\?\.status === 'PREPARED'/);
  assert.match(block, /candidate\.recoverPrepared[\s\S]*?executeClaimedSpecialistProvider\([\s\S]*?: await browserAgent\.executeClaimedSpecialistProviderFromAutomationPolicy/);
  assert.match(block, /createSpecialistConversationId\(\)/);
});

test('automatic provider evidence never self-authorizes completion or verification', () => {
  const block = automationCycleSource();
  assert.doesNotMatch(block, /completeSpecialistHandoff/);
  assert.doesNotMatch(block, /verifySpecialistHandoff/);
  assert.doesNotMatch(block, /completionAuthorized\s*:\s*true/);
});

test('startup, Browser Agent alarm and explicit run-now all enter the same automation cycle', () => {
  assert.match(source, /async function runStartupCycle\(\)[\s\S]*?runBrowserAgentAutomationCycle\(\)/);
  assert.match(source, /message\.command === 'RUN_BROWSER_AGENT_NOW'[\s\S]*?runBrowserAgentAutomationCycle\(\)/);
  assert.match(source, /alarm\.name === BROWSER_AGENT_ALARM\) runSafely\(runBrowserAgentAutomationCycle\(\)\)/);
});
