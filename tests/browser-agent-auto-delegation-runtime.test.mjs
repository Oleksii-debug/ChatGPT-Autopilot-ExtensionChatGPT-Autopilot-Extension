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

function readyReadinessResolver({
  executable = true,
  onResolve = null,
  onAssertCurrent = null,
} = {}) {
  return {
    async resolve(selection) {
      if (onResolve) await onResolve(selection);
      return {
        schemaVersion: 1,
        registryId: selection.registryId,
        registryRevision: selection.registryRevision,
        specialistId: selection.specialistId,
        providerId: selection.providerId,
        definitionRevision: selection.definitionRevision,
        executionPlane: selection.executionPlane,
        observedAt: T0,
        resolvedAt: T0,
        ageMs: 0,
        maxAgeMs: 60_000,
        readiness: executable ? 'READY' : 'UNAVAILABLE',
        executable,
        trustedResolverInvoked: true,
        callerReadinessAccepted: false,
        authority: {
          providerExecutionAuthorized: false,
          toolExecutionAuthorized: false,
          policyAuthorized: false,
          schedulingAuthorized: false,
          recoveryAuthorized: false,
          credentialAuthorized: false,
          completionAuthorized: false,
          verificationAuthorized: false,
          capacityReserved: false,
        },
      };
    },
    async assertCurrent(readiness) {
      if (onAssertCurrent) await onAssertCurrent(readiness);
      return true;
    },
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
    maxConcurrentHandoffs: 2,
    priority: 5,
    ...overrides,
  };
}

async function fixture({
  allowAgentCreatedChildren = true,
  maxDepth = 2,
  maxChildrenPerAgent = 2,
  specialistProviderReadinessResolver = null,
} = {}) {
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
    store.byId['job.auto'].runtime.runState = 'RUNNING';
    store.byId['job.auto'].runtime.controlEpoch = 1;
    return store;
  });

  const bindingDependencies = {
    resolveProjectHierarchyAuthority: projectId =>
      orchestration.resolveProjectHierarchyAuthority(projectId),
    withProjectHierarchyAuthority: (projectId, operation) =>
      orchestration.withProjectHierarchyAuthority(projectId, operation),
  };
  await manager.bindOrchestrationNode(
    'job.auto',
    { nodeId: 'worker', expectedGraphId: 'graph-1', expectedControlEpoch: 1 },
    bindingDependencies,
  );
  const dependencies = {
    withProjectHierarchyAuthority: bindingDependencies.withProjectHierarchyAuthority,
    specialistProviderReadinessResolver:
      specialistProviderReadinessResolver || readyReadinessResolver(),
  };

  return { chrome, core, orchestration, manager, dependencies, bindingDependencies };
}

test('runtime auto-delegation prepares least authority without claiming execution ownership', async () => {
  const { chrome, manager, dependencies } = await fixture();
  const result = await manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);

  assert.equal(result.proposal.selection.specialistId, 'narrow-a');
  assert.equal(result.assignment.specialistId, 'narrow-a');
  assert.equal(result.assignment.state, 'READY');
  assert.equal(result.assignment.leaseId, '');
  assert.equal(result.executionOwnership.state, ExecutionOwnershipState.AVAILABLE);
  assert.equal(result.executionOwnership.leaseId, '');
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.providerDispatched, false);
  assert.equal(result.capacityReservation.reserved, false);
  assert.equal(result.capacityReservation.reused, false);
  assert.equal(result.capacityReservation.capacityObligations, 0);
  assert.equal(result.capacityReservation.remainingSlots, 2);
  assert.equal(result.reused, false);
  assert.equal(result.structureAdmission.decision, 'ALLOW');
  assert.equal(result.delegationBinding.registryId, 'specialists:project-1');
  assert.equal(result.delegationBinding.registryRevision, 4);
  assert.equal(result.delegationBinding.selection.providerId, 'provider:narrow-a');
  assert.deepEqual(result.delegationBinding.selection.grantedToolIds, ['artifact.write', 'data.query']);

  const live = await manager.get('job.auto');
  assert.equal(live.job.runtime.plan.nodes[0].state, 'READY');
  assert.equal(live.job.runtime.specialistHandoffs.length, 1);
  assert.equal(live.job.runtime.specialistHandoffs[0].state, 'READY');
  assert.equal(live.job.runtime.specialistExecutionOwnerships.length, 1);
  assert.equal(live.job.runtime.specialistExecutionOwnerships[0].state, ExecutionOwnershipState.AVAILABLE);
  assert.equal(live.job.runtime.specialistDelegationBindings.length, 1);
  assert.deepEqual(
    Object.keys(chrome.data).filter(key => key.startsWith('autopilotBrowserAgent')),
    ['autopilotBrowserAgentV1'],
    'auto delegation must reuse the one Browser Agent storage authority',
  );
});

