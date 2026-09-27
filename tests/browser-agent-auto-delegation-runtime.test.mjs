import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { StorageRepository } from '../src/core/storage.js';
import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { OrchestrationV2Manager } from '../src/core/orchestration-v2-manager.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';
import { SpecialistRegistryMutationKind } from '../src/core/specialist-registry.js';
import { ExecutionOwnershipState } from '../src/core/execution-plane-ownership.js';

const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T11:00:00.000Z';

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

function orchestraConfig(projectId = 'project-1') {
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

function hierarchy({ graphId = 'graph-1', controlEpoch = 1 } = {}) {
  return {
    schemaVersion: 1,
    graphId,
    controlEpoch,
    promptProfiles: [
      { id: 'root-v1', role: 'GLOBAL_DIRECTOR', version: 1, prompt: 'WORK' },
    ],
    nodes: [
      {
        id: 'root',
        parentId: null,
        childIds: ['worker'],
        promptProfileId: 'root-v1',
        chatMode: 'PERSISTENT_CHAT',
      },
      {
        id: 'worker',
        parentId: 'root',
        childIds: [],
        promptProfileId: 'root-v1',
        chatMode: 'PERSISTENT_CHAT',
      },
    ],
  };
}

function agentDefinition() {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.analysis',
    label: 'Analysis Agent',
    description: 'Bounded project analysis.',
    instructions: 'Analyze only within the durable owner scope.',
    capabilityIds: ['data.analyze', 'data.read', 'filesystem.write'],
    toolIds: ['artifact.write', 'data.query', 'shell.run'],
    tags: ['analysis'],
    acceptanceCriteria: [],
    configDefaults: {},
    enabled: true,
    definitionRevision: 1,
  };
}

function ownerBudget() {
  return {
    maxSteps: 100,
    maxModelCalls: 20,
    maxInputTokens: 20000,
    maxOutputTokens: 10000,
    maxTotalTokens: 30000,
    maxOutputTokensPerCall: 2000,
    maxRuntimeMinutes: 60,
    maxCostUsd: 2,
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
  };
}

function specialist(specialistId, capabilities, tools, overrides = {}) {
  return {
    schemaVersion: 1,
    specialistId,
    providerId: `provider:${specialistId}`,
    label: specialistId,
    description: '',
    executionPlane: 'LOCAL',
    capabilityIds: capabilities,
    toolIds: tools,
    resultContractId: 'result:analysis',
    enabled: true,
    definitionRevision: 1,
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'plan:auto-runtime',
    jobId: 'job.auto',
    objective: 'Complete bounded delegated analysis.',
    successCriteria: ['Verified analysis exists'],
    createdAt: T0,
    updatedAt: T0,
    revision: 7,
    nodes: [{
      nodeId: 'local-analysis',
      title: 'Analyze data',
      objective: 'Analyze the bounded local dataset and return an artifact.',
      dependsOn: [],
      conflictKeys: ['artifact:analysis'],
      ownerId: 'agent-root',
      executionPlane: 'LOCAL',
      acceptanceCriteria: ['Artifact is independently verified'],
      budget: {
        maxModelCalls: 6,
        maxRuntimeSeconds: 1200,
        maxCostUsdMicros: 900000,
      },
      state: 'READY',
      evidence: '',
      updatedAt: T0,
    }],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 4,
    expectedPlanRevision: 7,
    nodeId: 'local-analysis',
    requiredCapabilityIds: ['data.read', 'data.analyze'],
    requiredToolIds: ['data.query', 'artifact.write'],
    policyEnvelopeId: 'policy:job.auto',
    deadlineAt: T1,
    priority: 5,
    ...overrides,
  };
}

