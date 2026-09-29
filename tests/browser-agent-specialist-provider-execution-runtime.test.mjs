import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { BROWSER_AGENT_STORAGE_KEY } from '../src/core/browser-agent.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';
import { SpecialistRegistryMutationKind } from '../src/core/specialist-registry.js';
import {
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
  OPENHANDS_CODING_SPECIALIST_ID,
  OpenHandsCodingSpecialistError,
} from '../src/core/coding-specialist-provider.js';
import {
  SpecialistProviderConfigKind,
  createSpecialistProviderConfigV1,
} from '../src/core/specialist-provider-config.js';
import {
  createSpecialistProviderExecutionV1,
  recordSpecialistProviderExecutionOutcomeV1,
} from '../src/core/specialist-provider-execution.js';

const T0 = '2026-09-29T04:00:00.000Z';
const T1 = '2026-09-29T04:01:00.000Z';
const T2 = '2026-09-29T04:02:00.000Z';

function chromeStorage() {
  const data = Object.create(null);
  return {
    data,
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

function providerConfig(revision = 1, updatedAt = T0) {
  return createSpecialistProviderConfigV1({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision,
    updatedAt,
    config: {
      schemaVersion: 1,
      serverUrl: 'http://127.0.0.1:3000',
      agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
      agentProfileId: '11111111-1111-4111-8111-111111111111',
      agentProfileRevision: revision,
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

function agentDefinition() {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.coder',
    label: 'Coding Agent',
    description: 'Bounded coding agent',
    instructions: 'Execute the exact bounded coding task.',
    capabilityIds: ['code.write'],
    toolIds: [],
    tags: ['coding'],
    acceptanceCriteria: [],
    configDefaults: {},
    modelRoutePolicy: null,
    specialistDelegationProfile: {
      schemaVersion: 1,
      registryId: 'specialists:project-1',
      requiredCapabilityIds: ['code.write'],
      requiredToolIds: [],
      policyEnvelopeId: 'policy:coding',
      deadlineSeconds: 900,
      maxConcurrentHandoffs: 1,
      leaseSeconds: 600,
      priority: 5,
      enabled: true,
    },
    enabled: true,
    definitionRevision: 1,
  };
}

function specialistDefinition() {
  return {
    schemaVersion: 1,
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    label: 'OpenHands Coding',
    description: 'Owner-qualified local coding specialist',
    executionPlane: 'LOCAL',
    capabilityIds: ['code.write'],
    toolIds: [],
    resultContractId: 'result.code',
    enabled: true,
    definitionRevision: 1,
  };
}

async function seed(manager) {
  const agents = await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  const agentMutation = await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: agents.registry.bindingKey,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: agentDefinition(),
  });
  await manager.createFromAgentDefinition({
    registryId: 'agents:project-1',
    expectedRegistryRevision: agentMutation.nextRegistryRevision,
    expectedRegistryBindingKey: agentMutation.nextRegistry.bindingKey,
    agentDefinitionId: 'agent.coder',
    expectedDefinitionRevision: 1,
    jobId: 'job.coder',
    goal: 'Produce a verified code change.',
    projectId: 'project-1',
    ownerBudget: {
      maxSteps: 100, maxModelCalls: 20, maxInputTokens: 20000, maxOutputTokens: 10000,
      maxTotalTokens: 30000, maxOutputTokensPerCall: 2000, maxRuntimeMinutes: 60,
      maxCostUsd: 2, inputPricePerMillionUsd: 1, outputPricePerMillionUsd: 2,
    },
    ownerCapabilityIds: ['code.write'],
    ownerToolIds: [],
    requestedCapabilityIds: ['code.write'],
    requestedToolIds: [],
  });
  await manager.update(store => {
    const job = store.byId['job.coder'];
    job.runtime.runState = 'RUNNING';
    job.runtime.plan = {
      schemaVersion: 1,
      planId: 'plan:job.coder',
      jobId: 'job.coder',
      objective: 'Produce a verified code change.',
      successCriteria: ['Verified result exists'],
      createdAt: T0,
      updatedAt: T0,
      revision: 1,
      nodes: [{
        nodeId: 'local:code',
        title: 'Coding specialist',
        objective: 'Implement the bounded code change.',
        dependsOn: [],
        conflictKeys: ['workspace:code'],
        ownerId: 'agent:root',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Change verified'],
        budget: { maxModelCalls: 0, maxRuntimeSeconds: 300, maxCostUsdMicros: 0 },
        state: 'READY',
        evidence: '',
        updatedAt: T0,
      }],
    };
    return store;
  });
  const specialists = await manager.createSpecialistRegistry({ registryId: 'specialists:project-1' });
  await manager.mutateSpecialistRegistry({
    registryId: 'specialists:project-1',
    expectedRegistryRevision: 1,
    expectedRegistryBindingKey: specialists.registry.bindingKey,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: specialistDefinition(),
  });
  await manager.putSpecialistProviderConfig({
    providerConfig: providerConfig(),
    expectedRevision: 0,
  });
  const prepared = await manager.cycleOne('job.coder');
  assert.equal(prepared.kind, 'SPECIALIST_PENDING');
  const claimed = await manager.claimSpecialistHandoffs('job.coder', {
    availableSlots: 1,
    leaseSeconds: 600,
    at: T0,
  });
  assert.equal(claimed.claimed.length, 1);
  return claimed.claimed[0];
}

test('claimed Specialist provider persists PREPARED before effect and records non-authorizing terminal success', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  let observedPrepared = null;
  let manager;
  const client = {
    async execute(input) {
      calls += 1;
      const state = await manager.listSpecialistHandoffs('job.coder');
      observedPrepared = state.providerExecutions[0];
      assert.equal(observedPrepared.status, 'PREPARED');
      assert.equal(input.handoff.specialistId, OPENHANDS_CODING_SPECIALIST_ID);
      assert.deepEqual(input.grantedCapabilityIds, ['code.write']);
      return {
        providerStatus: 'finished',
        providerSucceeded: true,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
        providerUpdatedAt: T1,
        providerObservedAt: T1,
      };
    },
  };
  manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '22222222-2222-4222-8222-222222222222',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(calls, 1);
  assert.equal(observedPrepared.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_SUCCEEDED');
  assert.equal(result.execution.status, 'PROVIDER_SUCCEEDED');
  assert.equal(result.completionAuthorized, false);
  assert.equal(result.verificationRequired, true);

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 1);
  assert.equal(durable.providerExecutions[0].status, 'PROVIDER_SUCCEEDED');
  assert.equal(durable.handoffs[0].state, 'LEASED');
  assert.equal(durable.executionOwnerships[0].state, 'OWNED');
  const current = await manager.get('job.coder');
  assert.equal(current.job.runtime.plan.nodes[0].state, 'RUNNING');
});

test('owner control drift after durable PREPARED cancels provider dispatch with safe retry evidence', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  const client = { async execute() { calls += 1; throw new Error('must not dispatch'); } };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);

  const originalGet = manager.get.bind(manager);
  let injected = false;
  manager.get = async id => {
    const value = await originalGet(id);
    if (!injected && value.job?.runtime?.specialistProviderExecutions?.length) {
      injected = true;
      await manager.update(store => {
        store.byId[id].runtime.controlEpoch += 1;
        store.byId[id].runtime.runState = 'PAUSED';
        return store;
      });
    }
    return value;
  };

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '33333333-3333-4333-8333-333333333333',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(calls, 0);
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_NOT_DISPATCHED');
  assert.equal(result.execution.status, 'RETRYABLE_FAILURE');
  assert.equal(result.execution.safeToRetry, true);
  assert.equal(result.execution.errorCode, 'OWNER_CONTROL_CHANGED_BEFORE_PROVIDER_DISPATCH');
});

