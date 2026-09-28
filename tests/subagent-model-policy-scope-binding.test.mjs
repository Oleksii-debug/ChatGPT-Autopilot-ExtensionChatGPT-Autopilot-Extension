import test from 'node:test';
import assert from 'node:assert/strict';

import { AiRouteRole } from '../src/core/ai-route-pool.js';
import { createAgentModelPolicyBindingV1 } from '../src/core/agent-model-policy-binding.js';
import { deriveSubagentAuthorityEnvelopeV1 } from '../src/core/subagent-authority-envelope.js';
import {
  deriveSubagentModelRouteScopeFromAgentBindingV1,
} from '../src/core/subagent-model-policy-scope-binding.js';

function route(routeId, overrides = {}) {
  return {
    schemaVersion: 1,
    routeId,
    provider: 'openai',
    model: 'model-' + routeId,
    endpointId: 'openai',
    displayName: routeId,
    systemPrompt: 'PRIVATE SYSTEM ' + routeId,
    workerPrompt: 'PRIVATE WORKER ' + routeId,
    roles: [AiRouteRole.CODER, AiRouteRole.FAST_WORKER],
    capabilityIds: ['model.code'],
    priority: 10,
    enabled: true,
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 1,
    supportsVision: false,
    maxWorkers: 8,
    ...overrides,
  };
}

function pool() {
  return [
    route('route.local', {
      provider: 'ollama',
      endpointId: 'ollama',
      locality: 'local',
      costClass: 'free',
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
      priority: 30,
    }),
    route('route.remote.cheap', {
      inputPricePerMillionUsd: 0.2,
      outputPricePerMillionUsd: 0.4,
      priority: 20,
    }),
    route('route.remote.expensive', {
      inputPricePerMillionUsd: 5,
      outputPricePerMillionUsd: 10,
      priority: 5,
    }),
    route('route.vision', {
      capabilityIds: ['model.code', 'model.vision'],
      supportsVision: true,
      inputPricePerMillionUsd: 0.5,
      outputPricePerMillionUsd: 0.5,
      priority: 15,
    }),
  ];
}

function childAuthority(overrides = {}) {
  return deriveSubagentAuthorityEnvelopeV1({
    projectId: 'project.alpha',
    parentAgentId: 'agent.parent',
    childAgentId: 'agent.child',
    taskId: 'task.one',
    providerId: 'provider.model-worker',
    parentProviderIds: ['provider.model-worker'],
    ownerAllowedProviderIds: ['provider.model-worker'],
    parentCapabilityIds: ['model.code', 'model.vision'],
    ownerAllowedCapabilityIds: ['model.code', 'model.vision'],
    providerCapabilityIds: ['model.code', 'model.vision'],
    taskRequestedCapabilityIds: ['model.code', 'model.vision'],
    parentSourceIds: [],
    ownerAllowedSourceIds: [],
    taskSourceIds: [],
    parentArtifactIds: [],
    ownerAllowedArtifactIds: [],
    taskArtifactIds: [],
    parentToolIds: [],
    ownerAllowedToolIds: [],
    requestedToolIds: [],
    parentToolDescriptors: [],
    ...overrides,
  });
}

function bindings() {
  const routes = pool();
  const parent = createAgentModelPolicyBindingV1({
    projectId: 'project.alpha',
    agentId: 'agent.parent',
    policyRevision: 1,
    routePoolRevision: 7,
    routePool: routes,
    ownerAllowedRouteIds: routes.map(item => item.routeId),
    routePolicy: {},
  });
  const child = createAgentModelPolicyBindingV1({
    projectId: 'project.alpha',
    agentId: 'agent.child',
    policyRevision: 2,
    routePoolRevision: 7,
    routePool: routes,
    ownerAllowedRouteIds: [
      'route.local',
      'route.remote.cheap',
      'route.vision',
    ],
    parentBinding: parent,
    routePolicy: {
      allowRouteIds: ['route.remote.cheap', 'route.vision'],
      locality: 'remote',
      maxInputPricePerMillionUsd: 1,
      maxOutputPricePerMillionUsd: 1,
    },
  });
  return { routes, parent, child };
}

function request(overrides = {}) {
  const { routes, child } = bindings();
  return {
    childAuthorityEnvelope: childAuthority(),
    childModelPolicyBinding: child,
    routes,
    currentRoutePoolRevision: 7,
    taskModelCapabilityIds: ['model.code'],
    taskRequestedRouteIds: [],
    role: AiRouteRole.FAST_WORKER,
    requiresVision: false,
    ...overrides,
  };
}

