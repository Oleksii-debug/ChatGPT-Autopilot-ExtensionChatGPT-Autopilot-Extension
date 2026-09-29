import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';
import { SpecialistRegistryMutationKind } from '../src/core/specialist-registry.js';

function chromeStorage() {
  const data = Object.create(null);
  return {
    data,
    chrome: {
      storage: { local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(record) { for (const [key, value] of Object.entries(record)) data[key] = structuredClone(value); },
      } },
      alarms: { async create() {}, async clear() { return true; } },
    },
  };
}
const managerFor = chrome => new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });

const agentDefinition = {
  schemaVersion: 1,
  agentDefinitionId: 'agent.research',
  label: 'Research Agent',
  description: 'Bounded reusable research agent',
  instructions: 'Delegate bounded specialist research.',
  capabilityIds: ['research'],
  toolIds: ['browser.read'],
  tags: ['research'],
  acceptanceCriteria: [],
  configDefaults: {},
  modelRoutePolicy: null,
  specialistDelegationProfile: {
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    requiredCapabilityIds: ['research'],
    requiredToolIds: ['browser.read'],
    policyEnvelopeId: 'policy:research',
    deadlineSeconds: 900,
    maxConcurrentHandoffs: 2,
    leaseSeconds: 600,
    priority: 7,
    enabled: true,
  },
  enabled: true,
  definitionRevision: 1,
};

const specialistDefinition = {
  schemaVersion: 1,
  specialistId: 'specialist.research.local',
  providerId: 'provider.local',
  label: 'Local Research',
  description: 'Least-authority research specialist',
  executionPlane: 'LOCAL',
  capabilityIds: ['research'],
  toolIds: ['browser.read'],
  resultContractId: 'result.research',
  enabled: true,
  definitionRevision: 1,
};

async function setup(manager) {
  const agents = await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  const mutatedAgents = await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: agents.registry.bindingKey,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: agentDefinition,
  });
  await manager.createFromAgentDefinition({
    registryId: 'agents:project-1',
    expectedRegistryRevision: mutatedAgents.nextRegistryRevision,
    expectedRegistryBindingKey: mutatedAgents.nextRegistry.bindingKey,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    jobId: 'job.research',
    goal: 'Produce verified research.',
    projectId: 'project-1',
    ownerBudget: {
      maxSteps: 100, maxModelCalls: 20, maxInputTokens: 20000, maxOutputTokens: 10000,
      maxTotalTokens: 30000, maxOutputTokensPerCall: 2000, maxRuntimeMinutes: 60,
      maxCostUsd: 2, inputPricePerMillionUsd: 1, outputPricePerMillionUsd: 2,
    },
    ownerCapabilityIds: ['research'],
    ownerToolIds: ['browser.read'],
    requestedCapabilityIds: ['research'],
    requestedToolIds: ['browser.read'],
  });
  await manager.update(store => {
    store.byId['job.research'].runtime.plan = {
      schemaVersion: 1,
      planId: 'plan:research',
      jobId: 'job.research',
      objective: 'Produce verified research.',
      successCriteria: ['Verified result exists'],
      createdAt: '2026-09-29T03:00:00.000Z',
      updatedAt: '2026-09-29T03:00:00.000Z',
      revision: 4,
      nodes: [{
        nodeId: 'local:research',
        title: 'Specialist research',
        objective: 'Research bounded evidence.',
        dependsOn: [],
        conflictKeys: ['artifact:research'],
        ownerId: 'agent:root',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Artifact verified'],
        budget: { maxModelCalls: 5, maxRuntimeSeconds: 1200, maxCostUsdMicros: 700000 },
        state: 'READY',
        evidence: '',
        updatedAt: '2026-09-29T03:00:00.000Z',
      }],
    };
    return store;
  });
  const specialists = await manager.createSpecialistRegistry({ registryId: 'specialists:project-1' });
  return manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: specialists.registry.bindingKey,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: specialistDefinition,
  });
}

test('automatic Agent delegation consumes the canonical durable Specialist registry and persists one idempotent handoff', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const registry = await setup(manager);

  const request = {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  };
  const first = await manager.prepareDefinitionSpecialistDelegation('job.research', request);
  assert.equal(first.reused, false);
  assert.equal(first.proposal.registryId, 'specialists:project-1');
  assert.equal(first.proposal.selection.specialistId, 'specialist.research.local');
  assert.equal(first.executionOwnership.state, 'AVAILABLE');

  const second = await manager.prepareDefinitionSpecialistDelegation('job.research', request);
  assert.equal(second.reused, true);
  const persisted = await manager.listSpecialistHandoffs('job.research');
  assert.equal(persisted.handoffs.length, 1);
  assert.equal(persisted.executionOwnerships.length, 1);
});

test('caller cannot inject a Specialist registry and durable registry revision drift fails closed', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const registry = await setup(manager);

  await assert.rejects(
    () => manager.prepareDefinitionSpecialistDelegation('job.research', {
      registry: { forged: true },
      expectedRegistryRevision: registry.nextRegistryRevision,
      expectedPlanRevision: 4,
      nodeId: 'local:research',
    }),
    /unknown field/,
  );

  await assert.rejects(
    () => manager.prepareDefinitionSpecialistDelegation('job.research', {
      expectedRegistryRevision: registry.nextRegistryRevision + 1,
      expectedPlanRevision: 4,
      nodeId: 'local:research',
    }),
    /revision drifted/,
  );
  assert.equal((await manager.listSpecialistHandoffs('job.research')).handoffs.length, 0);
});


