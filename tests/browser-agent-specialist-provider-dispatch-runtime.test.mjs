import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';
import { SpecialistRegistryMutationKind } from '../src/core/specialist-registry.js';
import {
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
  OPENHANDS_CODING_SPECIALIST_ID,
} from '../src/core/coding-specialist-provider.js';
import {
  SpecialistProviderConfigKind,
  createSpecialistProviderConfigV1,
} from '../src/core/specialist-provider-config.js';

const NOW = Date.parse('2026-09-29T05:20:00.000Z');
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

function storage() {
  const data = Object.create(null);
  return {
    chrome: {
      storage: { local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(record) {
          for (const [key, value] of Object.entries(record)) data[key] = structuredClone(value);
        },
      } },
      alarms: { async create() {}, async clear() { return true; } },
    },
  };
}

const managerFor = chrome => new BrowserAgentManager({
  chromeApi: chrome,
  routePrompt: async () => ({ text: '{}' }),
  now: () => NOW,
});

const agentDefinition = {
  schemaVersion: 1,
  agentDefinitionId: 'agent.coding',
  label: 'Coding Agent',
  description: 'Bounded coding agent',
  instructions: 'Execute bounded coding work.',
  capabilityIds: ['code.write'],
  toolIds: ['filesystem.write'],
  tags: ['coding'],
  acceptanceCriteria: [],
  configDefaults: {},
  modelRoutePolicy: null,
  specialistDelegationProfile: {
    schemaVersion: 1,
    registryId: 'specialists:code',
    requiredCapabilityIds: ['code.write'],
    requiredToolIds: ['filesystem.write'],
    policyEnvelopeId: 'policy:code',
    deadlineSeconds: 900,
    maxConcurrentHandoffs: 1,
    leaseSeconds: 600,
    priority: 10,
    enabled: true,
  },
  enabled: true,
  definitionRevision: 1,
};

const specialistDefinition = {
  schemaVersion: 1,
  specialistId: OPENHANDS_CODING_SPECIALIST_ID,
  providerId: OPENHANDS_CODING_PROVIDER_ID,
  label: 'OpenHands coding',
  description: 'Qualified local coding specialist',
  executionPlane: 'LOCAL',
  capabilityIds: ['code.write'],
  toolIds: ['filesystem.write'],
  resultContractId: 'result.code',
  enabled: true,
  definitionRevision: 1,
};

function providerConfig() {
  return createSpecialistProviderConfigV1({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision: 1,
    updatedAt: '2026-09-29T05:19:00.000Z',
    config: {
      schemaVersion: 1,
      serverUrl: 'http://127.0.0.1:3000',
      agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
      agentProfileId: '11111111-1111-4111-8111-111111111111',
      agentProfileRevision: 1,
      workspacePath: 'C:\\Autopilot\\workspace',
      qualifiedCapabilityIds: ['code.write'],
      requestTimeoutSeconds: 10,
      maxExecutionSeconds: 600,
      pollIntervalMs: 500,
      maxIterations: 30,
      maxResponseBytes: 65536,
      authMode: 'LOCAL_UNAUTHENTICATED',
    },
  });
}

