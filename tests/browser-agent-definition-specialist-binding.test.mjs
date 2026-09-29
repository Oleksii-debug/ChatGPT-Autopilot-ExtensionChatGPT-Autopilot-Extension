import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import {
  AgentDefinitionRegistryMutationKind,
  createAgentDefinitionRegistryV1,
} from '../src/core/agent-definition-registry.js';
import { createSpecialistRegistryV1 } from '../src/core/specialist-registry.js';

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

function managerFor(chrome) {
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
  });
}

function delegationProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    requiredCapabilityIds: ['research'],
    requiredToolIds: ['browser.read'],
    policyEnvelopeId: 'policy:research-specialists',
    deadlineSeconds: 900,
    maxConcurrentHandoffs: 3,
    leaseSeconds: 600,
    priority: 9,
    enabled: true,
    ...overrides,
  };
}

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: 'Delegating reusable research Agent',
    instructions: 'Research the task and delegate bounded specialist work when appropriate.',
    capabilityIds: ['browser', 'research'],
    toolIds: ['browser.read', 'files.read'],
    tags: ['research'],
    acceptanceCriteria: [],
    configDefaults: {},
    modelRoutePolicy: null,
    specialistDelegationProfile: delegationProfile(),
    enabled: true,
    definitionRevision: 1,
    ...overrides,
  };
}

function ownerBudget() {
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
  };
}

async function seed(manager, def = definition()) {
  const created = await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  return manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: created.registry.bindingKey,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: def,
  });
}

function bindingKey(def = definition()) {
  return createAgentDefinitionRegistryV1({
    schemaVersion: 1,
    registryId: 'agents:project-1',
    revision: 2,
    definitions: [def],
  }).bindingKey;
}

function launch(overrides = {}) {
  return {
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    expectedRegistryBindingKey: bindingKey(),
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    jobId: 'job.research-binding',
    goal: 'Produce a verified research result.',
    projectId: 'project-1',
    ownerBudget: ownerBudget(),
    ownerCapabilityIds: ['browser', 'research'],
    ownerToolIds: ['browser.read', 'files.read'],
    requestedCapabilityIds: ['research'],
    requestedToolIds: ['browser.read'],
    ...overrides,
  };
}

test('definition launch persists the exact non-authorizing specialist delegation binding across restart', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);

  const created = await manager.createFromAgentDefinition(launch());
  assert.equal(created.job.specialistDelegationBinding.jobId, 'job.research-binding');
  assert.equal(created.job.specialistDelegationBinding.projectId, 'project-1');
  assert.equal(created.job.specialistDelegationBinding.registryId, 'agents:project-1');
  assert.equal(created.job.specialistDelegationBinding.registryRevision, 2);
  assert.equal(created.job.specialistDelegationBinding.agentDefinitionId, 'agent.research');
  assert.equal(created.job.specialistDelegationBinding.definitionRevision, 1);
  assert.deepEqual(
    created.job.specialistDelegationBinding.profile.requiredCapabilityIds,
    ['research'],
  );
  assert.deepEqual(
    created.job.specialistDelegationBinding.profile.requiredToolIds,
    ['browser.read'],
  );
  assert.equal(created.job.specialistDelegationBinding.authority.proposalOnly, true);
  assert.equal(created.job.specialistDelegationBinding.authority.executionAuthorized, false);
  assert.equal(created.job.specialistDelegationBinding.authority.capacityReserved, false);

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.research-binding');
  assert.deepEqual(
    loaded.job.specialistDelegationBinding,
    created.job.specialistDelegationBinding,
  );
});

test('restart fails closed when a selected delegation profile loses its durable binding', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);
  await manager.createFromAgentDefinition(launch());

  delete data.autopilotBrowserAgentV1.byId['job.research-binding'].specialistDelegationBinding;

  const restarted = managerFor(chrome);
  assert.equal(
    (await restarted.get('job.research-binding')).job,
    null,
    'profile-bearing reusable Agent must not reload without exact launch binding',
  );
});

