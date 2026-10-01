import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../src/core/commands.js';
import { createEmptyState, validateState } from '../src/core/schema.js';
import {
  AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
} from '../src/core/agent-model-orchestrator-envelope.js';
import {
  AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
} from '../src/core/agent-self-repair-model-binding.js';
import {
  AGENT_SELF_REPAIR_MODEL_INVOCATION_AUTHORITY,
  prepareBoundAgentSelfRepairModelInvocationV1,
} from '../src/core/agent-self-repair-model-invocation.js';

class MemoryRepo {
  constructor(state = createEmptyState(1_000)) {
    this.state = structuredClone(state);
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

function envelopeForIntent(intent, overrides = {}) {
  const route = {
    schemaVersion: 1,
    routeId: 'route.agent',
    provider: 'openai',
    model: 'agent-model',
    endpointId: '',
    displayName: 'Agent model',
    systemPrompt: '',
    workerPrompt: '',
    roles: [intent.routeIntent.role],
    capabilityIds: [...intent.routeIntent.capabilityIds],
    priority: 20,
    enabled: true,
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
    supportsVision: intent.routeIntent.requiresVision,
    maxWorkers: 1,
  };
  return {
    schemaVersion: 1,
    jobId: intent.ownerId,
    projectId: 'project.alpha',
    definitionModelPolicyBindingKey: 'definition.binding',
    modelPolicyBindingKey: 'model.binding',
    routePoolRevision: 9,
    role: intent.routeIntent.role,
    capabilityIds: [...intent.routeIntent.capabilityIds],
    requiresVision: intent.routeIntent.requiresVision,
    preparedAt: 1_000,
    revalidatedAt: 1_500,
    routeId: 'route.agent',
    settings: {
      enabled: true,
      gatewayUrl: 'http://127.0.0.1:3210',
      timeoutSeconds: 180,
      mode: 'primary',
      primary: { provider: 'openai', model: 'agent-model' },
      strong: { provider: 'openai', model: 'unused' },
      routes: [route],
      routePolicy: {
        autoSwitch: false,
        pinnedRouteId: 'route.agent',
        orderedRouteIds: ['route.agent'],
        allowRouteIds: ['route.agent'],
        denyRouteIds: [],
        freeOnly: false,
        locality: 'remote',
        maxInputPricePerMillionUsd: 4,
        maxOutputPricePerMillionUsd: 5,
      },
    },
    runtime: {
      requestCount: 7,
      routeStates: {
        'route.agent': {
          consecutiveFailures: 0,
          successes: 2,
          failures: 0,
          backoffUntil: 0,
          circuitOpenUntil: 0,
          lastErrorCode: '',
          lastErrorCategory: '',
          lastErrorAt: 0,
          lastSuccessAt: 1_400,
          lastLatencyMs: 12,
        },
      },
      lastRouteId: 'route.agent',
      lastFailoverChain: [],
    },
    authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
    ...overrides,
  };
}

function request(intent = activeIntent(), overrides = {}) {
  return {
    selfRepairModelIntent: intent,
    currentSelfRepairModelBindingKey: intent.bindingKey,
    orchestratorEnvelope: envelopeForIntent(intent),
    providerCallBudgetContext: {
      kind: 'browser-agent',
      jobId: intent.ownerId,
      controlEpoch: 7,
    },
    prompt: 'Repair the exact failed node and return bounded evidence.',
    systemPrompt: 'Stay inside the admitted repair scope.',
    maxOutputTokens: 512,
    currentNow: 1_800,
    ...overrides,
  };
}

test('self-repair invocation binding reaches canonical dispatcher without widening model authority', async () => {
  const intent = activeIntent();
  const prepared = prepareBoundAgentSelfRepairModelInvocationV1(request(intent));

  assert.equal(prepared.command, 'RUN_AI_ROUTED_PROMPT');
  assert.equal(prepared.ownerId, 'actor-1');
  assert.equal(prepared.workKind, 'REPAIR');
  assert.equal(prepared.payload.maxModelCallsForRequest, 1);
  assert.equal(prepared.payload.maxOutputTokens, 512);
  assert.deepEqual(prepared.internal.providerCallBudgetContext, {
    kind: 'browser-agent',
    jobId: 'actor-1',
    controlEpoch: 7,
  });
  assert.deepEqual(prepared.authority, AGENT_SELF_REPAIR_MODEL_INVOCATION_AUTHORITY);
  assert.equal(prepared.authority.dispatcherInvocationAuthorized, false);
  assert.equal(prepared.authority.providerCallAuthorized, false);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.internal.agentModelOrchestratorEnvelope), true);

  const repo = new MemoryRepo();
  repo.state.profile.aiRouter = structuredClone(prepared.internal.agentModelOrchestratorEnvelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(prepared.internal.agentModelOrchestratorEnvelope.runtime);
  const beforeSettings = structuredClone(repo.state.profile.aiRouter);
  const beforeRuntime = structuredClone(repo.state.profile.aiRouterRuntime);
  const seen = [];
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: {
      async run(settings, runtime, prompt, options) {
        seen.push({
          settings: structuredClone(settings),
          runtime: structuredClone(runtime),
          prompt,
          options: structuredClone(options),
        });
        return {
          text: 'repair result',
          route: 'route.agent',
          primary: { provider: 'openai', model: 'agent-model', routeId: 'route.agent' },
          strong: null,
          runtime: {
            ...runtime,
            requestCount: runtime.requestCount + 1,
            lastRouteId: 'route.agent',
          },
        };
      },
    },
  });

