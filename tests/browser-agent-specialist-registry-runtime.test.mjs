import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { SpecialistRegistryMutationKind } from '../src/core/specialist-registry.js';

function makeChromeStorage() {
  const data = Object.create(null);
  return {
    data,
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

function managerFor(chrome) {
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
  });
}

function specialist(overrides = {}) {
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
    ...overrides,
  };
}

test('Specialist registry is durable in the existing BrowserAgent store and survives restart', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);

  const created = await manager.createSpecialistRegistry({
    registryId: 'specialists:project-1',
  });
  assert.equal(created.registry.registryId, 'specialists:project-1');
  assert.equal(created.registry.revision, 1);
  assert.deepEqual(created.registry.definitions, []);

  const restarted = managerFor(chrome);
  const fetched = await restarted.getSpecialistRegistry('specialists:project-1');
  assert.deepEqual(fetched.registry, created.registry);
  assert.equal(fetched.quarantined, false);

  const listed = await restarted.listSpecialistRegistries();
  assert.deepEqual(listed.registries, [created.registry]);
  assert.deepEqual(listed.quarantinedRegistryIds, []);
});

test('Specialist registry mutation commits canonical CAS proposal and persists exact definition provenance', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createSpecialistRegistry({
    registryId: 'specialists:project-1',
  });

  const committed = await manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: created.registry.bindingKey,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: specialist(),
  });

  assert.equal(committed.previousRegistryRevision, 1);
  assert.equal(committed.nextRegistryRevision, 2);
  assert.equal(committed.specialistId, 'specialist.research.local');
  assert.equal(committed.nextDefinitionRevision, 1);
  assert.equal(committed.authority.persistenceAuthorized, false);
  assert.equal(committed.authority.executionAuthorized, false);

  const restarted = managerFor(chrome);
  const fetched = await restarted.getSpecialistRegistry('specialists:project-1');
  assert.equal(fetched.registry.revision, 2);
  assert.equal(fetched.registry.definitions.length, 1);
  assert.deepEqual(fetched.registry.definitions[0], specialist());
});

test('stale Specialist registry revision or bindingKey fails without mutating durable state', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createSpecialistRegistry({
    registryId: 'specialists:project-1',
  });

  await assert.rejects(
    () => manager.mutateSpecialistRegistry({
      registryId: 'specialists:project-1',
      expectedRegistryRevision: 2,
      expectedRegistryBindingKey: created.registry.bindingKey,
      kind: SpecialistRegistryMutationKind.CREATE,
      definition: specialist(),
    }),
    /revision drifted/,
  );

  await assert.rejects(
    () => manager.mutateSpecialistRegistry({
      registryId: 'specialists:project-1',
      expectedRegistryRevision: 1,
      expectedRegistryBindingKey: '["forged"]',
      kind: SpecialistRegistryMutationKind.CREATE,
      definition: specialist(),
    }),
    /bindingKey drifted/,
  );

  const fetched = await manager.getSpecialistRegistry('specialists:project-1');
  assert.equal(fetched.registry.revision, 1);
  assert.deepEqual(fetched.registry.definitions, []);
});

test('corrupt persisted Specialist registry is quarantined without poisoning healthy registries', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.createSpecialistRegistry({ registryId: 'specialists:good' });
  await manager.createSpecialistRegistry({ registryId: 'specialists:bad' });

  data.autopilotBrowserAgentV1.specialistRegistriesById['specialists:bad'].revision = 9;

  const restarted = managerFor(chrome);
  const listed = await restarted.listSpecialistRegistries();
  assert.deepEqual(
    listed.registries.map(item => item.registryId),
    ['specialists:good'],
  );
  assert.deepEqual(listed.quarantinedRegistryIds, ['specialists:bad']);

  const bad = await restarted.getSpecialistRegistry('specialists:bad');
  assert.equal(bad.registry, null);
  assert.equal(bad.quarantined, true);

  await assert.rejects(
    () => restarted.createSpecialistRegistry({ registryId: 'specialists:bad' }),
    /quarantined/,
  );
});

test('Specialist registry manager rejects accessor-backed mutation authority without executing getters', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createSpecialistRegistry({
    registryId: 'specialists:project-1',
  });

  let reads = 0;
  const request = {
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: created.registry.bindingKey,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: specialist(),
  };
  Object.defineProperty(request, 'expectedRegistryBindingKey', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return created.registry.bindingKey;
    },
  });

  await assert.rejects(
    () => manager.mutateSpecialistRegistry(request),
    /enumerable data property/,
  );
  assert.equal(reads, 0);

  const fetched = await manager.getSpecialistRegistry('specialists:project-1');
  assert.equal(fetched.registry.revision, 1);
});
