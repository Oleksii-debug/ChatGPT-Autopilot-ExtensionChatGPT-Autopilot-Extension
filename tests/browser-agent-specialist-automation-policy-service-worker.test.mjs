import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);

test('Specialist automation policy GET is read-only while SET and CLEAR remain mutation-only', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  assert.match(block, /'GET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'/);
  assert.doesNotMatch(block, /'SET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'/);
  assert.doesNotMatch(block, /'CLEAR_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'/);
});

test('Specialist automation policy commands delegate only to BrowserAgentManager durable authority', () => {
  assert.match(
    source,
    /message\.command === 'GET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'[\s\S]*?browserAgent\.getSpecialistAutomationPolicy\(\)/,
  );
  assert.match(
    source,
    /message\.command === 'SET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'[\s\S]*?browserAgent\.setSpecialistAutomationPolicy\(message\.payload \|\| \{\}\)/,
  );
  assert.match(
    source,
    /message\.command === 'CLEAR_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'[\s\S]*?browserAgent\.clearSpecialistAutomationPolicy\(message\.payload \|\| \{\}\)/,
  );
});
