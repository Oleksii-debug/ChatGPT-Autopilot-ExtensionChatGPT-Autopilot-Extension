import test from 'node:test';
import assert from 'node:assert/strict';

import {
  materializeAgentDefinitionV1,
  selectAgentDefinitionV1,
} from '../src/core/agent-definition-registry.js';
import {
  createAgentModelPolicyBindingV1,
} from '../src/core/agent-model-policy-binding.js';
import {
  createAgentDefinitionModelPolicyBindingV1,
  normalizeAgentDefinitionModelPolicyBindingV1,
} from '../src/core/agent-definition-model-policy-binding.js';

function route(routeId, overrides = {}) {
  return {
    schemaVersion: 1,
    routeId,
    provider: 'openai',
    model: `model-${routeId}`,
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
    route('route.a'),
    route('route.b', {
      costClass: 'free',
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
    }),
    route('route.c'),
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
      autoSwitch: false,
      pinnedRouteId: 'route.b',
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

function materialized(definitionOverrides = {}, requestOverrides = {}) {
  const reg = registry(definitionOverrides);
  return materializeAgentDefinitionV1({
    registry: reg,
    selection: selectAgentDefinitionV1({
      registry: reg,
      agentDefinitionId: 'agent.research',
    }),
    jobId: 'agent.runtime.001',
    projectId: 'project.alpha',
    goal: 'Produce a bounded evidence report.',
    ownerBudget: ownerBudget(),
    ownerCapabilityIds: ['project.context', 'research.read'],
    ownerToolIds: ['browser.read', 'files.read'],
    requestedCapabilityIds: ['project.context', 'research.read'],
    requestedToolIds: ['browser.read'],
    ...requestOverrides,
  });
}

function bindRequest(overrides = {}) {
  return {
    materializedAgent: materialized(),
    routePool: pool(),
    routePoolRevision: 9,
    ownerAllowedRouteIds: ['route.a', 'route.b', 'route.c'],
    ...overrides,
  };
}

test('materialized reusable Agent becomes a durable per-Agent model-policy binding', () => {
  const binding = createAgentDefinitionModelPolicyBindingV1(bindRequest());

  assert.deepEqual(binding.definitionBinding, {
    registryId: 'agents:project.alpha',
    registryRevision: 6,
    agentDefinitionId: 'agent.research',
    definitionRevision: 4,
  });
  assert.equal(binding.jobId, 'agent.runtime.001');
  assert.equal(binding.projectId, 'project.alpha');
  assert.equal(binding.modelPolicyBinding.agentId, 'agent.runtime.001');
  assert.equal(binding.modelPolicyBinding.projectId, 'project.alpha');
  assert.equal(binding.modelPolicyBinding.policyRevision, 4);
  assert.equal(binding.modelPolicyBinding.routePoolRevision, 9);
  assert.equal(binding.modelPolicyBinding.routePolicy.pinnedRouteId, 'route.b');
  assert.equal(binding.modelPolicyBinding.routePolicy.autoSwitch, false);
  assert.deepEqual(binding.modelPolicyBinding.routePolicy.allowRouteIds, ['route.a', 'route.b']);
  assert.deepEqual(binding.modelPolicyBinding.effectiveRouteIds, ['route.a', 'route.b']);
  assert.equal(binding.executionAuthority, false);
  assert.equal(binding.providerAuthority, false);
  assert.equal(binding.credentialAuthority, false);
  assert.equal(binding.policyAuthority, false);
  assert.equal(binding.persistenceAuthority, false);
  assert.equal(binding.schedulingAuthority, false);
  assert.equal(binding.recoveryAuthority, false);
  assert.equal(binding.currentRouterRevalidationRequired, true);
  assert.equal(binding.modelPolicyBinding.currentRouterRevalidationRequired, true);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.definitionBinding), true);
  assert.equal(Object.isFrozen(binding.modelPolicyBinding), true);
});

test('definitionRevision is the model-policy revision and registry identity is bound into restart key', () => {
  const first = createAgentDefinitionModelPolicyBindingV1(bindRequest());
  const changed = createAgentDefinitionModelPolicyBindingV1(bindRequest({
    materializedAgent: materialized({ definitionRevision: 5 }),
  }));

  assert.equal(first.modelPolicyBinding.policyRevision, 4);
  assert.equal(changed.modelPolicyBinding.policyRevision, 5);
  assert.notEqual(changed.bindingKey, first.bindingKey);

  const roundTripped = normalizeAgentDefinitionModelPolicyBindingV1(
    JSON.parse(JSON.stringify(first)),
  );
  assert.deepEqual(roundTripped, first);
});

