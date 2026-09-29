import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';
import { SpecialistRegistryMutationKind } from '../src/core/specialist-registry.js';

function chromeStorage() {
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
  now: () => Date.parse('2026-09-29T03:05:00.000Z'),
});

function definition({ delegation = true, maxConcurrentHandoffs = 2, leaseSeconds = 600 } = {}) {
  return {
    schemaVersion: 1,
    agentDefinitionId: delegation ? 'agent.research' : 'agent.manual',
    label: delegation ? 'Research Agent' : 'Manual Agent',
    description: 'Bounded reusable agent',
    instructions: 'Execute the bounded plan.',
    capabilityIds: ['research'],
    toolIds: ['browser.read'],
    tags: ['research'],
    acceptanceCriteria: [],
    configDefaults: {},
    modelRoutePolicy: null,
    ...(delegation ? {
      specialistDelegationProfile: {
        schemaVersion: 1,
        registryId: 'specialists:project-1',
        requiredCapabilityIds: ['research'],
        requiredToolIds: ['browser.read'],
        policyEnvelopeId: 'policy:research',
        deadlineSeconds: 900,
        maxConcurrentHandoffs,
        leaseSeconds,
        priority: 7,
        enabled: true,
      },
    } : {}),
    enabled: true,
    definitionRevision: 1,
  };
}

const specialist = {
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

async function seed(manager, {
  delegation = true,
  createRegistry = delegation,
  maxConcurrentHandoffs = 2,
  leaseSeconds = 600,
  twoExternalNodes = false,
} = {}) {
  const agent = definition({ delegation, maxConcurrentHandoffs, leaseSeconds });
  const agents = await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  const mutatedAgents = await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: agents.registry.bindingKey,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: agent,
  });
  await manager.createFromAgentDefinition({
    registryId: 'agents:project-1',
    expectedRegistryRevision: mutatedAgents.nextRegistryRevision,
    expectedRegistryBindingKey: mutatedAgents.nextRegistry.bindingKey,
    agentDefinitionId: agent.agentDefinitionId,
    expectedDefinitionRevision: 1,
    jobId: delegation ? 'job.research' : 'job.manual',
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

  const id = delegation ? 'job.research' : 'job.manual';
  await manager.update(store => {
    const job = store.byId[id];
    job.runtime.runState = 'RUNNING';
    job.runtime.plan = {
      schemaVersion: 1,
      planId: `plan:${id}`,
      jobId: id,
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
      }, ...(twoExternalNodes ? [{
        nodeId: 'local:research-2',
        title: 'Second specialist research',
        objective: 'Research a second bounded evidence set.',
        dependsOn: [],
        conflictKeys: ['artifact:research-2'],
        ownerId: 'agent:root',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Second artifact verified'],
        budget: { maxModelCalls: 5, maxRuntimeSeconds: 1200, maxCostUsdMicros: 700000 },
        state: 'READY',
        evidence: '',
        updatedAt: '2026-09-29T03:00:00.000Z',
      }] : [])],
    };
    return store;
  });

  if (createRegistry) {
    const registries = await manager.createSpecialistRegistry({ registryId: 'specialists:project-1' });
    await manager.mutateSpecialistRegistry({
      registryId: 'specialists:project-1',
      expectedRegistryRevision: 1,
      expectedRegistryBindingKey: registries.registry.bindingKey,
      kind: SpecialistRegistryMutationKind.CREATE,
      definition: specialist,
    });
  }
  return id;
}

test('execution loop automatically prepares a durable definition-bound Specialist handoff', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager);

  const result = await manager.cycleOne(id);
  assert.equal(result.kind, 'SPECIALIST_PENDING');
  assert.equal(result.automaticallyPrepared, true);
  assert.equal(result.reused, false);
  assert.equal(result.node.nodeId, 'local:research');
  assert.equal(result.handoff.specialistId, 'specialist.research.local');
  assert.equal(result.executionOwnership.state, 'AVAILABLE');

  const persisted = await manager.listSpecialistHandoffs(id);
  assert.equal(persisted.handoffs.length, 1);
  assert.equal(persisted.executionOwnerships.length, 1);

  const repeated = await manager.cycleOne(id);
  assert.equal(repeated.kind, 'SPECIALIST_PENDING');
  assert.equal(repeated.handoff.agentId, result.handoff.agentId);
  assert.equal((await manager.listSpecialistHandoffs(id)).handoffs.length, 1);
});

test('execution loop preserves explicit SPECIALIST_REQUIRED behavior without durable delegation authority', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, { delegation: false });

  const result = await manager.cycleOne(id);
  assert.equal(result.kind, 'SPECIALIST_REQUIRED');
  assert.equal(result.node.nodeId, 'local:research');
  assert.equal((await manager.listSpecialistHandoffs(id)).handoffs.length, 0);
});