test('ambiguous provider transport failure is durably fenced for reconciliation', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  const client = {
    async execute() {
      throw new OpenHandsCodingSpecialistError('ambiguous timeout', {
        code: 'OPENHANDS_REQUEST_TIMEOUT',
        conversationId: '44444444-4444-4444-8444-444444444444',
        effectMayHaveOccurred: true,
        reconciliationRequired: true,
        safeToRetry: false,
      });
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '44444444-4444-4444-8444-444444444444',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(result.kind, 'SPECIALIST_PROVIDER_RECONCILE');
  assert.equal(result.execution.status, 'RECONCILE');
  assert.equal(result.execution.reconciliationRequired, true);
  assert.equal(result.execution.safeToRetry, false);
  assert.equal(result.execution.errorCode, 'OPENHANDS_REQUEST_TIMEOUT');

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.executionOwnerships[0].state, 'RECONCILE');
  assert.equal(durable.executionOwnerships[0].leaseId, result.execution.leaseId);
});

test('durable PREPARED record resumes only the exact provider conversation after restart-shaped re-entry', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  let observedConversationId = '';
  const client = {
    async execute(input) {
      calls += 1;
      observedConversationId = input.conversationId;
      return {
        providerStatus: 'finished',
        providerSucceeded: true,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
        providerUpdatedAt: T1,
        providerObservedAt: T1,
      };
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = [{
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: assignment.leaseId,
      leaseUntil: assignment.leaseExpiresAt,
      conversationId: '55555555-5555-4555-8555-555555555555',
      providerConfig: providerConfig(),
      status: 'PREPARED',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: '',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }];
    return store;
  });
  clock.value = Date.parse(T1);
  const restarted = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });

  const result = await restarted.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '55555555-5555-4555-8555-555555555555',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(calls, 1);
  assert.equal(observedConversationId, '55555555-5555-4555-8555-555555555555');
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_SUCCEEDED');
  assert.equal(result.execution.status, 'PROVIDER_SUCCEEDED');

  const durable = await restarted.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 1);
  assert.equal(durable.providerExecutions[0].status, 'PROVIDER_SUCCEEDED');
  const history = (await restarted.get('job.coder')).job.runtime.history;
  assert.ok(history.some(item => item.type === 'specialist-provider-execution-resumed'));
});

