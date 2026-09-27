import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageRepository } from '../src/core/storage.js';
import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { OrchestrationV2Manager } from '../src/core/orchestration-v2-manager.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';

function chromeFake() {
  const data = Object.create(null);
  return {
    data,
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map(item => [item, structuredClone(data[item])]));
          }
          return { [key]: structuredClone(data[key]) };
        },
        async set(record) {
          for (const [key, value] of Object.entries(record)) data[key] = structuredClone(value);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        },
      },
    },
    alarms: {
      async create() {},
      async clear() { return true; },
    },
  };
}

function orchestraConfig(projectId) {
  return {
    enabled: false,
    projectId,
    targetRepository: 'owner/repository',
    controlRepository: 'owner/control',
    controlIssueNumber: 1,
    masterCoordinatorPrompt: 'MASTER',
    defaultDesiredWorkers: 1,
    absoluteMaxWorkers: 4,
  };
}

function hierarchy({
  graphId = 'graph-1',
  controlEpoch = 1,
  includeWorker = true,
} = {}) {
  const childIds = includeWorker ? ['worker'] : [];
  const nodes = [
    {
      id: 'root',
      parentId: null,
      childIds,
      promptProfileId: 'root-v1',
      chatMode: 'PERSISTENT_CHAT',
    },
  ];
  if (includeWorker) {
    nodes.push({
      id: 'worker',
      parentId: 'root',
      childIds: [],
      promptProfileId: 'root-v1',
      chatMode: 'PERSISTENT_CHAT',
    });
  }
  return {
    schemaVersion: 1,
    graphId,
    controlEpoch,
    promptProfiles: [
      { id: 'root-v1', role: 'GLOBAL_DIRECTOR', version: 1, prompt: 'WORK' },
    ],
    nodes,
  };
}

async function fixture() {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  const orchestration = new OrchestrationV2Manager({
    coreRepository: core,
    chromeApi: chrome,
    createId: () => 'orch-1',
    now: () => 1000,
  });
  await orchestration.create({ name: 'Project orchestra', config: orchestraConfig('project-1') });
  await orchestration.controllerFor('orch-1').configureHierarchy(hierarchy(), { nowMs: 1000 });

  let now = 2000;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => now,
  });
  await manager.create({
    id: 'job-1',
    projectId: 'project-1',
    name: 'Bound agent',
    goal: 'Execute bounded project work.',
  });
  const dependencies = {
    resolveProjectHierarchyAuthority: projectId =>
      orchestration.resolveProjectHierarchyAuthority(projectId),
  };
  return {
    chrome,
    core,
    orchestration,
    manager,
    dependencies,
    advance(ms = 1) { now += ms; },
  };
}

test('Project authority resolver returns the unique durable orchestra policy and hierarchy', async () => {
  const { orchestration } = await fixture();
  const authority = await orchestration.resolveProjectHierarchyAuthority('project-1');
  assert.equal(authority.orchestraId, 'orch-1');
  assert.equal(authority.projectId, 'project-1');
  assert.equal(authority.graphId, 'graph-1');
  assert.equal(authority.controlEpoch, 1);
  assert.deepEqual(authority.graph.nodeOrder, ['root', 'worker']);
  assert.deepEqual(authority.subagentPolicy, {
    schemaVersion: 1,
    allowAgentCreatedChildren: false,
    maxDepth: 0,
    maxChildrenPerAgent: 0,
  });
  assert.equal(Object.isFrozen(authority), true);
});

test('Browser Agent binding persists through the existing store and survives restart', async () => {
  const { chrome, manager, orchestration, dependencies } = await fixture();
  const result = await manager.bindOrchestrationNode(
    'job-1',
    { nodeId: 'worker', expectedGraphId: 'graph-1', expectedControlEpoch: 1 },
    dependencies,
  );
  assert.equal(result.binding.jobId, 'job-1');
  assert.equal(result.binding.projectId, 'project-1');
  assert.equal(result.binding.orchestraId, 'orch-1');
  assert.equal(result.binding.graphId, 'graph-1');
  assert.equal(result.binding.controlEpoch, 1);
  assert.equal(result.binding.nodeId, 'worker');

  const restarted = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => 3000,
  });
  const inspected = await restarted.inspectOrchestrationNodeBinding(
    'job-1',
    { resolveProjectHierarchyAuthority: projectId => orchestration.resolveProjectHierarchyAuthority(projectId) },
  );
  assert.equal(inspected.status, 'CURRENT');
  assert.equal(inspected.current, true);
  assert.equal(inspected.binding.nodeId, 'worker');
  assert.deepEqual(
    Object.keys(chrome.data).filter(key => key.startsWith('autopilotBrowserAgent')),
    ['autopilotBrowserAgentV1'],
    'orchestration binding must not create a second Browser Agent storage authority',
  );
});

