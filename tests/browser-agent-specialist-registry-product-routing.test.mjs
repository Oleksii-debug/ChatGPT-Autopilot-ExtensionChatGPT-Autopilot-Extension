import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { SpecialistRegistryMutationKind } from '../src/core/specialist-registry.js';

function makeChromeStorage() {
  const data = Object.create(null);
  return {
    chrome: {
      storage: {
        local: {
          async get(key) { return { [key]: structuredClone(data[key]) }; },
          async set(record) {
            for (const [key, value] of Object.entries(record)) data[key] = structuredClone(value);
          },
        },
      },
      alarms: {
        async create() {},
        async clear() { return true; },
      },
    },
  };
}

function specialistDefinition() {
  return {
    schemaVersion: 1,
    specialistId: 'specialist.research.local',
    providerId: 'provider.local.research',
    label: 'Local Research',
    description: 'Bounded local research specialist',
    executionPlane: 'LOCAL',
    capabilityIds: ['research'],
    toolIds: ['browser.read'],
    resultContractId: 'result.research',
    enabled: true,
    definitionRevision: 1,
  };
}

test('nested Specialist definition accessors fail closed before serialized persistence without getter execution', async () => {
  const { chrome } = makeChromeStorage();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
  });
  const created = await manager.createSpecialistRegistry({
    registryId: 'specialists:hostile',
  });

  let reads = 0;
  const hostile = specialistDefinition();
  Object.defineProperty(hostile, 'toolIds', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return ['browser.read'];
    },
  });

  await assert.rejects(
    () => manager.mutateSpecialistRegistry({
      registryId: 'specialists:hostile',
      expectedRegistryRevision: 1,
      expectedRegistryBindingKey: created.registry.bindingKey,
      kind: SpecialistRegistryMutationKind.CREATE,
      definition: hostile,
    }),
    /toolIds must be an enumerable own data property/,
  );
  assert.equal(reads, 0);

  const persisted = await manager.getSpecialistRegistry('specialists:hostile');
  assert.equal(persisted.registry.revision, 1);
  assert.deepEqual(persisted.registry.definitions, []);
});
