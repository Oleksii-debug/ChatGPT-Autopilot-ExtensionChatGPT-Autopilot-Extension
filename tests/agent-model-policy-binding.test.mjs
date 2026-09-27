import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentModelPolicyBindingV1,
  normalizeAgentModelPolicyBindingV1,
} from '../src/core/agent-model-policy-binding.js';

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
    route('route.b', { costClass: 'free', inputPricePerMillionUsd: 0, outputPricePerMillionUsd: 0 }),
    route('route.c'),
    route('route.d'),
  ];
}

function request(overrides = {}) {
  return {
    projectId: 'project.alpha',
    agentId: 'agent.top',
    policyRevision: 1,
    routePoolRevision: 7,
    routePool: pool(),
    ownerAllowedRouteIds: ['route.a', 'route.b', 'route.c'],
    routePolicy: {},
    ...overrides,
  };
}

test('top-level Agent receives an explicit owner-bounded route projection and zero authority', () => {
  const binding = createAgentModelPolicyBindingV1(request());

  assert.equal(binding.projectId, 'project.alpha');
  assert.equal(binding.agentId, 'agent.top');
  assert.equal(binding.parentAgentId, null);
  assert.deepEqual(binding.authorityRouteIds, ['route.a', 'route.b', 'route.c']);
  assert.deepEqual(binding.effectiveRouteIds, ['route.a', 'route.b', 'route.c']);
  assert.deepEqual(binding.routePolicy.allowRouteIds, ['route.a', 'route.b', 'route.c']);
  assert.equal(binding.executionAuthority, false);
  assert.equal(binding.providerAuthority, false);
  assert.equal(binding.credentialAuthority, false);
  assert.equal(binding.policyAuthority, false);
  assert.equal(binding.persistenceAuthority, false);
  assert.equal(binding.schedulingAuthority, false);
  assert.equal(binding.currentRouterRevalidationRequired, true);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.authorityRouteIds), true);
  assert.equal(Object.isFrozen(binding.effectiveRouteIds), true);
  assert.equal(Object.isFrozen(binding.routePolicy), true);
  assert.equal(Object.isFrozen(binding.routePolicy.allowRouteIds), true);
});

test('Agent-specific policy preserves normalized owner choices inside its authority', () => {
  const binding = createAgentModelPolicyBindingV1(request({
    routePolicy: {
      autoSwitch: false,
      pinnedRouteId: 'route.b',
      orderedRouteIds: ['route.b', 'route.a'],
      allowRouteIds: ['route.b', 'route.a'],
      denyRouteIds: [],
      freeOnly: true,
      locality: 'remote',
      maxInputPricePerMillionUsd: 3,
      maxOutputPricePerMillionUsd: 4,
      retryBackoffSeconds: 120,
      circuitBreakerFailures: 1,
      circuitBreakerSeconds: 600,
    },
  }));

  assert.deepEqual(binding.routePolicy.allowRouteIds, ['route.a', 'route.b']);
  assert.deepEqual(binding.routePolicy.orderedRouteIds, ['route.b', 'route.a']);
  assert.deepEqual(binding.effectiveRouteIds, ['route.a', 'route.b']);
  assert.equal(binding.routePolicy.pinnedRouteId, 'route.b');
  assert.equal(binding.routePolicy.autoSwitch, false);
  assert.equal(binding.routePolicy.freeOnly, true);
  assert.equal(binding.routePolicy.locality, 'remote');
  assert.equal(binding.routePolicy.maxInputPricePerMillionUsd, 3);
  assert.equal(binding.routePolicy.maxOutputPricePerMillionUsd, 4);
  assert.equal(binding.routePolicy.retryBackoffSeconds, 120);
  assert.equal(binding.routePolicy.circuitBreakerFailures, 1);
  assert.equal(binding.routePolicy.circuitBreakerSeconds, 600);
});

