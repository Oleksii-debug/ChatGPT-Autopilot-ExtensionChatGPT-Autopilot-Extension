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
  AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY,
  createBoundAgentModelRouteDispatchIntentV1,
} from '../src/core/agent-model-route-dispatch-intent.js';

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
    route('route.a', { priority: 20 }),
    route('route.b', { priority: 10 }),
    route('route.c', { priority: 100 }),
  ];
}

function definition() {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: 'Reusable bounded research Agent.',
    instructions: 'Research only inside the owner-admitted scope.',
    capabilityIds: ['project.context', 'research.read'],
    toolIds: ['browser.read'],
    tags: ['research'],
    acceptanceCriteria: ['Return evidence.'],
    configDefaults: { maxSteps: 40, maxModelCalls: 10, maxRuntimeMinutes: 10 },
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
    agentDefinitionId: 'agent.research',
  });
}

function materialized() {
  const reg = registry();
  const selected = selection();
  return materializeAgentDefinitionV1({
    registry: reg,
    selection: selected,
    jobId: 'agent.runtime.001',
    projectId: 'project.alpha',
    goal: 'Produce a bounded evidence report.',
    ownerBudget: {
      maxSteps: 100,
      maxModelCalls: 30,
      maxInputTokens: 200000,
      maxOutputTokens: 20000,
      maxTotalTokens: 220000,
      maxOutputTokensPerCall: 4096,
      maxRuntimeMinutes: 60,
      maxCostUsd: 5,
      inputPricePerMillionUsd: 3,
      outputPricePerMillionUsd: 6,
    },
    ownerCapabilityIds: ['project.context', 'research.read'],
    ownerToolIds: ['browser.read'],
    requestedCapabilityIds: ['project.context', 'research.read'],
    requestedToolIds: ['browser.read'],
  });
}

function binding() {
  const mat = materialized();
  return createAgentDefinitionModelPolicyBindingV1({
    materializedAgent: mat,
    currentDefinitionSelection: selection(),
    currentJobId: mat.config.id,
    currentProjectId: mat.config.projectId,
    routePool: pool(),
    routePoolRevision: 9,
    ownerAllowedRouteIds: ['route.a', 'route.b', 'route.c'],
  });
}

function request(overrides = {}) {
  const current = binding();
  return {
    definitionModelPolicyBinding: current,
    currentDefinitionModelPolicyBindingKey: current.bindingKey,
    currentDefinitionSelection: selection(),
    currentJobId: current.jobId,
    currentProjectId: current.projectId,
    currentRoutePoolRevision: 9,
    routes: pool(),
    routeStates: {},
    role: 'planner',
    capabilityIds: ['cap.reason'],
    requiresVision: false,
    now: 1790620000000,
    ...overrides,
  };
}

test('prepares exact canonical provider identity only after fresh bound ranking', () => {
  const result = createBoundAgentModelRouteDispatchIntentV1(request());
  assert.equal(result.routeId, 'route.b');
  assert.deepEqual(result.route, {
    routeId: 'route.b',
    provider: 'openai',
    model: 'model-route.b',
    endpointId: '',
  });
  assert.deepEqual(result.availableRouteIds, ['route.b', 'route.a']);
  assert.equal(result.definitionRevision, 4);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.route), true);
});

test('expected prior preference detects route-state TOCTOU before dispatch preparation', () => {
  const now = 1790620000000;
  assert.throws(
    () => createBoundAgentModelRouteDispatchIntentV1(request({
      expectedPreferredRouteId: 'route.b',
      routeStates: {
        'route.b': { backoffUntil: now + 5000 },
      },
      now,
    })),
    /preference changed before dispatch preparation/u,
  );
});

test('temporarily unavailable bound pool fails with retry evidence', () => {
  const now = 1790620000000;
  assert.throws(
    () => createBoundAgentModelRouteDispatchIntentV1(request({
      routeStates: {
        'route.a': { backoffUntil: now + 5000 },
        'route.b': { circuitOpenUntil: now + 8000 },
      },
      now,
    })),
    error => error?.code === 'AGENT_MODEL_ROUTE_DISPATCH_UNAVAILABLE'
      && error.retryAt === now + 5000,
  );
});

test('out-of-scope route is never promoted into dispatch intent', () => {
  const routes = pool().map(item => item.routeId === 'route.c'
    ? { ...item, priority: 999999 }
    : item);
  const result = createBoundAgentModelRouteDispatchIntentV1(request({ routes }));
  assert.equal(result.routeId, 'route.b');
  assert.equal(result.availableRouteIds.includes('route.c'), false);
});

test('stale durable owner binding remains fail-closed at dispatch boundary', () => {
  const current = request();
  assert.throws(
    () => createBoundAgentModelRouteDispatchIntentV1({
      ...current,
      currentDefinitionModelPolicyBindingKey:
        current.currentDefinitionModelPolicyBindingKey + ':stale',
    }),
    /not the current owner binding/u,
  );
});

test('caller cannot inject provider, model, credentials or authority aliases', () => {
  for (const extra of [
    { provider: 'openai' },
    { model: 'forged' },
    { apiKey: 'secret' },
    { providerCallAuthorized: true },
    { routeSelectionAuthorized: true },
  ]) {
    assert.throws(
      () => createBoundAgentModelRouteDispatchIntentV1({ ...request(), ...extra }),
      /contains unknown field/u,
    );
  }
});

test('hostile top-level accessors do not execute', () => {
  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'expectedPreferredRouteId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'route.b';
    },
  });
  assert.throws(
    () => createBoundAgentModelRouteDispatchIntentV1(hostile),
    /must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);
});

test('dispatch intent grants no provider, execution, credential or route-selection authority', () => {
  const result = createBoundAgentModelRouteDispatchIntentV1(request());
  assert.equal(result.authority, AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY);
  assert.equal(result.authority.dispatchPrepared, true);
  assert.equal(result.authority.routeSelectionAuthorized, false);
  assert.equal(result.authority.providerCallAuthorized, false);
  assert.equal(result.authority.credentialAccessAuthorized, false);
  assert.equal(result.authority.executionAuthorized, false);
  assert.equal(result.authority.requiresCanonicalAiOrchestrator, true);
  assert.equal(result.authority.requiresProviderCallLifecycleRevalidation, true);
});
