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
  const storage = chromeStorage();
  const manager = managerFor(storage.chrome);
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
  const admissions = storage.data.autopilotBrowserAgentV1.byId['job.research'].runtime.specialistDelegationAdmissions;
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].agentId, first.assignment.agentId);
  assert.equal(admissions[0].selection.specialistId, 'specialist.research.local');
  assert.equal(admissions[0].selection.providerId, 'provider.local');
  assert.equal(admissions[0].selection.registryId, 'specialists:project-1');
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

test('persisted READY assignment drift is rejected independently of matching admission provenance', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const registry = await setup(manager);
  const request = {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  };
  await manager.prepareDefinitionSpecialistDelegation('job.research', request);
  await manager.update(store => {
    store.byId['job.research'].runtime.specialistHandoffs[0].priority = 6;
    return store;
  });

  await assert.rejects(
    () => manager.prepareDefinitionSpecialistDelegation('job.research', request),
    /runtime state drifted from its canonical READY proposal/,
  );
});


test('legacy claim fails closed when owner-bound admission provenance is lost', async () => {
  const storage = chromeStorage();
  const manager = managerFor(storage.chrome);
  const registry = await setup(manager);
  await manager.prepareDefinitionSpecialistDelegation('job.research', {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  });

  delete storage.data.autopilotBrowserAgentV1.byId['job.research'].runtime.specialistDelegationAdmissions;
  const restarted = managerFor(storage.chrome);
  await assert.rejects(
    () => restarted.claimSpecialistHandoffs('job.research', {
      availableSlots: 1,
      maxChildrenPerAgent: 1,
      maxDepth: 2,
      leaseSeconds: 600,
      at: '2026-09-29T03:06:00.000Z',
    }),
    /lacks durable admission provenance/,
  );
  const persisted = await restarted.listSpecialistHandoffs('job.research');
  assert.equal(persisted.handoffs[0].state, 'READY');
  assert.equal(persisted.executionOwnerships[0].state, 'AVAILABLE');
});

test('product-wide claim fails closed when an owner-bound handoff lost admission provenance', async () => {
  const storage = chromeStorage();
  const manager = managerFor(storage.chrome);
  const registry = await setup(manager);
  await manager.prepareDefinitionSpecialistDelegation('job.research', {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  });

  delete storage.data.autopilotBrowserAgentV1.byId['job.research'].runtime.specialistDelegationAdmissions;
  const restarted = managerFor(storage.chrome);
  await assert.rejects(
    () => restarted.claimSpecialistHandoffsAcrossJobs({
      maxConcurrentHandoffs: 4,
      maxChildrenPerAgent: 4,
      maxDepth: 2,
      leaseSeconds: 600,
      at: '2026-09-29T03:06:00.000Z',
    }),
    /lacks durable admission provenance/,
  );
});


test('owner-bound claim requires trusted executable readiness on the product dependency path', async () => {
  const storage = chromeStorage();
  const manager = managerFor(storage.chrome);
  const registry = await setup(manager);
  await manager.prepareDefinitionSpecialistDelegation('job.research', {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  });

  const claim = {
    availableSlots: 1,
    maxChildrenPerAgent: 1,
    maxDepth: 2,
    leaseSeconds: 600,
    at: '2026-09-29T03:06:00.000Z',
  };
  const readiness = executable => ({
    async resolve(selection) {
      return {
        registryId: selection.registryId,
        registryRevision: selection.registryRevision,
        specialistId: selection.specialistId,
        providerId: selection.providerId,
        definitionRevision: selection.definitionRevision,
        executionPlane: selection.executionPlane,
        executable,
        trustedResolverInvoked: true,
        callerReadinessAccepted: false,
        resolvedAt: new Date(Date.now()).toISOString(),
        maxAgeMs: 60_000,
      };
    },
    async assertCurrent() { return true; },
  });

  await assert.rejects(
    () => manager.claimSpecialistHandoffs('job.research', claim, {
      specialistProviderReadinessResolver: readiness(false),
    }),
    /not currently executable/,
  );
  let persisted = await manager.listSpecialistHandoffs('job.research');
  assert.equal(persisted.handoffs[0].state, 'READY');
  assert.equal(persisted.executionOwnerships[0].state, 'AVAILABLE');

  let currentChecks = 0;
  const resolver = readiness(true);
  resolver.assertCurrent = async () => { currentChecks += 1; return true; };
  const claimed = await manager.claimSpecialistHandoffs('job.research', claim, {
    specialistProviderReadinessResolver: resolver,
  });
  assert.equal(claimed.claimed.length, 1);
  assert.equal(currentChecks, 1);
  persisted = await manager.listSpecialistHandoffs('job.research');
  assert.equal(persisted.handoffs[0].state, 'LEASED');
  assert.equal(persisted.executionOwnerships[0].state, 'OWNED');
});

test('owner-bound claim fails closed when trusted readiness becomes stale before serialized claim', async () => {
  const storage = chromeStorage();
  const manager = managerFor(storage.chrome);
  const registry = await setup(manager);
  await manager.prepareDefinitionSpecialistDelegation('job.research', {
    expectedRegistryRevision: registry.nextRegistryRevision,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  });
  const resolver = {
    async resolve(selection) {
      return {
        registryId: selection.registryId,
        registryRevision: selection.registryRevision,
        specialistId: selection.specialistId,
        providerId: selection.providerId,
        definitionRevision: selection.definitionRevision,
        executionPlane: selection.executionPlane,
        executable: true,
        trustedResolverInvoked: true,
        callerReadinessAccepted: false,
        resolvedAt: new Date(Date.now()).toISOString(),
        maxAgeMs: 60_000,
      };
    },
    async assertCurrent() { throw new Error('Specialist provider config changed after readiness probe'); },
  };
  await assert.rejects(
    () => manager.claimSpecialistHandoffs('job.research', {
      availableSlots: 1,
      maxChildrenPerAgent: 1,
      maxDepth: 2,
      leaseSeconds: 600,
      at: '2026-09-29T03:06:00.000Z',
    }, { specialistProviderReadinessResolver: resolver }),
    /config changed after readiness probe/,
  );
  const persisted = await manager.listSpecialistHandoffs('job.research');
  assert.equal(persisted.handoffs[0].state, 'READY');
  assert.equal(persisted.executionOwnerships[0].state, 'AVAILABLE');
});
