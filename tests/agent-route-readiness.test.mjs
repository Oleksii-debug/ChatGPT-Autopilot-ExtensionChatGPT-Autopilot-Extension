import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRouteReadinessState,
  inspectAgentRouteReadinessV1,
} from '../src/core/agent-route-readiness.js';

function routes() {
  return [
    {
      routeId:'planner-local',
      provider:'ollama',
      model:'qwen3:8b',
      roles:['planner'],
      capabilityIds:['browser'],
      locality:'local',
      costClass:'free',
      priority:10,
    },
    {
      routeId:'verifier-remote',
      provider:'openai',
      model:'gpt-verifier',
      roles:['verifier'],
      capabilityIds:['verify'],
      locality:'remote',
      costClass:'paid',
      inputPriceKnown:true,
      outputPriceKnown:true,
      inputPricePerMillionUsd:1,
      outputPricePerMillionUsd:1,
      priority:8,
    },
    {
      routeId:'vision-planner',
      provider:'openai-compatible',
      model:'vision',
      roles:['planner'],
      capabilityIds:['browser','vision'],
      supportsVision:true,
      locality:'remote',
      costClass:'paid',
      inputPriceKnown:true,
      outputPriceKnown:true,
      inputPricePerMillionUsd:1,
      outputPricePerMillionUsd:1,
      priority:7,
    },
  ];
}

test('planner and verifier readiness is READY when both canonical role paths are executable', () => {
  const result = inspectAgentRouteReadinessV1({
    routes:routes(),
    policy:{},
    plannerCapabilityIds:['browser'],
    verifierCapabilityIds:['verify'],
    now:1000,
  });
  assert.equal(result.state, AgentRouteReadinessState.READY);
  assert.equal(result.ready, true);
  assert.deepEqual(result.planner.availableRouteIds, ['planner-local','vision-planner']);
  assert.deepEqual(result.verifier.availableRouteIds, ['verifier-remote']);
  assert.equal(result.retryAt, 0);
  assert.deepEqual(result.authority, {
    executionAuthorized:false,
    providerCallAuthorized:false,
    policyAuthorized:false,
    schedulingAuthorized:false,
    recoveryAuthorized:false,
    completionAuthorized:false,
    verificationAuthorized:false,
  });
});

test('planner-only admission does not invent a verifier requirement', () => {
  const result = inspectAgentRouteReadinessV1({
    routes:[routes()[0]],
    policy:{ pinnedRouteId:'planner-local', autoSwitch:false },
    plannerCapabilityIds:['browser'],
    requiresVerifier:false,
    now:1000,
  });
  assert.equal(result.state, AgentRouteReadinessState.READY);
  assert.equal(result.requiresVerifier, false);
  assert.deepEqual(result.verifier.availableRouteIds, []);
});

test('pinned route that cannot perform the required verifier role fails as configuration-unavailable', () => {
  const result = inspectAgentRouteReadinessV1({
    routes:routes(),
    policy:{ pinnedRouteId:'planner-local', autoSwitch:false },
    plannerCapabilityIds:['browser'],
    verifierCapabilityIds:['verify'],
    now:1000,
  });
  assert.equal(result.state, AgentRouteReadinessState.UNAVAILABLE_CONFIG);
  assert.equal(result.ready, false);
  assert.deepEqual(result.planner.eligibleRouteIds, ['planner-local']);
  assert.deepEqual(result.verifier.eligibleRouteIds, []);
  assert.equal(result.retryAt, 0);
});

test('temporary backoff is WAITING_RETRY and reports earliest required-role recovery time', () => {
  const result = inspectAgentRouteReadinessV1({
    routes:routes(),
    policy:{},
    routeStates:{
      'planner-local':{ backoffUntil:5000 },
      'vision-planner':{ circuitOpenUntil:7000 },
      'verifier-remote':{ backoffUntil:9000 },
    },
    plannerCapabilityIds:['browser'],
    verifierCapabilityIds:['verify'],
    now:1000,
  });
  assert.equal(result.state, AgentRouteReadinessState.WAITING_RETRY);
  assert.equal(result.ready, false);
  assert.deepEqual(result.planner.availableRouteIds, []);
  assert.deepEqual(result.verifier.availableRouteIds, []);
  assert.equal(result.retryAt, 5000);
});

test('vision and capability constraints are delegated to the canonical route selector', () => {
  const result = inspectAgentRouteReadinessV1({
    routes:routes(),
    policy:{},
    plannerCapabilityIds:['browser','vision'],
    verifierCapabilityIds:['verify'],
    requiresVision:true,
    now:1000,
  });
  assert.equal(result.state, AgentRouteReadinessState.READY);
  assert.deepEqual(result.planner.availableRouteIds, ['vision-planner']);

  const blocked = inspectAgentRouteReadinessV1({
    routes:routes(),
    policy:{ locality:'local' },
    plannerCapabilityIds:['browser','vision'],
    verifierCapabilityIds:['verify'],
    requiresVision:true,
    now:1000,
  });
  assert.equal(blocked.state, AgentRouteReadinessState.UNAVAILABLE_CONFIG);
});

test('readiness request boundary rejects getters, hidden fields, symbols and coercive time aliases without caller execution', () => {
  let reads = 0;
  const getter = {};
  Object.defineProperty(getter, 'routes', {
    enumerable:true,
    get() {
      reads += 1;
      return routes();
    },
  });
  assert.throws(() => inspectAgentRouteReadinessV1(getter), /enumerable own data property/u);
  assert.equal(reads, 0);

  const hidden = { routes:routes() };
  Object.defineProperty(hidden, 'policy', { value:{}, enumerable:false });
  assert.throws(() => inspectAgentRouteReadinessV1(hidden), /enumerable own data property/u);

  const symbol = { routes:routes() };
  symbol[Symbol('hidden')] = true;
  assert.throws(() => inspectAgentRouteReadinessV1(symbol), /unknown field/u);

  for (const invalidNow of ['1000', 1000.5, -0, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => inspectAgentRouteReadinessV1({ routes:routes(), policy:{}, now:invalidNow }),
      /readiness now is invalid/u,
    );
  }
});

test('nested route, policy, state and capability arrays preserve canonical fail-closed boundaries', () => {
  let reads = 0;
  const capabilities = ['browser'];
  Object.defineProperty(capabilities, '0', {
    enumerable:true,
    configurable:true,
    get() {
      reads += 1;
      return 'browser';
    },
  });
  assert.throws(
    () => inspectAgentRouteReadinessV1({
      routes:routes(),
      policy:{},
      plannerCapabilityIds:capabilities,
      requiresVerifier:false,
      now:1000,
    }),
    /dense data-only array/u,
  );
  assert.equal(reads, 0);

  const policy = {};
  Object.defineProperty(policy, 'pinnedRouteId', {
    enumerable:true,
    get() {
      reads += 1;
      return 'planner-local';
    },
  });
  assert.throws(
    () => inspectAgentRouteReadinessV1({
      routes:routes(),
      policy,
      requiresVerifier:false,
      now:1000,
    }),
    /data property/u,
  );
  assert.equal(reads, 0);
});
