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
  createAgentModelPolicyBindingV1,
} from '../src/core/agent-model-policy-binding.js';
import {
  AGENT_MODEL_ROUTE_DISPATCH_AUTHORITY,
  authorizeBoundAgentModelRouteDispatchV1,
} from '../src/core/agent-model-route-dispatch-authorization.js';

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

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: 'Reusable bounded research Agent.',
    instructions: 'Research only inside the owner-admitted scope.',
    capabilityIds: ['project.context', 'research.read'],
    toolIds: ['browser.read', 'files.read'],
    tags: ['research'],
    acceptanceCriteria: ['Return evidence for every material claim.'],
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
    ...overrides,
  };
}

function registry(definitionOverrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'agents:project.alpha',
    revision: 6,
    definitions: [definition(definitionOverrides)],
  };
}

function selection(definitionOverrides = {}) {
  const reg = registry(definitionOverrides);
  return selectAgentDefinitionV1({
    registry: reg,
    agentDefinitionId: 'agent.research',
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

function materialized() {
  const reg = registry();
  const selected = selectAgentDefinitionV1({
    registry: reg,
    agentDefinitionId: 'agent.research',
  });
  return materializeAgentDefinitionV1({
    registry: reg,
    selection: selected,
    jobId: 'agent.runtime.001',
    projectId: 'project.alpha',
    goal: 'Produce a bounded evidence report.',
    ownerBudget: ownerBudget(),
    ownerCapabilityIds: ['project.context', 'research.read'],
    ownerToolIds: ['browser.read', 'files.read'],
    requestedCapabilityIds: ['project.context', 'research.read'],
    requestedToolIds: ['browser.read'],
  });
}

function definitionBinding(overrides = {}) {
  const mat = materialized();
  return createAgentDefinitionModelPolicyBindingV1({
    materializedAgent: mat,
    currentDefinitionSelection: selection(),
    currentJobId: mat.config.id,
    currentProjectId: mat.config.projectId,
    routePool: pool(),
    routePoolRevision: 9,
    ownerAllowedRouteIds: ['route.a', 'route.b', 'route.c'],
    ...overrides,
  });
}

function parentBinding(overrides = {}) {
  return createAgentModelPolicyBindingV1({
    projectId: 'project.alpha',
    agentId: 'agent.parent',
    policyRevision: 3,
    routePoolRevision: 9,
    routePool: pool(),
    ownerAllowedRouteIds: ['route.a', 'route.b', 'route.c'],
    routePolicy: {
      allowRouteIds: ['route.a', 'route.b', 'route.c'],
      locality: 'remote',
    },
    ...overrides,
  });
}

function childDefinitionBinding(parent = parentBinding()) {
  const mat = materialized();
  return createAgentDefinitionModelPolicyBindingV1({
    materializedAgent: mat,
    currentDefinitionSelection: selection(),
    currentJobId: mat.config.id,
    currentProjectId: mat.config.projectId,
    routePool: pool(),
    routePoolRevision: 9,
    ownerAllowedRouteIds: ['route.a', 'route.b', 'route.c'],
    parentBinding: parent,
  });
}

function request(overrides = {}) {
  const binding = definitionBinding();
  return {
    definitionModelPolicyBinding: binding,
    currentDefinitionModelPolicyBindingKey: binding.bindingKey,
    currentDefinitionSelection: selection(),
    currentJobId: binding.jobId,
    currentProjectId: binding.projectId,
    currentRoutePoolRevision: 9,
    routes: pool(),
    routeStates: {},
    currentRouterPolicy: {
      autoSwitch: true,
      orderedRouteIds: ['route.c', 'route.a', 'route.b'],
      allowRouteIds: ['route.a', 'route.b', 'route.c'],
      denyRouteIds: [],
      locality: 'remote',
    },
    role: 'planner',
    capabilityIds: ['cap.reason'],
    requiresVision: false,
    now: 1_790_620_000_000,
    ...overrides,
  };
}

function childRequest(overrides = {}) {
  const parent = parentBinding();
  const binding = childDefinitionBinding(parent);
  return request({
    definitionModelPolicyBinding: binding,
    currentDefinitionModelPolicyBindingKey: binding.bindingKey,
    currentParentModelPolicyBinding: parent,
    currentParentModelPolicyBindingKey: parent.bindingKey,
    ...overrides,
  });
}

test('authorizes only the intersection of bound Agent scope and current Router policy', () => {
  const result = authorizeBoundAgentModelRouteDispatchV1(request());

  assert.equal(result.routeAttemptAuthorized, true);
  assert.deepEqual(result.boundAvailableRouteIds, ['route.b', 'route.a']);
  assert.deepEqual(result.routerAvailableRouteIds, ['route.c', 'route.a', 'route.b']);
  assert.deepEqual(result.selectedRoute, {
    routeId: 'route.b',
    provider: 'openai',
    model: 'model-route.b',
    endpointId: '',
  });
  assert.equal(result.selectedRoute.routeId === 'route.c', false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.selectedRoute), true);
});

test('current Router allow-list can narrow a bound Agent to a different route', () => {
  const result = authorizeBoundAgentModelRouteDispatchV1(request({
    currentRouterPolicy: {
      autoSwitch: true,
      allowRouteIds: ['route.a', 'route.c'],
      locality: 'remote',
    },
  }));

  assert.equal(result.routeAttemptAuthorized, true);
  assert.equal(result.selectedRoute.routeId, 'route.a');
});

test('current Router pin outside Agent scope yields no route authorization', () => {
  const result = authorizeBoundAgentModelRouteDispatchV1(request({
    currentRouterPolicy: {
      autoSwitch: true,
      pinnedRouteId: 'route.c',
      allowRouteIds: ['route.a', 'route.b', 'route.c'],
      locality: 'remote',
    },
  }));

  assert.equal(result.routeAttemptAuthorized, false);
  assert.equal(result.selectedRoute, null);
  assert.equal(result.retryAt, 0);
});

test('Router no-auto-switch cannot be bypassed by Agent fallback order', () => {
  const result = authorizeBoundAgentModelRouteDispatchV1(request({
    currentRouterPolicy: {
      autoSwitch: false,
      orderedRouteIds: ['route.c', 'route.a', 'route.b'],
      allowRouteIds: ['route.a', 'route.b', 'route.c'],
      locality: 'remote',
    },
  }));

  assert.equal(result.routeAttemptAuthorized, false);
  assert.deepEqual(result.routerAvailableRouteIds, ['route.c']);
});

test('shared durable backoff is re-observed before route authorization', () => {
  const now = 1_790_620_000_000;
  const result = authorizeBoundAgentModelRouteDispatchV1(request({
    routeStates: {
      'route.a': { backoffUntil: now + 5_000 },
      'route.b': { circuitOpenUntil: now + 8_000 },
      'route.c': { backoffUntil: 0 },
    },
    currentRouterPolicy: {
      autoSwitch: true,
      allowRouteIds: ['route.a', 'route.b'],
      locality: 'remote',
    },
    now,
  }));

  assert.equal(result.routeAttemptAuthorized, false);
  assert.equal(result.selectedRoute, null);
  assert.equal(result.retryAt, now + 5_000);
});

test('role/capability restrictions remain active at both authority layers', () => {
  const result = authorizeBoundAgentModelRouteDispatchV1(request({
    role: 'coder',
    capabilityIds: ['cap.code'],
  }));

  assert.equal(result.routeAttemptAuthorized, true);
  assert.deepEqual(result.boundEligibleRouteIds, ['route.a']);
  assert.equal(result.selectedRoute.routeId, 'route.a');
});

test('child authorization preserves current parent binding provenance', () => {
  const result = authorizeBoundAgentModelRouteDispatchV1(childRequest());
  assert.equal(result.routeAttemptAuthorized, true);
  assert.equal(typeof result.parentModelPolicyBindingKey, 'string');

  const stale = childRequest();
  stale.currentParentModelPolicyBindingKey += ':stale';
  assert.throws(
    () => authorizeBoundAgentModelRouteDispatchV1(stale),
    /parent binding is not the current owner binding/u,
  );
});

test('definition/route-pool/binding drift fails before any route authorization', () => {
  assert.throws(
    () => authorizeBoundAgentModelRouteDispatchV1(request({ currentRoutePoolRevision: 10 })),
    /route-pool revision is stale/u,
  );
  const stale = request();
  stale.currentDefinitionModelPolicyBindingKey += ':stale';
  assert.throws(
    () => authorizeBoundAgentModelRouteDispatchV1(stale),
    /not the current owner binding/u,
  );
});

test('authorization requires explicit current Router policy and deterministic time', () => {
  const missingPolicy = request();
  delete missingPolicy.currentRouterPolicy;
  assert.throws(
    () => authorizeBoundAgentModelRouteDispatchV1(missingPolicy),
    /requires currentRouterPolicy/u,
  );

  const missingNow = request();
  delete missingNow.now;
  assert.throws(
    () => authorizeBoundAgentModelRouteDispatchV1(missingNow),
    /requires explicit now/u,
  );
});

test('caller cannot inject provider/model/selection or provider-call authority', () => {
  for (const extra of [
    { routeId: 'route.c' },
    { provider: 'openai' },
    { model: 'forged' },
    { selectedRoute: { routeId: 'route.c' } },
    { providerCallAuthority: true },
  ]) {
    assert.throws(
      () => authorizeBoundAgentModelRouteDispatchV1({ ...request(), ...extra }),
      /contains unknown field/u,
    );
  }
});

test('authorization is route-specific but still grants no provider or execution authority', () => {
  const result = authorizeBoundAgentModelRouteDispatchV1(request());
  assert.equal(result.authority, AGENT_MODEL_ROUTE_DISPATCH_AUTHORITY);
  assert.equal(result.authority.routeSelectionAuthority, true);
  assert.equal(result.authority.providerCallAuthority, false);
  assert.equal(result.authority.credentialAuthority, false);
  assert.equal(result.authority.executionAuthority, false);
  assert.equal(result.authority.policyAuthority, false);
  assert.equal(result.authority.persistenceAuthority, false);
  assert.equal(result.authority.schedulingAuthority, false);
  assert.equal(result.authority.recoveryAuthority, false);
  assert.equal(result.authority.requiresImmediateProviderBoundaryRevalidation, true);
  assert.match(result.authorizationKey, /route\.b/u);
});


test('authorization key binds capability provenance and exact current Router policy', () => {
  const baseline = authorizeBoundAgentModelRouteDispatchV1(request());
  const repeated = authorizeBoundAgentModelRouteDispatchV1(request());
  assert.equal(baseline.authorizationKey, repeated.authorizationKey);

  const stricterCapabilities = authorizeBoundAgentModelRouteDispatchV1(request({
    role: 'coder',
    capabilityIds: ['cap.code'],
  }));
  assert.notEqual(baseline.authorizationKey, stricterCapabilities.authorizationKey);

  const reorderedPolicy = authorizeBoundAgentModelRouteDispatchV1(request({
    currentRouterPolicy: {
      autoSwitch: true,
      orderedRouteIds: ['route.a', 'route.c', 'route.b'],
      allowRouteIds: ['route.a', 'route.b', 'route.c'],
      denyRouteIds: [],
      locality: 'remote',
    },
  }));
  assert.notEqual(baseline.authorizationKey, reorderedPolicy.authorizationKey);
});

test('capability input is data-only and duplicate-free at dispatch boundary', () => {
  assert.throws(
    () => authorizeBoundAgentModelRouteDispatchV1(request({
      capabilityIds: ['cap.reason', 'cap.reason'],
    })),
    /contains duplicates/u,
  );

  let reads = 0;
  const capabilities = ['cap.reason'];
  Object.defineProperty(capabilities, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'cap.reason';
    },
  });
  assert.throws(
    () => authorizeBoundAgentModelRouteDispatchV1(request({ capabilityIds: capabilities })),
    /invalid value/u,
  );
  assert.equal(reads, 0);
});
