import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { StorageRepository } from '../src/core/storage.js';
import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { OrchestrationV2Manager } from '../src/core/orchestration-v2-manager.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';
import {
  createBrowserAgentOrchestrationNodeBindingV1,
  createOrchestrationProjectAuthorityV1,
  inspectBrowserAgentOrchestrationNodeBindingV1,
} from '../src/core/browser-agent-orchestration-binding.js';

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

test('same canonical binding is idempotent and preserves original boundAt', async () => {
  const { manager, dependencies, advance } = await fixture();
  const first = await manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies);
  const before = await manager.get('job-1');
  advance(500);
  const second = await manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies);
  const after = await manager.get('job-1');
  assert.deepEqual(second.binding, first.binding);
  assert.equal(after.job.updatedAt, before.job.updatedAt, 'idempotent bind must not mutate durable job state');
});

test('binding preserves legal manual Browser Agent job IDs with internal spaces', async () => {
  const { manager, dependencies } = await fixture();
  await manager.create({
    id: 'manual job 2',
    projectId: 'project-1',
    name: 'Manual spaced identity',
    goal: 'Verify compatibility with existing Browser Agent identity semantics.',
  });
  const bound = await manager.bindOrchestrationNode(
    'manual job 2',
    { nodeId: 'worker', expectedGraphId: 'graph-1', expectedControlEpoch: 1 },
    dependencies,
  );
  assert.equal(bound.binding.jobId, 'manual job 2');
  assert.equal((await manager.inspectOrchestrationNodeBinding('manual job 2', dependencies)).status, 'CURRENT');
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

test('Browser Agent binding rejects cross-Project authority even from the trusted resolver seam', async () => {
  const { manager, orchestration } = await fixture();
  const live = await orchestration.resolveProjectHierarchyAuthority('project-1');
  const wrongProjectAuthority = createOrchestrationProjectAuthorityV1({
    orchestraId: live.orchestraId,
    projectId: 'project-2',
    graph: live.graph,
    subagentPolicy: live.subagentPolicy,
  });
  await assert.rejects(
    () => manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker' },
      { resolveProjectHierarchyAuthority: async () => wrongProjectAuthority },
    ),
    /does not match Browser Agent project/,
  );
  assert.equal((await manager.get('job-1')).job.orchestrationNodeBinding, null);
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

test('binding rejects Project ownership drift between canonical authority reads before persistence', async () => {
  const { manager, orchestration } = await fixture();
  let authorityReads = 0;
  const dependencies = {
    resolveProjectHierarchyAuthority: async projectId => {
      authorityReads += 1;
      if (authorityReads === 2) {
        const status = await orchestration.getStatus('orch-1');
        await orchestration.updateConfig({ ...status.config, projectId: 'project-2' }, 'orch-1');
      }
      return orchestration.resolveProjectHierarchyAuthority(projectId);
    },
  };

  await assert.rejects(
    () => manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies),
    /No canonical orchestra owns this Project ID/,
  );
  assert.equal(authorityReads, 2);
  assert.equal((await manager.get('job-1')).job.orchestrationNodeBinding, null);
});

test('binding compensates a Project authority change in the final storage commit window', async () => {
  const { manager, orchestration } = await fixture();
  const before = await manager.get('job-1');
  let authorityReads = 0;
  const dependencies = {
    resolveProjectHierarchyAuthority: async projectId => {
      authorityReads += 1;
      if (authorityReads === 3) {
        const status = await orchestration.getStatus('orch-1');
        await orchestration.updateConfig({ ...status.config, projectId: 'project-2' }, 'orch-1');
      }
      return orchestration.resolveProjectHierarchyAuthority(projectId);
    },
  };

  await assert.rejects(
    () => manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies),
    /Canonical orchestration authority changed during Browser Agent binding/,
  );
  assert.equal(authorityReads, 3);
  const after = await manager.get('job-1');
  assert.equal(after.job.orchestrationNodeBinding, null);
  assert.equal(after.job.updatedAt, before.job.updatedAt, 'compensating rollback restores the pre-bind timestamp when untouched');
});

test('binding inspection returns structured Project drift after durable owner reassignment', async () => {
  const { manager, orchestration, dependencies } = await fixture();
  const bound = await manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies);
  const status = await orchestration.getStatus('orch-1');
  await orchestration.updateConfig({ ...status.config, projectId: 'project-2' }, 'orch-1');

  const inspected = await manager.inspectOrchestrationNodeBinding('job-1', dependencies);
  assert.equal(inspected.status, 'PROJECT_AUTHORITY_DRIFTED');
  assert.equal(inspected.current, false);
  assert.equal(inspected.currentAuthority, null);
  assert.equal(inspected.authorityErrorCode, 'PROJECT_UNOWNED');
  assert.deepEqual(inspected.binding, bound.binding);
});

