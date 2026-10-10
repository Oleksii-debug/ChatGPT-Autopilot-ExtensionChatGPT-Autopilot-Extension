import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import {
  createAgentDefinitionRegistryV1, normalizeAgentDefinitionRegistryV1,
} from '../src/core/agent-definition-registry.js';
import {
  createSpecialistRegistryV1, normalizeSpecialistRegistryV1,
} from '../src/core/specialist-registry.js';

function browserStorage() {
  const data = Object.create(null);
  const chromeApi = {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(data[key]) }; },
      async set(record) {
        for (const [key, value] of Object.entries(record)) data[key] = structuredClone(value);
      },
    } },
    alarms: { async create() {}, async clear() { return true; } },
  };
  return { data, chromeApi };
}

function manager(chromeApi) {
  return new BrowserAgentManager({
    chromeApi,
    routePrompt: async () => ({ text: '{}' }),
  });
}

test('Plan8 S1: existing factories persist exact Agent and Specialist CAS keys across cold restart', async () => {
  const { data, chromeApi } = browserStorage();
  const first = manager(chromeApi);
  const agentId = 'agents:plan8';
  const specialistId = 'specialists:plan8';
  const a = (await first.createAgentDefinitionRegistry({ registryId: agentId })).registry;
  const s = (await first.createSpecialistRegistry({ registryId: specialistId })).registry;
  assert.equal(a.bindingKey, createAgentDefinitionRegistryV1({
    schemaVersion: 1, registryId: agentId, revision: 1, definitions: [],
  }).bindingKey);
  assert.equal(s.bindingKey, createSpecialistRegistryV1({
    schemaVersion: 1, registryId: specialistId, revision: 1, definitions: [],
  }).bindingKey);
  assert.equal(normalizeAgentDefinitionRegistryV1(JSON.parse(JSON.stringify(a))).bindingKey, a.bindingKey);
  assert.equal(normalizeSpecialistRegistryV1(JSON.parse(JSON.stringify(s))).bindingKey, s.bindingKey);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1']);

  const second = manager(chromeApi);
  assert.equal((await second.getAgentDefinitionRegistry(agentId)).registry.bindingKey, a.bindingKey);
  assert.equal((await second.getSpecialistRegistry(specialistId)).registry.bindingKey, s.bindingKey);
  assert.equal((await second.getAgentDefinitionRegistry(agentId)).quarantined, false);
  assert.equal((await second.getSpecialistRegistry(specialistId)).quarantined, false);
});

test('Plan8 S1: missing or forged stored registry keys quarantine on cold restart; never minted', async () => {
  const { data, chromeApi } = browserStorage();
  const first = manager(chromeApi);
  await first.createAgentDefinitionRegistry({ registryId: 'agents:plan8' });
  await first.createSpecialistRegistry({ registryId: 'specialists:plan8' });
  delete data.autopilotBrowserAgentV1.definitionRegistriesById['agents:plan8'].bindingKey;
  data.autopilotBrowserAgentV1.specialistRegistriesById['specialists:plan8'].bindingKey = 'forged';
  const second = manager(chromeApi);
  const a = await second.getAgentDefinitionRegistry('agents:plan8');
  const s = await second.getSpecialistRegistry('specialists:plan8');
  assert.equal(a.registry, null);
  assert.equal(a.quarantined, true);
  assert.equal(s.registry, null);
  assert.equal(s.quarantined, true);
  assert.equal(Object.keys(data).length, 1, 'quarantine cannot add a second store');
});
