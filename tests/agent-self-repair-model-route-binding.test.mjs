import test from 'node:test';
import assert from 'node:assert/strict';

import {
  materializeAgentDefinitionV1,
  selectAgentDefinitionV1,
} from '../src/core/agent-definition-registry.js';
import {
  createAgentDefinitionModelPolicyBindingV1,
} from '../src/core/agent-definition-model-policy-binding.js';
import {
  AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
} from '../src/core/agent-self-repair-model-binding.js';
import {
  AGENT_SELF_REPAIR_MODEL_DISPATCH_BINDING_AUTHORITY,
  AGENT_SELF_REPAIR_MODEL_ROUTE_BINDING_AUTHORITY,
  createBoundAgentSelfRepairModelDispatchV1,
  rankBoundAgentSelfRepairModelCandidatesV1,
} from '../src/core/agent-self-repair-model-route-binding.js';

function route(routeId, overrides = {}) {
  return {
    schemaVersion: 1,
    routeId,
    provider: 'openai',
    model: 'model-' + routeId,
    endpointId: '',
    displayName: routeId,
    systemPrompt: '',
    workerPrompt: '',
    roles: ['planner', 'coder', 'fast-worker', 'verifier'],
    capabilityIds: ['cap.reason', 'cap.code'],
    priority: 10,
    enabled: true,
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
    supportsVision: false,
    maxWorkers: 4,
    ...overrides,
  };
}

function pool() {
  return [
    route('route.a', { priority: 20, capabilityIds: ['cap.reason', 'cap.code'] }),
    route('route.b', { priority: 10, capabilityIds: ['cap.reason'] }),
    route('route.c', { priority: 100, capabilityIds: ['cap.reason', 'cap.code'] }),
  ];
}

function definition() {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.repair-worker',
    label: 'Repair worker',
    description: 'Bound repair and verification worker.',
    instructions: 'Work only inside the admitted repair scope.',
    capabilityIds: ['project.context'],
    toolIds: ['files.read'],
    tags: ['repair'],
    acceptanceCriteria: ['Return bounded evidence.'],
    configDefaults: {
      maxSteps: 40,
      maxModelCalls: 10,
      maxRuntimeMinutes: 10,
    },
    modelRoutePolicy: {
      autoSwitch: true,
      pinnedRouteId: '',
      orderedRouteIds: ['route.b', 'route.a'],
      allowRouteIds: ['route.a', 'route.b'],
      denyRouteIds: [],
      freeOnly: false,
      locality: 'remote',
      maxInputPricePerMillionUsd: 4,
      maxOutputPricePerMillionUsd: 5,
    },
    enabled: true,
    definitionRevision: 4,
  };
}

function registry() {
  return {
    schemaVersion: 1,
    registryId: 'agents:project.alpha',
    revision: 6,
    definitions: [definition()],
  };
}

function selection() {
  return selectAgentDefinitionV1({
    registry: registry(),
    agentDefinitionId: 'agent.repair-worker',
  });
}

function ownerBudget() {
  return {
    maxSteps: 100,
    maxModelCalls: 30,
    maxInputTokens: 200_000,
    maxOutputTokens: 20_000,
    maxTotalTokens: 220_000,
    maxOutputTokensPerCall: 4096,
    maxRuntimeMinutes: 60,
    maxCostUsd: 5,
    inputPricePerMillionUsd: 3,
    outputPricePerMillionUsd: 6,
  };
}

function definitionBinding(ownerId) {
  const reg = registry();
  const selected = selection();
  const mat = materializeAgentDefinitionV1({
    registry: reg,
    selection: selected,
    jobId: ownerId,
    projectId: 'project.alpha',
    goal: 'Repair or independently retest the failed work.',
    ownerBudget: ownerBudget(),
    ownerCapabilityIds: ['project.context'],
    ownerToolIds: ['files.read'],
    requestedCapabilityIds: ['project.context'],
    requestedToolIds: ['files.read'],
  });
  return createAgentDefinitionModelPolicyBindingV1({
    materializedAgent: mat,
    currentDefinitionSelection: selected,
    currentJobId: ownerId,
    currentProjectId: 'project.alpha',
    routePool: pool(),
    routePoolRevision: 9,
    ownerAllowedRouteIds: ['route.a', 'route.b', 'route.c'],
  });
}