test('durable PREPARED restart attach fails closed on conversation drift', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  const client = { async execute() { calls += 1; throw new Error('must not dispatch'); } };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = [{
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: assignment.leaseId,
      leaseUntil: assignment.leaseExpiresAt,
      conversationId: '55555555-5555-4555-8555-555555555555',
      providerConfig: providerConfig(),
      status: 'PREPARED',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: '',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }];
    return store;
  });
  clock.value = Date.parse(T1);

  await assert.rejects(
    () => manager.executeClaimedSpecialistProvider('job.coder', {
      agentId,
      conversationId: '66666666-6666-4666-8666-666666666666',
      expectedControlEpoch: 0,
      at: T1,
    }),
    /requires reconciliation before redispatch/,
  );
  assert.equal(calls, 0);
});

test('durable PREPARED restart attach fails closed on provider config drift', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  const client = { async execute() { calls += 1; throw new Error('must not dispatch'); } };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = [{
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: assignment.leaseId,
      leaseUntil: assignment.leaseExpiresAt,
      conversationId: '77777777-7777-4777-8777-777777777777',
      providerConfig: providerConfig(),
      status: 'PREPARED',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: '',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }];
    return store;
  });
  clock.value = Date.parse(T1);
  await manager.putSpecialistProviderConfig({
    providerConfig: providerConfig(2, T1),
    expectedRevision: 1,
  });
  clock.value = Date.parse(T2);

  await assert.rejects(
    () => manager.executeClaimedSpecialistProvider('job.coder', {
      agentId,
      conversationId: '77777777-7777-4777-8777-777777777777',
      expectedControlEpoch: 0,
      at: T2,
    }),
    /provider config drifted before restart attach/,
  );
  assert.equal(calls, 0);
});

test('owner control drift during durable PREPARED recovery requires reconciliation', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  const client = { async execute() { calls += 1; throw new Error('must not dispatch'); } };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = [{
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: assignment.leaseId,
      leaseUntil: assignment.leaseExpiresAt,
      conversationId: '99999999-9999-4999-8999-999999999999',
      providerConfig: providerConfig(),
      status: 'PREPARED',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: '',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }];
    return store;
  });
  clock.value = Date.parse(T1);

  const originalGet = manager.get.bind(manager);
  let injected = false;
  manager.get = async id => {
    const value = await originalGet(id);
    if (!injected) {
      injected = true;
      await manager.update(store => {
        store.byId[id].runtime.controlEpoch += 1;
        store.byId[id].runtime.runState = 'PAUSED';
        return store;
      });
    }
    return value;
  };

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '99999999-9999-4999-8999-999999999999',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(calls, 0);
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_RECONCILE');
  assert.equal(result.execution.status, 'RECONCILE');
  assert.equal(result.execution.reconciliationRequired, true);
  assert.equal(result.execution.safeToRetry, false);
  assert.equal(result.execution.errorCode, 'OWNER_CONTROL_CHANGED_DURING_PREPARED_RECOVERY');

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.executionOwnerships[0].state, 'RECONCILE');
});