async function fixture({ allowAgentCreatedChildren = true, maxDepth = 2, maxChildrenPerAgent = 2 } = {}) {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  const orchestration = new OrchestrationV2Manager({
    coreRepository: core,
    chromeApi: chrome,
    createId: () => 'orch-1',
    now: () => Date.parse(T0),
  });
  await orchestration.create({ name: 'Project orchestra', config: orchestraConfig() });
  await orchestration.controllerFor('orch-1').configureHierarchy(hierarchy(), { nowMs: Date.parse(T0) });
  chrome.data.autopilotOrchestrationV2Manager.byId['orch-1'].subagentPolicy = {
    schemaVersion: 1,
    allowAgentCreatedChildren,
    maxDepth,
    maxChildrenPerAgent,
  };

  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T0),
  });
  await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: agentDefinition(),
  });
  await manager.createFromAgentDefinition({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    agentDefinitionId: 'agent.analysis',
    expectedDefinitionRevision: 1,
    jobId: 'job.auto',
    goal: 'Produce a bounded verified analysis.',
    projectId: 'project-1',
    ownerBudget: ownerBudget(),
    ownerCapabilityIds: ['data.analyze', 'data.read', 'filesystem.write'],
    ownerToolIds: ['artifact.write', 'data.query', 'shell.run'],
    requestedCapabilityIds: ['data.analyze', 'data.read', 'filesystem.write'],
    requestedToolIds: ['artifact.write', 'data.query', 'shell.run'],
  });

  await manager.createSpecialistRegistry({ registryId: 'specialists:project-1' });
  const definitions = [
    specialist(
      'broad',
      ['data.read', 'data.analyze', 'filesystem.write'],
      ['data.query', 'artifact.write', 'shell.run'],
    ),
    specialist(
      'narrow-z',
      ['data.read', 'data.analyze'],
      ['data.query', 'artifact.write'],
    ),
    specialist(
      'narrow-a',
      ['data.read', 'data.analyze'],
      ['data.query', 'artifact.write'],
    ),
  ];
  let revision = 1;
  for (const definition of definitions) {
    await manager.mutateSpecialistRegistry({
      registryId: 'specialists:project-1',
      expectedRegistryRevision: revision,
      kind: SpecialistRegistryMutationKind.CREATE,
      definition,
    });
    revision += 1;
  }

  await manager.update(store => {
    store.byId['job.auto'].runtime.plan = plan();
    return store;
  });

  const dependencies = {
    resolveProjectHierarchyAuthority: projectId =>
      orchestration.resolveProjectHierarchyAuthority(projectId),
  };
  await manager.bindOrchestrationNode(
    'job.auto',
    { nodeId: 'worker', expectedGraphId: 'graph-1', expectedControlEpoch: 1 },
    dependencies,
  );

  return { chrome, core, orchestration, manager, dependencies };
}

test('runtime auto-delegation atomically selects least authority and persists non-executing provenance', async () => {
  const { chrome, manager, dependencies } = await fixture();
  const result = await manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);

  assert.equal(result.proposal.selection.specialistId, 'narrow-a');
  assert.equal(result.assignment.specialistId, 'narrow-a');
  assert.equal(result.executionOwnership.state, ExecutionOwnershipState.AVAILABLE);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.reused, false);
  assert.equal(result.structureAdmission.decision, 'ALLOW');
  assert.equal(result.delegationBinding.registryId, 'specialists:project-1');
  assert.equal(result.delegationBinding.registryRevision, 4);
  assert.equal(result.delegationBinding.selection.providerId, 'provider:narrow-a');
  assert.deepEqual(result.delegationBinding.selection.grantedToolIds, ['artifact.write', 'data.query']);

  const live = await manager.get('job.auto');
  assert.equal(live.job.runtime.plan.revision, 8);
  assert.equal(live.job.runtime.specialistHandoffs.length, 1);
  assert.equal(live.job.runtime.specialistExecutionOwnerships.length, 1);
  assert.equal(live.job.runtime.specialistDelegationBindings.length, 1);
  assert.deepEqual(
    Object.keys(chrome.data).filter(key => key.startsWith('autopilotBrowserAgent')),
    ['autopilotBrowserAgentV1'],
    'auto delegation must reuse the one Browser Agent storage authority',
  );
});

test('durable delegation binding and isolated child references survive restart', async () => {
  const { chrome, manager, dependencies } = await fixture();
  const artifact = {
    schemaVersion: 1,
    artifactId: 'artifact:input',
    kind: 'dataset',
    uri: 'file://workspace/input.csv',
    mediaType: 'text/csv',
    sha256: 'a'.repeat(64),
    sizeBytes: 128,
    createdAt: T0,
    producerInvocationId: 'invoke:parent',
    sensitive: false,
  };
  const credential = {
    schemaVersion: 1,
    credentialId: 'credential:data',
    brokerId: 'broker:windows',
    kind: 'token',
    scope: ['data.example'],
    expiresAt: T1,
  };
  await manager.autoPrepareSpecialistHandoff('job.auto', request({
    artifactRefs: [artifact],
    credentialRefs: [credential],
    parentInvocationId: 'invoke:parent',
  }), dependencies);

  const restarted = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T0),
  });
  const listed = await restarted.listSpecialistHandoffs('job.auto');
  assert.equal(listed.delegationBindings.length, 1);
  const binding = listed.delegationBindings[0];
  assert.deepEqual(binding.handoff.artifactRefs.map(item => item.artifactId), ['artifact:input']);
  assert.deepEqual(binding.handoff.credentialRefs.map(item => item.credentialId), ['credential:data']);
  assert.equal(binding.handoff.parentInvocationId, 'invoke:parent');
  assert.deepEqual(binding.selection.requestedCapabilityIds, ['data.analyze', 'data.read']);
  assert.deepEqual(binding.selection.grantedToolIds, ['artifact.write', 'data.query']);
});