async function seedClaimed(manager) {
  const agents = await manager.createAgentDefinitionRegistry({ registryId: 'agents:code' });
  const nextAgents = await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:code',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: agents.registry.bindingKey,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: agentDefinition,
  });
  await manager.createFromAgentDefinition({
    registryId: 'agents:code',
    expectedRegistryRevision: nextAgents.nextRegistryRevision,
    expectedRegistryBindingKey: nextAgents.nextRegistry.bindingKey,
    agentDefinitionId: agentDefinition.agentDefinitionId,
    expectedDefinitionRevision: 1,
    jobId: 'job.code',
    goal: 'Apply the bounded code change.',
    projectId: 'project-code',
    ownerBudget: {
      maxSteps: 100, maxModelCalls: 20, maxInputTokens: 20000, maxOutputTokens: 10000,
      maxTotalTokens: 30000, maxOutputTokensPerCall: 2000, maxRuntimeMinutes: 60,
      maxCostUsd: 2, inputPricePerMillionUsd: 1, outputPricePerMillionUsd: 2,
    },
    ownerCapabilityIds: ['code.write'],
    ownerToolIds: ['filesystem.write'],
    requestedCapabilityIds: ['code.write'],
    requestedToolIds: ['filesystem.write'],
  });
  const specialists = await manager.createSpecialistRegistry({ registryId: 'specialists:code' });
  await manager.mutateSpecialistRegistry({
    registryId: 'specialists:code',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: specialists.registry.bindingKey,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: specialistDefinition,
  });
  await manager.putSpecialistProviderConfig({
    providerConfig: providerConfig(),
    expectedRevision: 0,
  });
  await manager.update(store => {
    const job = store.byId['job.code'];
    job.runtime.runState = 'RUNNING';
    job.runtime.plan = {
      schemaVersion: 1,
      planId: 'plan:job.code',
      jobId: 'job.code',
      objective: 'Apply the bounded code change.',
      successCriteria: ['Independent verification passes'],
      createdAt: '2026-09-29T05:18:00.000Z',
      updatedAt: '2026-09-29T05:18:00.000Z',
      revision: 1,
      nodes: [{
        nodeId: 'local:code',
        title: 'Coding specialist',
        objective: 'Apply one bounded code change.',
        dependsOn: [],
        conflictKeys: ['artifact:code'],
        ownerId: 'agent:root',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Independent verification passes'],
        budget: { maxModelCalls: 0, maxRuntimeSeconds: 300, maxCostUsdMicros: 0 },
        state: 'READY',
        evidence: '',
        updatedAt: '2026-09-29T05:18:00.000Z',
      }],
    };
    return store;
  });

  const prepared = await manager.cycleOne('job.code');
  assert.equal(prepared.kind, 'SPECIALIST_PENDING');
  assert.equal(prepared.handoff.specialistId, OPENHANDS_CODING_SPECIALIST_ID);

  const claimed = await manager.claimSpecialistHandoffs('job.code', {
    availableSlots: 1,
    maxChildrenPerAgent: 1,
    maxDepth: 2,
    leaseSeconds: 600,
    at: '2026-09-29T05:20:00.000Z',
  });
  assert.deepEqual(claimed.claimed, [prepared.handoff.agentId]);
  const assignment = claimed.assignments.find(item => item.agentId === prepared.handoff.agentId);
  assert.equal(assignment.state, 'LEASED');
  return assignment;
}

test('claimed OpenHands dispatch preparation is exact, non-effectful, and restart durable', async () => {
  const { chrome } = storage();
  const manager = managerFor(chrome);
  const assignment = await seedClaimed(manager);

  const first = await manager.prepareClaimedSpecialistProviderDispatch('job.code', {
    agentId: assignment.agentId,
    leaseId: assignment.leaseId,
    conversationId: CONVERSATION_ID,
    expectedProviderRevision: 1,
  });

  assert.equal(first.agentId, assignment.agentId);
  assert.equal(first.leaseId, assignment.leaseId);
  assert.equal(first.providerConfigRevision, 1);
  assert.equal(first.prepared.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(first.prepared.specialistId, OPENHANDS_CODING_SPECIALIST_ID);
  assert.equal(first.prepared.conversationId, CONVERSATION_ID);
  assert.equal(first.prepared.requestBody.conversation_id, CONVERSATION_ID);
  assert.equal(first.prepared.requestBody.workspace.working_dir, 'C:\\Autopilot\\workspace');
  assert.equal(first.authority.dispatchAuthorized, false);
  assert.equal(first.authority.completionAuthorized, false);
  assert.equal(first.authority.verificationAuthorized, false);
  assert.equal(first.authority.requiresPersistBeforeDispatch, true);

  const restarted = managerFor(chrome);
  const afterRestart = await restarted.prepareClaimedSpecialistProviderDispatch('job.code', {
    agentId: assignment.agentId,
    leaseId: assignment.leaseId,
    conversationId: CONVERSATION_ID,
    expectedProviderRevision: 1,
  });
  assert.deepEqual(afterRestart, first);
});

test('provider dispatch preparation rejects pre-claim, stale lease and provider revision drift', async () => {
  const { chrome } = storage();
  const manager = managerFor(chrome);
  const assignment = await seedClaimed(manager);

  await assert.rejects(
    () => manager.prepareClaimedSpecialistProviderDispatch('job.code', {
      agentId: assignment.agentId,
      leaseId: 'lease:wrong',
      conversationId: CONVERSATION_ID,
      expectedProviderRevision: 1,
    }),
    /current leased assignment/,
  );

  await assert.rejects(
    () => manager.prepareClaimedSpecialistProviderDispatch('job.code', {
      agentId: assignment.agentId,
      leaseId: assignment.leaseId,
      conversationId: CONVERSATION_ID,
      expectedProviderRevision: 2,
    }),
    /revision drifted/,
  );

  const state = await manager.listSpecialistHandoffs('job.code');
  assert.equal(state.providerAdmissionProvenance.length, 1);
  assert.equal(state.providerAdmissionProvenance[0].selection.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(state.providerAdmissionProvenance[0].handoff.specialistId, OPENHANDS_CODING_SPECIALIST_ID);
});
