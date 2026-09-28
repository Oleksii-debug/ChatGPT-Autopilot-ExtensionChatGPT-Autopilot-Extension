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
  AGENT_SELF_REPAIR_MODEL_ORCHESTRATOR_BINDING_AUTHORITY,
  AGENT_SELF_REPAIR_MODEL_ROUTE_BINDING_AUTHORITY,
  createBoundAgentSelfRepairModelDispatchV1,
  createBoundAgentSelfRepairModelOrchestratorEnvelopeV1,
  rankBoundAgentSelfRepairModelCandidatesV1,
} from '../src/core/agent-self-repair-model-route-binding.js';
import { CoreCommandDispatcher } from '../src/core/commands.js';
import { createEmptyState, validateState } from '../src/core/schema.js';

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

function routerSettings(overrides = {}) {
  return {
    enabled: true,
    gatewayUrl: 'http://127.0.0.1:3210',
    timeoutSeconds: 180,
    mode: 'primary',
    primary: { provider: 'ollama', model: 'legacy' },
    strong: { provider: 'openai', model: 'strong' },
    routes: pool(),
    routePolicy: {
      autoSwitch: true,
      pinnedRouteId: '',
      orderedRouteIds: ['route.b', 'route.a', 'route.c'],
      allowRouteIds: ['route.a', 'route.b', 'route.c'],
      denyRouteIds: [],
      freeOnly: false,
      locality: 'remote',
      maxInputPricePerMillionUsd: 4,
      maxOutputPricePerMillionUsd: 5,
    },
    ...overrides,
  };
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

function orchestratorRequest(intent = activeIntent(), overrides = {}) {
  return {
    ...request(intent),
    currentRouterSettings: routerSettings(),
    currentRouterRuntime: { routeStates: {} },
    currentNow: 1_790_620_000_100,
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
  assert.deepEqual(result.dispatchIntent.capabilityIds, ['cap.code']);
  assert.equal(result.dispatchIntent.preparedAt, 1_790_620_000_000);
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
  assert.deepEqual(result.dispatchIntent.capabilityIds, ['cap.reason']);
  assert.equal(result.dispatchIntent.preparedAt, 1_790_620_000_000);
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


test('provider-bound self-repair dispatch requires explicit deterministic time', () => {
  const input=request();
  delete input.now;
  assert.throws(
    () => createBoundAgentSelfRepairModelDispatchV1(input),
    /requires explicit now/u,
  );

  const candidates=rankBoundAgentSelfRepairModelCandidatesV1(input);
  assert.equal(candidates.workKind,'REPAIR');
});


test('REPAIR composes the current Router-authorized single-route orchestrator envelope', () => {
  const intent=activeIntent({role:'coder',capabilityIds:['cap.code']});
  const result=createBoundAgentSelfRepairModelOrchestratorEnvelopeV1(
    orchestratorRequest(intent),
  );

  assert.equal(result.workKind,'REPAIR');
  assert.equal(result.ownerId,'actor-1');
  assert.equal(result.orchestratorEnvelope.jobId,'actor-1');
  assert.equal(result.orchestratorEnvelope.routeId,'route.a');
  assert.deepEqual(result.orchestratorEnvelope.settings.routes.map(route=>route.routeId),['route.a']);
  assert.deepEqual(result.orchestratorEnvelope.capabilityIds,['cap.code']);
  assert.equal(result.orchestratorEnvelope.preparedAt,1_790_620_000_000);
  assert.equal(result.orchestratorEnvelope.revalidatedAt,1_790_620_000_100);
  assert.deepEqual(result.authority,AGENT_SELF_REPAIR_MODEL_ORCHESTRATOR_BINDING_AUTHORITY);
  assert.equal(result.authority.orchestratorInvocationAuthorized,false);
  assert.equal(result.authority.providerCallAuthorized,false);
});

test('RETEST composes verifier route without borrowing repair-worker authority', () => {
  const intent=activeIntent({
    workKind:'RETEST',
    role:'verifier',
    capabilityIds:['cap.reason'],
  });
  const result=createBoundAgentSelfRepairModelOrchestratorEnvelopeV1(
    orchestratorRequest(intent),
  );

  assert.equal(result.ownerId,'verifier-1');
  assert.equal(result.orchestratorEnvelope.jobId,'verifier-1');
  assert.equal(result.orchestratorEnvelope.role,'verifier');
  assert.equal(result.orchestratorEnvelope.routeId,'route.b');
  assert.deepEqual(result.orchestratorEnvelope.capabilityIds,['cap.reason']);
});

test('self-repair orchestrator composition cannot bypass current global Router deny or pin', () => {
  const intent=activeIntent({role:'coder',capabilityIds:['cap.code']});

  const denied=routerSettings();
  denied.routePolicy={...denied.routePolicy,denyRouteIds:['route.a']};
  assert.throws(
    ()=>createBoundAgentSelfRepairModelOrchestratorEnvelopeV1(
      orchestratorRequest(intent,{currentRouterSettings:denied}),
    ),
    /not currently authorized by canonical Router policy\/state/u,
  );

  const pinned=routerSettings();
  pinned.routePolicy={...pinned.routePolicy,pinnedRouteId:'route.c'};
  assert.throws(
    ()=>createBoundAgentSelfRepairModelOrchestratorEnvelopeV1(
      orchestratorRequest(intent,{currentRouterSettings:pinned}),
    ),
    /not currently authorized by canonical Router policy\/state/u,
  );
});

test('self-repair orchestrator composition re-observes current route backoff', () => {
  const now=1_790_620_000_100;
  assert.throws(
    ()=>createBoundAgentSelfRepairModelOrchestratorEnvelopeV1(
      orchestratorRequest(undefined,{
        currentNow:now,
        currentRouterRuntime:{
          routeStates:{
            'route.a':{backoffUntil:now+5_000},
          },
        },
      }),
    ),
    /not currently authorized by canonical Router policy\/state/u,
  );
});

test('self-repair orchestrator composition requires current revalidation time', () => {
  const input=orchestratorRequest();
  delete input.currentNow;
  assert.throws(
    ()=>createBoundAgentSelfRepairModelOrchestratorEnvelopeV1(input),
    /currentNow is invalid/u,
  );
});


class InvocationMemoryRepo {
  constructor() {
    this.state = createEmptyState(1_000);
  }
  async load() {
    return structuredClone(this.state);
  }
  async update(mutator) {
    const draft = structuredClone(this.state);
    this.state = await mutator(draft) || draft;
    this.state.revision += 1;
    validateState(this.state);
    return structuredClone(this.state);
  }
}

for (const scenario of [
  {
    label: 'REPAIR',
    intent: () => activeIntent({ role:'coder', capabilityIds:['cap.code'] }),
    expectedOwner: 'actor-1',
    expectedRole: 'coder',
    expectedRoute: 'route.a',
    expectedCapabilities: ['cap.code'],
  },
  {
    label: 'RETEST',
    intent: () => activeIntent({
      workKind:'RETEST',
      role:'verifier',
      capabilityIds:['cap.reason'],
    }),
    expectedOwner: 'verifier-1',
    expectedRole: 'verifier',
    expectedRoute: 'route.b',
    expectedCapabilities: ['cap.reason'],
  },
]) {
  test(scenario.label + ' reaches canonical AiOrchestrator through the internal bounded envelope bridge', async () => {
    const composed = createBoundAgentSelfRepairModelOrchestratorEnvelopeV1(
      orchestratorRequest(scenario.intent()),
    );
    const repo = new InvocationMemoryRepo();
    const beforeSettings = structuredClone(repo.state.profile.aiRouter);
    const beforeRuntime = structuredClone(repo.state.profile.aiRouterRuntime);
    const calls = [];
    const dispatcher = new CoreCommandDispatcher(repo, () => 1_790_620_000_200, {
      aiOrchestrator: {
        async run(settings, runtime, prompt, options) {
          calls.push({
            settings: structuredClone(settings),
            runtime: structuredClone(runtime),
            prompt,
            options: structuredClone(options),
          });
          return {
            text: scenario.label.toLowerCase() + ' result',
            route: scenario.expectedRoute,
            primary: {
              provider: settings.routes[0].provider,
              model: settings.routes[0].model,
              routeId: settings.routes[0].routeId,
            },
            strong: null,
            runtime: {
              ...runtime,
              requestCount: runtime.requestCount + 1,
              lastRouteId: scenario.expectedRoute,
            },
          };
        },
      },
    });

    const result = await dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      {
        prompt: scenario.label + ' bounded work',
        maxOutputTokens: 256,
        maxModelCallsForRequest: 1,
      },
      {
        agentModelOrchestratorEnvelope: composed.orchestratorEnvelope,
        providerCallBudgetContext: { jobId: scenario.expectedOwner },
      },
    );

    assert.equal(result.result.text, scenario.label.toLowerCase() + ' result');
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].settings.routes.map(item => item.routeId),
      [scenario.expectedRoute],
    );
    assert.equal(calls[0].settings.routePolicy.pinnedRouteId, scenario.expectedRoute);
    assert.equal(calls[0].options.taskRole, scenario.expectedRole);
    assert.equal(calls[0].options.strongTaskRole, scenario.expectedRole);
    assert.deepEqual(calls[0].options.capabilityIds, scenario.expectedCapabilities);
    assert.deepEqual(
      calls[0].options.providerCallBudgetContext,
      { jobId: scenario.expectedOwner },
    );
    assert.deepEqual(repo.state.profile.aiRouter, beforeSettings);
    assert.deepEqual(repo.state.profile.aiRouterRuntime, beforeRuntime);
  });
}