function intentBindingKey(value) {
  return JSON.stringify([
    1,
    value.planId,
    value.jobId,
    value.cycleId,
    value.failedNodeId,
    value.originPlanRevision,
    value.currentPlanRevision,
    value.proposedPlanRevision ?? null,
    value.failedNodeRevisionId,
    value.verifierPlanRevisionId,
    value.cycleState,
    value.workKind,
    value.activeAttemptNumber,
    value.currentSubjectRevisionId,
    value.evidenceTrust,
    value.actorId,
    value.verifierId,
    value.nodeId,
    value.ownerId,
    value.executionPlane ?? null,
    value.workBudget
      ? [
        value.workBudget.maxModelCalls,
        value.workBudget.maxRuntimeSeconds,
        value.workBudget.maxCostUsdMicros,
      ]
      : null,
    value.routeIntent
      ? [
        value.routeIntent.role,
        value.routeIntent.capabilityIds,
        value.routeIntent.requiresVision,
      ]
      : null,
  ]);
}

function activeIntent({
  workKind = 'REPAIR',
  role = 'coder',
  capabilityIds = ['cap.code'],
  requiresVision = false,
} = {}) {
  const retest = workKind === 'RETEST';
  const value = {
    schemaVersion: 1,
    planId: 'plan-repair',
    jobId: 'job-repair',
    cycleId: 'cycle-repair-1',
    failedNodeId: 'failed-node',
    originPlanRevision: 7,
    currentPlanRevision: retest ? 9 : 7,
    proposedPlanRevision: retest ? 10 : 8,
    failedNodeRevisionId: 'failed-revision-1',
    verifierPlanRevisionId: 'verifier-plan-r1',
    cycleState: retest ? 'READY_FOR_RETEST' : 'READY_FOR_REPAIR',
    workKind,
    activeAttemptNumber: 1,
    currentSubjectRevisionId: retest ? 'subject-revision-2' : 'failed-revision-1',
    evidenceTrust: 'UNVERIFIED_INPUT',
    requiresCanonicalEvidenceResolution: true,
    actorId: 'actor-1',
    verifierId: 'verifier-1',
    nodeId: retest ? 'retest-node-1' : 'repair-node-1',
    ownerId: retest ? 'verifier-1' : 'actor-1',
    executionPlane: 'LOCAL',
    workBudget: {
      maxModelCalls: 2,
      maxRuntimeSeconds: 120,
      maxCostUsdMicros: 100_000,
    },
    routeIntent: {
      role,
      capabilityIds: [...capabilityIds].sort(),
      requiresVision,
    },
    ...AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
  };
  value.bindingKey = intentBindingKey(value);
  return value;
}

function terminalIntent() {
  const value = {
    schemaVersion: 1,
    planId: 'plan-repair',
    jobId: 'job-repair',
    cycleId: 'cycle-repair-1',
    failedNodeId: 'failed-node',
    originPlanRevision: 7,
    currentPlanRevision: 10,
    failedNodeRevisionId: 'failed-revision-1',
    verifierPlanRevisionId: 'verifier-plan-r1',
    cycleState: 'VERIFIED',
    workKind: 'VERIFIED',
    activeAttemptNumber: 0,
    currentSubjectRevisionId: 'subject-revision-2',
    evidenceTrust: 'UNVERIFIED_INPUT',
    requiresCanonicalEvidenceResolution: true,
    actorId: 'actor-1',
    verifierId: 'verifier-1',
    nodeId: null,
    ownerId: null,
    workBudget: null,
    routeIntent: null,
    ...AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
  };
  value.bindingKey = intentBindingKey(value);
  return value;
}

function request(intent = activeIntent(), overrides = {}) {
  const binding = definitionBinding(intent.ownerId);
  return {
    selfRepairModelIntent: intent,
    currentSelfRepairModelBindingKey: intent.bindingKey,
    definitionModelPolicyBinding: binding,
    currentDefinitionModelPolicyBindingKey: binding.bindingKey,
    currentDefinitionSelection: selection(),
    currentJobId: intent.ownerId,
    currentProjectId: 'project.alpha',
    currentRoutePoolRevision: 9,
    routes: pool(),
    routeStates: {},
    now: 1_790_620_000_000,
    ...overrides,
  };
}

test('REPAIR route role/capabilities come only from durable self-repair intent', () => {
  const intent = activeIntent({ role: 'coder', capabilityIds: ['cap.code'] });
  const result = rankBoundAgentSelfRepairModelCandidatesV1(request(intent));

  assert.equal(result.workKind, 'REPAIR');
  assert.equal(result.ownerId, 'actor-1');
  assert.equal(result.routeIntent.role, 'coder');
  assert.deepEqual(result.routeIntent.capabilityIds, ['cap.code']);
  assert.equal(result.candidates.role, 'coder');
  assert.deepEqual(result.candidates.availableRouteIds, ['route.a']);
  assert.equal(result.candidates.preferredRouteId, 'route.a');
  assert.equal(result.candidates.availableRouteIds.includes('route.c'), false);
  assert.deepEqual(result.authority, AGENT_SELF_REPAIR_MODEL_ROUTE_BINDING_AUTHORITY);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidates), true);
});

