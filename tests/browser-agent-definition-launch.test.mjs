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

function managerFor(chrome, createId = () => 'job.generated') {
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    createId,
  });
}

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: 'Evidence-bound research worker',
    instructions: 'Research the owner task and preserve explicit source evidence.',
    capabilityIds: ['browser', 'research'],
    toolIds: ['browser.read', 'files.read'],
    tags: ['research'],
    acceptanceCriteria: [],
    configDefaults: {
      maxSteps: 50,
      maxModelCalls: 8,
      maxInputTokens: 6000,
      maxOutputTokens: 3000,
      maxTotalTokens: 9000,
      maxOutputTokensPerCall: 1000,
      maxRuntimeMinutes: 20,
      aiPinnedRouteId: 'route.research',
    },
    modelRoutePolicy: {
      autoSwitch: false,
      allowRouteIds: ['route.research'],
      freeOnly: true,
      locality: 'local',
    },
    enabled: true,
    definitionRevision: 1,
    ...overrides,
  };
}

function ownerBudget(overrides = {}) {
  return {
    maxSteps: 200,
    maxModelCalls: 20,
    maxInputTokens: 20000,
    maxOutputTokens: 10000,
    maxTotalTokens: 30000,
    maxOutputTokensPerCall: 2000,
    maxRuntimeMinutes: 60,
    maxCostUsd: 2,
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
    ...overrides,
  };
}

async function seedRegistry(manager, def = definition()) {
  await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: def,
  });
}

function launchRequest(overrides = {}) {
  return {
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    jobId: 'job.research-1',
    goal: 'Compare the current evidence and produce a verified result.',
    projectId: 'project-1',
    ownerBudget: ownerBudget(),
    ownerCapabilityIds: ['browser', 'research'],
    ownerToolIds: ['browser.read', 'files.read'],
    requestedCapabilityIds: ['research'],
    requestedToolIds: ['browser.read'],
    ...overrides,
  };
}

test('persisted Agent definition launches atomically into the canonical Browser Agent store', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  const created = await manager.createFromAgentDefinition(launchRequest());
  assert.equal(created.job.id, 'job.research-1');
  assert.equal(created.job.config.name, 'Research Agent');
  assert.equal(created.job.config.projectId, 'project-1');
  assert.equal(created.job.config.maxSteps, 50, 'definition ceiling must narrow owner ceiling');
  assert.equal(created.job.config.maxModelCalls, 8);
  assert.equal(created.job.config.aiPinnedRouteId, 'route.research');
  assert.match(created.job.config.goal, /^Reusable Agent definition instructions:/);
  assert.match(created.job.config.goal, /Owner task:\nCompare the current evidence/);

  assert.equal(created.job.definitionSelection.registryId, 'agents:project-1');
  assert.equal(created.job.definitionSelection.registryRevision, 2);
  assert.equal(created.job.definitionSelection.agentDefinitionId, 'agent.research');
  assert.equal(created.job.definitionSelection.definitionRevision, 1);
  assert.deepEqual(created.job.definitionScope, {
    capabilityIds: ['research'],
    toolIds: ['browser.read'],
  });
  assert.deepEqual(created.job.definitionRouterOverride.routePolicy.allowRouteIds, ['route.research']);
  assert.equal(created.job.definitionRouterOverride.routePolicy.autoSwitch, false);
  assert.equal(created.job.definitionRouterOverride.routePolicy.freeOnly, true);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1'], 'launch must reuse the one Browser Agent storage key');
});

test('definition launch provenance and narrowed scope survive service-worker restart', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);
  await manager.createFromAgentDefinition(launchRequest());

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.research-1');
  assert.equal(loaded.job.definitionSelection.registryRevision, 2);
  assert.equal(loaded.job.definitionSelection.definitionRevision, 1);
  assert.deepEqual(loaded.job.definitionScope.capabilityIds, ['research']);
  assert.deepEqual(loaded.job.definitionScope.toolIds, ['browser.read']);
  assert.deepEqual(loaded.job.definitionRouterOverride.routePolicy.allowRouteIds, ['route.research']);
  assert.equal(loaded.job.definitionRouterOverride.routePolicy.locality, 'local');
  assert.equal(loaded.job.config.aiPinnedRouteId, 'route.research');
});

