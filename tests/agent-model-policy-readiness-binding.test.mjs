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
  AGENT_MODEL_POLICY_READINESS_BINDING_AUTHORITY,
  inspectBoundAgentModelPolicyReadinessV1,
} from '../src/core/agent-model-policy-readiness-binding.js';
import { AgentRouteReadinessState } from '../src/core/agent-route-readiness.js';

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
    roles: ['planner', 'coder', 'verifier'],
    capabilityIds: ['cap.reason'],
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

function readinessRequest(overrides = {}) {
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
    plannerCapabilityIds: [],
    verifierCapabilityIds: [],
    requiresVision: false,
    requiresVerifier: true,
    now: 1_790_620_000_000,
    ...overrides,
  };
}

function childReadinessRequest(overrides = {}) {
  const parentBinding = parentModelPolicyBinding();
  const binding = childDefinitionBinding(parentBinding);
  return readinessRequest({
    definitionModelPolicyBinding: binding,
    currentDefinitionModelPolicyBindingKey: binding.bindingKey,
    currentParentModelPolicyBinding: parentBinding,
    currentParentModelPolicyBindingKey: parentBinding.bindingKey,
    ...overrides,
  });
}

test('readiness is evaluated only inside the exact current durable Agent model-policy scope', () => {
  const result = inspectBoundAgentModelPolicyReadinessV1(readinessRequest());

  assert.equal(result.jobId, 'agent.runtime.001');
  assert.equal(result.projectId, 'project.alpha');
  assert.equal(result.agentDefinitionId, 'agent.research');
  assert.equal(result.definitionRevision, 4);
  assert.equal(result.routePoolRevision, 9);
  assert.deepEqual(result.authorityRouteIds, ['route.a', 'route.b', 'route.c']);
  assert.deepEqual(result.effectiveRouteIds, ['route.a', 'route.b']);
  assert.equal(result.readiness.state, AgentRouteReadinessState.READY);
  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.planner.eligibleRouteIds.includes('route.c'), false);
  assert.equal(result.readiness.verifier.eligibleRouteIds.includes('route.c'), false);
  assert.equal(result.readiness.planner.availableRouteIds.includes('route.c'), false);
  assert.equal(result.readiness.verifier.availableRouteIds.includes('route.c'), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.effectiveRouteIds), true);
  assert.equal(Object.isFrozen(result.readiness), true);
});

test('child readiness is reconstructed through the exact current parent model-policy binding', () => {
  const result = inspectBoundAgentModelPolicyReadinessV1(childReadinessRequest());
  assert.equal(result.readiness.state, AgentRouteReadinessState.READY);
  assert.deepEqual(result.effectiveRouteIds, ['route.a', 'route.b']);
  assert.equal(result.definitionRevision, 4);
});

test('child readiness requires current parent authority and rejects parent identity or revision drift', () => {
  const request = childReadinessRequest();
  const missing = { ...request };
  delete missing.currentParentModelPolicyBinding;
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(missing),
    /requires current parent model-policy provenance/u,
  );

  const missingKey = { ...request };
  delete missingKey.currentParentModelPolicyBindingKey;
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(missingKey),
    /requires current parent model-policy provenance/u,
  );

  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(childReadinessRequest({
      currentParentModelPolicyBinding: parentModelPolicyBinding({
        agentId: 'agent.other-parent',
      }),
      currentParentModelPolicyBindingKey: parentModelPolicyBinding({
        agentId: 'agent.other-parent',
      }).bindingKey,
    })),
    /parent model policy identity is stale/u,
  );

  const alternateParent = parentModelPolicyBinding({
    routePolicy: {
      allowRouteIds: ['route.a', 'route.b'],
      locality: 'remote',
    },
  });
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(childReadinessRequest({
      currentParentModelPolicyBinding: alternateParent,
    })),
    /parent binding is not the current owner binding/u,
  );

  assert.throws(
    () => {
      const staleParent = parentModelPolicyBinding({
        routePoolRevision: 10,
      });
      return inspectBoundAgentModelPolicyReadinessV1(childReadinessRequest({
        currentParentModelPolicyBinding: staleParent,
        currentParentModelPolicyBindingKey: staleParent.bindingKey,
      }));
    },
    /parent route-pool revision is stale/u,
  );
});

test('same-revision child definition policy drift cannot reuse a binding under the current parent', () => {
  const current = selection();
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(childReadinessRequest({
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
    /child model policy drifted from the current parent\/definition authority/u,
  );
});

test('root readiness rejects a parent binding alias', () => {
  assert.throws(
    () => {
      const parentBinding = parentModelPolicyBinding();
      return inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
        currentParentModelPolicyBinding: parentBinding,
        currentParentModelPolicyBindingKey: parentBinding.bindingKey,
      }));
    },
    /Root Agent model readiness must not supply parent model-policy provenance/u,
  );
});

test('same-definition-revision alternate durable binding cannot replace the owner-current binding', () => {
  const current = definitionBinding();
  const alternate = definitionBinding({
    routePoolRevision: 10,
  });
  assert.equal(alternate.definitionBinding.definitionRevision, current.definitionBinding.definitionRevision);
  assert.notEqual(alternate.bindingKey, current.bindingKey);

  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      definitionModelPolicyBinding: alternate,
      currentDefinitionModelPolicyBindingKey: current.bindingKey,
      currentRoutePoolRevision: 10,
    })),
    /not the current owner binding/u,
  );
});

