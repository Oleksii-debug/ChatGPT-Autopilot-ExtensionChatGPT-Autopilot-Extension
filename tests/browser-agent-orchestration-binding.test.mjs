import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { StorageRepository } from '../src/core/storage.js';
import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { OrchestrationV2Manager } from '../src/core/orchestration-v2-manager.js';
import { exportOrchestrationProfile } from '../src/core/orchestration-v2-profile.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';
import {
  createBrowserAgentOrchestrationNodeBindingV1,
  createOrchestrationProjectAuthorityV1,
  inspectBrowserAgentOrchestrationNodeBindingV1,
  normalizeBrowserAgentOrchestrationBindingRequestV1,
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

function authorityStorageSnapshot(chrome, orchestraId = 'orch-1') {
  return structuredClone({
    config: chrome.data[`autopilotOrchestrationV2Config:${orchestraId}`],
    runtime: chrome.data[`autopilotOrchestrationV2Runtime:${orchestraId}`],
    manager: chrome.data.autopilotOrchestrationV2Manager,
  });
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
    withProjectHierarchyAuthority: (projectId, operation) =>
      orchestration.withProjectHierarchyAuthority(projectId, operation),
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

test('binding request normalizer is canonical and idempotent when optional epoch is absent', () => {
  const first = normalizeBrowserAgentOrchestrationBindingRequestV1({ nodeId: 'worker' });
  assert.deepEqual(first, {
    nodeId: 'worker',
    expectedGraphId: '',
    expectedControlEpoch: null,
  });
  const second = normalizeBrowserAgentOrchestrationBindingRequestV1(first);
  assert.deepEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
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
      {
        withProjectHierarchyAuthority: async (_projectId, operation) =>
          operation(wrongProjectAuthority),
      },
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

test('profile import keeps config, hierarchy and owner policy behind one Project authority fence', async () => {
  const { manager, orchestration, dependencies } = await fixture();
  const controller = orchestration.controllerFor('orch-1');
  const originalConfigureHierarchy = controller.configureHierarchy.bind(controller);

  let hierarchyReachedResolve;
  const hierarchyReached = new Promise(resolve => { hierarchyReachedResolve = resolve; });
  let releaseHierarchyResolve;
  const releaseHierarchy = new Promise(resolve => { releaseHierarchyResolve = resolve; });
  controller.configureHierarchy = async (...args) => {
    hierarchyReachedResolve();
    await releaseHierarchy;
    return originalConfigureHierarchy(...args);
  };

  const profile = exportOrchestrationProfile(orchestraConfig('project-1'), {
    name: 'Atomic authority import',
    hierarchy: hierarchy({ graphId: 'graph-2', controlEpoch: 2 }),
    subagentPolicy: {
      schemaVersion: 1,
      allowAgentCreatedChildren: true,
      maxDepth: 3,
      maxChildrenPerAgent: 2,
    },
  });

  try {
    const importing = orchestration.importProfile(profile);
    await hierarchyReached;

    let bindingSettled = false;
    const bindingPromise = manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker' },
      dependencies,
    ).then(result => {
      bindingSettled = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      bindingSettled,
      false,
      'Browser Agent bind must not observe a profile import between config, hierarchy and owner-policy commits',
    );

    releaseHierarchyResolve();
    const imported = await importing;
    const bound = await bindingPromise;

    assert.equal(imported.status.runtime.hierarchy.graph.graphId, 'graph-2');
    assert.deepEqual(imported.status.orchestra.subagentPolicy, {
      schemaVersion: 1,
      allowAgentCreatedChildren: true,
      maxDepth: 3,
      maxChildrenPerAgent: 2,
    });
    assert.equal(bound.binding.graphId, 'graph-2');
    assert.equal(bound.binding.controlEpoch, 2);
  } finally {
    releaseHierarchyResolve?.();
    controller.configureHierarchy = originalConfigureHierarchy;
  }
});

test('failed profile configure restores the exact authority snapshot before concurrent BIND', async () => {
  const { chrome, manager, orchestration, dependencies } = await fixture();
  const controller = orchestration.controllerFor('orch-1');
  const before = await orchestration.getStatus('orch-1');
  const beforeRaw = authorityStorageSnapshot(chrome);
  const beforeAuthority = await orchestration.resolveProjectHierarchyAuthority('project-1');
  const originalConfigureHierarchy = controller.configureHierarchy.bind(controller);

  let configureReachedResolve;
  const configureReached = new Promise(resolve => { configureReachedResolve = resolve; });
  let releaseConfigureResolve;
  const releaseConfigure = new Promise(resolve => { releaseConfigureResolve = resolve; });
  controller.configureHierarchy = async () => {
    const during = await controller.configRepository.load();
    assert.equal(during.absoluteMaxWorkers, 3, 'config mutation must precede the forced configure failure');
    configureReachedResolve();
    await releaseConfigure;
    throw new Error('forced hierarchy configure failure');
  };

  const profile = exportOrchestrationProfile(
    { ...before.config, enabled: false, absoluteMaxWorkers: 3 },
    {
      name: 'Rollback configure failure',
      hierarchy: hierarchy({ graphId: 'graph-2', controlEpoch: 2 }),
      subagentPolicy: {
        schemaVersion: 1,
        allowAgentCreatedChildren: true,
        maxDepth: 3,
        maxChildrenPerAgent: 2,
      },
    },
  );

  try {
    const importing = orchestration.importProfile(profile);
    await configureReached;

    let bindSettled = false;
    const binding = manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker' },
      dependencies,
    ).then(result => {
      bindSettled = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bindSettled, false, 'BIND must remain fenced while failed import is rolled back');

    releaseConfigureResolve();
    await assert.rejects(importing, /forced hierarchy configure failure/u);
    const bound = await binding;

    const after = await orchestration.getStatus('orch-1');
    const afterAuthority = await orchestration.resolveProjectHierarchyAuthority('project-1');
    assert.deepEqual(after.config, before.config);
    assert.deepEqual(after.runtime.hierarchy.graph, before.runtime.hierarchy.graph);
    assert.deepEqual(after.orchestra.subagentPolicy, before.orchestra.subagentPolicy);
    assert.deepEqual(authorityStorageSnapshot(chrome), beforeRaw, 'rollback must restore exact raw config/runtime/manager authority storage');
    assert.deepEqual(afterAuthority.graph, beforeAuthority.graph);
    assert.deepEqual(afterAuthority.subagentPolicy, beforeAuthority.subagentPolicy);
    assert.equal(bound.binding.graphId, 'graph-1');
    assert.equal(bound.binding.controlEpoch, 1);
  } finally {
    releaseConfigureResolve?.();
    controller.configureHierarchy = originalConfigureHierarchy;
  }
});

test('post-policy-persist profile failure restores config hierarchy and policy before concurrent BIND', async () => {
  const { chrome, manager, orchestration, dependencies } = await fixture();
  const before = await orchestration.getStatus('orch-1');
  const beforeRaw = authorityStorageSnapshot(chrome);
  const beforeAuthority = await orchestration.resolveProjectHierarchyAuthority('project-1');
  const originalUpdateMeta = orchestration.updateMeta.bind(orchestration);

  let policyPersistedResolve;
  const policyPersisted = new Promise(resolve => { policyPersistedResolve = resolve; });
  let releasePolicyResolve;
  const releasePolicy = new Promise(resolve => { releasePolicyResolve = resolve; });
  let armed = true;
  orchestration.updateMeta = mutator => originalUpdateMeta(mutator).then(async result => {
    const policy = result?.byId?.['orch-1']?.subagentPolicy;
    if (armed
        && policy?.allowAgentCreatedChildren === true
        && policy?.maxDepth === 3
        && policy?.maxChildrenPerAgent === 2) {
      armed = false;
      policyPersistedResolve();
      await releasePolicy;
      throw new Error('forced owner-policy persistence failure');
    }
    return result;
  });

  const profile = exportOrchestrationProfile(
    { ...before.config, enabled: false, absoluteMaxWorkers: 3 },
    {
      name: 'Rollback policy failure',
      hierarchy: hierarchy({ graphId: 'graph-2', controlEpoch: 2 }),
      subagentPolicy: {
        schemaVersion: 1,
        allowAgentCreatedChildren: true,
        maxDepth: 3,
        maxChildrenPerAgent: 2,
      },
    },
  );

  try {
    const importing = orchestration.importProfile(profile);
    await policyPersisted;

    const during = await orchestration.controllerFor('orch-1').runtimeRepository.load();
    assert.equal(during.hierarchy.graph.graphId, 'graph-2', 'hierarchy must have persisted before forced policy failure');

    let bindSettled = false;
    const binding = manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker' },
      dependencies,
    ).then(result => {
      bindSettled = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bindSettled, false, 'BIND must not observe imported hierarchy/policy before rollback');

    releasePolicyResolve();
    await assert.rejects(importing, /forced owner-policy persistence failure/u);
    const bound = await binding;

    const after = await orchestration.getStatus('orch-1');
    const afterAuthority = await orchestration.resolveProjectHierarchyAuthority('project-1');
    assert.deepEqual(after.config, before.config);
    assert.deepEqual(after.runtime.hierarchy.graph, before.runtime.hierarchy.graph);
    assert.deepEqual(after.orchestra.subagentPolicy, before.orchestra.subagentPolicy);
    assert.deepEqual(authorityStorageSnapshot(chrome), beforeRaw, 'rollback must restore exact raw config/runtime/manager authority storage');
    assert.deepEqual(afterAuthority.graph, beforeAuthority.graph);
    assert.deepEqual(afterAuthority.subagentPolicy, beforeAuthority.subagentPolicy);
    assert.equal(bound.binding.graphId, 'graph-1');
    assert.equal(bound.binding.controlEpoch, 1);
  } finally {
    releasePolicyResolve?.();
    orchestration.updateMeta = originalUpdateMeta;
  }
});

test('failed owner-paused project rebind defers managed-session purge until authority rollback completes', async () => {
  const { chrome, manager, orchestration, dependencies } = await fixture();
  await orchestration.updateMeta(meta => {
    meta.byId['orch-1'].ownerPaused = true;
    return meta;
  });

  const controller = orchestration.controllerFor('orch-1');
  const before = await orchestration.getStatus('orch-1');
  const beforeRaw = authorityStorageSnapshot(chrome);
  const originalConfigureHierarchy = controller.configureHierarchy.bind(controller);
  const originalCoreUpdate = orchestration.coreRepository.update.bind(orchestration.coreRepository);
  let coreUpdateCalls = 0;
  orchestration.coreRepository.update = (...args) => {
    coreUpdateCalls += 1;
    return originalCoreUpdate(...args);
  };

  let configureReachedResolve;
  const configureReached = new Promise(resolve => { configureReachedResolve = resolve; });
  let releaseConfigureResolve;
  const releaseConfigure = new Promise(resolve => { releaseConfigureResolve = resolve; });
  controller.configureHierarchy = async () => {
    const during = await controller.configRepository.load();
    assert.equal(during.projectId, 'project-2', 'project identity must have changed before forced configure failure');
    configureReachedResolve();
    await releaseConfigure;
    throw new Error('forced post-rebind configure failure');
  };

  const profile = exportOrchestrationProfile(
    { ...before.config, enabled: false, projectId: 'project-2' },
    {
      name: 'Rollback project rebind',
      hierarchy: hierarchy({ graphId: 'graph-2', controlEpoch: 2 }),
      subagentPolicy: {
        schemaVersion: 1,
        allowAgentCreatedChildren: true,
        maxDepth: 3,
        maxChildrenPerAgent: 2,
      },
    },
  );

  try {
    const importing = orchestration.importProfile(profile);
    await configureReached;
    assert.equal(
      coreUpdateCalls,
      0,
      'old-project managed Core state must not be purged before the composite authority import commits',
    );

    let bindSettled = false;
    const binding = manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker' },
      dependencies,
    ).then(result => {
      bindSettled = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bindSettled, false, 'BIND must remain fenced while project identity is transient');

    releaseConfigureResolve();
    await assert.rejects(importing, /forced post-rebind configure failure/u);
    const bound = await binding;

    const after = await orchestration.getStatus('orch-1');
    assert.equal(coreUpdateCalls, 0, 'failed project rebind must leave old managed Core state untouched');
    assert.deepEqual(authorityStorageSnapshot(chrome), beforeRaw);
    assert.deepEqual(after.config, before.config);
    assert.deepEqual(after.runtime.hierarchy.graph, before.runtime.hierarchy.graph);
    assert.deepEqual(after.orchestra.subagentPolicy, before.orchestra.subagentPolicy);
    assert.equal(bound.binding.projectId, 'project-1');
    assert.equal(bound.binding.graphId, 'graph-1');
    assert.equal(bound.binding.controlEpoch, 1);
  } finally {
    releaseConfigureResolve?.();
    controller.configureHierarchy = originalConfigureHierarchy;
    orchestration.coreRepository.update = originalCoreUpdate;
  }
});

test('successful owner-paused project rebind purges managed sessions only after config hierarchy and policy commit', async () => {
  const { orchestration } = await fixture();
  await orchestration.updateMeta(meta => {
    meta.byId['orch-1'].ownerPaused = true;
    return meta;
  });

  const before = await orchestration.getStatus('orch-1');
  const originalCoreUpdate = orchestration.coreRepository.update.bind(orchestration.coreRepository);
  let coreUpdateCalls = 0;
  let authorityAtPurge = null;
  orchestration.coreRepository.update = async (...args) => {
    coreUpdateCalls += 1;
    authorityAtPurge = await orchestration.getStatus('orch-1');
    return originalCoreUpdate(...args);
  };

  const profile = exportOrchestrationProfile(
    { ...before.config, enabled: false, projectId: 'project-2' },
    {
      name: 'Committed project rebind',
      hierarchy: hierarchy({ graphId: 'graph-2', controlEpoch: 2 }),
      subagentPolicy: {
        schemaVersion: 1,
        allowAgentCreatedChildren: true,
        maxDepth: 3,
        maxChildrenPerAgent: 2,
      },
    },
  );

  try {
    const imported = await orchestration.importProfile(profile);
    assert.equal(coreUpdateCalls, 1, 'successful project rebind must perform the deferred managed-session purge exactly once');
    assert.equal(authorityAtPurge.config.projectId, 'project-2');
    assert.equal(authorityAtPurge.runtime.hierarchy.graph.graphId, 'graph-2');
    assert.deepEqual(authorityAtPurge.orchestra.subagentPolicy, {
      schemaVersion: 1,
      allowAgentCreatedChildren: true,
      maxDepth: 3,
      maxChildrenPerAgent: 2,
    });
    assert.equal(imported.status.config.projectId, 'project-2');
    assert.equal(imported.status.runtime.hierarchy.graph.graphId, 'graph-2');
    assert.deepEqual(imported.status.orchestra.subagentPolicy, authorityAtPurge.orchestra.subagentPolicy);
  } finally {
    orchestration.coreRepository.update = originalCoreUpdate;
  }
});

test('binding holds the canonical Project authority fence through durable Browser Agent persistence', async () => {
  const { chrome, manager, orchestration, dependencies } = await fixture();
  const beforeAuthorityChange = await orchestration.getStatus('orch-1');
  const originalSet = chrome.storage.local.set.bind(chrome.storage.local);

  let persistReachedResolve;
  const persistReached = new Promise(resolve => { persistReachedResolve = resolve; });
  let releasePersistResolve;
  const releasePersist = new Promise(resolve => { releasePersistResolve = resolve; });
  let armed = true;
  chrome.storage.local.set = async record => {
    if (armed && Object.hasOwn(record, 'autopilotBrowserAgentV1')) {
      armed = false;
      persistReachedResolve();
      await releasePersist;
    }
    return originalSet(record);
  };

  try {
    const bindPromise = manager.bindOrchestrationNode(
      'job-1',
      { nodeId: 'worker', expectedGraphId: 'graph-1', expectedControlEpoch: 1 },
      dependencies,
    );
    await persistReached;

    let authorityMutationSettled = false;
    const authorityMutation = orchestration.updateConfig(
      { ...beforeAuthorityChange.config, projectId: 'project-2' },
      'orch-1',
    ).then(result => {
      authorityMutationSettled = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      authorityMutationSettled,
      false,
      'Project authority mutation must not settle inside the bind persistence window',
    );

    releasePersistResolve();
    const bound = await bindPromise;
    assert.equal(bound.binding.projectId, 'project-1');
    assert.equal(bound.binding.nodeId, 'worker');

    await authorityMutation;
    const inspected = await manager.inspectOrchestrationNodeBinding('job-1', dependencies);
    assert.equal(inspected.status, 'PROJECT_AUTHORITY_DRIFTED');
    assert.equal(inspected.current, false);
    assert.equal(inspected.authorityErrorCode, 'PROJECT_UNOWNED');
  } finally {
    releasePersistResolve?.();
    chrome.storage.local.set = originalSet;
  }
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

test('binding inspection returns structured graph drift for corrupt durable hierarchy runtime', async () => {
  const { chrome, manager, dependencies } = await fixture();
  const bound = await manager.bindOrchestrationNode('job-1', { nodeId: 'worker' }, dependencies);
  const key = 'autopilotOrchestrationV2Runtime:orch-1';
  chrome.data[key].hierarchy.state.nodeOrder = ['root'];

  const inspected = await manager.inspectOrchestrationNodeBinding('job-1', dependencies);
  assert.equal(inspected.status, 'GRAPH_DRIFTED');
  assert.equal(inspected.current, false);
  assert.equal(inspected.currentAuthority, null);
  assert.equal(inspected.authorityErrorCode, 'HIERARCHY_INCONSISTENT');
  assert.deepEqual(inspected.binding, bound.binding);
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
  assert.match(source, /orchestrationV2\.withProjectHierarchyAuthority\(projectId, operation\)/u);
  assert.match(source, /orchestrationV2\.resolveProjectHierarchyAuthority\(projectId\)/u);
});