test('restart fails closed on specialist binding provenance or profile drift', async () => {
  for (const mutate of [
    binding => { binding.projectId = 'project-other'; },
    binding => { binding.registryRevision = 3; },
    binding => { binding.profile.policyEnvelopeId = 'policy:tampered'; },
    binding => { binding.profile.requiredCapabilityIds = ['browser']; },
  ]) {
    const { data, chrome } = makeChromeStorage();
    const manager = managerFor(chrome);
    await seed(manager);
    await manager.createFromAgentDefinition(launch());

    mutate(data.autopilotBrowserAgentV1.byId['job.research-binding'].specialistDelegationBinding);

    const restarted = managerFor(chrome);
    assert.equal((await restarted.get('job.research-binding')).job, null);
  }
});

test('definition without delegation profile and manual jobs persist no specialist binding', async () => {
  const first = makeChromeStorage();
  const manager = managerFor(first.chrome);
  const noProfile = definition();
  delete noProfile.specialistDelegationProfile;
  await seed(manager, noProfile);
  const created = await manager.createFromAgentDefinition(launch({
    expectedRegistryBindingKey: bindingKey(noProfile),
  }));
  assert.equal(created.job.specialistDelegationBinding, null);

  const second = makeChromeStorage();
  const manualManager = managerFor(second.chrome);
  const manual = await manualManager.create({
    id: 'job.manual-no-binding',
    goal: 'Manual Browser Agent',
  });
  assert.equal(manual.job.specialistDelegationBinding, null);
  assert.equal((await managerFor(second.chrome).get('job.manual-no-binding')).job.specialistDelegationBinding, null);
});


function delegationPlan(overrides = {}) {
  const at = '2026-09-29T03:00:00.000Z';
  return {
    schemaVersion: 1,
    planId: 'plan:research-binding',
    jobId: 'job.research-binding',
    objective: 'Produce a verified research result.',
    successCriteria: ['Verified result exists'],
    createdAt: at,
    updatedAt: at,
    revision: 4,
    nodes: [{
      nodeId: 'local:research',
      title: 'Specialist research',
      objective: 'Research the bounded evidence and return an artifact.',
      dependsOn: [],
      conflictKeys: ['artifact:research'],
      ownerId: 'agent:root',
      executionPlane: 'LOCAL',
      acceptanceCriteria: ['Research artifact is verified'],
      budget: {
        maxModelCalls: 5,
        maxRuntimeSeconds: 1200,
        maxCostUsdMicros: 700000,
      },
      state: 'READY',
      evidence: '',
      updatedAt: at,
    }],
    ...overrides,
  };
}

async function attachDelegationPlan(manager, plan = delegationPlan()) {
  await manager.update(store => {
    store.byId['job.research-binding'].runtime.plan = plan;
    return store;
  });
}

test('durable definition binding materializes proposal-only specialist intent without caller policy fields', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);
  await manager.createFromAgentDefinition(launch());
  await attachDelegationPlan(manager);

  const intent = await manager.materializeDefinitionSpecialistDelegationIntent(
    'job.research-binding',
    {
      expectedRegistryRevision: 12,
      expectedPlanRevision: 4,
      nodeId: 'local:research',
      at: '2026-09-29T03:05:00.000Z',
      childBudget: {
        maxModelCalls: 3,
        maxRuntimeSeconds: 300,
        maxCostUsdMicros: 250000,
      },
      parentInvocationId: 'invoke:parent-1',
    },
  );

  assert.equal(intent.request.registryId, 'specialists:project-1');
  assert.equal(intent.request.expectedRegistryRevision, 12);
  assert.equal(intent.request.expectedPlanRevision, 4);
  assert.equal(intent.request.nodeId, 'local:research');
  assert.deepEqual(intent.request.requiredCapabilityIds, ['research']);
  assert.deepEqual(intent.request.requiredToolIds, ['browser.read']);
  assert.equal(intent.request.policyEnvelopeId, 'policy:research-specialists');
  assert.equal(intent.request.deadlineAt, '2026-09-29T03:20:00.000Z');
  assert.equal(intent.request.maxConcurrentHandoffs, 3);
  assert.equal(intent.request.leaseSeconds, 600);
  assert.equal(intent.request.priority, 9);
  assert.deepEqual(intent.request.childBudget, {
    maxModelCalls: 3,
    maxRuntimeSeconds: 300,
    maxCostUsdMicros: 250000,
  });
  assert.deepEqual(intent.provenance, {
    jobId: 'job.research-binding',
    projectId: 'project-1',
    agentDefinitionRegistryId: 'agents:project-1',
    agentDefinitionRegistryRevision: 2,
    agentDefinitionId: 'agent.research',
    definitionRevision: 1,
    ownerBound: true,
  });
  assert.equal(intent.authority.proposalOnly, true);
  assert.equal(intent.authority.executionAuthorized, false);
  assert.equal(intent.authority.capacityReserved, false);

  await assert.rejects(
    () => manager.materializeDefinitionSpecialistDelegationIntent(
      'job.research-binding',
      {
        expectedRegistryRevision: 12,
        expectedPlanRevision: 4,
        nodeId: 'local:research',
        requiredCapabilityIds: ['browser'],
      },
    ),
    /unknown field/,
  );
});