test('concurrent exact provider execution calls coalesce onto one external effect', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  let releaseEffect;
  let signalEntered;
  const effectGate = new Promise(resolve => { releaseEffect = resolve; });
  const enteredEffect = new Promise(resolve => { signalEntered = resolve; });
  const client = {
    async execute() {
      calls += 1;
      signalEntered();
      await effectGate;
      return {
        providerStatus: 'finished',
        providerSucceeded: true,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
        providerUpdatedAt: T1,
        providerObservedAt: T1,
      };
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);
  const request = {
    agentId,
    conversationId: '66666666-6666-4666-8666-666666666666',
    expectedControlEpoch: 0,
    at: T1,
  };

  const first = manager.executeClaimedSpecialistProvider('job.coder', request);
  await enteredEffect;
  const second = manager.executeClaimedSpecialistProvider('job.coder', request);

  assert.equal(first, second);
  assert.equal(calls, 1);

  releaseEffect();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.kind, 'SPECIALIST_PROVIDER_SUCCEEDED');
  assert.deepEqual(secondResult, firstResult);
  assert.equal(calls, 1);

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 1);
  assert.equal(durable.providerExecutions[0].status, 'PROVIDER_SUCCEEDED');
});


test('stale caller timestamp cannot extend an expired Specialist provider lease', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  const client = {
    async execute() {
      calls += 1;
      throw new Error('expired lease must not dispatch');
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);

  // seed() leases at T0 for 600 seconds. Move the live authority clock beyond
  // expiry while deliberately supplying an old pre-expiry request timestamp.
  clock.value = Date.parse('2026-09-29T04:11:00.000Z');

  await assert.rejects(
    () => manager.executeClaimedSpecialistProvider('job.coder', {
      agentId,
      conversationId: '77777777-7777-4777-8777-777777777777',
      expectedControlEpoch: 0,
      at: T1,
    }),
    /lease expired before provider preparation/,
  );
  assert.equal(calls, 0);

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 0);
});


test('future caller timestamp is rejected before durable PREPARED or provider effect', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T1) };
  let calls = 0;
  const client = {
    async execute() {
      calls += 1;
      throw new Error('future chronology must not dispatch');
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);

  await assert.rejects(
    () => manager.executeClaimedSpecialistProvider('job.coder', {
      agentId,
      conversationId: '88888888-8888-4888-8888-888888888888',
      expectedControlEpoch: 0,
      at: T2,
    }),
    /execute at cannot be in the future/,
  );
  assert.equal(calls, 0);

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 0);
});


test('provider execution validation preserves the asynchronous rejected-Promise contract', async () => {
  const { chrome } = chromeStorage();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T0),
    specialistProviderClients: new Map(),
  });

  const rejection = manager.executeClaimedSpecialistProvider('job.missing', {});
  assert.ok(rejection instanceof Promise);
  await assert.rejects(
    rejection,
    /requires agentId/,
  );
});


test('accessor-backed provider outcome is never executed and is durably reconciled', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let getterCalls = 0;
  const client = {
    async execute() {
      const outcome = {
        providerSucceeded: true,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'must-not-be-trusted',
      };
      Object.defineProperty(outcome, 'providerStatus', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 'finished';
        },
      });
      return outcome;
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '99999999-9999-4999-8999-999999999999',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(getterCalls, 0);
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_RECONCILE');
  assert.equal(result.execution.status, 'RECONCILE');
  assert.equal(result.execution.errorCode, 'SPECIALIST_PROVIDER_INVALID_OUTCOME');

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.executionOwnerships[0].state, 'RECONCILE');
  assert.equal(durable.executionOwnerships[0].leaseId, result.execution.leaseId);
});

