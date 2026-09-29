import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);

test('Specialist registry read commands are admitted as read-only UI operations', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  assert.match(block, /'LIST_BROWSER_AGENT_SPECIALIST_REGISTRIES'/);
  assert.match(block, /'GET_BROWSER_AGENT_SPECIALIST_REGISTRY'/);
  assert.doesNotMatch(block, /'CREATE_BROWSER_AGENT_SPECIALIST_REGISTRY'/);
  assert.doesNotMatch(block, /'MUTATE_BROWSER_AGENT_SPECIALIST_REGISTRY'/);
});

test('Specialist registry service-worker commands delegate only to BrowserAgentManager registry authority', () => {
  assert.match(
    source,
    /message\.command === 'LIST_BROWSER_AGENT_SPECIALIST_REGISTRIES'[\s\S]*?browserAgent\.listSpecialistRegistries\(\)/,
  );
  assert.match(
    source,
    /message\.command === 'GET_BROWSER_AGENT_SPECIALIST_REGISTRY'[\s\S]*?browserAgent\.getSpecialistRegistry\(message\.payload\?\.registryId \|\| ''\)/,
  );
  assert.match(
    source,
    /message\.command === 'CREATE_BROWSER_AGENT_SPECIALIST_REGISTRY'[\s\S]*?browserAgent\.createSpecialistRegistry\(message\.payload \|\| \{\}\)/,
  );
  assert.match(
    source,
    /message\.command === 'MUTATE_BROWSER_AGENT_SPECIALIST_REGISTRY'[\s\S]*?browserAgent\.mutateSpecialistRegistry\(message\.payload \|\| \{\}\)/,
  );
});


test('definition-bound Specialist admission command remains mutation-only and delegates exact payload', () => {
  const start = source.indexOf('const READ_ONLY_UI_COMMANDS = new Set([');
  const end = source.indexOf(']);', start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /PREPARE_BROWSER_AGENT_DEFINITION_SPECIALIST_DELEGATION/);

  assert.match(
    source,
    /message\.command === 'PREPARE_BROWSER_AGENT_DEFINITION_SPECIALIST_DELEGATION'[\s\S]*?browserAgent\.prepareDefinitionSpecialistDelegation\([\s\S]*?message\.payload\?\.id \|\| ''[\s\S]*?message\.payload\?\.delegation \|\| \{\}[\s\S]*?\)/,
  );
});
