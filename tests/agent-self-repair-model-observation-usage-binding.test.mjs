import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
} from '../src/core/agent-model-orchestrator-envelope.js';
import {
  AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
} from '../src/core/agent-self-repair-model-binding.js';
import {
  projectAgentSelfRepairModelObservationV1,
} from '../src/core/agent-self-repair-model-observation.js';

function modelBindingKey(value) {
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

function selfRepairIntent() {
  const value = {
    schemaVersion: 1,
    planId: 'plan.observe',
    jobId: 'root.job.observe',
    cycleId: 'cycle.observe.1',
    failedNodeId: 'failed.node',
    originPlanRevision: 4,
    currentPlanRevision: 4,
    proposedPlanRevision: 5,
    failedNodeRevisionId: 'failed.revision.1',
    verifierPlanRevisionId: 'verifier.plan.r1',
    cycleState: 'READY_FOR_REPAIR',
    workKind: 'REPAIR',
    activeAttemptNumber: 1,
    currentSubjectRevisionId: 'failed.revision.1',
    evidenceTrust: 'UNVERIFIED_INPUT',
    requiresCanonicalEvidenceResolution: true,
    actorId: 'actor.observe',
    verifierId: 'verifier.observe',
    nodeId: 'repair.node.observe',
    ownerId: 'actor.observe',
    executionPlane: 'LOCAL',
    workBudget: {
      maxModelCalls: 2,
      maxRuntimeSeconds: 120,
      maxCostUsdMicros: 75_000,
    },
    routeIntent: {
      role: 'coder',
      capabilityIds: ['cap.code'],
      requiresVision: false,
    },
    ...AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
  };
  value.bindingKey = modelBindingKey(value);
  return value;
}

function requestWithLegUsage(legUsage) {
  const intent = selfRepairIntent();
  const route = {
    schemaVersion: 1,
    routeId: 'route.observe',
    provider: 'openai',
    model: 'agent-model',
    endpointId: '',
    displayName: 'Agent model',
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
    supportsVision: false,
    maxWorkers: 1,
  };
  const text = 'Applied the bounded repair and produced evidence for independent verification.';
  return {
    invocationRequest: {
      selfRepairModelIntent: intent,
      currentSelfRepairModelBindingKey: intent.bindingKey,
      orchestratorEnvelope: {
        schemaVersion: 1,
        jobId: intent.ownerId,
        projectId: 'project.observe',
        definitionModelPolicyBindingKey: 'definition.observe.binding',
        modelPolicyBindingKey: 'model.observe.binding',
        routePoolRevision: 3,
        role: intent.routeIntent.role,
        capabilityIds: [...intent.routeIntent.capabilityIds],
        requiresVision: false,
        preparedAt: 1_000,
        revalidatedAt: 1_500,
        routeId: route.routeId,
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
          requestCount: 2,
          routeStates: {},
          lastRouteId: '',
          lastFailoverChain: [],
        },
        authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
      },
      providerCallBudgetContext: {
        kind: 'browser-agent',
        jobId: intent.ownerId,
        controlEpoch: 8,
      },
      prompt: 'Repair only the failed node and report bounded evidence.',
      systemPrompt: 'Stay inside the admitted repair scope.',
      maxOutputTokens: 512,
      currentNow: 1_800,
    },
    providerReservation: {
      reservationId: 'actor.observe:model-budget:1',
      controlEpoch: 8,
      modelCalls: 1,
      inputTokens: 64,
      outputTokens: 512,
      totalTokens: 576,
      estimatedCostUsd: 0.001,
      createdAt: 1_850,
      routeId: 'route.observe',
      provider: 'openai',
      model: 'agent-model',
      callNumber: 1,
    },
    observationId: 'observation.observe.usage-binding',
    modelResult: {
      ok: true,
      text,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        modelCalls: 1,
      },
      route: 'primary',
      trigger: 'primary-only',
      primary: {
        provider: 'openai',
        model: 'agent-model',
        routeId: 'route.observe',
        text,
        usage: legUsage,
      },
      strong: null,
      primaryError: '',
      strongError: '',
      routing: {
        selectedRouteId: 'route.observe',
        reason: 'pinned',
        failoverChain: [],
      },
      runtime: {},
    },
    observedAt: '1970-01-01T00:00:01.900Z',
  };
}

test('selected route leg usage must exactly match canonical model result usage', () => {
  const canonical = projectAgentSelfRepairModelObservationV1(
    requestWithLegUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
  );
  assert.deepEqual(canonical.data.usage, {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    modelCalls: 1,
  });

  for (const usage of [
    { inputTokens: 9, outputTokens: 20, totalTokens: 30 },
    { inputTokens: 10, outputTokens: 19, totalTokens: 30 },
    { inputTokens: 10, outputTokens: 20, totalTokens: 31 },
    null,
  ]) {
    assert.throws(
      () => projectAgentSelfRepairModelObservationV1(requestWithLegUsage(usage)),
      /usage disagrees with the selected route result/u,
    );
  }
});

test('selected route leg usage is descriptor-safe and canonical', () => {
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(requestWithLegUsage({
      inputTokens: -0,
      outputTokens: 20,
      totalTokens: 30,
    })),
    /non-negative safe integer/u,
  );

  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(requestWithLegUsage({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      modelCalls: 1,
    })),
    /contains unknown field: modelCalls/u,
  );
});