test('semantically invalid plain provider outcome is fenced into canonical reconciliation', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  const client = {
    async execute() {
      return {
        providerStatus: 'finished',
        providerSucceeded: false,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'contradictory-terminal-evidence',
        providerUpdatedAt: T1,
        providerObservedAt: T1,
      };
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(result.kind, 'SPECIALIST_PROVIDER_RECONCILE');
  assert.equal(result.execution.status, 'RECONCILE');
  assert.equal(result.execution.errorCode, 'SPECIALIST_PROVIDER_INVALID_OUTCOME');
  assert.equal(result.execution.safeToRetry, false);

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.executionOwnerships[0].state, 'RECONCILE');
});


test('retryable pre-effect provider failure enters canonical reconciliation before any retry', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  const client = {
    async execute() {
      throw new OpenHandsCodingSpecialistError('provider unavailable before effect', {
        code: 'OPENHANDS_PROVIDER_UNAVAILABLE',
        conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        effectMayHaveOccurred: false,
        reconciliationRequired: false,
        safeToRetry: true,
      });
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(result.kind, 'SPECIALIST_PROVIDER_FAILURE');
  assert.equal(result.execution.status, 'RETRYABLE_FAILURE');
  assert.equal(result.execution.safeToRetry, true);
  assert.equal(result.execution.reconciliationRequired, false);

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.executionOwnerships[0].state, 'RECONCILE');
  assert.equal(durable.executionOwnerships[0].leaseId, result.execution.leaseId);
  assert.equal(durable.handoffs[0].state, 'LEASED');
});


test('historical terminal provider execution from a prior lease does not block a newly claimed lease', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  const client = {
    async execute() {
      calls += 1;
      return {
        providerStatus: 'finished',
        providerSucceeded: true,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
        providerUpdatedAt: T1,
        providerObservedAt: T1,
      };
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];

  const priorPrepared = createSpecialistProviderExecutionV1({
    planId: current.job.runtime.plan.planId,
    nodeId: current.job.runtime.plan.nodes[0].nodeId,
    agentId,
    handoffId: provenance.handoff.handoffId,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    leaseId: 'lease:prior-safe-retry',
    leaseUntil: T2,
    conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    providerConfig: providerConfig(),
    at: T0,
  });
  const priorRetryable = recordSpecialistProviderExecutionOutcomeV1(priorPrepared, {
    providerStatus: '',
    providerSucceeded: false,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: true,
    effectEvidence: '',
    errorCode: 'OPENHANDS_PROVIDER_UNAVAILABLE',
    providerUpdatedAt: '',
    providerObservedAt: '',
    at: T1,
  });
  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = [priorRetryable];
    return store;
  });
  clock.value = Date.parse(T1);

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(result.kind, 'SPECIALIST_PROVIDER_SUCCEEDED');
  assert.equal(calls, 1);
  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 2);
  assert.ok(durable.providerExecutions.some(item => item.leaseId === 'lease:prior-safe-retry'));
  assert.ok(durable.providerExecutions.some(item => item.leaseId === assignment.leaseId));
});


test('bounded provider execution history retains the newest PREPARED record before the 129th effect', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  let manager;
  const currentConversationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const client = {
    async execute() {
      calls += 1;
      const duringEffect = await manager.listSpecialistHandoffs('job.coder');
      assert.equal(duringEffect.providerExecutions.length, 128);
      assert.ok(duringEffect.providerExecutions.some(item =>
        item.conversationId === currentConversationId && item.status === 'PREPARED'));
      assert.ok(!duringEffect.providerExecutions.some(item =>
        item.leaseId === 'lease:historical-0'));
      return {
        providerStatus: 'finished',
        providerSucceeded: true,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
        providerUpdatedAt: T1,
        providerObservedAt: T1,
      };
    },
  };
  manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const provenance = current.job.runtime.specialistSelectionProvenance[0];

  const historical = Array.from({ length: 128 }, (_, index) => {
    const prepared = createSpecialistProviderExecutionV1({
      planId: current.job.runtime.plan.planId,
      nodeId: current.job.runtime.plan.nodes[0].nodeId,
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: `lease:historical-${index}`,
      leaseUntil: T2,
      conversationId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      providerConfig: providerConfig(),
      at: T0,
    });
    return recordSpecialistProviderExecutionOutcomeV1(prepared, {
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: true,
      effectEvidence: '',
      errorCode: 'OPENHANDS_PROVIDER_UNAVAILABLE',
      providerUpdatedAt: '',
      providerObservedAt: '',
      at: T1,
    });
  });
  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = historical;
    return store;
  });
  clock.value = Date.parse(T1);

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: currentConversationId,
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(calls, 1);
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_SUCCEEDED');
  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 128);
  assert.ok(durable.providerExecutions.some(item => item.conversationId === currentConversationId));
});


