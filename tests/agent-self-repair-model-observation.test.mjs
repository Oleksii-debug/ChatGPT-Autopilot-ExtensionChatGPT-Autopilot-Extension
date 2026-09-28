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

function orchestratorEnvelope(intent = selfRepairIntent()) {
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
  return {
    schemaVersion: 1,
    jobId: intent.ownerId,
    projectId: 'project.observe',
    definitionModelPolicyBindingKey: 'definition.observe.binding',
    modelPolicyBindingKey: 'model.observe.binding',
    routePoolRevision: 3,
    role: intent.routeIntent.role,
    capabilityIds: [...intent.routeIntent.capabilityIds],
    requiresVision: intent.routeIntent.requiresVision,
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
  };
}

function invocationRequest(intent = selfRepairIntent(), overrides = {}) {
  return {
    selfRepairModelIntent: intent,
    currentSelfRepairModelBindingKey: intent.bindingKey,
    orchestratorEnvelope: orchestratorEnvelope(intent),
    providerCallBudgetContext: {
      kind: 'browser-agent',
      jobId: intent.ownerId,
      controlEpoch: 8,
    },
    prompt: 'Repair only the failed node and report bounded evidence.',
    systemPrompt: 'Stay inside the admitted repair scope.',
    maxOutputTokens: 512,
    currentNow: 1_800,
    ...overrides,
  };
}

function providerReservation(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function modelResult(overrides = {}) {
  const text = overrides.text ?? 'Applied the bounded repair and produced evidence for independent verification.';
  const primary = Object.hasOwn(overrides, 'primary')
    ? overrides.primary
    : {
      provider: 'openai',
      model: 'agent-model',
      routeId: 'route.observe',
      text,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    };
  return {
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
    primary,
    strong: null,
    primaryError: '',
    strongError: '',
    routing: {
      selectedRouteId: 'route.observe',
      reason: 'pinned',
      failoverChain: [],
    },
    runtime: {},
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    invocationRequest: invocationRequest(),
    providerReservation: providerReservation(),
    observationId: 'observation.observe.1',
    modelResult: modelResult(),
    observedAt: '1970-01-01T00:00:01.900Z',
    ...overrides,
  };
}

test('durable provider reservation becomes the exact canonical ObservationV1 invocation identity', () => {
  const observation = projectAgentSelfRepairModelObservationV1(request());

  assert.equal(observation.schemaVersion, 1);
  assert.equal(observation.observationId, 'observation.observe.1');
  assert.equal(observation.invocationId, 'actor.observe:model-budget:1');
  assert.equal(observation.status, 'OK');
  assert.match(observation.summary, /bounded repair/u);
  assert.deepEqual(observation.artifactRefs, []);
  assert.equal(observation.data.sourceKind, 'AGENT_SELF_REPAIR_MODEL_OUTPUT');
  assert.equal(observation.data.sourceTrust, 'UNVERIFIED_INPUT');
  assert.equal(observation.data.planId, 'plan.observe');
  assert.equal(observation.data.rootJobId, 'root.job.observe');
  assert.equal(observation.data.jobId, 'actor.observe');
  assert.equal(observation.data.ownerId, 'actor.observe');
  assert.deepEqual(observation.data.providerAdmission, {
    controlEpoch: 8,
    callNumber: 1,
    createdAt: 1_850,
  });
  assert.equal(observation.data.route.routeId, 'route.observe');
  assert.equal(observation.data.route.provider, 'openai');
  assert.equal(observation.data.route.model, 'agent-model');
  assert.deepEqual(observation.data.usage, {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    modelCalls: 1,
  });
  assert.equal(observation.data.outputTruncated, false);
  assert.equal(observation.data.fullOutputArtifactRequired, false);
  assert.equal(Object.hasOwn(observation, 'verificationId'), false);
  assert.equal(Object.hasOwn(observation, 'verificationAuthorityId'), false);
  assert.equal(Object.hasOwn(observation, 'completionAuthority'), false);
  assert.equal(Object.isFrozen(observation), true);
});

test('model result cannot mint invocation identity and caller cannot substitute another owner reservation', () => {
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      modelResult: {
        ...modelResult(),
        invocationId: 'forged.model.invocation',
      },
    })),
    /contains unknown field: invocationId/u,
  );

  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      providerReservation: providerReservation({
        reservationId: 'other.owner:model-budget:1',
      }),
    })),
    /does not belong to the current self-repair owner/u,
  );
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      providerReservation: providerReservation({
        reservationId: ' actor.observe:model-budget:1 ',
      }),
    })),
    /must already be canonical text/u,
  );
});