test('stale current Agent definition selection fails before readiness inspection', () => {
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      currentDefinitionSelection: selection({ definitionRevision: 5 }),
    })),
    /definition selection is stale/u,
  );
});

test('same-revision disabled Agent definition cannot retain readiness authority', () => {
  const current = selection();
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      currentDefinitionSelection: {
        ...current,
        definition: {
          ...current.definition,
          enabled: false,
        },
      },
    })),
    /definition is disabled/u,
  );
});

test('same-revision root model policy drift cannot reuse the durable binding', () => {
  const current = selection();
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      currentDefinitionSelection: {
        ...current,
        definition: {
          ...current.definition,
          modelRoutePolicy: {
            ...current.definition.modelRoutePolicy,
            freeOnly: true,
          },
        },
      },
    })),
    /root model policy drifted/u,
  );
});

test('current job and Project identities are exact owner fences', () => {
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      currentJobId: 'agent.runtime.other',
    })),
    /job identity is stale/u,
  );
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      currentProjectId: 'project.other',
    })),
    /Project identity is stale/u,
  );
});

test('stale route-pool revision fails even when route IDs are unchanged', () => {
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      currentRoutePoolRevision: 10,
    })),
    /route-pool revision is stale/u,
  );
});

test('every bound authority route must still exist in the same canonical route-pool revision', () => {
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      routes: pool().filter(item => item.routeId !== 'route.a'),
    })),
    /authority route is missing from current route pool: route\.a/u,
  );

  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      routes: pool().filter(item => item.routeId !== 'route.c'),
    })),
    /authority route is missing from current route pool: route\.c/u,
  );
});

test('same-revision authority route ordering drift fails closed', () => {
  const routes = pool();
  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
      routes: [routes[1], routes[0], routes[2]],
    })),
    /authority route order drifted/u,
  );
});

test('bound readiness supports verifier-only work without requiring planner eligibility', () => {
  const verifierOnlyRoutes = pool().map(item => (
    item.routeId === 'route.a' || item.routeId === 'route.b'
      ? { ...item, roles: ['verifier'] }
      : item
  ));
  const result = inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
    routes: verifierOnlyRoutes,
    requiresPlanner: false,
    requiresVerifier: true,
    verifierCapabilityIds: ['cap.reason'],
  }));

  assert.equal(result.readiness.state, AgentRouteReadinessState.READY);
  assert.equal(result.readiness.requiresPlanner, false);
  assert.equal(result.readiness.requiresVerifier, true);
  assert.deepEqual(result.readiness.planner.availableRouteIds, []);
  assert.deepEqual(result.readiness.verifier.availableRouteIds, ['route.a', 'route.b']);
});

test('routes outside durable effectiveRouteIds cannot make an otherwise unavailable Agent ready', () => {
  const limitedBinding = definitionBinding({
    ownerAllowedRouteIds: ['route.a', 'route.b'],
  });
  const routes = pool().map(item => (
    item.routeId === 'route.a' || item.routeId === 'route.b'
      ? { ...item, roles: ['coder'] }
      : item
  ));
  const result = inspectBoundAgentModelPolicyReadinessV1(readinessRequest({
    definitionModelPolicyBinding: limitedBinding,
    currentDefinitionModelPolicyBindingKey: limitedBinding.bindingKey,
    routes,
    requiresVerifier: false,
  }));

  assert.equal(result.readiness.state, AgentRouteReadinessState.UNAVAILABLE_CONFIG);
  assert.equal(result.readiness.ready, false);
  assert.equal(result.readiness.planner.eligibleRouteIds.includes('route.c'), false);
});

test('top-level descriptor boundary rejects accessors without executing them', () => {
  let reads = 0;
  const hostile = readinessRequest();
  Object.defineProperty(hostile, 'currentJobId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'agent.runtime.001';
    },
  });

  assert.throws(
    () => inspectBoundAgentModelPolicyReadinessV1(hostile),
    /currentJobId must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);
});

test('unknown caller-shaped policy and authority aliases fail closed', () => {
  for (const extra of [
    { policy: {} },
    { routeId: 'route.c' },
    { routeSelectionAuthorized: true },
    { providerCallAuthorized: true },
  ]) {
    assert.throws(
      () => inspectBoundAgentModelPolicyReadinessV1({
        ...readinessRequest(),
        ...extra,
      }),
      /contains unknown field/u,
    );
  }
});

test('authority remains advisory and cannot select routes or call providers', () => {
  const result = inspectBoundAgentModelPolicyReadinessV1(readinessRequest());
  assert.equal(result.authority, AGENT_MODEL_POLICY_READINESS_BINDING_AUTHORITY);
  assert.equal(result.authority.advisoryOnly, true);
  assert.equal(result.authority.routeSelectionAuthorized, false);
  assert.equal(result.authority.providerCallAuthorized, false);
  assert.equal(result.authority.executionAuthorized, false);
  assert.equal(result.authority.policyAuthorized, false);
  assert.equal(result.authority.persistenceAuthorized, false);
  assert.equal(result.authority.schedulingAuthorized, false);
  assert.equal(result.authority.recoveryAuthorized, false);
  assert.equal(result.authority.requiresCurrentDefinitionBinding, true);
  assert.equal(result.authority.requiresCurrentRoutePoolRevision, true);
});
