import test from 'node:test';
import assert from 'node:assert/strict';

import { AiRouteRole } from '../src/core/ai-route-pool.js';
import { deriveSubagentAuthorityEnvelopeV1 } from '../src/core/subagent-authority-envelope.js';
import {
  SubagentModelRouteScopeDecision,
  deriveSubagentModelRouteScopeV1,
} from '../src/core/subagent-model-route-scope.js';

function route(routeId, overrides = {}) {
  return {
    schemaVersion: 1,
    routeId,
    provider: 'openai',
    model: 'model-' + routeId,
    endpointId: 'openai',
    displayName: routeId,
    systemPrompt: 'PRIVATE ROUTE SYSTEM PROMPT ' + routeId,
    workerPrompt: 'PRIVATE ROUTE WORKER PROMPT ' + routeId,
    roles: [AiRouteRole.CODER, AiRouteRole.FAST_WORKER],
    capabilityIds: ['model.code'],
    priority: 10,
    enabled: true,
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
    supportsVision: false,
    maxWorkers: 8,
    ...overrides,
  };
}

function routes() {
  return [
    route('route.remote.expensive', {
      priority: 10,
      inputPricePerMillionUsd: 5,
      outputPricePerMillionUsd: 10,
    }),
    route('route.local', {
      provider: 'ollama',
      model: 'local-model',
      endpointId: 'ollama',
      priority: 30,
      locality: 'local',
      costClass: 'free',
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
    }),
    route('route.vision', {
      priority: 15,
      capabilityIds: ['model.code', 'model.vision'],
      inputPricePerMillionUsd: 0.5,
      outputPricePerMillionUsd: 0.5,
      supportsVision: true,
    }),
    route('route.remote.cheap', {
      priority: 20,
      inputPricePerMillionUsd: 0.2,
      outputPricePerMillionUsd: 0.4,
    }),
  ];
}

function childAuthority(capabilityIds = ['model.code', 'model.vision'], overrides = {}) {
  return deriveSubagentAuthorityEnvelopeV1({
    projectId: 'project.alpha',
    parentAgentId: 'agent.parent',
    childAgentId: 'agent.child',
    taskId: 'task.one',
    providerId: 'provider.model-worker',
    parentProviderIds: ['provider.model-worker'],
    ownerAllowedProviderIds: ['provider.model-worker'],
    parentCapabilityIds: capabilityIds,
    ownerAllowedCapabilityIds: capabilityIds,
    providerCapabilityIds: capabilityIds,
    taskRequestedCapabilityIds: capabilityIds,
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

function request(overrides = {}) {
  return {
    childAuthorityEnvelope: childAuthority(),
    routes: routes(),
    parentRoutePolicy: {},
    ownerRoutePolicy: {},
    taskModelCapabilityIds: ['model.code'],
    taskRequestedRouteIds: [],
    role: AiRouteRole.FAST_WORKER,
    requiresVision: false,
    ...overrides,
  };
}

test('derives only the common parent-owner model route scope and grants zero execution authority', () => {
  const value = deriveSubagentModelRouteScopeV1(request());

  assert.equal(value.decision, SubagentModelRouteScopeDecision.ALLOW);
  assert.equal(value.reasonCode, 'MODEL_ROUTE_SCOPE_ADMITTED');
  assert.equal(value.childAuthorityProviderId, 'provider.model-worker');
  assert.deepEqual(value.admittedRouteIds, [
    'route.local',
    'route.remote.cheap',
    'route.remote.expensive',
    'route.vision',
  ]);
  assert.deepEqual(value.parentPolicyRouteIds, value.admittedRouteIds);
  assert.deepEqual(value.ownerPolicyRouteIds, value.admittedRouteIds);
  assert.deepEqual(value.commonRouteIds, value.admittedRouteIds);
  assert.equal(value.routeSelectionAuthority, false);
  assert.equal(value.providerExecutionAuthority, false);
  assert.equal(value.policyAuthority, false);
  assert.equal(value.schedulingAuthority, false);
  assert.equal(value.recoveryAuthority, false);
  assert.equal(value.credentialAuthority, false);
  assert.equal(value.completionAuthority, false);
  assert.equal(value.derivedFromTransientRouteState, false);
  assert.equal(value.requiresCurrentRouterRevalidation, true);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.routeBindings), true);
  assert.equal(Object.isFrozen(value.routeBindings[0]), true);

  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('PRIVATE ROUTE SYSTEM PROMPT'), false);
  assert.equal(serialized.includes('PRIVATE ROUTE WORKER PROMPT'), false);
});