test('launch requires exact live registry and definition revisions at the serialized write boundary', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    kind: AgentDefinitionRegistryMutationKind.UPDATE,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    definition: definition({
      label: 'Research Agent v2',
      definitionRevision: 2,
    }),
  });

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest()),
    /registry revision drifted before launch/,
  );
  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      expectedRegistryRevision: 3,
      expectedDefinitionRevision: 1,
    })),
    /definition revision drifted before launch/,
  );

  const current = await manager.createFromAgentDefinition(launchRequest({
    expectedRegistryRevision: 3,
    expectedDefinitionRevision: 2,
    jobId: 'job.research-v2',
  }));
  assert.equal(current.job.config.name, 'Research Agent v2');
  assert.equal(current.job.definitionSelection.definitionRevision, 2);
});

test('a registry mutation queued before launch cannot be bypassed by stale launch expectations', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  const mutation = manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    kind: AgentDefinitionRegistryMutationKind.UPDATE,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    definition: definition({ label: 'Research Agent changed', definitionRevision: 2 }),
  });
  const launch = manager.createFromAgentDefinition(launchRequest({ jobId: 'job.stale' }));

  await mutation;
  await assert.rejects(() => launch, /registry revision drifted before launch/);
  assert.equal((await manager.get('job.stale')).job, null);
});

test('definition launch preserves owner and definition capability/tool intersection', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      requestedCapabilityIds: ['browser', 'research'],
      ownerCapabilityIds: ['research'],
      jobId: 'job.owner-capability-excess',
    })),
    /Requested Agent capabilities exceeds allowed authority/,
  );

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      requestedToolIds: ['browser.read', 'files.read'],
      ownerToolIds: ['browser.read'],
      jobId: 'job.owner-tool-excess',
    })),
    /Requested Agent tools exceeds allowed authority/,
  );
});

test('disabled definitions and duplicate job identity fail closed', async () => {
  const firstStore = makeChromeStorage();
  const disabledManager = managerFor(firstStore.chrome);
  await seedRegistry(disabledManager, definition({ enabled: false }));
  await assert.rejects(
    () => disabledManager.createFromAgentDefinition(launchRequest()),
    /missing or disabled/,
  );

  const secondStore = makeChromeStorage();
  const manager = managerFor(secondStore.chrome);
  await seedRegistry(manager);
  await manager.createFromAgentDefinition(launchRequest());
  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest()),
    /job already exists/,
  );
});

test('definition launch request boundary is exact-shape, data-only and zero-getter', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'registryId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'agents:project-1';
    },
  });
  await assert.rejects(
    () => manager.createFromAgentDefinition(hostile),
    /enumerable data property/,
  );
  assert.equal(reads, 0);

  await assert.rejects(
    () => manager.createFromAgentDefinition({
      ...launchRequest({ jobId: 'job.unknown-field' }),
      executionAuthorized: true,
    }),
    /unknown field/,
  );
});

test('launch snapshots nested owner authority before queued persistence', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  const request = launchRequest({ jobId: 'job.snapshot' });
  const pending = manager.createFromAgentDefinition(request);
  request.ownerBudget.maxSteps = 1;
  request.requestedCapabilityIds[0] = 'browser';
  request.requestedToolIds[0] = 'files.read';

  const created = await pending;
  assert.equal(created.job.config.maxSteps, 50, 'post-call budget mutation must not alter materialization');
  assert.deepEqual(created.job.definitionScope.capabilityIds, ['research']);
  assert.deepEqual(created.job.definitionScope.toolIds, ['browser.read']);
});

test('nested launch authority rejects accessors without executing them', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  let reads = 0;
  const budget = ownerBudget();
  Object.defineProperty(budget, 'maxSteps', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 200;
    },
  });

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      jobId: 'job.nested-getter',
      ownerBudget: budget,
    })),
    /enumerable data property/,
  );
  assert.equal(reads, 0);
});

test('standard Browser Agent creation carries no reusable-definition provenance', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.create({
    id: 'job.manual',
    goal: 'Owner-created Browser Agent',
  });
  assert.equal(created.job.definitionSelection, null);
  assert.equal(created.job.definitionScope, null);

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.manual');
  assert.equal(loaded.job.definitionSelection, null);
  assert.equal(loaded.job.definitionScope, null);
});

test('Core exposes definition launch only through the canonical BrowserAgentManager', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /'CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION'/);
  assert.match(source, /browserAgent\.createFromAgentDefinition\(message\.payload \|\| \{\}\)/);
  assert.doesNotMatch(source, /chrome\.storage\.local[^\n]+CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION/);
});