test('automatic Specialist prepare is cancelled when owner control changes after registry read', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager);

  const originalGetRegistry = manager.getSpecialistRegistry.bind(manager);
  let injected = false;
  manager.getSpecialistRegistry = async registryId => {
    const result = await originalGetRegistry(registryId);
    if (!injected) {
      injected = true;
      await manager.update(store => {
        const job = store.byId[id];
        job.runtime.controlEpoch += 1;
        job.runtime.runState = 'PAUSED';
        return store;
      });
    }
    return result;
  };

  const cancelled = await manager.cycleOne(id);
  assert.equal(cancelled.kind, 'CANCELLED_BY_OWNER');

  const persisted = await manager.listSpecialistHandoffs(id);
  assert.equal(persisted.handoffs.length, 0);
  assert.equal(persisted.executionOwnerships.length, 0);
  const current = await manager.get(id);
  assert.equal(current.job.runtime.runState, 'PAUSED');
});


test('runBurst stops after one automatic Specialist boundary instead of busy-looping', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager);

  const burst = await manager.runBurst(id, { maxCycles: 25, maxWallMs: 25000 });
  assert.equal(burst.kind, 'BURST');
  assert.equal(burst.cycles, 1);
  assert.equal(burst.results[0].kind, 'SPECIALIST_PENDING');
  assert.equal((await manager.listSpecialistHandoffs(id)).handoffs.length, 1);
});

test('runBurst stops after one explicit Specialist-required boundary for unbound jobs', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, { delegation: false });

  const burst = await manager.runBurst(id, { maxCycles: 25, maxWallMs: 25000 });
  assert.equal(burst.kind, 'BURST');
  assert.equal(burst.cycles, 1);
  assert.equal(burst.results[0].kind, 'SPECIALIST_REQUIRED');
  assert.equal((await manager.listSpecialistHandoffs(id)).handoffs.length, 0);
});


test('missing durable Specialist registry uses bounded planning backoff instead of uncaught loop failure', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, { delegation: true, createRegistry: false });

  const burst = await manager.runBurst(id, { maxCycles: 25, maxWallMs: 25000 });
  assert.equal(burst.kind, 'BURST');
  assert.equal(burst.cycles, 1);
  assert.equal(burst.results[0].kind, 'PLANNING_RETRY');
  assert.match(burst.results[0].error, /Specialist registry not found/);

  const current = await manager.get(id);
  assert.equal(current.job.runtime.runState, 'RUNNING');
  assert.match(current.job.runtime.lastError, /Specialist registry not found/);
  assert.ok(current.job.runtime.nextWakeAt > Date.parse('2026-09-29T03:05:00.000Z'));
  assert.equal((await manager.listSpecialistHandoffs(id)).handoffs.length, 0);
});

test('persistent automatic Specialist admission failure reaches the existing terminal ERROR fence', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, { delegation: true, createRegistry: false });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const retry = await manager.cycleOne(id);
    assert.equal(retry.kind, 'PLANNING_RETRY');
    assert.equal(retry.consecutive, attempt);
  }
  const terminal = await manager.cycleOne(id);
  assert.equal(terminal.kind, 'ERROR');
  assert.equal(terminal.consecutive, 4);

  const current = await manager.get(id);
  assert.equal(current.job.runtime.runState, 'ERROR');
  assert.equal(current.job.runtime.nextWakeAt, 0);
  assert.equal((await manager.listSpecialistHandoffs(id)).handoffs.length, 0);
});


test('durable reusable-Agent profile caps per-job Specialist lease duration at claim time', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, { leaseSeconds: 600 });

  const prepared = await manager.cycleOne(id);
  assert.equal(prepared.kind, 'SPECIALIST_PENDING');

  const claimed = await manager.claimSpecialistHandoffs(id, {
    availableSlots: 10,
    maxChildrenPerAgent: 10,
    maxDepth: 2,
    leaseSeconds: 3600,
    at: '2026-09-29T03:06:00.000Z',
  });
  assert.equal(claimed.claimed.length, 1);
  assert.equal(claimed.assignments[0].leaseExpiresAt, '2026-09-29T03:16:00.000Z');
});

test('durable reusable-Agent zero Specialist capacity prevents per-job claim widening', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, { maxConcurrentHandoffs: 0 });

  const prepared = await manager.cycleOne(id);
  assert.equal(prepared.kind, 'SPECIALIST_PENDING');

  const claimed = await manager.claimSpecialistHandoffs(id, {
    availableSlots: 10,
    maxChildrenPerAgent: 10,
    maxDepth: 2,
    leaseSeconds: 3600,
    at: '2026-09-29T03:06:00.000Z',
  });
  assert.deepEqual(claimed.claimed, []);
  assert.equal(claimed.assignments[0].state, 'READY');
  assert.equal(claimed.executionOwnerships[0].state, 'AVAILABLE');
});