test('automatic delegation refuses a non-running parent before any readiness probe', async () => {
  let readinessCalls = 0;
  const resolver = readyReadinessResolver({
    onResolve: async () => { readinessCalls += 1; },
  });
  const { manager, dependencies } = await fixture({
    specialistProviderReadinessResolver: resolver,
  });
  await manager.update(store => {
    store.byId['job.auto'].runtime.runState = 'PAUSED';
    store.byId['job.auto'].runtime.controlEpoch = 2;
    return store;
  });

  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies),
    /parent must be RUNNING/u,
  );
  assert.equal(readinessCalls, 0, 'revoked parent runtime must fail before provider probing');
  const listed = await manager.listSpecialistHandoffs('job.auto');
  assert.equal(listed.handoffs.length, 0);
  assert.equal(listed.executionOwnerships.length, 0);
  assert.equal(listed.delegationBindings.length, 0);
});

test('provider config provenance is revalidated inside durable auto-delegation admission', async () => {
  let assertions = 0;
  const resolver = readyReadinessResolver({
    onAssertCurrent: async () => {
      assertions += 1;
      throw new Error('Specialist provider config changed after readiness probe');
    },
  });
  const { manager, dependencies } = await fixture({
    specialistProviderReadinessResolver: resolver,
  });

  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies),
    /provider config changed after readiness probe/u,
  );
  assert.equal(assertions, 1);
  const after = await manager.listSpecialistHandoffs('job.auto');
  assert.equal(after.handoffs.length, 0);
  assert.equal(after.executionOwnerships.length, 0);
  assert.equal(after.delegationBindings.length, 0);
});

test('provider config provenance is revalidated again at canonical claim', async () => {
  let assertions = 0;
  let rejectAfterPrepare = false;
  const resolver = readyReadinessResolver({
    onAssertCurrent: async () => {
      assertions += 1;
      if (rejectAfterPrepare) {
        throw new Error('Specialist provider config changed after readiness probe');
      }
    },
  });
  const { manager, dependencies } = await fixture({
    specialistProviderReadinessResolver: resolver,
  });
  await manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);
  rejectAfterPrepare = true;

  await assert.rejects(
    () => manager.claimSpecialistHandoffsAcrossJobs({
      targetJobId: 'job.auto',
      maxConcurrentHandoffs: 1,
      maxChildrenPerAgent: 2,
      maxDepth: 2,
      leaseSeconds: 900,
      at: T0,
    }, dependencies),
    /provider config changed after readiness probe/u,
  );
  assert.equal(assertions, 2);
  const after = await manager.listSpecialistHandoffs('job.auto');
  assert.equal(after.handoffs[0].state, 'READY');
  assert.equal(after.executionOwnerships[0].state, ExecutionOwnershipState.AVAILABLE);
});

test('unavailable trusted provider readiness produces zero durable delegation mutation', async () => {
  let readinessCalls = 0;
  const resolver = readyReadinessResolver({
    executable: false,
    onResolve: async () => { readinessCalls += 1; },
  });
  const { manager, dependencies } = await fixture({
    specialistProviderReadinessResolver: resolver,
  });
  const before = await manager.get('job.auto');

  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies),
    /not currently executable/u,
  );

  assert.equal(readinessCalls, 1);
  const after = await manager.get('job.auto');
  assert.deepEqual(after.job.runtime.plan, before.job.runtime.plan);
  assert.deepEqual(after.job.runtime.specialistHandoffs, []);
  assert.deepEqual(after.job.runtime.specialistExecutionOwnerships, []);
  assert.deepEqual(after.job.runtime.specialistDelegationBindings, []);
});

