import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';

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
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: '',
    instructions: 'Research the owner task with explicit source evidence.',
    capabilityIds: [],
    toolIds: [],
    tags: ['research'],
    acceptanceCriteria: [],
    configDefaults: {},
    enabled: true,
    definitionRevision: 1,
    ...overrides,
  };
}

test('Agent definition registries persist through the existing Browser Agent store and restart', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  assert.equal(created.registry.revision, 1);

  const mutation = await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: definition(),
  });
  assert.equal(mutation.previousRegistryRevision, 1);
  assert.equal(mutation.nextRegistryRevision, 2);
  assert.equal(mutation.authority.persistenceAuthorized, false);

  const restarted = managerFor(chrome);
  const loaded = await restarted.getAgentDefinitionRegistry('agents:project-1');
  assert.equal(loaded.registry.revision, 2);
  assert.deepEqual(loaded.registry.definitions.map(item => item.agentDefinitionId), ['agent.research']);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1'], 'definition persistence must not create a second storage key');
});

test('persisted definition mutations enforce registry CAS at the actual serialized write boundary', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });

  const first = manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: definition({ agentDefinitionId: 'agent.a', label: 'Agent A', tags: ['a'] }),
  });
  const second = manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: definition({ agentDefinitionId: 'agent.b', label: 'Agent B', tags: ['b'] }),
  });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.match(String(results.find(item => item.status === 'rejected').reason), /registry revision drifted/);

  const live = await manager.getAgentDefinitionRegistry('agents:project-1');
  assert.equal(live.registry.revision, 2);
  assert.equal(live.registry.definitions.length, 1);
});

test('definition revision CAS survives persistence and rejects stale updates', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: definition(),
  });
  const updated = await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    kind: AgentDefinitionRegistryMutationKind.UPDATE,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    definition: definition({ label: 'Research Agent v2', definitionRevision: 2 }),
  });
  assert.equal(updated.nextRegistryRevision, 3);

  await assert.rejects(() => manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 3,
    kind: AgentDefinitionRegistryMutationKind.UPDATE,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    definition: definition({ label: 'Stale edit', definitionRevision: 2 }),
  }), /definition revision drifted/);
});

test('definition persistence boundaries are descriptor-safe, exact-shape and zero-getter', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'registryId', {
    enumerable: true,
    get() { reads += 1; return 'agents:project-1'; },
  });
  await assert.rejects(() => manager.createAgentDefinitionRegistry(hostile), /enumerable data property/);
  assert.equal(reads, 0);

  await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  await assert.rejects(() => manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: definition(),
    registry: { forged: true },
  }), /unknown field/);

  const portable = Object.create(null);
  portable.registryId = 'agents:project-2';
  const created = await manager.createAgentDefinitionRegistry(portable);
  assert.equal(created.registry.registryId, 'agents:project-2');
});

test('one corrupt persisted definition registry does not poison jobs or other valid registries', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.createAgentDefinitionRegistry({ registryId: 'agents:good' });
  data.autopilotBrowserAgentV1.definitionRegistriesById['agents:bad'] = {
    schemaVersion: 1,
    registryId: 'agents:bad',
    revision: 'not-a-revision',
    definitions: [],
  };
  const restarted = managerFor(chrome);
  const listed = await restarted.listAgentDefinitionRegistries();
  assert.deepEqual(listed.registries.map(item => item.registryId), ['agents:good']);
  assert.equal((await restarted.getAgentDefinitionRegistry('agents:bad')).registry, null);
  assert.deepEqual(await restarted.getExecutionPolicy(), { maxConcurrentAgents: 1 });
});

test('Core routes Agent-definition reads and mutations only through BrowserAgentManager', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /'LIST_BROWSER_AGENT_DEFINITION_REGISTRIES'/);
  assert.match(source, /'GET_BROWSER_AGENT_DEFINITION_REGISTRY'/);
  assert.match(source, /browserAgent\.listAgentDefinitionRegistries\(\)/);
  assert.match(source, /browserAgent\.getAgentDefinitionRegistry\(message\.payload\?\.registryId \|\| ''\)/);
  assert.match(source, /browserAgent\.createAgentDefinitionRegistry\(message\.payload \|\| \{\}\)/);
  assert.match(source, /browserAgent\.mutateAgentDefinitionRegistry\(message\.payload \|\| \{\}\)/);
  assert.equal((source.match(/autopilotBrowserAgentV1/g) || []).length, 0, 'service worker must not own a second persistence implementation');
});


test('Agent definition registry identity is prototype-safe for valid Object prototype names', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.createAgentDefinitionRegistry({ registryId: 'constructor' });
  assert.equal(created.registry.registryId, 'constructor');
  assert.equal((await manager.getAgentDefinitionRegistry('constructor')).registry.registryId, 'constructor');

  await assert.rejects(
    () => manager.createAgentDefinitionRegistry({ registryId: 'constructor' }),
    /already exists/,
  );

  const mutation = await manager.mutateAgentDefinitionRegistry({
    registryId: 'constructor',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: definition({ agentDefinitionId: 'agent.prototype-safe', label: 'Prototype Safe', tags: ['safe'] }),
  });
  assert.equal(mutation.nextRegistry.registryId, 'constructor');
  assert.equal(mutation.nextRegistryRevision, 2);
});