test('durable definition specialist intent fails closed on plan drift and snapshots child budget before async reads', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);
  await manager.createFromAgentDefinition(launch());
  await attachDelegationPlan(manager);

  await assert.rejects(
    () => manager.materializeDefinitionSpecialistDelegationIntent(
      'job.research-binding',
      {
        expectedRegistryRevision: 12,
        expectedPlanRevision: 3,
        nodeId: 'local:research',
      },
    ),
    /AgentPlan revision drifted/,
  );

  await assert.rejects(
    () => manager.materializeDefinitionSpecialistDelegationIntent(
      'job.research-binding',
      {
        expectedRegistryRevision: 12,
        expectedPlanRevision: 4,
        nodeId: 'local:missing',
      },
    ),
    /AgentPlan node not found/,
  );

  await attachDelegationPlan(manager, delegationPlan({
    nodes: [delegationPlan().nodes[0] && { ...delegationPlan().nodes[0], state: 'RUNNING' }],
  }));
  await assert.rejects(
    () => manager.materializeDefinitionSpecialistDelegationIntent(
      'job.research-binding',
      {
        expectedRegistryRevision: 12,
        expectedPlanRevision: 4,
        nodeId: 'local:research',
      },
    ),
    /must be READY/,
  );

  await attachDelegationPlan(manager, delegationPlan({
    nodes: [delegationPlan().nodes[0] && { ...delegationPlan().nodes[0], executionPlane: 'BROWSER' }],
  }));
  await assert.rejects(
    () => manager.materializeDefinitionSpecialistDelegationIntent(
      'job.research-binding',
      {
        expectedRegistryRevision: 12,
        expectedPlanRevision: 4,
        nodeId: 'local:research',
      },
    ),
    /requires LOCAL, CLOUD or REMOTE/,
  );

  await attachDelegationPlan(manager);

  const request = {
    expectedRegistryRevision: 12,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
    childBudget: {
      maxModelCalls: 2,
      maxRuntimeSeconds: 180,
      maxCostUsdMicros: 100000,
    },
  };
  const pending = manager.materializeDefinitionSpecialistDelegationIntent(
    'job.research-binding',
    request,
  );
  request.childBudget.maxModelCalls = 999;
  request.childBudget.maxRuntimeSeconds = 999;
  const intent = await pending;
  assert.deepEqual(intent.request.childBudget, {
    maxModelCalls: 2,
    maxRuntimeSeconds: 180,
    maxCostUsdMicros: 100000,
  });
});

function specialistRegistry(revision = 12) {
  return createSpecialistRegistryV1({
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    revision,
    definitions: [
      {
        schemaVersion: 1,
        specialistId: 'specialist.research.tight',
        providerId: 'provider.local-tight',
        label: 'Tight research specialist',
        description: 'Exact bounded research scope.',
        executionPlane: 'LOCAL',
        capabilityIds: ['research'],
        toolIds: ['browser.read'],
        resultContractId: 'result.research',
        enabled: true,
        definitionRevision: 1,
      },
      {
        schemaVersion: 1,
        specialistId: 'specialist.research.wide',
        providerId: 'provider.local-wide',
        label: 'Wide research specialist',
        description: 'Broader authority than required.',
        executionPlane: 'LOCAL',
        capabilityIds: ['browser', 'research'],
        toolIds: ['browser.read', 'files.read'],
        resultContractId: 'result.research',
        enabled: true,
        definitionRevision: 1,
      },
    ],
  });
}