test('repeated current auto-delegation is idempotent and does not duplicate durable effects', async () => {
  const { manager, dependencies } = await fixture();
  const first = await manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);
  const before = await manager.get('job.auto');
  const second = await manager.autoPrepareSpecialistHandoff(
    'job.auto',
    request({ expectedPlanRevision: 8 }),
    dependencies,
  );
  const after = await manager.get('job.auto');

  assert.equal(second.reused, true);
  assert.equal(second.assignment.agentId, first.assignment.agentId);
  assert.equal(after.job.runtime.plan.revision, 8);
  assert.equal(after.job.runtime.specialistHandoffs.length, 1);
  assert.equal(after.job.runtime.specialistExecutionOwnerships.length, 1);
  assert.equal(after.job.runtime.specialistDelegationBindings.length, 1);
  assert.equal(after.job.runtime.updatedAt, before.job.runtime.updatedAt);
});

test('owner structural policy denies automatic child creation before durable handoff mutation', async () => {
  const denied = await fixture({ allowAgentCreatedChildren: false, maxDepth: 2, maxChildrenPerAgent: 2 });
  await assert.rejects(
    () => denied.manager.autoPrepareSpecialistHandoff('job.auto', request(), denied.dependencies),
    /AGENT_CHILD_CREATION_DISABLED/,
  );
  assert.equal((await denied.manager.listSpecialistHandoffs('job.auto')).handoffs.length, 0);

  const exhausted = await fixture({ allowAgentCreatedChildren: true, maxDepth: 2, maxChildrenPerAgent: 0 });
  await assert.rejects(
    () => exhausted.manager.autoPrepareSpecialistHandoff('job.auto', request(), exhausted.dependencies),
    /MAX_FANOUT_EXCEEDED/,
  );
  assert.equal((await exhausted.manager.listSpecialistHandoffs('job.auto')).handoffs.length, 0);
});

test('automatic delegation rejects stale plan, registry and orchestration authority revisions', async () => {
  const { manager, orchestration, dependencies } = await fixture();
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.auto', request({ expectedPlanRevision: 6 }), dependencies),
    /AgentPlan revision drifted/,
  );
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.auto', request({ expectedRegistryRevision: 3 }), dependencies),
    /registry revision drifted/,
  );

  await orchestration.controllerFor('orch-1').configureHierarchy(
    hierarchy({ controlEpoch: 2 }),
    { nowMs: Date.parse(T0) + 1 },
  );
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies),
    /CONTROL_EPOCH_DRIFTED/,
  );
  assert.equal((await manager.listSpecialistHandoffs('job.auto')).handoffs.length, 0);
});

test('current registry mutation invalidates persisted auto-delegation provenance instead of silently reusing it', async () => {
  const { manager, dependencies } = await fixture();
  await manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);
  await manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 4,
    kind: SpecialistRegistryMutationKind.UPDATE,
    specialistId: 'narrow-a',
    expectedDefinitionRevision: 1,
    definition: specialist(
      'narrow-a',
      ['data.read', 'data.analyze'],
      ['data.query', 'artifact.write'],
      { label: 'narrow-a-v2', definitionRevision: 2 },
    ),
  });

  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff(
      'job.auto',
      request({ expectedRegistryRevision: 5, expectedPlanRevision: 8 }),
      dependencies,
    ),
    /registry identity or revision drifted/,
  );
  const listed = await manager.listSpecialistHandoffs('job.auto');
  assert.equal(listed.handoffs.length, 1);
  assert.equal(listed.delegationBindings[0].registryRevision, 4);
});