test('parent pause during async readiness probe invalidates the runtime fence before persistence', async () => {
  let probeReachedResolve;
  const probeReached = new Promise(resolve => { probeReachedResolve = resolve; });
  let releaseProbeResolve;
  const releaseProbe = new Promise(resolve => { releaseProbeResolve = resolve; });
  const resolver = readyReadinessResolver({
    onResolve: async () => {
      probeReachedResolve();
      await releaseProbe;
    },
  });
  const { manager, dependencies } = await fixture({
    specialistProviderReadinessResolver: resolver,
  });

  const pending = manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);
  await probeReached;
  await manager.update(store => {
    store.byId['job.auto'].runtime.runState = 'PAUSED';
    store.byId['job.auto'].runtime.controlEpoch = 2;
    return store;
  });
  releaseProbeResolve();

  await assert.rejects(
    pending,
    /parent runtime fence is stale: NOT_RUNNING/u,
  );
  const listed = await manager.listSpecialistHandoffs('job.auto');
  assert.equal(listed.handoffs.length, 0);
  assert.equal(listed.executionOwnerships.length, 0);
  assert.equal(listed.delegationBindings.length, 0);
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

test('repeated current auto-delegation reuses the same prepared handoff without a second mutation', async () => {
  const { manager, dependencies } = await fixture();
  const first = await manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);
  const before = await manager.get('job.auto');
  const second = await manager.autoPrepareSpecialistHandoff(
    'job.auto',
    request({ expectedPlanRevision: before.job.runtime.plan.revision }),
    dependencies,
  );
  const after = await manager.get('job.auto');

  assert.equal(second.reused, true);
  assert.equal(second.capacityReservation.reserved, false);
  assert.equal(second.capacityReservation.reused, true);
  assert.equal(second.providerDispatched, false);
  assert.equal(second.assignment.agentId, first.assignment.agentId);
  assert.equal(second.assignment.state, 'READY');
  assert.equal(second.assignment.leaseId, '');
  assert.equal(second.executionOwnership.state, ExecutionOwnershipState.AVAILABLE);
  assert.equal(after.job.runtime.plan.revision, before.job.runtime.plan.revision);
  assert.equal(after.job.runtime.specialistHandoffs.length, 1);
  assert.equal(after.job.runtime.specialistExecutionOwnerships.length, 1);
  assert.equal(after.job.runtime.specialistDelegationBindings.length, 1);
  assert.equal(after.job.runtime.updatedAt, before.job.runtime.updatedAt);
});

test('automatic preparation reuses an already canonically claimed handoff without claiming again', async () => {
  const { manager, dependencies } = await fixture();
  const prepared = await manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);
  const claim = await manager.claimSpecialistHandoffsAcrossJobs({
    maxConcurrentHandoffs: 1,
    maxChildrenPerAgent: 2,
    maxDepth: 2,
    leaseSeconds: 900,
    at: T0,
  }, dependencies);
  assert.equal(claim.claimed.length, 1);
  assert.equal(claim.claimed[0].jobId, 'job.auto');
  assert.equal(claim.claimed[0].agentId, prepared.assignment.agentId);

  const before = await manager.get('job.auto');
  assert.equal(before.job.runtime.plan.nodes[0].state, 'RUNNING');
  const second = await manager.autoPrepareSpecialistHandoff(
    'job.auto',
    request({ expectedPlanRevision: before.job.runtime.plan.revision }),
    dependencies,
  );
  const after = await manager.get('job.auto');

  assert.equal(second.reused, true);
  assert.equal(second.assignment.state, 'LEASED');
  assert.equal(second.executionOwnership.state, ExecutionOwnershipState.OWNED);
  assert.equal(second.capacityReservation.reserved, true);
  assert.equal(second.capacityReservation.reused, true);
  assert.equal(second.providerDispatched, false);
  assert.deepEqual(after, before);
});

test('legacy per-job claim cannot bypass automatic delegation readiness admission', async () => {
  const { manager, dependencies } = await fixture();
  const prepared = await manager.autoPrepareSpecialistHandoff('job.auto', request(), dependencies);

  await assert.rejects(
    () => manager.claimSpecialistHandoffs('job.auto', {
      maxChildrenPerAgent: 2,
      maxDepth: 2,
      leaseSeconds: 900,
      at: T0,
    }),
    /canonical cross-job claim admission/,
  );

  const stillReady = await manager.listSpecialistHandoffs('job.auto');
  assert.equal(stillReady.handoffs[0].agentId, prepared.assignment.agentId);
  assert.equal(stillReady.handoffs[0].state, 'READY');
  assert.equal(stillReady.executionOwnerships[0].state, ExecutionOwnershipState.AVAILABLE);

  const admitted = await manager.claimSpecialistHandoffsAcrossJobs({
    targetJobId: 'job.auto',
    maxConcurrentHandoffs: 1,
    maxChildrenPerAgent: 2,
    maxDepth: 2,
    leaseSeconds: 900,
    at: T0,
  }, dependencies);
  assert.deepEqual(admitted.claimed, [{ jobId: 'job.auto', agentId: prepared.assignment.agentId }]);
});

