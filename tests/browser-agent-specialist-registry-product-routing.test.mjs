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
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
  });
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

test('Specialist definition is canonically snapshotted before serialized persistence enqueue', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createSpecialistRegistry({ registryId: 'specialists:snapshot' });

  const mutable = definition();
  const pending = manager.mutateSpecialistRegistry({
    registryId: 'specialists:snapshot',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: created.registry.bindingKey,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: mutable,
  });

  mutable.label = 'Mutated after call';
  mutable.capabilityIds[0] = 'admin';
  mutable.toolIds[0] = 'filesystem.write';

  const committed = await pending;
  assert.equal(committed.nextRegistry.definitions[0].label, 'Research');
  assert.deepEqual(committed.nextRegistry.definitions[0].capabilityIds, ['research.web']);
  assert.deepEqual(committed.nextRegistry.definitions[0].toolIds, ['browser.read', 'files.read']);
});

test('Specialist nested accessors fail closed before serialized persistence without getter execution', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createSpecialistRegistry({ registryId: 'specialists:hostile' });
  let reads = 0;
  const hostile = definition();
  Object.defineProperty(hostile, 'toolIds', {
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
    expectedRegistryBindingKey: created.registry.bindingKey,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: hostile,
  }), /toolIds must be an enumerable own data property/);
  assert.equal(reads, 0);
});

test('service worker exposes Specialist registry reads and mutations only through BrowserAgentManager', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  for (const command of [
    'LIST_BROWSER_AGENT_SPECIALIST_REGISTRIES',
    'GET_BROWSER_AGENT_SPECIALIST_REGISTRY',
    'CREATE_BROWSER_AGENT_SPECIALIST_REGISTRY',
    'MUTATE_BROWSER_AGENT_SPECIALIST_REGISTRY',
  ]) {
    assert.match(source, new RegExp("'"+command+"'"));
  }
  assert.match(source, /browserAgent\.listSpecialistRegistries\(\)/);
  assert.match(source, /browserAgent\.getSpecialistRegistry\(message\.payload\?\.registryId \|\| ''\)/);
  assert.match(source, /browserAgent\.createSpecialistRegistry\(message\.payload \|\| \{\}\)/);
  assert.match(source, /browserAgent\.mutateSpecialistRegistry\(message\.payload \|\| \{\}\)/);

  const readOnlyBlock = source.slice(
    source.indexOf('const READ_ONLY_UI_COMMANDS'),
    source.indexOf('const repo = new StorageRepository'),
  );
  assert.match(readOnlyBlock, /'LIST_BROWSER_AGENT_SPECIALIST_REGISTRIES'/);
  assert.match(readOnlyBlock, /'GET_BROWSER_AGENT_SPECIALIST_REGISTRY'/);
  assert.doesNotMatch(readOnlyBlock, /'CREATE_BROWSER_AGENT_SPECIALIST_REGISTRY'/);
  assert.doesNotMatch(readOnlyBlock, /'MUTATE_BROWSER_AGENT_SPECIALIST_REGISTRY'/);
});