test('owner free-only policy narrows a child to the free local route', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    ownerRoutePolicy: { freeOnly: true },
  }));

  assert.equal(value.decision, 'ALLOW');
  assert.deepEqual(value.ownerPolicyRouteIds, ['route.local']);
  assert.deepEqual(value.admittedRouteIds, ['route.local']);
  assert.equal(value.routeBindings[0].provider, 'ollama');
  assert.equal(value.routeBindings[0].locality, 'local');
  assert.equal(value.routeBindings[0].costClass, 'free');
});

test('parent locality and owner price ceilings are intersected without inventing a merged Router policy', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    parentRoutePolicy: { locality: 'remote' },
    ownerRoutePolicy: {
      maxInputPricePerMillionUsd: 1,
      maxOutputPricePerMillionUsd: 1,
    },
  }));

  assert.equal(value.decision, 'ALLOW');
  assert.deepEqual(value.parentPolicyRouteIds, [
    'route.remote.cheap',
    'route.remote.expensive',
    'route.vision',
  ]);
  assert.deepEqual(value.ownerPolicyRouteIds, [
    'route.local',
    'route.remote.cheap',
    'route.vision',
  ]);
  assert.deepEqual(value.admittedRouteIds, [
    'route.remote.cheap',
    'route.vision',
  ]);
});

test('parent and owner allow/deny scopes can only shrink the child intersection', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    parentRoutePolicy: {
      allowRouteIds: ['route.local', 'route.remote.cheap', 'route.vision'],
    },
    ownerRoutePolicy: {
      denyRouteIds: ['route.local', 'route.vision'],
    },
  }));

  assert.equal(value.decision, 'ALLOW');
  assert.deepEqual(value.admittedRouteIds, ['route.remote.cheap']);
});

test('conflicting parent and owner pins deny instead of choosing a third route', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    parentRoutePolicy: { pinnedRouteId: 'route.local' },
    ownerRoutePolicy: { pinnedRouteId: 'route.remote.cheap' },
  }));

  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'NO_COMMON_MODEL_ROUTE');
  assert.deepEqual(value.parentPolicyRouteIds, ['route.local']);
  assert.deepEqual(value.ownerPolicyRouteIds, ['route.remote.cheap']);
  assert.deepEqual(value.routeBindings, []);
});

test('parent no-switch semantics constrain the child to the canonical first candidate', () => {
  const parentRoutePolicy = {
    autoSwitch: false,
    orderedRouteIds: ['route.remote.expensive', 'route.local'],
  };
  const allowed = deriveSubagentModelRouteScopeV1(request({ parentRoutePolicy }));
  assert.deepEqual(allowed.parentPolicyRouteIds, ['route.remote.expensive']);
  assert.deepEqual(allowed.admittedRouteIds, ['route.remote.expensive']);

  const escalation = deriveSubagentModelRouteScopeV1(request({
    parentRoutePolicy,
    taskRequestedRouteIds: ['route.local'],
  }));
  assert.equal(escalation.decision, 'DENY');
  assert.equal(escalation.reasonCode, 'MODEL_ROUTE_ESCALATION');
  assert.deepEqual(escalation.deniedRouteIds, ['route.local']);
});