test('restart retention keeps the newest 128 provider execution records', async () => {
  const { chrome } = chromeStorage();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T0),
    specialistProviderClients: new Map(),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  const store = await manager.load();

  store.byId['job.coder'].runtime.specialistProviderExecutions = Array.from({ length: 130 }, (_, index) =>
    createSpecialistProviderExecutionV1({
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: `lease:${index}`,
      leaseUntil: assignment.leaseExpiresAt,
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerConfig: providerConfig(),
      at: T0,
    }));
  await chrome.storage.local.set({ [BROWSER_AGENT_STORAGE_KEY]: store });

  const restarted = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T0),
    specialistProviderClients: new Map(),
  });
  const durable = await restarted.listSpecialistHandoffs('job.coder');

  assert.equal(durable.providerExecutions.length, 128);
  assert.equal(durable.providerExecutions[0].leaseId, 'lease:2');
  assert.equal(durable.providerExecutions.at(-1).leaseId, 'lease:129');
});

test('ambiguous provider outcome observed after lease expiry still enters canonical reconciliation', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  const client = {
    async execute() {
      clock.value = Date.parse('2026-09-29T04:11:00.000Z');
      throw new OpenHandsCodingSpecialistError('late ambiguous timeout', {
        code: 'OPENHANDS_REQUEST_TIMEOUT',
        conversationId: '77777777-7777-4777-8777-777777777777',
        effectMayHaveOccurred: true,
        reconciliationRequired: true,
        safeToRetry: false,
      });
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);
  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '77777777-7777-4777-8777-777777777777',
    expectedControlEpoch: 0,
    at: T1,
  });
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_RECONCILE');
  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.executionOwnerships[0].state, 'RECONCILE');
  assert.equal(durable.executionOwnerships[0].leaseId, durable.handoffs[0].leaseId);
});

test('provider attempt guard is scoped to the current lease rather than agent identity', async () => {
  const { chrome } = chromeStorage();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T1),
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, {
      async execute() {
        return {
          providerStatus: 'finished',
          providerSucceeded: true,
          manualReviewRequired: false,
          reconciliationRequired: false,
          safeToRetry: false,
          effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
          providerUpdatedAt: T1,
          providerObservedAt: T1,
        };
      },
    }]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = [{
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: 'lease:prior-attempt:1',
      leaseUntil: '2026-09-29T04:10:00.000Z',
      conversationId: '88888888-8888-4888-8888-888888888888',
      providerConfig: providerConfig(),
      status: 'RECONCILE',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: true,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: 'OPENHANDS_REQUEST_TIMEOUT',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }];
    return store;
  });
  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '99999999-9999-4999-8999-999999999999',
    expectedControlEpoch: 0,
    at: T1,
  });
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_SUCCEEDED');
  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 2);
  assert.equal(durable.providerExecutions[0].leaseId, 'lease:prior-attempt:1');
  assert.equal(durable.providerExecutions[1].leaseId, assignment.leaseId);
});

test('provider attempt history capacity fails closed before the 129th dispatch while exact PREPARED resume remains allowed', async () => {
  const { chrome } = chromeStorage();
  let calls = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T1),
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, {
      async execute() {
        calls += 1;
        throw new Error('provider must not be called after history capacity is exhausted');
      },
    }]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];

  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = Array.from({ length: 128 }, (_, index) => ({
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: `lease:history:${index + 1}`,
      leaseUntil: T2,
      conversationId: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      providerConfig: providerConfig(),
      status: 'RECONCILE',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: true,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: 'OPENHANDS_REQUEST_TIMEOUT',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }));
    return store;
  });

  await assert.rejects(
    () => manager.executeClaimedSpecialistProvider('job.coder', {
      agentId,
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedControlEpoch: 0,
      at: T1,
    }),
    /history capacity exhausted/,
  );
  assert.equal(calls, 0);

  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 128);
  assert.equal(durable.handoffs[0].leaseId, assignment.leaseId);
});