test('idempotent admission rejects changed bounded delegation proposal and preserves the original handoff', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const registry = await setup(manager);

  const base = {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
    childBudget: {
      maxModelCalls: 3,
      maxRuntimeSeconds: 300,
      maxCostUsdMicros: 250000,
    },
    parentInvocationId: 'invoke:parent-1',
  };
  const first = await manager.prepareDefinitionSpecialistDelegation('job.research', base);
  assert.equal(first.reused, false);

  await assert.rejects(
    () => manager.prepareDefinitionSpecialistDelegation('job.research', {
      ...base,
      childBudget: {
        maxModelCalls: 2,
        maxRuntimeSeconds: 300,
        maxCostUsdMicros: 250000,
      },
    }),
    /drifted from current owner-bound delegation proposal/,
  );

  await assert.rejects(
    () => manager.prepareDefinitionSpecialistDelegation('job.research', {
      ...base,
      parentInvocationId: 'invoke:parent-2',
    }),
    /drifted from current owner-bound delegation proposal/,
  );

  const persisted = await manager.listSpecialistHandoffs('job.research');
  assert.equal(persisted.handoffs.length, 1);
  assert.equal(persisted.executionOwnerships.length, 1);
  assert.deepEqual(persisted.handoffs[0], first.assignment);
  assert.deepEqual(persisted.executionOwnerships[0], first.executionOwnership);
});


test('durable specialist admission provenance survives restart and rejects missing provenance', async () => {
  const storage = chromeStorage();
  const manager = managerFor(storage.chrome);
  const registry = await setup(manager);
  const request = {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
    childBudget: { maxModelCalls: 3, maxRuntimeSeconds: 300, maxCostUsdMicros: 250000 },
    parentInvocationId: 'invoke:parent-1',
  };
  const first = await manager.prepareDefinitionSpecialistDelegation('job.research', request);
  const restarted = managerFor(storage.chrome);
  const repeated = await restarted.prepareDefinitionSpecialistDelegation('job.research', request);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.assignment.agentId, first.assignment.agentId);

  delete storage.data.autopilotBrowserAgentV1.byId['job.research'].runtime.specialistDelegationAdmissions;
  const missing = managerFor(storage.chrome);
  await assert.rejects(
    () => missing.prepareDefinitionSpecialistDelegation('job.research', request),
    /lacks canonical durable admission provenance/,
  );
});

test('owner-bound delegation profile caps legacy per-job claim lease', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const registry = await setup(manager);
  await manager.prepareDefinitionSpecialistDelegation('job.research', {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  });
  const claimed = await manager.claimSpecialistHandoffs('job.research', {
    availableSlots: 10,
    maxChildrenPerAgent: 10,
    maxDepth: 2,
    leaseSeconds: 3600,
    at: '2026-09-29T03:06:00.000Z',
  });
  assert.equal(claimed.claimed.length, 1);
  assert.equal(claimed.assignments[0].leaseExpiresAt, '2026-09-29T03:16:00.000Z');
});

test('owner-bound delegation profile caps lease inside product-wide claim authority', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const registry = await setup(manager);
  await manager.prepareDefinitionSpecialistDelegation('job.research', {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  });
  const claimed = await manager.claimSpecialistHandoffsAcrossJobs({
    maxConcurrentHandoffs: 10,
    maxChildrenPerAgent: 10,
    maxDepth: 2,
    leaseSeconds: 3600,
    at: '2026-09-29T03:06:00.000Z',
  });
  assert.equal(claimed.claimed.length, 1);
  const persisted = await manager.listSpecialistHandoffs('job.research');
  assert.equal(persisted.handoffs[0].leaseExpiresAt, '2026-09-29T03:16:00.000Z');
});


test('owner-bound maxConcurrentHandoffs caps a wider legacy claim', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const registry = await setup(manager);

  await manager.update(store => {
    const job = store.byId['job.research'];
    const first = job.runtime.plan.nodes[0];
    job.runtime.plan = {
      ...job.runtime.plan,
      nodes: [
        first,
        {
          ...first,
          nodeId: 'local:research-2',
          title: 'Specialist research 2',
          objective: 'Research bounded evidence 2.',
          conflictKeys: ['artifact:research-2'],
        },
        {
          ...first,
          nodeId: 'local:research-3',
          title: 'Specialist research 3',
          objective: 'Research bounded evidence 3.',
          conflictKeys: ['artifact:research-3'],
        },
      ],
    };
    return store;
  });

  for (const nodeId of ['local:research', 'local:research-2', 'local:research-3']) {
    await manager.prepareDefinitionSpecialistDelegation('job.research', {
      expectedRegistryRevision: registry.nextRegistryRevision,
      expectedPlanRevision: 4,
      nodeId,
      at: '2026-09-29T03:05:00.000Z',
    });
  }

  const claimed = await manager.claimSpecialistHandoffs('job.research', {
    availableSlots: 10,
    maxChildrenPerAgent: 10,
    maxDepth: 2,
    leaseSeconds: 3600,
    at: '2026-09-29T03:06:00.000Z',
  });
  assert.equal(claimed.claimed.length, 2);
  assert.equal(claimed.assignments.filter(item => item.state === 'LEASED').length, 2);
  assert.equal(claimed.assignments.filter(item => item.state === 'READY').length, 1);
});
