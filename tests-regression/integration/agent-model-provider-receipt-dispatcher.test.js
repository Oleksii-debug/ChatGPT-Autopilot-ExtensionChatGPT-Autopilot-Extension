import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../../src/core/commands.js';
import {
  AiOrchestrator,
} from '../../src/core/ai-orchestrator.js';
import {
  AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
} from '../../src/core/agent-model-orchestrator-envelope.js';
import {
  createEmptyState,
  validateState,
} from '../../src/core/schema.js';

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

function internalAgentEnvelope() {
  const route = {
    schemaVersion: 1,
    routeId: 'route.receipt',
    provider: 'openai',
    model: 'receipt-model',
    endpointId: '',
    displayName: 'Receipt model',
    systemPrompt: '',
    workerPrompt: '',
    roles: ['coder'],
    capabilityIds: ['cap.reason'],
    priority: 20,
    enabled: true,
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
    supportsVision: false,
    maxWorkers: 1,
  };

  return {
    schemaVersion: 1,
    jobId: 'agent.receipt',
    projectId: 'project.receipt',
    definitionModelPolicyBindingKey: 'definition.receipt',
    modelPolicyBindingKey: 'model.receipt',
    routePoolRevision: 1,
    role: 'coder',
    capabilityIds: ['cap.reason'],
    requiresVision: false,
    preparedAt: 1_000,
    revalidatedAt: 1_500,
    routeId: route.routeId,
    settings: {
      enabled: true,
      gatewayUrl: 'http://127.0.0.1:3210',
      timeoutSeconds: 180,
      mode: 'primary',
      primary: { provider: route.provider, model: route.model },
      strong: { provider: 'openai', model: 'unused' },
      routes: [route],
      routePolicy: {
        autoSwitch: false,
        pinnedRouteId: route.routeId,
        orderedRouteIds: [route.routeId],
        allowRouteIds: [route.routeId],
        denyRouteIds: [],
        freeOnly: false,
        locality: 'remote',
        maxInputPricePerMillionUsd: 4,
        maxOutputPricePerMillionUsd: 5,
      },
    },
    runtime: {
      requestCount: 3,
      routeStates: {
        [route.routeId]: {
          consecutiveFailures: 0,
          successes: 1,
          failures: 0,
          backoffUntil: 0,
          circuitOpenUntil: 0,
          lastErrorCode: '',
          lastErrorCategory: '',
          lastErrorAt: 0,
          lastSuccessAt: 1_400,
          lastLatencyMs: 10,
        },
      },
      lastRouteId: route.routeId,
      lastFailoverChain: [],
    },
    authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
  };
}

function durableReservation() {
  return {
    reservationId: 'agent.receipt:model-budget:4',
    controlEpoch: 7,
    modelCalls: 1,
    inputTokens: 40,
    outputTokens: 128,
    totalTokens: 168,
    estimatedCostUsd: 0.001,
    createdAt: 1_900,
    routeId: 'route.receipt',
    provider: 'openai',
    model: 'receipt-model',
    callNumber: 1,
  };
}

test('internal Agent dispatcher preserves the selected durable provider receipt from canonical AiOrchestrator', async () => {
  const envelope = internalAgentEnvelope();
  const repo = new MemoryRepo();
  repo.state.profile.aiRouter = structuredClone(envelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(envelope.runtime);

  const lifecycleEvents = [];
  const admitted = durableReservation();
  const orchestrator = new AiOrchestrator({
    now: () => 2_000,
    gatewayClient: {
      async complete(request) {
        lifecycleEvents.push(['gateway', request.provider, request.model]);
        return {
          text: 'bounded repair result',
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
          },
        };
      },
    },
    providerCallLifecycle: {
      async beforeProviderCall({ context, route, maxOutputTokens, callNumber }) {
        lifecycleEvents.push([
          'before',
          context.jobId,
          context.controlEpoch,
          route.routeId,
          maxOutputTokens,
          callNumber,
        ]);
        return admitted;
      },
      async afterProviderCall({ reservation, route, ok, result }) {
        lifecycleEvents.push([
          'after',
          reservation.reservationId,
          route.routeId,
          ok,
          result.usage.totalTokens,
        ]);
      },
    },
  });
  const dispatcher = new CoreCommandDispatcher(
    repo,
    () => 2_000,
    { aiOrchestrator: orchestrator },
  );

  const response = await dispatcher.execute(
    'RUN_AI_ROUTED_PROMPT',
    {
      prompt: 'Repair only the failed node.',
      systemPrompt: 'Stay inside the admitted node.',
      maxOutputTokens: 128,
      maxModelCallsForRequest: 1,
    },
    {
      agentModelOrchestratorEnvelope: envelope,
      providerCallBudgetContext: {
        kind: 'browser-agent',
        jobId: 'agent.receipt',
        controlEpoch: 7,
      },
    },
  );

  assert.equal(response.result.text, 'bounded repair result');
  assert.deepEqual(
    { ...response.result.providerReservation },
    durableReservation(),
  );
  assert.equal(Object.isFrozen(response.result.providerReservation), true);
  assert.equal(response.result.routing.selectedRouteId, 'route.receipt');
  assert.equal(response.result.usage.modelCalls, 1);
  assert.deepEqual(lifecycleEvents, [
    ['before', 'agent.receipt', 7, 'route.receipt', 128, 1],
    ['gateway', 'openai', 'receipt-model'],
    ['after', 'agent.receipt:model-budget:4', 'route.receipt', true, 30],
  ]);
  assert.equal(
    repo.state.profile.aiRouterRuntime.requestCount,
    envelope.runtime.requestCount,
    'internal Agent invocation must remain isolated from global Router runtime',
  );
});