test('child Agent derives identity from the trusted parent binding and can only narrow parent routes', () => {
  const parent = createAgentModelPolicyBindingV1(request({
    agentId: 'agent.parent',
    routePolicy: {
      allowRouteIds: ['route.a', 'route.b'],
      denyRouteIds: ['route.a'],
      freeOnly: true,
      locality: 'remote',
      retryBackoffSeconds: 120,
      circuitBreakerFailures: 1,
      circuitBreakerSeconds: 600,
    },
  }));
  assert.deepEqual(parent.effectiveRouteIds, ['route.b']);

  const child = createAgentModelPolicyBindingV1(request({
    agentId: 'agent.child',
    policyRevision: 2,
    ownerAllowedRouteIds: ['route.b', 'route.c'],
    parentBinding: parent,
    routePolicy: {
      allowRouteIds: ['route.b'],
      freeOnly: true,
      locality: 'remote',
      retryBackoffSeconds: 180,
      circuitBreakerFailures: 1,
      circuitBreakerSeconds: 900,
    },
  }));

  assert.equal(child.parentAgentId, 'agent.parent');
  assert.deepEqual(child.authorityRouteIds, ['route.b']);
  assert.deepEqual(child.effectiveRouteIds, ['route.b']);

  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      agentId: 'agent.child',
      ownerAllowedRouteIds: ['route.b', 'route.c'],
      parentBinding: parent,
      routePolicy: {
        allowRouteIds: ['route.c'],
        freeOnly: true,
        locality: 'remote',
        retryBackoffSeconds: 180,
        circuitBreakerFailures: 1,
        circuitBreakerSeconds: 900,
      },
    })),
    /exceeds route authority/,
  );
});

test('child inherits parent routing constraints when it only narrows route authority', () => {
  const parent = createAgentModelPolicyBindingV1(request({
    agentId: 'agent.parent',
    routePolicy: {
      allowRouteIds: ['route.a', 'route.b'],
      orderedRouteIds: ['route.b', 'route.a'],
      autoSwitch: false,
      freeOnly: true,
      locality: 'remote',
      maxInputPricePerMillionUsd: 3,
      maxOutputPricePerMillionUsd: 4,
      retryBackoffSeconds: 120,
      circuitBreakerFailures: 1,
      circuitBreakerSeconds: 600,
    },
  }));

  const childInput = request({
    agentId: 'agent.child',
    policyRevision: 2,
    ownerAllowedRouteIds: ['route.b', 'route.c'],
    parentBinding: parent,
  });
  delete childInput.routePolicy;

  const child = createAgentModelPolicyBindingV1(childInput);
  assert.deepEqual(child.authorityRouteIds, ['route.b']);
  assert.deepEqual(child.routePolicy.allowRouteIds, ['route.b']);
  assert.deepEqual(child.routePolicy.orderedRouteIds, ['route.b']);
  assert.equal(child.routePolicy.autoSwitch, false);
  assert.equal(child.routePolicy.freeOnly, true);
  assert.equal(child.routePolicy.locality, 'remote');
  assert.equal(child.routePolicy.maxInputPricePerMillionUsd, 3);
  assert.equal(child.routePolicy.maxOutputPricePerMillionUsd, 4);
  assert.equal(child.routePolicy.retryBackoffSeconds, 120);
  assert.equal(child.routePolicy.circuitBreakerFailures, 1);
  assert.equal(child.routePolicy.circuitBreakerSeconds, 600);
});

test('child cannot widen parent behavioral routing constraints', () => {
  const parent = createAgentModelPolicyBindingV1(request({
    agentId: 'agent.parent',
    routePolicy: {
      pinnedRouteId: 'route.b',
      allowRouteIds: ['route.a', 'route.b'],
      autoSwitch: false,
      freeOnly: true,
      locality: 'remote',
      maxInputPricePerMillionUsd: 3,
      maxOutputPricePerMillionUsd: 4,
      retryBackoffSeconds: 120,
      circuitBreakerFailures: 1,
      circuitBreakerSeconds: 600,
    },
  }));

  const base = {
    allowRouteIds: ['route.b'],
    pinnedRouteId: 'route.b',
    autoSwitch: false,
    freeOnly: true,
    locality: 'remote',
    maxInputPricePerMillionUsd: 3,
    maxOutputPricePerMillionUsd: 4,
    retryBackoffSeconds: 120,
    circuitBreakerFailures: 1,
    circuitBreakerSeconds: 600,
  };

  const cases = [
    [{ ...base, autoSwitch: true }, /autoSwitch/],
    [{ ...base, freeOnly: false }, /freeOnly/],
    [{ ...base, locality: 'any' }, /locality/],
    [{ ...base, maxInputPricePerMillionUsd: null }, /input price cap/],
    [{ ...base, maxOutputPricePerMillionUsd: 5 }, /output price cap/],
    [{ ...base, pinnedRouteId: '' }, /pinned route/],
    [{ ...base, retryBackoffSeconds: 60 }, /retry backoff/],
    [{ ...base, circuitBreakerFailures: 2 }, /failure threshold/],
    [{ ...base, circuitBreakerSeconds: 300 }, /breaker duration/],
  ];

  for (const [routePolicy, pattern] of cases) {
    assert.throws(
      () => createAgentModelPolicyBindingV1(request({
        agentId: 'agent.child',
        policyRevision: 2,
        parentBinding: parent,
        ownerAllowedRouteIds: ['route.a', 'route.b'],
        routePolicy,
      })),
      pattern,
    );
  }
});