test('Agent definition without a model override receives canonical owner-bounded Router defaults', () => {
  const noPolicy = materialized({ modelRoutePolicy: null });
  assert.deepEqual(noPolicy.routerOverride, {});

  const binding = createAgentDefinitionModelPolicyBindingV1(bindRequest({
    materializedAgent: noPolicy,
    ownerAllowedRouteIds: ['route.b', 'route.c'],
  }));

  assert.deepEqual(binding.modelPolicyBinding.authorityRouteIds, ['route.b', 'route.c']);
  assert.deepEqual(binding.modelPolicyBinding.effectiveRouteIds, ['route.b', 'route.c']);
  assert.deepEqual(binding.modelPolicyBinding.routePolicy.allowRouteIds, ['route.b', 'route.c']);
  assert.equal(binding.modelPolicyBinding.parentAgentId, null);
});

test('materialized policy cannot escape current owner route authority', () => {
  assert.throws(
    () => createAgentDefinitionModelPolicyBindingV1(bindRequest({
      ownerAllowedRouteIds: ['route.c'],
    })),
    /exceeds route authority|no routes inside owner\/parent model authority/u,
  );

  const forged = structuredClone(materialized());
  forged.routerOverride.routePolicy.allowRouteIds = ['route.c'];
  forged.routerOverride.routePolicy.pinnedRouteId = '';
  forged.routerOverride.routePolicy.orderedRouteIds = ['route.c'];
  assert.throws(
    () => createAgentDefinitionModelPolicyBindingV1(bindRequest({
      materializedAgent: forged,
      ownerAllowedRouteIds: ['route.a', 'route.b'],
    })),
    /exceeds route authority/u,
  );
});

test('parent Agent binding remains canonical authority and child definition can only narrow it', () => {
  const parent = createAgentModelPolicyBindingV1({
    projectId: 'project.alpha',
    agentId: 'agent.parent',
    policyRevision: 3,
    routePoolRevision: 9,
    routePool: pool(),
    ownerAllowedRouteIds: ['route.a', 'route.b'],
    routePolicy: {
      allowRouteIds: ['route.b'],
      freeOnly: true,
      locality: 'remote',
      retryBackoffSeconds: 120,
      circuitBreakerFailures: 1,
      circuitBreakerSeconds: 600,
    },
  });

  const childMaterialized = materialized({
    modelRoutePolicy: {
      allowRouteIds: ['route.b'],
      freeOnly: true,
      locality: 'remote',
    },
  });
  const child = createAgentDefinitionModelPolicyBindingV1(bindRequest({
    materializedAgent: childMaterialized,
    ownerAllowedRouteIds: ['route.b', 'route.c'],
    parentBinding: parent,
  }));

  assert.equal(child.modelPolicyBinding.parentAgentId, 'agent.parent');
  assert.deepEqual(child.modelPolicyBinding.authorityRouteIds, ['route.b']);
  assert.deepEqual(child.modelPolicyBinding.effectiveRouteIds, ['route.b']);
  assert.equal(child.modelPolicyBinding.routePolicy.freeOnly, true);
  assert.equal(child.modelPolicyBinding.routePolicy.retryBackoffSeconds, 120);
  assert.equal(child.modelPolicyBinding.routePolicy.circuitBreakerFailures, 1);
  assert.equal(child.modelPolicyBinding.routePolicy.circuitBreakerSeconds, 600);
});

test('child definition cannot relax parent policy or use a stale parent route-pool revision', () => {
  const parent = createAgentModelPolicyBindingV1({
    projectId: 'project.alpha',
    agentId: 'agent.parent',
    policyRevision: 3,
    routePoolRevision: 9,
    routePool: pool(),
    ownerAllowedRouteIds: ['route.b'],
    routePolicy: {
      allowRouteIds: ['route.b'],
      freeOnly: true,
      locality: 'remote',
      retryBackoffSeconds: 120,
      circuitBreakerFailures: 1,
      circuitBreakerSeconds: 600,
    },
  });

  assert.throws(
    () => createAgentDefinitionModelPolicyBindingV1(bindRequest({
      materializedAgent: materialized({
        modelRoutePolicy: {
          allowRouteIds: ['route.b'],
          freeOnly: false,
          locality: 'remote',
        },
      }),
      ownerAllowedRouteIds: ['route.b'],
      parentBinding: parent,
    })),
    /cannot disable parent freeOnly constraint/u,
  );

  assert.throws(
    () => createAgentDefinitionModelPolicyBindingV1(bindRequest({
      routePoolRevision: 10,
      ownerAllowedRouteIds: ['route.b'],
      parentBinding: parent,
    })),
    /routePoolRevision is stale/u,
  );
});