test('task model scope derives from one durable child Agent policy binding, not raw parent/owner policy inputs', () => {
  const value = deriveSubagentModelRouteScopeFromAgentBindingV1(request());

  assert.equal(value.decision, 'ALLOW');
  assert.equal(value.reasonCode, 'MODEL_ROUTE_SCOPE_ADMITTED');
  assert.equal(value.projectId, 'project.alpha');
  assert.equal(value.parentAgentId, 'agent.parent');
  assert.equal(value.childAgentId, 'agent.child');
  assert.equal(value.taskId, 'task.one');
  assert.equal(value.agentModelPolicyRevision, 2);
  assert.equal(value.routePoolRevision, 7);
  assert.equal(value.derivedFromDurableAgentModelPolicyBinding, true);
  assert.equal(value.rawParentPolicyAuthorityAccepted, false);
  assert.equal(value.rawOwnerPolicyAuthorityAccepted, false);
  assert.deepEqual(value.admittedRouteIds, [
    'route.remote.cheap',
    'route.vision',
  ]);
  assert.equal(value.routeBindings.every(item => (
    ['route.remote.cheap', 'route.vision'].includes(item.routeId)
  )), true);
  assert.equal(value.routeSelectionAuthority, false);
  assert.equal(value.providerExecutionAuthority, false);
  assert.equal(value.policyAuthority, false);
  assert.equal(value.schedulingAuthority, false);
  assert.equal(value.recoveryAuthority, false);
  assert.equal(value.credentialAuthority, false);
  assert.equal(value.completionAuthority, false);
  assert.equal(value.persistenceAuthority, false);
  assert.equal(value.requiresCurrentRouterRevalidation, true);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(JSON.stringify(value).includes('PRIVATE SYSTEM'), false);
  assert.equal(JSON.stringify(value).includes('PRIVATE WORKER'), false);
});

test('task route request cannot escape durable child effective route scope', () => {
  const value = deriveSubagentModelRouteScopeFromAgentBindingV1(request({
    taskRequestedRouteIds: ['route.local'],
  }));

  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'MODEL_ROUTE_ESCALATION');
  assert.deepEqual(value.admittedRouteIds, []);
  assert.deepEqual(value.routeBindings, []);
  assert.deepEqual(value.deniedRouteIds, ['route.local']);
});

test('composed durable policy cannot grant vision outside child capability authority', () => {
  const value = deriveSubagentModelRouteScopeFromAgentBindingV1(request({
    childAuthorityEnvelope: childAuthority({
      parentCapabilityIds: ['model.code'],
      ownerAllowedCapabilityIds: ['model.code'],
      providerCapabilityIds: ['model.code'],
      taskRequestedCapabilityIds: ['model.code'],
    }),
    requiresVision: true,
  }));

  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'MODEL_CAPABILITY_ESCALATION');
  assert.deepEqual(value.deniedCapabilityIds, ['model.vision']);
  assert.deepEqual(value.admittedRouteIds, []);
  assert.deepEqual(value.routeBindings, []);
});

test('durable model policy binding must match exact child authority identity', () => {
  const value = deriveSubagentModelRouteScopeFromAgentBindingV1(request({
    childAuthorityEnvelope: childAuthority({
      childAgentId: 'agent.other-child',
    }),
  }));

  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'MODEL_POLICY_BINDING_IDENTITY_MISMATCH');
  assert.deepEqual(value.admittedRouteIds, []);
  assert.deepEqual(value.routeBindings, []);
});

test('current owner route-pool revision must exactly match durable child binding revision', () => {
  const value = deriveSubagentModelRouteScopeFromAgentBindingV1(request({
    currentRoutePoolRevision: 8,
  }));

  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'MODEL_POLICY_ROUTE_POOL_REVISION_STALE');
  assert.equal(value.currentRoutePoolRevision, 8);
  assert.deepEqual(value.admittedRouteIds, []);
});

test('same route-pool revision with missing bound routes fails closed as owner snapshot drift', () => {
  const { child } = bindings();
  const value = deriveSubagentModelRouteScopeFromAgentBindingV1(request({
    childModelPolicyBinding: child,
    routes: pool().filter(item => item.routeId !== 'route.vision'),
  }));

  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'MODEL_POLICY_ROUTE_POOL_BINDING_DRIFT');
  assert.deepEqual(value.missingEffectiveRouteIds, ['route.vision']);
  assert.deepEqual(value.admittedRouteIds, []);
});

test('top-level Agent model policy binding cannot masquerade as a child binding', () => {
  const { parent } = bindings();
  const value = deriveSubagentModelRouteScopeFromAgentBindingV1(request({
    childModelPolicyBinding: parent,
  }));

  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'MODEL_POLICY_BINDING_IDENTITY_MISMATCH');
  assert.deepEqual(value.admittedRouteIds, []);
});

test('tampered durable binding identity is rejected before task route admission', () => {
  const { child } = bindings();
  const tampered = structuredClone(child);
  tampered.agentId = 'agent.other-child';

  assert.throws(
    () => deriveSubagentModelRouteScopeFromAgentBindingV1(request({
      childModelPolicyBinding: tampered,
    })),
    /bindingKey is inconsistent/u,
  );
});

test('raw parent/owner policies and transient route state are not accepted authority surfaces', () => {
  for (const extra of [
    { parentRoutePolicy: {} },
    { ownerRoutePolicy: {} },
    { routeStates: {} },
  ]) {
    assert.throws(
      () => deriveSubagentModelRouteScopeFromAgentBindingV1({
        ...request(),
        ...extra,
      }),
      /contains unknown field/u,
    );
  }
});

test('request boundary rejects accessor authority without executing the getter', () => {
  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'childModelPolicyBinding', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return bindings().child;
    },
  });

  assert.throws(
    () => deriveSubagentModelRouteScopeFromAgentBindingV1(hostile),
    /childModelPolicyBinding.*enumerable own data property/u,
  );
  assert.equal(reads, 0);
});

test('route-pool revision rejects coercion and signed zero aliases', () => {
  for (const value of ['7', 7.5, -0, 0]) {
    assert.throws(
      () => deriveSubagentModelRouteScopeFromAgentBindingV1(request({
        currentRoutePoolRevision: value,
      })),
      /currentRoutePoolRevision is invalid/u,
    );
  }
});