test('parent project and route-pool revision are exact restart fences', () => {
  const parent = createAgentModelPolicyBindingV1(request({ agentId: 'agent.parent' }));

  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      projectId: 'project.other',
      agentId: 'agent.child',
      parentBinding: parent,
    })),
    /projectId mismatch/,
  );

  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      agentId: 'agent.child',
      routePoolRevision: 8,
      parentBinding: parent,
    })),
    /routePoolRevision is stale/,
  );
});

test('owner and Agent route references cannot escape canonical route authority', () => {
  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      ownerAllowedRouteIds: ['route.a', 'route.unknown'],
    })),
    /unknown route/,
  );

  for (const routePolicy of [
    { allowRouteIds: ['route.d'] },
    { denyRouteIds: ['route.d'] },
    { orderedRouteIds: ['route.d'] },
    { pinnedRouteId: 'route.d' },
  ]) {
    assert.throws(
      () => createAgentModelPolicyBindingV1(request({ routePolicy })),
      /exceeds route authority/,
    );
  }
});

test('pin/order/deny references must remain inside the Agent allow set', () => {
  for (const routePolicy of [
    { allowRouteIds: ['route.a'], denyRouteIds: ['route.b'] },
    { allowRouteIds: ['route.a'], orderedRouteIds: ['route.b'] },
    { allowRouteIds: ['route.a'], pinnedRouteId: 'route.b' },
  ]) {
    assert.throws(
      () => createAgentModelPolicyBindingV1(request({ routePolicy })),
      /outside Agent allow scope/,
    );
  }
});

test('all-denied route scope and denied pin fail closed', () => {
  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      routePolicy: {
        allowRouteIds: ['route.a'],
        denyRouteIds: ['route.a'],
      },
    })),
    /no effective routes/,
  );

  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      routePolicy: {
        allowRouteIds: ['route.a', 'route.b'],
        denyRouteIds: ['route.a'],
        pinnedRouteId: 'route.a',
      },
    })),
    /pinned route is denied/i,
  );
});

test('durable normalizer rejects binding identity, effective-set and authority tampering', () => {
  const binding = createAgentModelPolicyBindingV1(request({
    routePolicy: {
      allowRouteIds: ['route.a', 'route.b'],
      denyRouteIds: ['route.a'],
    },
  }));

  assert.throws(
    () => normalizeAgentModelPolicyBindingV1({ ...binding, bindingKey: 'forged' }),
    /bindingKey is inconsistent/,
  );
  assert.throws(
    () => normalizeAgentModelPolicyBindingV1({
      ...binding,
      effectiveRouteIds: ['route.a', 'route.b'],
    }),
    /effectiveRouteIds is inconsistent/,
  );
  assert.throws(
    () => normalizeAgentModelPolicyBindingV1({ ...binding, executionAuthority: true }),
    /executionAuthority must be false/,
  );
  assert.throws(
    () => normalizeAgentModelPolicyBindingV1({ ...binding, providerAuthority: true }),
    /providerAuthority must be false/,
  );
  assert.throws(
    () => normalizeAgentModelPolicyBindingV1({
      ...binding,
      currentRouterRevalidationRequired: false,
    }),
    /currentRouterRevalidationRequired must be true/,
  );
});