test('task requested route IDs are an exact narrowing request, never a hint that can widen authority', () => {
  const admitted = deriveSubagentModelRouteScopeV1(request({
    taskRequestedRouteIds: ['route.remote.cheap'],
  }));
  assert.equal(admitted.decision, 'ALLOW');
  assert.deepEqual(admitted.admittedRouteIds, ['route.remote.cheap']);
  assert.deepEqual(admitted.routeBindings.map(item => item.routeId), ['route.remote.cheap']);

  const denied = deriveSubagentModelRouteScopeV1(request({
    ownerRoutePolicy: { freeOnly: true },
    taskRequestedRouteIds: ['route.remote.cheap'],
  }));
  assert.equal(denied.decision, 'DENY');
  assert.equal(denied.reasonCode, 'MODEL_ROUTE_ESCALATION');
  assert.deepEqual(denied.deniedRouteIds, ['route.remote.cheap']);
});

test('unknown task route ID is denied even when all canonical policies are otherwise open', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    taskRequestedRouteIds: ['route.not-owned'],
  }));
  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'MODEL_ROUTE_ESCALATION');
  assert.deepEqual(value.deniedRouteIds, ['route.not-owned']);
});

test('task model capabilities cannot exceed the already-admitted child capability envelope', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    childAuthorityEnvelope: childAuthority(['model.code']),
    taskModelCapabilityIds: ['model.code', 'model.admin'],
  }));
  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'MODEL_CAPABILITY_ESCALATION');
  assert.deepEqual(value.deniedCapabilityIds, ['model.admin']);
  assert.deepEqual(value.routeBindings, []);
});

test('route capability requirements are enforced by the canonical Router selector', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    taskModelCapabilityIds: ['model.vision'],
  }));
  assert.equal(value.decision, 'ALLOW');
  assert.deepEqual(value.admittedRouteIds, ['route.vision']);
  assert.deepEqual(value.modelCapabilityIds, ['model.vision']);
});

test('vision requirement is inherited through canonical route eligibility', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    requiresVision: true,
  }));
  assert.equal(value.decision, 'ALLOW');
  assert.deepEqual(value.admittedRouteIds, ['route.vision']);
  assert.equal(value.routeBindings[0].supportsVision, true);
});

test('role mismatch yields no common route instead of silently changing child role', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    role: AiRouteRole.VERIFIER,
  }));
  assert.equal(value.decision, 'DENY');
  assert.equal(value.reasonCode, 'NO_COMMON_MODEL_ROUTE');
  assert.deepEqual(value.admittedRouteIds ?? [], []);
});

test('set-valued scope inputs are canonical across semantically equivalent ordering', () => {
  const forward = deriveSubagentModelRouteScopeV1(request({
    childAuthorityEnvelope: childAuthority(['model.code', 'model.vision']),
    taskModelCapabilityIds: ['model.code', 'model.vision'],
    taskRequestedRouteIds: ['route.vision'],
  }));
  const reordered = deriveSubagentModelRouteScopeV1(request({
    routes: [...routes()].reverse(),
    childAuthorityEnvelope: childAuthority(['model.vision', 'model.code']),
    taskModelCapabilityIds: ['model.vision', 'model.code'],
    taskRequestedRouteIds: ['route.vision'],
  }));

  assert.deepEqual(forward.admittedRouteIds, reordered.admittedRouteIds);
  assert.deepEqual(forward.modelCapabilityIds, ['model.code', 'model.vision']);
  assert.deepEqual(forward.taskRequestedRouteIds, ['route.vision']);
  assert.deepEqual(forward.routeBindings, reordered.routeBindings);
});

test('request boundary rejects accessors without executing them', () => {
  let getterCalls = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'role', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error('must not execute');
    },
  });

  assert.throws(
    () => deriveSubagentModelRouteScopeV1(hostile),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);
});

test('child authority envelope boundary rejects accessors without executing them', () => {
  let getterCalls = 0;
  const hostileAuthority = { ...childAuthority() };
  Object.defineProperty(hostileAuthority, 'capabilityIds', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error('must not execute child authority getter');
    },
  });

  assert.throws(
    () => deriveSubagentModelRouteScopeV1(request({
      childAuthorityEnvelope: hostileAuthority,
    })),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);
});