test('child resource budget is narrowed to the exact live AgentPlan node envelope', async () => {
  const { manager, dependencies } = await fixture();
  const result = await manager.autoPrepareSpecialistHandoff('job.auto', request({
    childBudget: {
      maxModelCalls: 100,
      maxRuntimeSeconds: 3600,
      maxCostUsdMicros: 5000000,
    },
  }), dependencies);
  assert.deepEqual(result.proposal.childBudget, {
    maxModelCalls: 6,
    maxRuntimeSeconds: 1200,
    maxCostUsdMicros: 900000,
    narrowed: true,
  });
  assert.equal(result.delegationBinding.handoff.maxModelCalls, 6);
  assert.equal(result.delegationBinding.handoff.maxRuntimeSeconds, 1200);
  assert.equal(result.delegationBinding.handoff.maxCostUsdMicros, 900000);
});

test('manual jobs without durable Agent-definition authority cannot mint parent specialist scope', async () => {
  const { manager, dependencies } = await fixture();
  await manager.create({
    id: 'job.manual',
    projectId: 'project-1',
    name: 'Manual',
    goal: 'Manual job.',
  });
  await manager.update(store => {
    store.byId['job.manual'].runtime.plan = {
      ...plan(),
      jobId: 'job.manual',
      planId: 'plan:manual',
    };
    return store;
  });
  await manager.bindOrchestrationNode('job.manual', { nodeId: 'worker' }, dependencies);
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.manual', {
      ...request(),
      expectedPlanRevision: 7,
    }, dependencies),
    /requires a durable Agent definition capability\/tool scope/,
  );
});

test('automatic runtime boundary rejects unknown fields and accessors without invoking getters', async () => {
  const { manager, dependencies } = await fixture();
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff(
      'job.auto',
      { ...request(), executionAuthorized: true },
      dependencies,
    ),
    /unknown field/,
  );

  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'nodeId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'local-analysis';
    },
  });
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.auto', hostile, dependencies),
    /enumerable data property/,
  );
  assert.equal(reads, 0);
});

test('nested automatic-delegation intent is snapshotted before serialized enqueue', async () => {
  const { manager, dependencies } = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const blocker = manager.update(async store => {
    await gate;
    return store;
  });

  const mutable = request();
  mutable.requiredCapabilityIds = ['data.read', 'data.analyze'];
  mutable.requiredToolIds = ['data.query', 'artifact.write'];
  const pending = manager.autoPrepareSpecialistHandoff('job.auto', mutable, dependencies);

  mutable.requiredCapabilityIds[0] = 'filesystem.write';
  mutable.requiredToolIds[0] = 'shell.run';
  mutable.priority = 999;
  release();
  await blocker;
  const result = await pending;

  assert.equal(result.proposal.selection.specialistId, 'narrow-a');
  assert.deepEqual(result.proposal.selection.requestedCapabilityIds, ['data.analyze', 'data.read']);
  assert.deepEqual(result.proposal.selection.grantedToolIds, ['artifact.write', 'data.query']);
  assert.equal(result.assignment.priority, 5);
});

test('automatic delegation rejects non-canonical timestamps before durable admission', async () => {
  const { manager, dependencies } = await fixture();
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff(
      'job.auto',
      request({ deadlineAt: '2026-09-27T11:00:00Z' }),
      dependencies,
    ),
    /canonical ISO-8601 UTC/,
  );
  assert.equal((await manager.listSpecialistHandoffs('job.auto')).handoffs.length, 0);
});

test('serialized registry mutation wins before queued auto-delegation and stale CAS cannot bypass it', async () => {
  const { manager, dependencies } = await fixture();
  const mutation = manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 4,
    kind: SpecialistRegistryMutationKind.UPDATE,
    specialistId: 'narrow-a',
    expectedDefinitionRevision: 1,
    definition: specialist(
      'narrow-a',
      ['data.read', 'data.analyze'],
      ['data.query', 'artifact.write'],
      { label: 'narrow-a-v2', definitionRevision: 2 },
    ),
  });
  const delegation = manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);
  await mutation;
  await assert.rejects(() => delegation, /registry revision drifted/);
  assert.equal((await manager.listSpecialistHandoffs('job.auto')).handoffs.length, 0);
});

test('service worker routes automatic preparation through BrowserAgentManager and canonical OrchestrationV2 resolver', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /'AUTO_PREPARE_BROWSER_AGENT_SPECIALIST_HANDOFF'/);
  assert.match(source, /browserAgent\.autoPrepareSpecialistHandoff\(/);
  assert.match(source, /orchestrationV2\.resolveProjectHierarchyAuthority\(projectId\)/);
  assert.equal(
    (source.match(/autopilotBrowserAgentV1/g) || []).length,
    0,
    'service worker must not own a second Browser Agent persistence implementation',
  );
});
