import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { AgentExecutionPlane } from '../src/core/agent-plan.js';
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
  return new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
}

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    specialistId: 'research-local',
    providerId: 'provider.research',
    label: 'Research',
    description: 'Least-authority research specialist.',
    executionPlane: AgentExecutionPlane.LOCAL,
    capabilityIds: ['research.web'],
    toolIds: ['browser.read', 'files.read'],
    resultContractId: 'result.research.v1',
    enabled: true,
    definitionRevision: 1,
    ...overrides,
  };
}

test('Specialist registries persist through the existing Browser Agent store and restart', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createSpecialistRegistry({ registryId: 'specialists:project-1' });
  assert.equal(created.registry.revision, 1);

  const mutation = await manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: definition(),
  });
  assert.equal(mutation.nextRegistryRevision, 2);
  assert.equal(mutation.authority.persistenceAuthorized, false);

  const restarted = managerFor(chrome);
  const loaded = await restarted.getSpecialistRegistry('specialists:project-1');
  assert.equal(loaded.registry.revision, 2);
  assert.deepEqual(loaded.registry.definitions.map(item => item.specialistId), ['research-local']);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1'], 'SpecialistRegistry persistence must not create a second storage key');
});

test('Specialist registry CAS is enforced at the actual serialized write boundary', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.createSpecialistRegistry({ registryId: 'specialists:project-1' });

  const first = manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: definition({ specialistId: 'specialist.a', label: 'A' }),
  });
  const second = manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: definition({ specialistId: 'specialist.b', label: 'B' }),
  });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.match(String(results.find(item => item.status === 'rejected').reason), /registry revision drifted/);

  const live = await manager.getSpecialistRegistry('specialists:project-1');
  assert.equal(live.registry.revision, 2);
  assert.equal(live.registry.definitions.length, 1);
});

test('Specialist definition revision CAS persists and rejects stale edits', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.createSpecialistRegistry({ registryId: 'specialists:project-1' });
  await manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: definition(),
  });
  const updated = await manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 2,
    kind: SpecialistRegistryMutationKind.UPDATE,
    specialistId: 'research-local',
    expectedDefinitionRevision: 1,
    definition: definition({ label: 'Research v2', definitionRevision: 2 }),
  });
  assert.equal(updated.nextRegistryRevision, 3);
  assert.equal(updated.nextDefinitionRevision, 2);

  await assert.rejects(() => manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 3,
    kind: SpecialistRegistryMutationKind.UPDATE,
    specialistId: 'research-local',
    expectedDefinitionRevision: 1,
    definition: definition({ label: 'Stale', definitionRevision: 2 }),
  }), /definition revision drifted/);
});

test('nested Specialist definition is snapshotted before serialized enqueue', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.createSpecialistRegistry({ registryId: 'specialists:snapshot' });

  const mutable = definition();
  const pending = manager.mutateSpecialistRegistry({
    registryId: 'specialists:snapshot',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: mutable,
  });
  mutable.label = 'Mutated after call';
  mutable.toolIds[0] = 'filesystem.write';

  const committed = await pending;
  assert.equal(committed.nextRegistry.definitions[0].label, 'Research');
  assert.deepEqual(committed.nextRegistry.definitions[0].toolIds, ['browser.read', 'files.read']);
});

test('Specialist persistence boundaries reject accessors and unknown authority fields without getter execution', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'registryId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'specialists:hostile';
    },
  });
  await assert.rejects(() => manager.createSpecialistRegistry(hostile), /enumerable data property/);
  assert.equal(reads, 0);

  await manager.createSpecialistRegistry({ registryId: 'specialists:hostile' });
  const nested = definition();
  Object.defineProperty(nested, 'toolIds', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return ['browser.read'];
    },
  });
  await assert.rejects(() => manager.mutateSpecialistRegistry({
    registryId: 'specialists:hostile',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: nested,
  }), /toolIds must be an enumerable own data property/);
  assert.equal(reads, 0);

  await assert.rejects(() => manager.mutateSpecialistRegistry({
    registryId: 'specialists:hostile',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: definition(),
    executionAuthorized: true,
  }), /unknown field/);
});

test('corrupt persisted Specialist registry is quarantined and preserved across unrelated saves', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.createSpecialistRegistry({ registryId: 'specialists:good' });
  data.autopilotBrowserAgentV1.specialistRegistriesById['specialists:bad'] = {
    schemaVersion: 1,
    registryId: 'specialists:bad',
    revision: 'broken',
    definitions: [],
  };

  const restarted = managerFor(chrome);
  const listed = await restarted.listSpecialistRegistries();
  assert.deepEqual(listed.registries.map(item => item.registryId), ['specialists:good']);
  assert.deepEqual(listed.quarantinedRegistryIds, ['specialists:bad']);
  const bad = await restarted.getSpecialistRegistry('specialists:bad');
  assert.equal(bad.registry, null);
  assert.equal(bad.quarantined, true);

  await assert.rejects(
    () => restarted.createSpecialistRegistry({ registryId: 'specialists:bad' }),
    /quarantined as corrupt/,
  );
  await restarted.updateExecutionPolicy({ maxConcurrentAgents: 2 });
  assert.ok(data.autopilotBrowserAgentV1.specialistRegistryQuarantineById['specialists:bad']);
  assert.deepEqual(
    (await managerFor(chrome).listSpecialistRegistries()).quarantinedRegistryIds,
    ['specialists:bad'],
  );
});

test('valid Object prototype names are safe Specialist registry identities', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createSpecialistRegistry({ registryId: 'constructor' });
  assert.equal(created.registry.registryId, 'constructor');
  assert.equal((await manager.getSpecialistRegistry('constructor')).registry.registryId, 'constructor');
  await assert.rejects(
    () => manager.createSpecialistRegistry({ registryId: 'constructor' }),
    /already exists/,
  );
});

test('Core routes Specialist registry CRUD only through BrowserAgentManager', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /'LIST_BROWSER_AGENT_SPECIALIST_REGISTRIES'/);
  assert.match(source, /'GET_BROWSER_AGENT_SPECIALIST_REGISTRY'/);
  assert.match(source, /browserAgent\.listSpecialistRegistries\(\)/);
  assert.match(source, /browserAgent\.getSpecialistRegistry\(message\.payload\?\.registryId \|\| ''\)/);
  assert.match(source, /browserAgent\.createSpecialistRegistry\(message\.payload \|\| \{\}\)/);
  assert.match(source, /browserAgent\.mutateSpecialistRegistry\(message\.payload \|\| \{\}\)/);
  assert.equal((source.match(/autopilotBrowserAgentV1/g) || []).length, 0, 'service worker must not own a second persistence implementation');
});