test('owner-bound profile atomically selects least-authority specialist and persists canonical handoff', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);
  await manager.createFromAgentDefinition(launch());
  await attachDelegationPlan(manager);

  const request = {
    registry: specialistRegistry(),
    expectedRegistryRevision: 12,
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
  const admitted = await manager.prepareDefinitionSpecialistDelegation(
    'job.research-binding',
    request,
  );

  assert.equal(admitted.reused, false);
  assert.equal(admitted.proposal.selection.specialistId, 'specialist.research.tight');
  assert.equal(admitted.proposal.selectionReason.kind, 'LEAST_AUTHORITY_ELIGIBLE');
  assert.equal(admitted.proposal.registryRevision, 12);
  assert.equal(admitted.proposal.authority.executionAuthorized, false);
  assert.equal(admitted.proposal.requiresCanonicalRevalidation.productWideCapacityReservation, true);
  assert.equal(admitted.assignment.specialistId, 'specialist.research.tight');
  assert.equal(admitted.executionOwnership.state, 'AVAILABLE');

  const persisted = await manager.listSpecialistHandoffs('job.research-binding');
  assert.equal(persisted.handoffs.length, 1);
  assert.equal(persisted.executionOwnerships.length, 1);
  assert.equal(persisted.handoffs[0].agentId, admitted.assignment.agentId);
  assert.equal(persisted.executionOwnerships[0].effectId, admitted.executionOwnership.effectId);

  const repeated = await manager.prepareDefinitionSpecialistDelegation(
    'job.research-binding',
    request,
  );
  assert.equal(repeated.reused, true);
  assert.equal((await manager.listSpecialistHandoffs('job.research-binding')).handoffs.length, 1);
});

test('owner-bound specialist runtime admission fails closed on registry revision drift without persistence', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);
  await manager.createFromAgentDefinition(launch());
  await attachDelegationPlan(manager);

  await assert.rejects(
    () => manager.prepareDefinitionSpecialistDelegation(
      'job.research-binding',
      {
        registry: specialistRegistry(13),
        expectedRegistryRevision: 12,
        expectedPlanRevision: 4,
        nodeId: 'local:research',
        at: '2026-09-29T03:05:00.000Z',
      },
    ),
    /registry identity or revision drifted/,
  );

  const persisted = await manager.listSpecialistHandoffs('job.research-binding');
  assert.equal(persisted.handoffs.length, 0);
  assert.equal(persisted.executionOwnerships.length, 0);
});


function driftedSameRevisionSpecialistRegistry() {
  return createSpecialistRegistryV1({
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    revision: 12,
    definitions: [
      {
        schemaVersion: 1,
        specialistId: 'specialist.research.tight',
        providerId: 'provider.local-tight',
        label: 'Tight research specialist',
        description: 'Exact bounded research scope.',
        executionPlane: 'LOCAL',
        capabilityIds: ['research'],
        toolIds: ['browser.read'],
        resultContractId: 'result.research',
        enabled: false,
        definitionRevision: 1,
      },
      {
        schemaVersion: 1,
        specialistId: 'specialist.research.wide',
        providerId: 'provider.local-wide',
        label: 'Wide research specialist',
        description: 'Broader authority than required.',
        executionPlane: 'LOCAL',
        capabilityIds: ['browser', 'research'],
        toolIds: ['browser.read', 'files.read'],
        resultContractId: 'result.research',
        enabled: true,
        definitionRevision: 1,
      },
    ],
  });
}

test('idempotent reusable-Agent delegation refuses same-revision registry content drift', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);
  await manager.createFromAgentDefinition(launch());
  await attachDelegationPlan(manager);

  const baseRequest = {
    registry: specialistRegistry(),
    expectedRegistryRevision: 12,
    expectedPlanRevision: 4,
    nodeId: 'local:research',
    at: '2026-09-29T03:05:00.000Z',
  };
  const first = await manager.prepareDefinitionSpecialistDelegation(
    'job.research-binding',
    baseRequest,
  );
  assert.equal(first.assignment.specialistId, 'specialist.research.tight');

  await assert.rejects(
    () => manager.prepareDefinitionSpecialistDelegation(
      'job.research-binding',
      {
        ...baseRequest,
        registry: driftedSameRevisionSpecialistRegistry(),
      },
    ),
    /drifted from current owner-bound delegation proposal/,
  );

  const persisted = await manager.listSpecialistHandoffs('job.research-binding');
  assert.equal(persisted.handoffs.length, 1);
  assert.equal(persisted.handoffs[0].specialistId, 'specialist.research.tight');
});