test('binding identity is deterministic for exact replay and changes with policy semantics', () => {
  const first = createAgentModelPolicyBindingV1(request());
  const second = createAgentModelPolicyBindingV1(request());
  assert.equal(first.bindingKey, second.bindingKey);
  assert.deepEqual(first, second);

  const changed = createAgentModelPolicyBindingV1(request({
    routePolicy: { allowRouteIds: ['route.a', 'route.b'] },
  }));
  assert.notEqual(first.bindingKey, changed.bindingKey);
});

test('durable normalizer rejects non-canonical route-set ordering', () => {
  const binding = createAgentModelPolicyBindingV1(request({
    routePolicy: {
      allowRouteIds: ['route.b', 'route.a'],
      denyRouteIds: ['route.b'],
    },
  }));

  assert.deepEqual(binding.routePolicy.allowRouteIds, ['route.a', 'route.b']);
  assert.deepEqual(binding.routePolicy.denyRouteIds, ['route.b']);

  assert.throws(
    () => normalizeAgentModelPolicyBindingV1({
      ...binding,
      routePolicy: {
        ...binding.routePolicy,
        allowRouteIds: ['route.b', 'route.a'],
      },
    }),
    /routePolicy\.allowRouteIds is inconsistent/,
  );
});

test('revision fields reject signed zero, fractions, unsafe and string coercion', () => {
  for (const bad of [-0, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(
      () => createAgentModelPolicyBindingV1(request({ policyRevision: bad })),
      /policyRevision is invalid/,
    );
  }
  for (const bad of [-0, 0, 2.5, Number.MAX_SAFE_INTEGER + 1, '7']) {
    assert.throws(
      () => createAgentModelPolicyBindingV1(request({ routePoolRevision: bad })),
      /routePoolRevision is invalid/,
    );
  }
});

test('request boundary rejects accessors, symbols and unknown fields without getter execution', () => {
  let reads = 0;
  const accessor = request();
  Object.defineProperty(accessor, 'agentId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'agent.top';
    },
  });
  assert.throws(
    () => createAgentModelPolicyBindingV1(accessor),
    /agentId.*enumerable own data property/,
  );
  assert.equal(reads, 0);

  const symbol = request();
  symbol[Symbol('executionAuthority')] = true;
  assert.throws(() => createAgentModelPolicyBindingV1(symbol), /symbol field/);

  assert.throws(
    () => createAgentModelPolicyBindingV1({ ...request(), executionAuthority: true }),
    /unknown field: executionAuthority/,
  );
});

test('owner route scope rejects sparse, accessor-backed and duplicate arrays without getter execution', () => {
  const sparse = request();
  sparse.ownerAllowedRouteIds = new Array(2);
  sparse.ownerAllowedRouteIds[0] = 'route.a';
  assert.throws(
    () => createAgentModelPolicyBindingV1(sparse),
    /dense data-only array/,
  );

  let reads = 0;
  const accessorList = ['route.a'];
  Object.defineProperty(accessorList, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'route.a';
    },
  });
  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      ownerAllowedRouteIds: accessorList,
    })),
    /dense data-only array/,
  );
  assert.equal(reads, 0);

  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      ownerAllowedRouteIds: ['route.a', 'route.a'],
    })),
    /contains duplicates/,
  );
});

test('routePolicy input is fail-closed rather than truthy/falsy-coerced', () => {
  assert.throws(
    () => createAgentModelPolicyBindingV1(request({ routePolicy: false })),
    /AI route policy must be an object/,
  );

  const parent = createAgentModelPolicyBindingV1(request({ agentId: 'agent.parent' }));
  assert.throws(
    () => createAgentModelPolicyBindingV1(request({
      agentId: 'agent.child',
      parentBinding: parent,
      routePolicy: false,
    })),
    /Child AiRoutePolicy must be a plain object/,
  );
});

test('canonical route-pool normalizer remains the only route metadata authority', () => {
  const hostile = pool();
  hostile[0] = { ...hostile[0], secretCredential: 'must-not-pass' };
  assert.throws(
    () => createAgentModelPolicyBindingV1(request({ routePool: hostile })),
    /unknown field: secretCredential/,
  );
});