test('binding inspection returns structured graph drift when the durable hierarchy disappears', async () => {
  const { manager, orchestration, dependencies } = await fixture();
  const bound = await manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies);
  await orchestration.controllerFor('orch-1').clearHierarchy({ nowMs: 3000 });

  const inspected = await manager.inspectOrchestrationNodeBinding('job-1', dependencies);
  assert.equal(inspected.status, 'GRAPH_DRIFTED');
  assert.equal(inspected.current, false);
  assert.equal(inspected.currentAuthority, null);
  assert.equal(inspected.authorityErrorCode, 'HIERARCHY_UNAVAILABLE');
  assert.deepEqual(inspected.binding, bound.binding);
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


test('exported binding helpers reject hostile outer records before invoking accessors', () => {
  const policy = {
    schemaVersion: 1,
    allowAgentCreatedChildren: false,
    maxDepth: 0,
    maxChildrenPerAgent: 0,
  };
  let authorityReads = 0;
  const hostileAuthorityCreate = {
    orchestraId: 'orch-1',
    projectId: 'project-1',
    subagentPolicy: policy,
  };
  Object.defineProperty(hostileAuthorityCreate, 'graph', {
    enumerable: true,
    get() {
      authorityReads += 1;
      return hierarchy();
    },
  });
  assert.throws(
    () => createOrchestrationProjectAuthorityV1(hostileAuthorityCreate),
    /enumerable own data property/,
  );
  assert.equal(authorityReads, 0);

  const authority = createOrchestrationProjectAuthorityV1({
    orchestraId: 'orch-1',
    projectId: 'project-1',
    graph: hierarchy(),
    subagentPolicy: policy,
  });

  let bindingReads = 0;
  const hostileBindingCreate = {
    jobId: 'job-1',
    projectId: 'project-1',
    boundAt: 1000,
    request: { nodeId: 'worker' },
  };
  Object.defineProperty(hostileBindingCreate, 'authority', {
    enumerable: true,
    get() {
      bindingReads += 1;
      return authority;
    },
  });
  assert.throws(
    () => createBrowserAgentOrchestrationNodeBindingV1(hostileBindingCreate),
    /enumerable own data property/,
  );
  assert.equal(bindingReads, 0);

  const binding = createBrowserAgentOrchestrationNodeBindingV1({
    jobId: 'job-1',
    projectId: 'project-1',
    boundAt: 1000,
    authority,
    request: { nodeId: 'worker' },
  });
  let inspectionReads = 0;
  const hostileInspection = { authority };
  Object.defineProperty(hostileInspection, 'binding', {
    enumerable: true,
    get() {
      inspectionReads += 1;
      return binding;
    },
  });
  assert.throws(
    () => inspectBrowserAgentOrchestrationNodeBindingV1(hostileInspection),
    /enumerable own data property/,
  );
  assert.equal(inspectionReads, 0);

  assert.throws(
    () => inspectBrowserAgentOrchestrationNodeBindingV1({
      binding,
      authority,
      executionAuthorized: true,
    }),
    /unknown field/,
  );
});

test('definition-launched Browser Agent keeps definition provenance when bound to canonical hierarchy', async () => {
  const { manager, dependencies } = await fixture();
  await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: {
      schemaVersion: 1,
      agentDefinitionId: 'agent.bound',
      label: 'Bound reusable agent',
      description: 'Reusable bounded project specialist',
      instructions: 'Work only within the persisted project authority.',
      capabilityIds: ['browser', 'research'],
      toolIds: ['browser.read', 'files.read'],
      tags: ['bounded'],
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
      enabled: true,
      definitionRevision: 1,
    },
  });
  const launched = await manager.createFromAgentDefinition({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    agentDefinitionId: 'agent.bound',
    expectedDefinitionRevision: 1,
    jobId: 'job.definition-bound',
    goal: 'Perform bounded project work.',
    projectId: 'project-1',
    ownerBudget: {
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
    },
    ownerCapabilityIds: ['browser', 'research'],
    ownerToolIds: ['browser.read', 'files.read'],
    requestedCapabilityIds: ['research'],
    requestedToolIds: ['browser.read'],
  });
  assert.equal(launched.job.definitionSelection.agentDefinitionId, 'agent.bound');
  assert.equal(launched.job.orchestrationNodeBinding, null);

  await manager.bindOrchestrationNode(
    'job.definition-bound',
    { nodeId: 'worker', expectedGraphId: 'graph-1', expectedControlEpoch: 1 },
    dependencies,
  );
  const persisted = await manager.get('job.definition-bound');
  assert.equal(persisted.job.definitionSelection.registryRevision, 2);
  assert.equal(persisted.job.definitionSelection.definitionRevision, 1);
  assert.deepEqual(persisted.job.definitionScope, {
    capabilityIds: ['research'],
    toolIds: ['browser.read'],
  });
  assert.equal(persisted.job.orchestrationNodeBinding.nodeId, 'worker');
  assert.equal(persisted.job.orchestrationNodeBinding.projectId, 'project-1');
});

test('Project authority resolver rejects structurally corrupt durable hierarchy runtime', async () => {
  const { chrome, orchestration } = await fixture();
  const key = 'autopilotOrchestrationV2Runtime:orch-1';
  chrome.data[key].hierarchy.state.nodeOrder = ['root'];
  await assert.rejects(
    () => orchestration.resolveProjectHierarchyAuthority('project-1'),
    /Canonical orchestration hierarchy runtime is invalid/,
  );
});

test('service worker exposes one explicit read path and one explicit bind path through existing managers', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /'GET_BROWSER_AGENT_ORCHESTRATION_BINDING'/u);
  assert.match(source, /browserAgent\.inspectOrchestrationNodeBinding\(/u);
  assert.match(source, /'BIND_BROWSER_AGENT_ORCHESTRATION_NODE'/u);
  assert.match(source, /browserAgent\.bindOrchestrationNode\(/u);
  assert.match(source, /orchestrationV2\.resolveProjectHierarchyAuthority\(projectId\)/u);
});