test('adapter does not accept caller-shaped policy or identity aliases beside materialized Agent bytes', () => {
  for (const extra of [
    { routePolicy: {} },
    { agentId: 'agent.forged' },
    { projectId: 'project.forged' },
    { policyRevision: 99 },
  ]) {
    assert.throws(
      () => createAgentDefinitionModelPolicyBindingV1({
        ...bindRequest(),
        ...extra,
      }),
      /contains unknown field/u,
    );
  }
});

test('projectless reusable Agent cannot mint a durable per-Agent model policy binding', () => {
  const projectless = materialized({}, { projectId: '' });
  assert.equal(projectless.config.projectId, '');
  assert.throws(
    () => createAgentDefinitionModelPolicyBindingV1(bindRequest({
      materializedAgent: projectless,
    })),
    /Materialized Agent config\.projectId is invalid/u,
  );
});

test('materialized authority must remain non-authorizing before model-policy binding', () => {
  const forged = structuredClone(materialized());
  forged.authority.executionAuthorized = true;
  assert.throws(
    () => createAgentDefinitionModelPolicyBindingV1(bindRequest({
      materializedAgent: forged,
    })),
    /executionAuthorized must be false/u,
  );
});

test('materialized descriptor boundary rejects accessors without executing them', () => {
  for (const target of ['config', 'definitionBinding', 'routerOverride']) {
    let reads = 0;
    const forged = structuredClone(materialized());
    if (target === 'config') {
      Object.defineProperty(forged.config, 'id', {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return 'agent.forged';
        },
      });
    } else if (target === 'definitionBinding') {
      Object.defineProperty(forged.definitionBinding, 'definitionRevision', {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return 99;
        },
      });
    } else {
      Object.defineProperty(forged.routerOverride, 'routePolicy', {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return {};
        },
      });
    }

    assert.throws(
      () => createAgentDefinitionModelPolicyBindingV1(bindRequest({
        materializedAgent: forged,
      })),
      /enumerable own data property/u,
    );
    assert.equal(reads, 0);
  }
});

test('durable normalization rejects definition/model identity, revision and binding-key tampering', () => {
  const binding = createAgentDefinitionModelPolicyBindingV1(bindRequest());

  const wrongJob = JSON.parse(JSON.stringify(binding));
  wrongJob.jobId = 'agent.other';
  assert.throws(
    () => normalizeAgentDefinitionModelPolicyBindingV1(wrongJob),
    /jobId does not match model policy Agent identity/u,
  );

  const wrongRevision = JSON.parse(JSON.stringify(binding));
  wrongRevision.definitionBinding.definitionRevision += 1;
  assert.throws(
    () => normalizeAgentDefinitionModelPolicyBindingV1(wrongRevision),
    /definition revision does not match model policy revision/u,
  );

  const wrongKey = JSON.parse(JSON.stringify(binding));
  wrongKey.bindingKey += ':tampered';
  assert.throws(
    () => normalizeAgentDefinitionModelPolicyBindingV1(wrongKey),
    /bindingKey is inconsistent/u,
  );

  const authority = JSON.parse(JSON.stringify(binding));
  authority.currentRouterRevalidationRequired = false;
  assert.throws(
    () => normalizeAgentDefinitionModelPolicyBindingV1(authority),
    /currentRouterRevalidationRequired must be true/u,
  );
});

test('durable bridge binds registry revision even when underlying model policy bytes are unchanged', () => {
  const first = createAgentDefinitionModelPolicyBindingV1(bindRequest());

  const materializedCopy = structuredClone(materialized());
  materializedCopy.definitionBinding.registryRevision = 7;
  const second = createAgentDefinitionModelPolicyBindingV1(bindRequest({
    materializedAgent: materializedCopy,
  }));

  assert.equal(second.modelPolicyBinding.bindingKey, first.modelPolicyBinding.bindingKey);
  assert.notEqual(second.bindingKey, first.bindingKey);
  assert.equal(second.definitionBinding.registryRevision, 7);
});
