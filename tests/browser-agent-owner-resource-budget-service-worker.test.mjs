import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);

test('owner resource budget GET is read-only while SET is mutation-only', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  assert.match(block, /'GET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET'/);
  assert.doesNotMatch(block, /'SET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET'/);
});

test('owner resource budget commands delegate only to the existing BrowserAgentManager authority', () => {
  assert.match(
    source,
    /message\.command === 'GET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET'[\s\S]*?browserAgent\.getOwnerResourceBudget\(\)/,
  );
  assert.match(
    source,
    /message\.command === 'SET_BROWSER_AGENT_OWNER_RESOURCE_BUDGET'[\s\S]*?browserAgent\.setOwnerResourceBudget\(message\.payload \|\| \{\}\)/,
  );
  assert.doesNotMatch(source, /new ResourceBudget.*Manager|new .*ResourceBudget.*Store/);
});

test('cross-job Specialist claim stays mutation-only, strips caller time, and uses trusted readiness', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  const readOnly = source.slice(start, end);
  assert.doesNotMatch(readOnly, /CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS_ACROSS_JOBS/);

  assert.match(
    source,
    /CLAIM_BROWSER_AGENT_SPECIALIST_HANDOFFS_ACROSS_JOBS'[\s\S]*?structuredClone\(message\.payload\?\.claim \|\| \{\}\)[\s\S]*?delete claim\.at[\s\S]*?claimSpecialistHandoffsAcrossJobs\([\s\S]*?specialistProviderReadinessResolver[\s\S]*?\);/,
  );
});
