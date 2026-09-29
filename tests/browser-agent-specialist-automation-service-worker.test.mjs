import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);

test('Specialist automation policy GET is read-only while SET and CLEAR are mutation-only', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  assert.match(block, /'GET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'/);
  assert.doesNotMatch(block, /'SET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'/);
  assert.doesNotMatch(block, /'CLEAR_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'/);
});

test('Specialist automation policy commands delegate to the existing BrowserAgent durable authority', () => {
  assert.match(
    source,
    /GET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'[\s\S]*?browserAgent\.getSpecialistAutomationPolicy\(\)/,
  );
  assert.match(
    source,
    /SET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'[\s\S]*?browserAgent\.setSpecialistAutomationPolicy\(message\.payload \|\| \{\}\)/,
  );
  assert.match(
    source,
    /CLEAR_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'[\s\S]*?browserAgent\.clearSpecialistAutomationPolicy\(message\.payload \|\| \{\}\)/,
  );
});

test('canonical Browser Agent cycle PREPAREs then owner-policy CLAIMs then executes only claimed provider work', () => {
  const start = source.indexOf('export function runBrowserAgentCycle()');
  const end = source.indexOf('\nasync function notifyStatusChanged', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  const prepareIndex = block.indexOf('browserAgent.cycleAll()');
  const claimIndex = block.indexOf('browserAgent.claimSpecialistHandoffsAcrossJobsFromAutomationPolicy');
  const executeIndex = block.indexOf('browserAgent.executeClaimedSpecialistProvider');
  assert.ok(prepareIndex >= 0);
  assert.ok(claimIndex > prepareIndex);
  assert.ok(executeIndex > claimIndex);
  assert.match(block, /specialistProviderReadinessResolver/);
  assert.match(block, /globalThis\.crypto\?\.randomUUID/);
  assert.match(block, /expectedControlEpoch:\s*claimed\.controlEpoch/);
  assert.doesNotMatch(block, /completeSpecialistHandoff|verifySpecialistHandoff/);
});

test('startup, alarm and owner RUN NOW converge on the one automatic Browser Agent cycle', () => {
  assert.match(source, /const agent = await runBrowserAgentCycle\(\)/);
  assert.match(
    source,
    /message\.command === 'RUN_BROWSER_AGENT_NOW'[\s\S]*?result = await runBrowserAgentCycle\(\)/,
  );
  assert.match(
    source,
    /alarm\.name === BROWSER_AGENT_ALARM\) runSafely\(runBrowserAgentCycle\(\)\)/,
  );
});