test('RETEST binds independent verifier Agent identity to verifier candidates', () => {
  const intent = activeIntent({
    workKind: 'RETEST',
    role: 'verifier',
    capabilityIds: ['cap.reason'],
  });
  const result = rankBoundAgentSelfRepairModelCandidatesV1(request(intent));

  assert.equal(result.workKind, 'RETEST');
  assert.equal(result.ownerId, 'verifier-1');
  assert.equal(result.routeIntent.role, 'verifier');
  assert.equal(result.candidates.jobId, 'verifier-1');
  assert.deepEqual(result.candidates.availableRouteIds, ['route.b', 'route.a']);
  assert.equal(result.candidates.preferredRouteId, 'route.b');
});

test('REPAIR dispatch reuses durable role intent and resolves exact provider identity', () => {
  const intent = activeIntent({ role: 'coder', capabilityIds: ['cap.code'] });
  const result = createBoundAgentSelfRepairModelDispatchV1(request(intent));

  assert.equal(result.workKind, 'REPAIR');
  assert.equal(result.ownerId, 'actor-1');
  assert.equal(result.routeIntent.role, 'coder');
  assert.equal(result.dispatchIntent.role, 'coder');
  assert.equal(result.dispatchIntent.routeId, 'route.a');
  assert.deepEqual(result.dispatchIntent.route, {
    routeId: 'route.a',
    provider: 'openai',
    model: 'model-route.a',
    endpointId: '',
  });
  assert.deepEqual(result.authority, AGENT_SELF_REPAIR_MODEL_DISPATCH_BINDING_AUTHORITY);
  assert.equal(result.authority.providerCallAuthorized, false);
});

test('RETEST dispatch stays bound to the independent verifier route role', () => {
  const intent = activeIntent({
    workKind: 'RETEST',
    role: 'verifier',
    capabilityIds: ['cap.reason'],
  });
  const result = createBoundAgentSelfRepairModelDispatchV1(request(intent));

  assert.equal(result.ownerId, 'verifier-1');
  assert.equal(result.dispatchIntent.jobId, 'verifier-1');
  assert.equal(result.dispatchIntent.role, 'verifier');
  assert.equal(result.dispatchIntent.routeId, 'route.b');
});

test('self-repair dispatch preserves expected-preference TOCTOU assertion', () => {
  const intent = activeIntent({ role: 'coder', capabilityIds: ['cap.code'] });
  assert.throws(
    () => createBoundAgentSelfRepairModelDispatchV1(request(intent, {
      expectedPreferredRouteId: 'route.b',
    })),
    /preference changed before dispatch preparation/u,
  );
});

test('stale self-repair binding key and Agent owner substitution fail closed', () => {
  const intent = activeIntent();
  assert.throws(
    () => rankBoundAgentSelfRepairModelCandidatesV1(request(intent, {
      currentSelfRepairModelBindingKey: intent.bindingKey + ':stale',
    })),
    /not the current owner binding/u,
  );

  assert.throws(
    () => rankBoundAgentSelfRepairModelCandidatesV1(request(intent, {
      currentJobId: 'verifier-1',
    })),
    /route owner does not match current Agent identity/u,
  );
});

test('terminal self-repair state cannot resurrect model routing', () => {
  const intent = terminalIntent();
  assert.throws(
    () => rankBoundAgentSelfRepairModelCandidatesV1({
      selfRepairModelIntent: intent,
      currentSelfRepairModelBindingKey: intent.bindingKey,
      currentJobId: 'actor-1',
    }),
    /has no model route candidates/u,
  );
});

test('caller cannot override durable role, capabilities, vision or route authority', () => {
  for (const extra of [
    { role: 'verifier' },
    { capabilityIds: ['cap.reason'] },
    { requiresVision: true },
    { preferredRouteId: 'route.c' },
    { routeSelectionAuthorized: true },
    { providerCallAuthorized: true },
  ]) {
    assert.throws(
      () => rankBoundAgentSelfRepairModelCandidatesV1({
        ...request(),
        ...extra,
      }),
      /contains unknown field/u,
    );
  }
});

test('dispatch adapter rejects caller routing aliases before canonical dispatch', () => {
  for (const extra of [
    { role: 'verifier' },
    { capabilityIds: ['cap.reason'] },
    { requiresVision: true },
    { provider: 'forged' },
    { model: 'forged' },
    { providerCallAuthorized: true },
  ]) {
    assert.throws(
      () => createBoundAgentSelfRepairModelDispatchV1({
        ...request(),
        ...extra,
      }),
      /contains unknown field/u,
    );
  }
});

test('top-level accessors are rejected without executing caller code', () => {
  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'currentJobId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'actor-1';
    },
  });

  assert.throws(
    () => rankBoundAgentSelfRepairModelCandidatesV1(hostile),
    /currentJobId must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);
});