test('durable provider reservation must match current epoch, route and one-call admission', () => {
  for (const reservation of [
    providerReservation({ controlEpoch: 9 }),
    providerReservation({ modelCalls: 2 }),
    providerReservation({ callNumber: 2 }),
    providerReservation({ routeId: 'route.other' }),
    providerReservation({ provider: 'other-provider' }),
    providerReservation({ model: 'other-model' }),
    providerReservation({ reservationId: 'actor.observe:model-budget:0' }),
  ]) {
    assert.throws(
      () => projectAgentSelfRepairModelObservationV1(request({
        providerReservation: reservation,
      })),
      /controlEpoch drifted|exactly one model call|one-call invocation ceiling|route identity drifted|identity sequence is invalid/u,
    );
  }
});

test('reservation bounds and chronology are canonical before model result can become evidence', () => {
  for (const reservation of [
    providerReservation({ inputTokens: -0 }),
    providerReservation({ outputTokens: 1.5 }),
    providerReservation({ totalTokens: 10 }),
    providerReservation({ estimatedCostUsd: Number.NaN }),
    providerReservation({ estimatedCostUsd: -1 }),
    providerReservation({ createdAt: 1_799 }),
  ]) {
    assert.throws(
      () => projectAgentSelfRepairModelObservationV1(request({
        providerReservation: reservation,
      })),
      /safe integer|totalTokens is inconsistent|estimatedCostUsd is invalid|predates invocation preparation/u,
    );
  }

  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      observedAt: '1970-01-01T00:00:01.840Z',
    })),
    /predates durable provider admission/u,
  );
});

test('route, provider, model and selected text must match the admitted one-route envelope', () => {
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      modelResult: modelResult({
        routing: {
          selectedRouteId: 'route.other',
          reason: 'forged',
          failoverChain: [],
        },
      }),
    })),
    /route drifted from the admitted envelope/u,
  );

  for (const primary of [
    {
      provider: 'other-provider', model: 'agent-model', routeId: 'route.observe',
      text: 'Applied the bounded repair and produced evidence for independent verification.', usage: null,
    },
    {
      provider: 'openai', model: 'other-model', routeId: 'route.observe',
      text: 'Applied the bounded repair and produced evidence for independent verification.', usage: null,
    },
    {
      provider: 'openai', model: 'agent-model', routeId: 'route.observe',
      text: 'different selected-leg text', usage: null,
    },
  ]) {
    assert.throws(
      () => projectAgentSelfRepairModelObservationV1(request({
        modelResult: modelResult({ primary }),
      })),
      /provider identity drifted|text disagrees/u,
    );
  }
});

test('observation admits exactly one bounded provider call and canonical token counters', () => {
  for (const usage of [
    { inputTokens: 10, outputTokens: 20, totalTokens: 30, modelCalls: 0 },
    { inputTokens: 10, outputTokens: 20, totalTokens: 30, modelCalls: 2 },
    { inputTokens: -0, outputTokens: 20, totalTokens: 30, modelCalls: 1 },
    { inputTokens: 10.5, outputTokens: 20, totalTokens: 31, modelCalls: 1 },
    { inputTokens: 10, outputTokens: 20, totalTokens: 5, modelCalls: 1 },
  ]) {
    assert.throws(
      () => projectAgentSelfRepairModelObservationV1(request({
        modelResult: modelResult({ usage }),
      })),
      /model call|safe integer|inconsistent/u,
    );
  }
});

test('observation timestamp spelling must already be canonical UTC', () => {
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      observedAt: '1970-01-01T00:00:01.900+00:00',
    })),
    /exact canonical timestamp/u,
  );
});

test('large model output is summary-bounded and requires canonical artifact materialization', () => {
  const text = 'x'.repeat(8_050);
  const observation = projectAgentSelfRepairModelObservationV1(request({
    modelResult: modelResult({ text }),
  }));
  assert.equal(observation.summary.length, 8_000);
  assert.equal(observation.data.outputTruncated, true);
  assert.equal(observation.data.fullOutputArtifactRequired, true);
  assert.deepEqual(observation.artifactRefs, []);

  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      modelResult: modelResult({ text: 'x'.repeat(100_001) }),
    })),
    /invalid or too large/u,
  );
});

test('stale self-repair binding still fails before observation projection', () => {
  const intent = selfRepairIntent();
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      invocationRequest: invocationRequest(intent, {
        currentSelfRepairModelBindingKey: intent.bindingKey + ':stale',
      }),
    })),
    /not the current owner binding/u,
  );
});

test('hostile accessors and authority-shaped aliases fail without executing getters', () => {
  let getterCalls = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'modelResult', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return modelResult();
    },
  });
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(hostile),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);

  assert.throws(
    () => projectAgentSelfRepairModelObservationV1({
      ...request(),
      verificationAuthorized: true,
    }),
    /contains unknown field/u,
  );
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      modelResult: {
        ...modelResult(),
        completionAuthority: true,
      },
    })),
    /contains unknown field/u,
  );
  assert.throws(
    () => projectAgentSelfRepairModelObservationV1(request({
      providerReservation: {
        ...providerReservation(),
        verificationAuthorityId: 'forged',
      },
    })),
    /contains unknown field/u,
  );
});
