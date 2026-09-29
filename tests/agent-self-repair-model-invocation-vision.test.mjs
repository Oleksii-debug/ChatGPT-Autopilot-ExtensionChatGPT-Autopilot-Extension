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

function bindingKey(value) {
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
    [
      value.workBudget.maxModelCalls,
      value.workBudget.maxRuntimeSeconds,
      value.workBudget.maxCostUsdMicros,
    ],
    [
      value.routeIntent.role,
      value.routeIntent.capabilityIds,
      value.routeIntent.requiresVision,
    ],
  ]);
}

function intent(requiresVision) {
  const value = {
    schemaVersion: 1,
    planId: 'plan-vision',
    jobId: 'job-vision',
    cycleId: 'cycle-vision-1',
    failedNodeId: 'failed-node',
    originPlanRevision: 3,
    currentPlanRevision: 3,
    proposedPlanRevision: 4,
    failedNodeRevisionId: 'failed-revision-1',
    verifierPlanRevisionId: 'verifier-plan-r1',
    cycleState: 'READY_FOR_REPAIR',
    workKind: 'REPAIR',
    activeAttemptNumber: 1,
    currentSubjectRevisionId: 'failed-revision-1',
    evidenceTrust: 'UNVERIFIED_INPUT',
    requiresCanonicalEvidenceResolution: true,
    actorId: 'actor-vision',
    verifierId: 'verifier-vision',
    nodeId: 'repair-node-vision',
    ownerId: 'actor-vision',
    executionPlane: 'LOCAL',
    workBudget: {
      maxModelCalls: 1,
      maxRuntimeSeconds: 90,
      maxCostUsdMicros: 50_000,
    },
    routeIntent: {
      role: 'coder',
      capabilityIds: ['cap.code'],
      requiresVision,
    },
    ...AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
  };
  value.bindingKey = bindingKey(value);
  return value;
}

function envelope(value) {
  const route = {
    schemaVersion: 1,
    routeId: 'route.vision',
    provider: 'openai',
    model: 'vision-model',
    endpointId: '',
    displayName: 'Vision-capable Agent model',
    systemPrompt: '',
    workerPrompt: '',
    roles: ['coder'],
    capabilityIds: ['cap.code'],
    priority: 1,
    enabled: true,
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
    supportsVision: true,
    maxWorkers: 1,
  };
  return {
    schemaVersion: 1,
    jobId: value.ownerId,
    projectId: 'project.vision',
    definitionModelPolicyBindingKey: 'definition.vision.binding',
    modelPolicyBindingKey: 'model.vision.binding',
    routePoolRevision: 1,
    role: 'coder',
    capabilityIds: ['cap.code'],
    requiresVision: value.routeIntent.requiresVision,
    preparedAt: 1_000,
    revalidatedAt: 1_500,
    routeId: route.routeId,
    settings: {
      enabled: true,
      gatewayUrl: 'http://127.0.0.1:3210',
      timeoutSeconds: 180,
      mode: 'primary',
      primary: { provider: 'openai', model: 'vision-model' },
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
        maxInputPricePerMillionUsd: 2,
        maxOutputPricePerMillionUsd: 3,
      },
    },
    runtime: {
      requestCount: 0,
      routeStates: {},
      lastRouteId: '',
      lastFailoverChain: [],
    },
    authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
  };
}

function request(value, extra = {}) {
  return {
    selfRepairModelIntent: value,
    currentSelfRepairModelBindingKey: value.bindingKey,
    orchestratorEnvelope: envelope(value),
    providerCallBudgetContext: {
      kind: 'browser-agent',
      jobId: value.ownerId,
      controlEpoch: 2,
    },
    prompt: 'Inspect the admitted evidence and repair only the failed node.',
    systemPrompt: 'Preserve the durable repair scope.',
    maxOutputTokens: 256,
    currentNow: 1_800,
    ...extra,
  };
}

test('non-vision repair intent cannot inject image input after Router revalidation', () => {
  const value = intent(false);
  assert.throws(
    () => prepareBoundAgentSelfRepairModelInvocationV1(request(value, {
      imageDataUrl: 'data:image/png;base64,AAAA',
    })),
    /does not match durable requiresVision intent/u,
  );
});

test('vision repair intent cannot silently drop its required image input', () => {
  const value = intent(true);
  assert.throws(
    () => prepareBoundAgentSelfRepairModelInvocationV1(request(value)),
    /does not match durable requiresVision intent/u,
  );
  assert.throws(
    () => prepareBoundAgentSelfRepairModelInvocationV1(request(value, {
      imageDataUrl: ' data:image/png;base64,AAAA ',
    })),
    /must already be canonical text/u,
  );
});

test('vision-bound repair preserves exact image input through canonical dispatcher options', async () => {
  const value = intent(true);
  const imageDataUrl = 'data:image/png;base64,AAAA';
  const prepared = prepareBoundAgentSelfRepairModelInvocationV1(request(value, { imageDataUrl }));
  assert.equal(prepared.payload.imageDataUrl, imageDataUrl);
  assert.equal(prepared.routeIntent.requiresVision, true);

  const repo = new MemoryRepo();
  repo.state.profile.aiRouter = structuredClone(prepared.internal.agentModelOrchestratorEnvelope.settings);
  repo.state.profile.aiRouterRuntime = structuredClone(prepared.internal.agentModelOrchestratorEnvelope.runtime);
  const seen = [];
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: {
      async run(_settings, runtime, _prompt, options) {
        seen.push(structuredClone(options));
        return {
          text: 'vision repair result',
          route: 'route.vision',
          primary: { provider: 'openai', model: 'vision-model', routeId: 'route.vision' },
          strong: null,
          runtime: { ...runtime, requestCount: runtime.requestCount + 1 },
        };
      },
    },
  });

  const result = await dispatcher.execute(
    prepared.command,
    prepared.payload,
    prepared.internal,
  );

  assert.equal(result.result.text, 'vision repair result');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].imageDataUrl, imageDataUrl);
  assert.equal(seen[0].taskRole, 'coder');
  assert.deepEqual(seen[0].capabilityIds, ['cap.code']);
});