test('automatic preparation does not consume product-wide capacity; canonical claim owns the slot', async () => {
  const { manager, dependencies, bindingDependencies } = await fixture();

  await manager.createFromAgentDefinition({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    agentDefinitionId: 'agent.analysis',
    expectedDefinitionRevision: 1,
    jobId: 'job.other',
    goal: 'Produce another bounded verified analysis.',
    projectId: 'project-1',
    ownerBudget: ownerBudget(),
    ownerCapabilityIds: ['data.analyze', 'data.read', 'filesystem.write'],
    ownerToolIds: ['artifact.write', 'data.query', 'shell.run'],
    requestedCapabilityIds: ['data.analyze', 'data.read', 'filesystem.write'],
    requestedToolIds: ['artifact.write', 'data.query', 'shell.run'],
  });
  await manager.update(store => {
    store.byId['job.other'].runtime.plan = plan({
      planId: 'plan:other',
      jobId: 'job.other',
    });
    store.byId['job.other'].runtime.runState = 'RUNNING';
    store.byId['job.other'].runtime.controlEpoch = 1;
    return store;
  });
  await manager.bindOrchestrationNode(
    'job.other',
    { nodeId: 'worker', expectedGraphId: 'graph-1', expectedControlEpoch: 1 },
    bindingDependencies,
  );

  const firstPrepared = await manager.autoPrepareSpecialistHandoff(
    'job.auto',
    request({ maxConcurrentHandoffs: 1 }),
    dependencies,
  );
  const secondPrepared = await manager.autoPrepareSpecialistHandoff(
    'job.other',
    request({
      policyEnvelopeId: 'policy:job.other',
      maxConcurrentHandoffs: 1,
    }),
    dependencies,
  );
  assert.equal(firstPrepared.capacityReservation.reserved, false);
  assert.equal(secondPrepared.capacityReservation.reserved, false);
  assert.equal(secondPrepared.capacityReservation.capacityObligations, 0);
  assert.equal(secondPrepared.capacityReservation.remainingSlots, 1);

  const claim = await manager.claimSpecialistHandoffsAcrossJobs({
    maxConcurrentHandoffs: 1,
    maxChildrenPerAgent: 2,
    maxDepth: 2,
    leaseSeconds: 900,
    at: T0,
  }, dependencies);
  assert.equal(claim.claimed.length, 1);
  assert.equal(claim.remainingSlots, 0);

  const first = await manager.listSpecialistHandoffs('job.auto');
  const second = await manager.listSpecialistHandoffs('job.other');
  assert.deepEqual(
    [first.handoffs[0].state, second.handoffs[0].state].sort(),
    ['LEASED', 'READY'],
  );
  assert.deepEqual(
    [first.executionOwnerships[0].state, second.executionOwnerships[0].state].sort(),
    [ExecutionOwnershipState.AVAILABLE, ExecutionOwnershipState.OWNED].sort(),
  );
});

test('automatic delegation requires an explicit bounded capacity preflight without reserving it', async () => {
  const { manager, dependencies } = await fixture();
  const missing = request();
  delete missing.maxConcurrentHandoffs;
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff('job.auto', missing, dependencies),
    /requires maxConcurrentHandoffs/,
  );
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff(
      'job.auto',
      request({ maxConcurrentHandoffs: 257 }),
      dependencies,
    ),
    /integer from 0 to 256/,
  );

  const zero = await manager.autoPrepareSpecialistHandoff(
    'job.auto',
    request({ maxConcurrentHandoffs: 0 }),
    dependencies,
  );
  assert.equal(zero.assignment.state, 'READY');
  assert.equal(zero.executionOwnership.state, ExecutionOwnershipState.AVAILABLE);
  assert.equal(zero.capacityReservation.maxConcurrentHandoffs, 0);
  assert.equal(zero.capacityReservation.remainingSlots, 0);
  assert.equal(zero.capacityReservation.reserved, false);
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

  const liveRevision = (await manager.get('job.auto')).job.runtime.plan.revision;
  await assert.rejects(
    () => manager.autoPrepareSpecialistHandoff(
      'job.auto',
      request({ expectedRegistryRevision: 5, expectedPlanRevision: liveRevision }),
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
  const { manager, dependencies, bindingDependencies } = await fixture();
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
    store.byId['job.manual'].runtime.runState = 'RUNNING';
    store.byId['job.manual'].runtime.controlEpoch = 1;
    return store;
  });
  await manager.bindOrchestrationNode('job.manual', { nodeId: 'worker' }, bindingDependencies);
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
  assert.match(source, /orchestrationV2\.withProjectHierarchyAuthority\(projectId, operation\)/);
  assert.equal(
    (source.match(/autopilotBrowserAgentV1/g) || []).length,
    0,
    'service worker must not own a second Browser Agent persistence implementation',
  );
});