  const result = await dispatcher.execute(
    prepared.command,
    prepared.payload,
    prepared.internal,
  );

  assert.equal(result.result.text, 'repair result');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].settings.routes.map(route => route.routeId), ['route.agent']);
  assert.equal(seen[0].options.taskRole, 'coder');
  assert.equal(seen[0].options.strongTaskRole, 'coder');
  assert.deepEqual(seen[0].options.capabilityIds, ['cap.code']);
  assert.equal(seen[0].options.maxModelCallsForRequest, 1);
  assert.deepEqual(seen[0].options.providerCallBudgetContext, {
    kind: 'browser-agent',
    jobId: 'actor-1',
    controlEpoch: 7,
  });
  assert.deepEqual(repo.state.profile.aiRouter, beforeSettings);
  assert.deepEqual(repo.state.profile.aiRouterRuntime, beforeRuntime);
});

test('RETEST invocation stays bound to the independent verifier identity and role', () => {
  const intent = activeIntent({
    workKind: 'RETEST',
    role: 'verifier',
    capabilityIds: ['cap.reason'],
  });
  const prepared = prepareBoundAgentSelfRepairModelInvocationV1(request(intent));

  assert.equal(prepared.ownerId, 'verifier-1');
  assert.equal(prepared.workKind, 'RETEST');
  assert.equal(prepared.routeIntent.role, 'verifier');
  assert.deepEqual(prepared.routeIntent.capabilityIds, ['cap.reason']);
  assert.equal(prepared.internal.agentModelOrchestratorEnvelope.jobId, 'verifier-1');
  assert.equal(prepared.internal.agentModelOrchestratorEnvelope.role, 'verifier');
});

test('stale or terminal self-repair state cannot prepare provider invocation', () => {
  const intent = activeIntent();
  assert.throws(
    () => prepareBoundAgentSelfRepairModelInvocationV1(request(intent, {
      currentSelfRepairModelBindingKey: intent.bindingKey + ':stale',
    })),
    /not the current owner binding/u,
  );

  const terminal = terminalIntent();
  assert.throws(
    () => prepareBoundAgentSelfRepairModelInvocationV1({
      selfRepairModelIntent: terminal,
      currentSelfRepairModelBindingKey: terminal.bindingKey,
      orchestratorEnvelope: envelopeForIntent(intent),
      providerCallBudgetContext: { kind: 'browser-agent', jobId: 'actor-1', controlEpoch: 7 },
      prompt: 'forged resurrection',
      maxOutputTokens: 128,
      currentNow: 1_800,
    }),
    /cannot prepare model invocation/u,
  );
});

test('orchestrator owner, role, capability and vision drift fail closed', () => {
  const intent = activeIntent();
  for (const envelope of [
    envelopeForIntent(intent, { jobId: 'verifier-1' }),
    envelopeForIntent(intent, { role: 'planner' }),
    envelopeForIntent(intent, { capabilityIds: ['cap.reason'] }),
    envelopeForIntent(intent, { requiresVision: true }),
  ]) {
    assert.throws(
      () => prepareBoundAgentSelfRepairModelInvocationV1(request(intent, {
        orchestratorEnvelope: envelope,
      })),
      /owner drifted|drifted from durable route intent/u,
    );
  }
});

test('provider budget lifecycle must be the existing exact-owner BrowserAgent lifecycle', () => {
  const intent = activeIntent();
  for (const providerCallBudgetContext of [
    { kind: 'self-repair', jobId: 'actor-1', controlEpoch: 7 },
    { kind: 'browser-agent', jobId: 'verifier-1', controlEpoch: 7 },
    { kind: 'browser-agent', jobId: 'actor-1', controlEpoch: 0 },
  ]) {
    assert.throws(
      () => prepareBoundAgentSelfRepairModelInvocationV1(request(intent, {
        providerCallBudgetContext,
      })),
      /existing BrowserAgent provider budget lifecycle|budget owner|controlEpoch/u,
    );
  }
});

test('invocation chronology and bounded output fail closed before dispatcher use', () => {
  const intent = activeIntent();
  assert.throws(
    () => prepareBoundAgentSelfRepairModelInvocationV1(request(intent, { currentNow: 1_499 })),
    /cannot precede Router revalidation/u,
  );
  for (const maxOutputTokens of [0, -0, 1.5]) {
    assert.throws(
      () => prepareBoundAgentSelfRepairModelInvocationV1(request(intent, { maxOutputTokens })),
      /maxOutputTokens/u,
    );
  }
});

test('public aliases and hostile accessors are rejected without executing getters', () => {
  const intent = activeIntent();
  assert.throws(
    () => prepareBoundAgentSelfRepairModelInvocationV1({
      ...request(intent),
      taskRole: 'verifier',
    }),
    /contains unknown field/u,
  );

  let getterCalls = 0;
  const hostile = request(intent);
  Object.defineProperty(hostile, 'currentNow', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1_800;
    },
  });
  assert.throws(
    () => prepareBoundAgentSelfRepairModelInvocationV1(hostile),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);
});