test('definition-launched Browser Agents use the same durable orchestration binding seam', async () => {
  const { manager, dependencies } = await fixture();
  await manager.createAgentDefinitionRegistry({ registryId: 'agents:binding-project' });
  await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:binding-project',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: {
      schemaVersion: 1,
      agentDefinitionId: 'agent.bound',
      label: 'Bound Agent',
      description: '',
      instructions: 'Perform bounded delegated work.',
      capabilityIds: [],
      toolIds: [],
      tags: ['bound'],
      acceptanceCriteria: [],
      configDefaults: {},
      enabled: true,
      definitionRevision: 1,
    },
  });
  const launched = await manager.createFromAgentDefinition({
    registryId: 'agents:binding-project',
    expectedRegistryRevision: 2,
    agentDefinitionId: 'agent.bound',
    expectedDefinitionRevision: 1,
    jobId: 'job.definition-bound',
    goal: 'Work under the canonical hierarchy.',
    projectId: 'project-1',
    ownerBudget: {
      maxSteps: 100,
      maxModelCalls: 10,
      maxInputTokens: 10000,
      maxOutputTokens: 5000,
      maxTotalTokens: 15000,
      maxOutputTokensPerCall: 1000,
      maxRuntimeMinutes: 30,
      maxCostUsd: 1,
      inputPricePerMillionUsd: 1,
      outputPricePerMillionUsd: 1,
    },
    ownerCapabilityIds: [],
    ownerToolIds: [],
    requestedCapabilityIds: [],
    requestedToolIds: [],
  });
  assert.equal(launched.job.orchestrationNodeBinding, null);

  const bound = await manager.bindOrchestrationNode(
    'job.definition-bound',
    { nodeId: 'worker', expectedGraphId: 'graph-1', expectedControlEpoch: 1 },
    dependencies,
  );
  assert.equal(bound.binding.jobId, 'job.definition-bound');
  assert.equal((await manager.get('job.definition-bound')).job.definitionSelection.agentDefinitionId, 'agent.bound');
  assert.equal(
    (await manager.inspectOrchestrationNodeBinding('job.definition-bound', dependencies)).status,
    'CURRENT',
  );
});

test('same canonical binding is idempotent and preserves original boundAt', async () => {
  const { manager, dependencies, advance } = await fixture();
  const first = await manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies);
  advance(500);
  const second = await manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies);
  assert.deepEqual(second.binding, first.binding);
});

test('binding fails closed on missing node and stale graph provenance fences', async () => {
  const { manager, dependencies } = await fixture();
  await assert.rejects(
    () => manager.bindOrchestrationNode('job-1', { nodeId: 'missing' }, dependencies),
    /not present in canonical hierarchy/,
  );
  await assert.rejects(
    () => manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker', expectedGraphId: 'graph-old' },
      dependencies,
    ),
    /graph changed/,
  );
  await assert.rejects(
    () => manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker', expectedControlEpoch: 2 },
      dependencies,
    ),
    /control epoch changed/,
  );
});

test('binding request and trusted resolver dependency boundaries are exact-shape and zero-getter', async () => {
  const { manager, dependencies } = await fixture();
  let requestReads = 0;
  const hostileRequest = {};
  Object.defineProperty(hostileRequest, 'nodeId', {
    enumerable: true,
    get() {
      requestReads += 1;
      return 'worker';
    },
  });
  await assert.rejects(
    () => manager.bindOrchestrationNode('job-1', hostileRequest, dependencies),
    /enumerable own data property/,
  );
  assert.equal(requestReads, 0);

  let dependencyReads = 0;
  const hostileDependencies = {};
  Object.defineProperty(hostileDependencies, 'resolveProjectHierarchyAuthority', {
    enumerable: true,
    get() {
      dependencyReads += 1;
      return dependencies.resolveProjectHierarchyAuthority;
    },
  });
  await assert.rejects(
    () => manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, hostileDependencies),
    /enumerable data property/,
  );
  assert.equal(dependencyReads, 0);

  await assert.rejects(
    () => manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker', unexpectedAuthority: true },
      dependencies,
    ),
    /unknown field/,
  );
});

test('current binding exposes control-epoch, graph and node drift without silent rebinding', async () => {
  const { manager, orchestration, dependencies } = await fixture();
  const original = await manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies);

  await orchestration.controllerFor('orch-1').configureHierarchy(
    hierarchy({ controlEpoch: 2 }),
    { nowMs: 3000 },
  );
  let inspected = await manager.inspectOrchestrationNodeBinding('job-1', dependencies);
  assert.equal(inspected.status, 'CONTROL_EPOCH_DRIFTED');
  assert.equal(inspected.current, false);
  assert.deepEqual(inspected.binding, original.binding);

  await orchestration.controllerFor('orch-1').configureHierarchy(
    hierarchy({ graphId: 'graph-2', controlEpoch: 2 }),
    { nowMs: 4000 },
  );
  inspected = await manager.inspectOrchestrationNodeBinding('job-1', dependencies);
  assert.equal(inspected.status, 'GRAPH_DRIFTED');

  await orchestration.controllerFor('orch-1').configureHierarchy(
    hierarchy({ graphId: 'graph-1', controlEpoch: 1, includeWorker: false }),
    { nowMs: 5000 },
  );
  inspected = await manager.inspectOrchestrationNodeBinding('job-1', dependencies);
  assert.equal(inspected.status, 'NODE_MISSING');
});

test('Project authority resolver fails closed on missing hierarchy and duplicate durable project ownership', async () => {
  const { chrome, orchestration } = await fixture();
  await orchestration.controllerFor('orch-1').clearHierarchy({ nowMs: 2000 });
  await assert.rejects(
    () => orchestration.resolveProjectHierarchyAuthority('project-1'),
    /no durable orchestration hierarchy/,
  );

  const second = new OrchestrationV2Manager({
    coreRepository: new StorageRepository(chrome),
    chromeApi: chrome,
    createId: () => 'orch-2',
    now: () => 3000,
  });
  await second.create({ name: 'Second', config: orchestraConfig('project-2') });
  const duplicateKey = 'autopilotOrchestrationV2Config:orch-2';
  chrome.data[duplicateKey] = { ...chrome.data[duplicateKey], projectId: 'project-1' };
  await assert.rejects(
    () => second.resolveProjectHierarchyAuthority('project-1'),
    /not uniquely owned/,
  );
});
