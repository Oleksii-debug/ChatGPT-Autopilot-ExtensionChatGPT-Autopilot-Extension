import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
} from '../src/core/agent-model-orchestrator-envelope.js';
import {
  AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
} from '../src/core/agent-self-repair-model-binding.js';
import {
  prepareBoundAgentSelfRepairModelInvocationV1,
} from '../src/core/agent-self-repair-model-invocation.js';

function bindingKey(value) {
  return JSON.stringify([
    1,
    value.planId,
    value.jobId,
    value.cycleId,
    value.failedNodeId,
    value.originPlanRevision,
    value.currentPlanRevision,
    value.proposedPlanRevision,
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
    value.executionPlane,
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

function repairIntent() {
  const intent = {
    schemaVersion: 1,
    planId: 'plan-root',
    jobId: 'root-browser-job',
    cycleId: 'cycle-1',
    failedNodeId: 'failed-node',
    originPlanRevision: 1,
    currentPlanRevision: 1,
    proposedPlanRevision: 2,
    failedNodeRevisionId: 'failed-r1',
    verifierPlanRevisionId: 'verifier-r1',
    cycleState: 'READY_FOR_REPAIR',
    workKind: 'REPAIR',
    activeAttemptNumber: 1,
    currentSubjectRevisionId: 'failed-r1',
    evidenceTrust: 'UNVERIFIED_INPUT',
    requiresCanonicalEvidenceResolution: true,
    actorId: 'repair-actor',
    verifierId: 'independent-verifier',
    nodeId: 'repair-node',
    ownerId: 'repair-actor',
    executionPlane: 'LOCAL',
    workBudget: {
      maxModelCalls: 1,
      maxRuntimeSeconds: 120,
      maxCostUsdMicros: 100_000,
    },
    routeIntent: {
      role: 'coder',
      capabilityIds: ['cap.code'],
      requiresVision: false,
    },
    ...AGENT_SELF_REPAIR_MODEL_BINDING_AUTHORITY,
  };
  intent.bindingKey = bindingKey(intent);
  return intent;
}

function envelope(intent) {
  const route = {
    schemaVersion: 1,
    routeId: 'route.agent',
    provider: 'openai',
    model: 'agent-model',
    endpointId: '',
    displayName: 'Agent model',
    systemPrompt: '',
    workerPrompt: '',
    roles: ['coder'],
    capabilityIds: ['cap.code'],
    priority: 10,
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
    jobId: intent.ownerId,
    projectId: 'project.alpha',
    definitionModelPolicyBindingKey: 'definition.binding',
    modelPolicyBindingKey: 'model.binding',
    routePoolRevision: 1,
    role: 'coder',
    capabilityIds: ['cap.code'],
    requiresVision: false,
    preparedAt: 100,
    revalidatedAt: 200,
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
      requestCount: 0,
      routeStates: {
        'route.agent': {
          consecutiveFailures: 0,
          successes: 0,
          failures: 0,
          backoffUntil: 0,
          circuitOpenUntil: 0,
          lastErrorCode: '',
          lastErrorCategory: '',
          lastErrorAt: 0,
          lastSuccessAt: 0,
          lastLatencyMs: 0,
        },
      },
      lastRouteId: '',
      lastFailoverChain: [],
    },
    authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
  };
}

test('self-repair invocation exposes the exact provider-budget owner as jobId while preserving root job provenance', () => {
  const intent = repairIntent();
  const prepared = prepareBoundAgentSelfRepairModelInvocationV1({
    selfRepairModelIntent: intent,
    currentSelfRepairModelBindingKey: intent.bindingKey,
    orchestratorEnvelope: envelope(intent),
    providerCallBudgetContext: {
      kind: 'browser-agent',
      jobId: intent.ownerId,
      controlEpoch: 1,
    },
    prompt: 'Repair the failed node.',
    systemPrompt: '',
    maxOutputTokens: 128,
    currentNow: 300,
  });

  assert.equal(prepared.rootJobId, 'root-browser-job');
  assert.equal(prepared.jobId, 'repair-actor');
  assert.equal(prepared.ownerId, 'repair-actor');
  assert.equal(prepared.jobId, prepared.internal.agentModelOrchestratorEnvelope.jobId);
  assert.equal(prepared.jobId, prepared.internal.providerCallBudgetContext.jobId);
  assert.notEqual(prepared.rootJobId, prepared.jobId);
});
