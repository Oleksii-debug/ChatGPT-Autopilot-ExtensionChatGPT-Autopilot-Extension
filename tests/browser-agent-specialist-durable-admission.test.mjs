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
  assert.equal(first.executionOwnership.state, 'UNOWNED');

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
