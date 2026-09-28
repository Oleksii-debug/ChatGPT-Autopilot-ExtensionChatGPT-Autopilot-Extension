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
  AGENT_MODEL_ROUTE_CANDIDATE_BINDING_AUTHORITY,
  rankBoundAgentModelRouteCandidatesV1,
} from '../src/core/agent-model-route-candidate-binding.js';

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

function materialized(definitionOverrides = {}) {
  const reg = registry(definitionOverrides);
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

function parentModelPolicyBinding(overrides = {}) {
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

function childDefinitionBinding(parentBinding = parentModelPolicyBinding(), overrides = {}) {
  const mat = materialized();
  return createAgentDefinitionModelPolicyBindingV1({
    materializedAgent: mat,
    currentDefinitionSelection: selection(),
    currentJobId: mat.config.id,
    currentProjectId: mat.config.projectId,
    routePool: pool(),
    routePoolRevision: 9,
    ownerAllowedRouteIds: ['route.a', 'route.b', 'route.c'],
    parentBinding,
    ...overrides,
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
    role: 'planner',
    capabilityIds: ['cap.reason'],
    requiresVision: false,
    now: 1_790_620_000_000,
    ...overrides,
  };
}

function childRequest(overrides = {}) {
  const parentBinding = parentModelPolicyBinding();
  const binding = childDefinitionBinding(parentBinding);
  return request({
    definitionModelPolicyBinding: binding,
    currentDefinitionModelPolicyBindingKey: binding.bindingKey,
    currentParentModelPolicyBinding: parentBinding,
    ...overrides,
  });
}

test('ranks only candidates inside exact durable Agent model-policy scope', () => {
  const result = rankBoundAgentModelRouteCandidatesV1(request());

  assert.equal(result.jobId, 'agent.runtime.001');
  assert.equal(result.projectId, 'project.alpha');
  assert.deepEqual(result.effectiveRouteIds, ['route.a', 'route.b']);
  assert.deepEqual(result.eligibleRouteIds, ['route.b', 'route.a']);
  assert.deepEqual(result.availableRouteIds, ['route.b', 'route.a']);
  assert.equal(result.selectedRouteId, 'route.b');
  assert.equal(result.availableRouteIds.includes('route.c'), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.availableRouteIds), true);
});

test('canonical role and capability filtering are preserved inside bound scope', () => {
  const result = rankBoundAgentModelRouteCandidatesV1(request({
    role: 'coder',
    capabilityIds: ['cap.code'],
  }));

  assert.deepEqual(result.eligibleRouteIds, ['route.a']);
  assert.deepEqual(result.availableRouteIds, ['route.a']);
  assert.equal(result.selectedRouteId, 'route.a');
});

test('temporary route state produces retry evidence without widening scope', () => {
  const now = 1_790_620_000_000;
  const result = rankBoundAgentModelRouteCandidatesV1(request({
    routeStates: {
      'route.a': { backoffUntil: now + 5_000 },
      'route.b': { circuitOpenUntil: now + 8_000 },
      'route.c': { backoffUntil: 0 },
    },
    now,
  }));

  assert.deepEqual(result.eligibleRouteIds, ['route.b', 'route.a']);
  assert.deepEqual(result.availableRouteIds, []);
  assert.equal(result.selectedRouteId, null);
  assert.equal(result.retryAt, now + 5_000);
});

test('out-of-scope high-priority route can never become a bound candidate', () => {
  const routes = pool().map(item => (
    item.routeId === 'route.c' ? { ...item, priority: 999_999 } : item
  ));
  const result = rankBoundAgentModelRouteCandidatesV1(request({ routes }));

  assert.equal(result.availableRouteIds.includes('route.c'), false);
  assert.equal(result.eligibleRouteIds.includes('route.c'), false);
});

test('same-revision definition policy substitution fails closed', () => {
  const current = selection();
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(request({
      currentDefinitionSelection: {
        ...current,
        definition: {
          ...current.definition,
          modelRoutePolicy: {
            ...current.definition.modelRoutePolicy,
            orderedRouteIds: ['route.a', 'route.b'],
          },
        },
      },
    })),
    /root model policy drifted/u,
  );
});

test('stale binding, identity, definition and route-pool fences fail closed', () => {
  const current = request();
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1({
      ...current,
      currentDefinitionModelPolicyBindingKey: current.currentDefinitionModelPolicyBindingKey + ':other',
    }),
    /not the current owner binding/u,
  );
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(request({ currentJobId: 'agent.runtime.other' })),
    /job identity is stale/u,
  );
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(request({ currentProjectId: 'project.other' })),
    /Project identity is stale/u,
  );
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(request({
      currentDefinitionSelection: selection({ definitionRevision: 5 }),
    })),
    /definition selection is stale/u,
  );
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(request({ currentRoutePoolRevision: 10 })),
    /route-pool revision is stale/u,
  );
});

test('child candidate ranking requires exact current parent authority', () => {
  const result = rankBoundAgentModelRouteCandidatesV1(childRequest());
  assert.deepEqual(result.effectiveRouteIds, ['route.a', 'route.b']);

  const missing = childRequest();
  delete missing.currentParentModelPolicyBinding;
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(missing),
    /child binding requires the current parent model policy binding/u,
  );

  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(childRequest({
      currentParentModelPolicyBinding: parentModelPolicyBinding({ agentId: 'agent.other' }),
    })),
    /parent model policy identity is stale/u,
  );
});

test('route removal and same-revision authority ordering drift fail closed', () => {
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(request({
      routes: pool().filter(item => item.routeId !== 'route.a'),
    })),
    /authority route is missing/u,
  );

  const routes = pool();
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(request({
      routes: [routes[1], routes[0], routes[2]],
    })),
    /authority route order drifted/u,
  );
});

test('caller cannot inject provider, selected route or authority aliases', () => {
  for (const extra of [
    { routeId: 'route.c' },
    { provider: 'openai' },
    { model: 'forged' },
    { routeSelectionAuthorized: true },
    { providerCallAuthorized: true },
  ]) {
    assert.throws(
      () => rankBoundAgentModelRouteCandidatesV1({ ...request(), ...extra }),
      /contains unknown field/u,
    );
  }
});

test('hostile top-level accessors and non-canonical roles fail before authority projection', () => {
  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'role', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'planner';
    },
  });
  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(hostile),
    /role must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);

  assert.throws(
    () => rankBoundAgentModelRouteCandidatesV1(request({ role: ' planner ' })),
    /role is invalid/u,
  );
});

test('candidate result explicitly grants no provider or execution authority', () => {
  const result = rankBoundAgentModelRouteCandidatesV1(request());
  assert.equal(result.authority, AGENT_MODEL_ROUTE_CANDIDATE_BINDING_AUTHORITY);
  assert.equal(result.authority.advisoryOnly, true);
  assert.equal(result.authority.routeSelectionAuthorized, false);
  assert.equal(result.authority.providerCallAuthorized, false);
  assert.equal(result.authority.executionAuthorized, false);
  assert.equal(result.authority.policyAuthorized, false);
  assert.equal(result.authority.persistenceAuthorized, false);
  assert.equal(result.authority.schedulingAuthorized, false);
  assert.equal(result.authority.recoveryAuthorized, false);
  assert.equal(result.authority.requiresCurrentRouteStateObservation, true);
});