test('history capacity still permits exact PREPARED resume for the current lease', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  const client = {
    async execute() {
      calls += 1;
      return {
        providerStatus: 'finished',
        providerSucceeded: true,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
        providerUpdatedAt: T1,
        providerObservedAt: T1,
      };
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  await manager.update(store => {
    const history = Array.from({ length: 127 }, (_, index) => ({
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: `lease:history-resume:${index + 1}`,
      leaseUntil: T2,
      conversationId: `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      providerConfig: providerConfig(),
      status: 'RECONCILE',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: true,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: 'OPENHANDS_REQUEST_TIMEOUT',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }));
    store.byId['job.coder'].runtime.specialistProviderExecutions = [...history, {
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: assignment.leaseId,
      leaseUntil: assignment.leaseExpiresAt,
      conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      providerConfig: providerConfig(),
      status: 'PREPARED',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: '',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }];
    return store;
  });
  clock.value = Date.parse(T1);

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(result.kind, 'SPECIALIST_PROVIDER_SUCCEEDED');
  assert.equal(calls, 1);
  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 128);
  assert.equal(durable.providerExecutions.at(-1).status, 'PROVIDER_SUCCEEDED');
});


test('expired PREPARED recovery owner drift still enters reconciliation', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let calls = 0;
  const client = { async execute() { calls += 1; throw new Error('must not dispatch'); } };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  await manager.update(store => {
    store.byId['job.coder'].runtime.specialistProviderExecutions = [{
      schemaVersion: 1,
      planId: 'plan:job.coder',
      nodeId: 'local:code',
      agentId,
      handoffId: provenance.handoff.handoffId,
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      leaseId: assignment.leaseId,
      leaseUntil: assignment.leaseExpiresAt,
      conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      providerConfig: providerConfig(),
      status: 'PREPARED',
      providerStatus: '',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: false,
      effectEvidence: '',
      errorCode: '',
      providerUpdatedAt: '',
      providerObservedAt: '',
      preparedAt: T0,
      updatedAt: T0,
    }];
    return store;
  });
  clock.value = Date.parse(T1);

  const originalGet = manager.get.bind(manager);
  let injected = false;
  manager.get = async id => {
    const value = await originalGet(id);
    if (!injected) {
      injected = true;
      clock.value = Date.parse('2026-09-29T04:11:00.000Z');
      await manager.update(store => {
        store.byId[id].runtime.controlEpoch += 1;
        store.byId[id].runtime.runState = 'PAUSED';
        return store;
      });
    }
    return value;
  };

  const result = await manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    expectedControlEpoch: 0,
    at: T1,
  });

  assert.equal(calls, 0);
  assert.equal(result.kind, 'SPECIALIST_PROVIDER_RECONCILE');
  assert.equal(result.execution.status, 'RECONCILE');
  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.executionOwnerships[0].state, 'RECONCILE');
  assert.equal(durable.executionOwnerships[0].leaseId, assignment.leaseId);
});



test('corrupt durable provider execution fails closed across restart and Start', async () => {
  const { chrome } = chromeStorage();
  let calls = 0;
  const client = { async execute() { calls += 1; throw new Error('must not dispatch'); } };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T0),
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  const current = await manager.get('job.coder');
  const assignment = current.job.runtime.specialistHandoffs[0];
  const provenance = current.job.runtime.specialistSelectionProvenance[0];
  const valid = createSpecialistProviderExecutionV1({
    planId: 'plan:job.coder',
    nodeId: 'local:code',
    agentId,
    handoffId: provenance.handoff.handoffId,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    leaseId: assignment.leaseId,
    leaseUntil: assignment.leaseExpiresAt,
    conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    providerConfig: providerConfig(),
    at: T0,
  });
  const corrupt = structuredClone(valid);
  corrupt.providerConfig.revision = 'corrupt';

  const store = await manager.load();
  store.byId['job.coder'].runtime.specialistProviderExecutions = [corrupt];
  await chrome.storage.local.set({ [BROWSER_AGENT_STORAGE_KEY]: store });

  const restarted = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T1),
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });

  const afterRestart = await restarted.get('job.coder');
  assert.equal(afterRestart.job.runtime.specialistProviderExecutionIntegrityFault, true);
  assert.equal(afterRestart.job.runtime.runState, 'ERROR');
  assert.match(afterRestart.job.runtime.lastError, /execution integrity fault/);
  assert.equal(afterRestart.job.runtime.specialistProviderExecutions.length, 0);

  await assert.rejects(
    () => restarted.executeClaimedSpecialistProvider('job.coder', {
      agentId,
      conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expectedControlEpoch: 0,
      at: T1,
    }),
    /execution integrity fault requires explicit reconciliation/,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    () => restarted.start('job.coder', { runInitial: false }),
    /execution integrity fault requires explicit reconciliation before Start/,
  );
  assert.equal(calls, 0);
  const final = await restarted.get('job.coder');
  assert.equal(final.job.runtime.specialistProviderExecutionIntegrityFault, true);
  assert.equal(final.job.runtime.runState, 'ERROR');
});

test('live PREPARED execution fences provider config mutation until external effect resolves', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const client = {
    async execute() {
      entered();
      await gate;
      return {
        providerStatus: 'finished',
        providerSucceeded: true,
        manualReviewRequired: false,
        reconciliationRequired: false,
        safeToRetry: false,
        effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
        providerUpdatedAt: T1,
        providerObservedAt: T1,
      };
    },
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, client]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);
  const pending = manager.executeClaimedSpecialistProvider('job.coder', {
    agentId,
    conversationId: '77777777-7777-4777-8777-777777777777',
    expectedControlEpoch: 0,
    at: T1,
  });
  await started;

  // Lease expiry alone cannot release provider-config authority while the
  // already-dispatched external effect remains unresolved.
  const afterLease = '2026-09-29T04:11:00.000Z';
  clock.value = Date.parse(afterLease);
  await assert.rejects(
    () => manager.putSpecialistProviderConfig({
      providerConfig: providerConfig(2, afterLease),
      expectedRevision: 1,
    }),
    /bound to a live provider execution/,
  );
  await assert.rejects(
    () => manager.clearSpecialistProviderConfig({
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      expectedRevision: 1,
    }),
    /bound to a live provider execution/,
  );

  release();
  const outcome = await pending;
  assert.equal(outcome.execution.status, 'PROVIDER_SUCCEEDED');
});


test('trusted readiness dependency rejects accessor methods without invoking getters', async () => {
  const { chrome } = chromeStorage();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(T1),
  });
  let getterCalls = 0;
  const resolver = Object.create(null);
  Object.defineProperty(resolver, 'resolve', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => ({});
    },
  });
  Object.defineProperty(resolver, 'assertCurrent', {
    enumerable: true,
    value: async () => true,
  });

  await assert.rejects(
    Promise.resolve().then(() => manager.executeClaimedSpecialistProvider(
      'missing.job',
      {
        agentId: 'agent:test',
        conversationId: '88888888-8888-4888-8888-888888888888',
        expectedControlEpoch: 0,
      },
      { specialistProviderReadinessResolver: resolver },
    )),
    /readiness resolver\.resolve must be a data method/,
  );
  assert.equal(getterCalls, 0);
});


test('trusted readiness result rejects accessor-backed authority fields without invoking getters', async () => {
  const { chrome } = chromeStorage();
  const clock = { value: Date.parse(T0) };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => clock.value,
    specialistProviderClients: new Map([[OPENHANDS_CODING_PROVIDER_ID, {
      async execute() { throw new Error('must not dispatch'); },
    }]]),
  });
  const agentId = await seed(manager);
  clock.value = Date.parse(T1);
  let getterCalls = 0;
  const resolver = {
    async resolve() {
      const readiness = Object.create(null);
      Object.defineProperty(readiness, 'trustedResolverInvoked', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return true;
        },
      });
      return readiness;
    },
    async assertCurrent() {
      throw new Error('must not reach readiness revalidation');
    },
  };

  await assert.rejects(
    () => manager.executeClaimedSpecialistProvider(
      'job.coder',
      {
        agentId,
        conversationId: '99999999-9999-4999-8999-999999999999',
        expectedControlEpoch: 0,
        at: T1,
      },
      { specialistProviderReadinessResolver: resolver },
    ),
    /not executable according to trusted readiness/,
  );
  assert.equal(getterCalls, 0);
  const durable = await manager.listSpecialistHandoffs('job.coder');
  assert.equal(durable.providerExecutions.length, 0);
});