test('route and policy boundaries reject accessors without executing them', () => {
  let routeGetterCalls = 0;
  const hostileRoute = route('route.hostile');
  Object.defineProperty(hostileRoute, 'model', {
    enumerable: true,
    configurable: true,
    get() {
      routeGetterCalls += 1;
      throw new Error('must not execute route getter');
    },
  });
  assert.throws(
    () => deriveSubagentModelRouteScopeV1(request({ routes: [hostileRoute] })),
    /enumerable own data property/u,
  );
  assert.equal(routeGetterCalls, 0);

  let policyGetterCalls = 0;
  const hostilePolicy = {};
  Object.defineProperty(hostilePolicy, 'freeOnly', {
    enumerable: true,
    get() {
      policyGetterCalls += 1;
      throw new Error('must not execute policy getter');
    },
  });
  assert.throws(
    () => deriveSubagentModelRouteScopeV1(request({ ownerRoutePolicy: hostilePolicy })),
    /enumerable own data property/u,
  );
  assert.equal(policyGetterCalls, 0);
});

test('sparse, duplicate, symbol and unknown authority representations fail closed', () => {
  assert.throws(
    () => deriveSubagentModelRouteScopeV1(request({
      taskRequestedRouteIds: new Array(1),
    })),
    /enumerable own data property|dense/u,
  );

  assert.throws(
    () => deriveSubagentModelRouteScopeV1(request({
      taskRequestedRouteIds: ['route.local', 'route.local'],
    })),
    /duplicates/u,
  );

  const withSymbol = request();
  withSymbol[Symbol('authority')] = true;
  assert.throws(
    () => deriveSubagentModelRouteScopeV1(withSymbol),
    /unknown field/u,
  );

  assert.throws(
    () => deriveSubagentModelRouteScopeV1({
      ...request(),
      routeStates: { 'route.local': { backoffUntil: 999999 } },
    }),
    /unknown field: routeStates/u,
  );

  assert.throws(
    () => deriveSubagentModelRouteScopeV1({
      ...request(),
      provider: 'openai',
    }),
    /unknown field: provider/u,
  );
});

test('child identity and capability provenance come only from the admitted #469 authority envelope', () => {
  assert.throws(
    () => deriveSubagentModelRouteScopeV1({
      ...request(),
      childAgentId: 'agent.alias',
    }),
    /unknown field: childAgentId/u,
  );

  assert.throws(
    () => deriveSubagentModelRouteScopeV1(request({ requiresVision: 0 })),
    /must be boolean/u,
  );

  const deniedAuthority = childAuthority(['model.code'], {
    childAgentId: 'agent.parent',
  });
  assert.equal(deniedAuthority.decision, 'DENY');
  assert.throws(
    () => deriveSubagentModelRouteScopeV1(request({
      childAuthorityEnvelope: deniedAuthority,
    })),
    /admitted least-authority envelope/u,
  );

  assert.throws(
    () => deriveSubagentModelRouteScopeV1(request({
      childAuthorityEnvelope: {
        ...childAuthority(),
        executionAuthority: true,
      },
    })),
    /executionAuthority must remain false/u,
  );
});

test('route binding carries model identity and policy-relevant metadata but no prompts or authority', () => {
  const value = deriveSubagentModelRouteScopeV1(request({
    taskRequestedRouteIds: ['route.remote.cheap'],
  }));
  const binding = value.routeBindings[0];

  assert.deepEqual(binding, {
    routeId: 'route.remote.cheap',
    provider: 'openai',
    model: 'model-route.remote.cheap',
    endpointId: 'openai',
    roles: [AiRouteRole.CODER, AiRouteRole.FAST_WORKER],
    capabilityIds: ['model.code'],
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 0.2,
    outputPricePerMillionUsd: 0.4,
    inputPriceKnown: true,
    outputPriceKnown: true,
    supportsVision: false,
  });
  assert.equal('systemPrompt' in binding, false);
  assert.equal('workerPrompt' in binding, false);
  assert.equal('executionAuthority' in binding, false);
});