test('cross-job claim cannot widen durable Agent zero capacity', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, { maxConcurrentHandoffs: 0 });

  assert.equal((await manager.cycleOne(id)).kind, 'SPECIALIST_PENDING');

  const claimed = await manager.claimSpecialistHandoffsAcrossJobs({
    maxConcurrentHandoffs: 32,
    maxChildrenPerAgent: 32,
    maxDepth: 2,
    leaseSeconds: 3600,
    at: '2026-09-29T03:06:00.000Z',
  });
  assert.deepEqual(claimed.claimed, []);
  assert.equal(claimed.remainingSlots, 32);

  const persisted = await manager.listSpecialistHandoffs(id);
  assert.equal(persisted.handoffs[0].state, 'READY');
  assert.equal(persisted.executionOwnerships[0].state, 'AVAILABLE');
});

test('cross-job claim caps lease duration by each durable Agent profile', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, { maxConcurrentHandoffs: 2, leaseSeconds: 300 });

  assert.equal((await manager.cycleOne(id)).kind, 'SPECIALIST_PENDING');

  const claimed = await manager.claimSpecialistHandoffsAcrossJobs({
    maxConcurrentHandoffs: 32,
    maxChildrenPerAgent: 32,
    maxDepth: 2,
    leaseSeconds: 3600,
    at: '2026-09-29T03:06:00.000Z',
  });
  assert.equal(claimed.claimed.length, 1);

  const persisted = await manager.listSpecialistHandoffs(id);
  assert.equal(persisted.handoffs[0].leaseExpiresAt, '2026-09-29T03:11:00.000Z');
  assert.equal(persisted.executionOwnerships[0].state, 'OWNED');
});


test('existing owned Specialist work consumes durable Agent profile capacity before another canonical handoff claim', async () => {
  const { chrome } = chromeStorage();
  const manager = managerFor(chrome);
  const id = await seed(manager, {
    maxConcurrentHandoffs: 1,
    leaseSeconds: 600,
    twoExternalNodes: true,
  });

  assert.equal((await manager.cycleOne(id)).kind, 'SPECIALIST_PENDING');
  const first = await manager.claimSpecialistHandoffs(id, {
    availableSlots: 10,
    maxChildrenPerAgent: 10,
    maxDepth: 2,
    leaseSeconds: 600,
    at: '2026-09-29T03:06:00.000Z',
  });
  assert.equal(first.claimed.length, 1);
  assert.equal(first.executionOwnerships.filter(item => item.state === 'OWNED').length, 1);

  const preparedSecond = await manager.prepareSpecialistHandoff(id, {
    nodeId: 'local:research-2',
    specialistId: 'specialist.research.local',
    requestedCapabilityIds: ['research'],
    parentCapabilityIds: ['research'],
    policyEnvelopeId: 'policy:research',
    deadlineAt: '2026-09-29T03:20:00.000Z',
    priority: 7,
    at: '2026-09-29T03:07:00.000Z',
  });
  assert.equal(preparedSecond.reused, false);
  assert.equal(preparedSecond.assignment.state, 'READY');

  const second = await manager.claimSpecialistHandoffs(id, {
    availableSlots: 10,
    maxChildrenPerAgent: 10,
    maxDepth: 2,
    leaseSeconds: 600,
    at: '2026-09-29T03:08:00.000Z',
  });
  assert.deepEqual(second.claimed, []);
  assert.equal(second.executionOwnerships.filter(item => item.state === 'OWNED').length, 1);
  assert.equal(second.assignments.filter(item => item.state === 'READY').length, 1);
});

test('existing owner-bound handoff with missing admission provenance enters bounded planning retry', async () => {
  const storage = chromeStorage();
  const manager = managerFor(storage.chrome);
  const id = await seed(manager);
  const first = await manager.cycleOne(id);
  assert.equal(first.kind, 'SPECIALIST_PENDING');

  delete storage.data.autopilotBrowserAgentV1.byId[id].runtime.specialistDelegationAdmissions;
  const restarted = managerFor(storage.chrome);
  const result = await restarted.cycleOne(id);
  assert.equal(result.kind, 'PLANNING_RETRY');
  assert.match(result.error, /lacks durable admission provenance/);

  const persisted = await restarted.listSpecialistHandoffs(id);
  assert.equal(persisted.handoffs.length, 1);
  assert.equal(persisted.handoffs[0].state, 'READY');
  assert.equal(persisted.executionOwnerships[0].state, 'AVAILABLE');
});