test('durable reusable-Agent profile caps specialist lease duration at claim time', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);
  await manager.createFromAgentDefinition(launch());
  await attachDelegationPlan(manager);
  await manager.prepareDefinitionSpecialistDelegation(
    'job.research-binding',
    {
      registry: specialistRegistry(),
      expectedRegistryRevision: 12,
      expectedPlanRevision: 4,
      nodeId: 'local:research',
      at: '2026-09-29T03:05:00.000Z',
    },
  );

  const claimed = await manager.claimSpecialistHandoffs(
    'job.research-binding',
    {
      availableSlots: 10,
      maxChildrenPerAgent: 10,
      maxDepth: 2,
      leaseSeconds: 3600,
      at: '2026-09-29T03:06:00.000Z',
    },
  );
  assert.equal(claimed.claimed.length, 1);
  assert.equal(claimed.assignments[0].leaseExpiresAt, '2026-09-29T03:16:00.000Z');
});

test('durable reusable-Agent zero specialist capacity prevents legacy claim widening', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const zeroCapacity = definition({
    specialistDelegationProfile: delegationProfile({ maxConcurrentHandoffs: 0 }),
  });
  await seed(manager, zeroCapacity);
  await manager.createFromAgentDefinition(launch({
    expectedRegistryBindingKey: bindingKey(zeroCapacity),
  }));
  await attachDelegationPlan(manager);
  await manager.prepareDefinitionSpecialistDelegation(
    'job.research-binding',
    {
      registry: specialistRegistry(),
      expectedRegistryRevision: 12,
      expectedPlanRevision: 4,
      nodeId: 'local:research',
      at: '2026-09-29T03:05:00.000Z',
    },
  );

  const claimed = await manager.claimSpecialistHandoffs(
    'job.research-binding',
    {
      availableSlots: 10,
      maxChildrenPerAgent: 10,
      maxDepth: 2,
      leaseSeconds: 3600,
      at: '2026-09-29T03:06:00.000Z',
    },
  );
  assert.deepEqual(claimed.claimed, []);
  assert.equal(claimed.assignments[0].state, 'READY');
});


test('reuses the same handoff after mutable claim state advances', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seed(manager);
  await manager.createFromAgentDefinition(launch());
  await attachDelegationPlan(manager);

  const first = await manager.prepareDefinitionSpecialistDelegation(
    'job.research-binding',
    {
      registry: specialistRegistry(),
      expectedRegistryRevision: 12,
      expectedPlanRevision: 4,
      nodeId: 'local:research',
      at: '2026-09-29T03:05:00.000Z',
    },
  );
  const claimed = await manager.claimSpecialistHandoffs(
    'job.research-binding',
    {
      availableSlots: 1,
      maxChildrenPerAgent: 3,
      maxDepth: 2,
      leaseSeconds: 600,
      at: '2026-09-29T03:06:00.000Z',
    },
  );
  assert.equal(claimed.assignments[0].state, 'LEASED');
  assert.equal(claimed.executionOwnerships[0].state, 'OWNED');

  const repeated = await manager.prepareDefinitionSpecialistDelegation(
    'job.research-binding',
    {
      registry: specialistRegistry(),
      expectedRegistryRevision: 12,
      expectedPlanRevision: claimed.plan.revision,
      nodeId: 'local:research',
      at: '2026-09-29T03:07:00.000Z',
    },
  );
  assert.equal(repeated.reused, true);
  assert.equal(repeated.assignment.agentId, first.assignment.agentId);
  assert.equal(repeated.assignment.state, 'LEASED');
  assert.equal(repeated.executionOwnership.state, 'OWNED');
  assert.equal((await manager.listSpecialistHandoffs('job.research-binding')).handoffs.length, 1);
});
