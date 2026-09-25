import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAiRouteError,
  normalizeAiRoutePolicy,
  normalizeAiRoutePool,
  normalizeAiRouteStates,
  normalizeAiWorkerPolicy,
  recordAiRouteOutcome,
  selectAiRouteCandidates,
} from '../src/core/ai-route-pool.js';

const routes = () => normalizeAiRoutePool([
  { routeId:'paid-remote', provider:'openai', model:'strong', roles:['planner'], priority:30, locality:'remote', costClass:'paid', inputPricePerMillionUsd:10, outputPricePerMillionUsd:30 },
  { routeId:'free-local', provider:'ollama', model:'local', roles:['planner'], priority:20, locality:'local', costClass:'free' },
  { routeId:'compatible', provider:'openai-compatible', endpointId:'team-a', model:'worker', roles:['planner','coder'], capabilityIds:['code'], priority:10, locality:'remote', costClass:'paid', inputPricePerMillionUsd:2, outputPricePerMillionUsd:8 },
]);

test('remote route with unclassified pricing remains unknown and cannot silently execute', () => {
  const [remote, local] = normalizeAiRoutePool([
    { routeId:'new-remote', provider:'openai-compatible', endpointId:'team-a', model:'worker' },
    { routeId:'known-local', provider:'ollama', model:'local' },
  ]);
  assert.equal(remote.costClass, 'unknown');
  assert.equal(local.costClass, 'free');
  assert.deepEqual(selectAiRouteCandidates({ routes:[remote, local], role:'planner', now:1000 }).candidates.map(route => route.routeId), ['known-local']);
  const pricedButUnclassified = normalizeAiRoutePool([{ routeId:'unclassified', provider:'openai-compatible', endpointId:'team-a', model:'worker', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 }]);
  assert.deepEqual(selectAiRouteCandidates({ routes:pricedButUnclassified, role:'planner', now:1000 }).candidates, []);
  assert.equal(normalizeAiRoutePool([{ ...remote, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 }])[0].costClass, 'paid');
});

test('unknown pricing stays fail-closed even with UI-shaped numeric prices and route pinning', () => {
  const unknown = normalizeAiRoutePool([{
    routeId:'ui-unknown',
    provider:'openai',
    model:'unclassified',
    roles:['planner'],
    priority:50,
    locality:'remote',
    costClass:'unknown',
    inputPricePerMillionUsd:0,
    outputPricePerMillionUsd:0,
  }]);
  assert.equal(unknown[0].inputPriceKnown, true);
  assert.equal(unknown[0].outputPriceKnown, true);
  const selected = selectAiRouteCandidates({
    routes:unknown,
    policy:{ pinnedRouteId:'ui-unknown', allowRouteIds:['ui-unknown'] },
    role:'planner',
    now:1000,
  });
  assert.deepEqual(selected.candidates, []);
  assert.deepEqual(selected.eligibleRouteIds, []);
});

test('route pool applies owner allow/deny, cost, locality, capability and deterministic order', () => {
  const policy = normalizeAiRoutePolicy({ freeOnly:true, locality:'local', orderedRouteIds:['free-local','paid-remote'] });
  const selected = selectAiRouteCandidates({ routes:routes(), policy, role:'planner', now:1000 });
  assert.deepEqual(selected.candidates.map(route => route.routeId), ['free-local']);
  const coder = selectAiRouteCandidates({ routes:routes(), policy:{ allowRouteIds:['compatible'] }, role:'coder', capabilityIds:['code'], now:1000 });
  assert.deepEqual(coder.candidates.map(route => route.routeId), ['compatible']);
  const deniedCapability = selectAiRouteCandidates({ routes:routes(), policy:{ allowRouteIds:['compatible'] }, role:'coder', capabilityIds:['filesystem.write'], now:1000 });
  assert.deepEqual(deniedCapability.candidates, []);
});

test('paid routes with any unknown price dimension are rejected before automatic dispatch', () => {
  const missingOutput = normalizeAiRoutePool([{
    routeId:'missing-output', provider:'openai', model:'paid', roles:['planner'],
    priority:50, locality:'remote', costClass:'paid', inputPricePerMillionUsd:3,
  }]);
  assert.equal(missingOutput[0].inputPriceKnown, true);
  assert.equal(missingOutput[0].outputPriceKnown, false);
  const outputSelection = selectAiRouteCandidates({
    routes:missingOutput,
    policy:{ maxInputPricePerMillionUsd:10, maxOutputPricePerMillionUsd:10, pinnedRouteId:'missing-output' },
    role:'planner',
    now:1000,
  });
  assert.deepEqual(outputSelection.candidates, []);
  assert.deepEqual(outputSelection.eligibleRouteIds, []);

  const missingInput = normalizeAiRoutePool([{
    routeId:'missing-input', provider:'openai', model:'paid', roles:['planner'],
    priority:50, locality:'remote', costClass:'paid', outputPricePerMillionUsd:7,
  }]);
  assert.equal(missingInput[0].inputPriceKnown, false);
  assert.equal(missingInput[0].outputPriceKnown, true);
  const inputSelection = selectAiRouteCandidates({
    routes:missingInput,
    policy:{ maxInputPricePerMillionUsd:10, maxOutputPricePerMillionUsd:10 },
    role:'planner',
    now:1000,
  });
  assert.deepEqual(inputSelection.candidates, []);

  const explicitZero = normalizeAiRoutePool([{
    routeId:'zero-known', provider:'openai', model:'paid-zero', roles:['planner'],
    locality:'remote', costClass:'paid', inputPricePerMillionUsd:0, outputPricePerMillionUsd:0,
  }]);
  assert.deepEqual(
    selectAiRouteCandidates({ routes:explicitZero, policy:{}, role:'planner', now:1000 }).candidates.map(route => route.routeId),
    ['zero-known'],
  );
});

test('explicit zero owner price caps reject positive paid dimensions while absent caps remain unbounded', () => {
  const priceVariants = normalizeAiRoutePool([
    {
      routeId:'positive-input', provider:'openai', model:'input-paid', roles:['planner'],
      locality:'remote', costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:0,
    },
    {
      routeId:'positive-output', provider:'openai', model:'output-paid', roles:['planner'],
      locality:'remote', costClass:'paid', inputPricePerMillionUsd:0, outputPricePerMillionUsd:1,
    },
    {
      routeId:'zero-both', provider:'openai', model:'zero-paid', roles:['planner'],
      locality:'remote', costClass:'paid', inputPricePerMillionUsd:0, outputPricePerMillionUsd:0,
    },
  ]);

  assert.deepEqual(
    selectAiRouteCandidates({
      routes:priceVariants,
      policy:{},
      role:'planner',
      now:1000,
    }).candidates.map(route => route.routeId),
    ['positive-input', 'positive-output', 'zero-both'],
    'absent caps must remain unbounded',
  );

  assert.deepEqual(
    selectAiRouteCandidates({
      routes:priceVariants,
      policy:{ maxInputPricePerMillionUsd:0 },
      role:'planner',
      now:1000,
    }).candidates.map(route => route.routeId),
    ['positive-output', 'zero-both'],
    'explicit zero input cap must reject positive input price before dispatch',
  );

  assert.deepEqual(
    selectAiRouteCandidates({
      routes:priceVariants,
      policy:{ maxOutputPricePerMillionUsd:0 },
      role:'planner',
      now:1000,
    }).candidates.map(route => route.routeId),
    ['positive-input', 'zero-both'],
    'explicit zero output cap must reject positive output price before dispatch',
  );

  assert.deepEqual(
    selectAiRouteCandidates({
      routes:priceVariants,
      policy:{ maxInputPricePerMillionUsd:0, maxOutputPricePerMillionUsd:0 },
      role:'planner',
      now:1000,
    }).candidates.map(route => route.routeId),
    ['zero-both'],
  );
});

test('economic route and policy authority is descriptor-safe before dispatch', () => {
  let reads = 0;
  const accessorPolicy = {};
  Object.defineProperty(accessorPolicy, 'maxInputPricePerMillionUsd', {
    enumerable:true,
    get() { reads += 1; return 0; },
  });
  assert.throws(() => normalizeAiRoutePolicy(accessorPolicy), /data property/u);
  assert.equal(reads, 0, 'owner price-cap getter must never execute');

  const hiddenPolicy = {};
  Object.defineProperty(hiddenPolicy, 'maxOutputPricePerMillionUsd', {
    value:0,
    enumerable:false,
  });
  assert.throws(() => normalizeAiRoutePolicy(hiddenPolicy), /enumerable own data property/u);

  const symbolPolicy = { freeOnly:true };
  symbolPolicy[Symbol('hidden')] = true;
  assert.throws(() => normalizeAiRoutePolicy(symbolPolicy), /symbol field/u);

  const inheritedPolicy = Object.create({ maxInputPricePerMillionUsd:0 });
  inheritedPolicy.freeOnly = true;
  assert.throws(() => normalizeAiRoutePolicy(inheritedPolicy), /plain data object/u);

  const nullPolicy = Object.create(null);
  nullPolicy.maxInputPricePerMillionUsd = 0;
  assert.equal(normalizeAiRoutePolicy(nullPolicy).maxInputPricePerMillionUsd, 0);

  let descriptorReads = 0;
  const swappingTarget = { maxInputPricePerMillionUsd:0 };
  const swappingPolicy = new Proxy(swappingTarget, {
    getOwnPropertyDescriptor(target, key) {
      descriptorReads += 1;
      if (key === 'maxInputPricePerMillionUsd') {
        return {
          value: descriptorReads === 1 ? 0 : 999,
          enumerable:true,
          configurable:true,
          writable:true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.equal(normalizeAiRoutePolicy(swappingPolicy).maxInputPricePerMillionUsd, 0);
  assert.equal(descriptorReads, 1, 'economic descriptor must be snapshotted exactly once');

  reads = 0;
  const accessorRoute = {
    routeId:'accessor-route',
    provider:'openai',
    model:'paid',
    locality:'remote',
    costClass:'paid',
    outputPricePerMillionUsd:1,
  };
  Object.defineProperty(accessorRoute, 'inputPricePerMillionUsd', {
    enumerable:true,
    get() { reads += 1; return 1; },
  });
  assert.throws(() => normalizeAiRoutePool([accessorRoute]), /data property/u);
  assert.equal(reads, 0, 'route price getter must never execute');

  const hiddenKnown = {
    routeId:'hidden-known',
    provider:'openai',
    model:'paid',
    locality:'remote',
    costClass:'paid',
    inputPricePerMillionUsd:1,
    outputPricePerMillionUsd:1,
  };
  Object.defineProperty(hiddenKnown, 'outputPriceKnown', { value:false, enumerable:false });
  assert.throws(() => normalizeAiRoutePool([hiddenKnown]), /enumerable own data property/u);

  const symbolRoute = {
    routeId:'symbol-route',
    provider:'openai',
    model:'paid',
    locality:'remote',
    costClass:'paid',
    inputPricePerMillionUsd:0,
    outputPricePerMillionUsd:0,
  };
  symbolRoute[Symbol('hidden')] = true;
  assert.throws(() => normalizeAiRoutePool([symbolRoute]), /symbol field/u);

  const inheritedRoute = Object.create({ inputPricePerMillionUsd:0 });
  Object.assign(inheritedRoute, {
    routeId:'inherited-route',
    provider:'openai',
    model:'paid',
    locality:'remote',
    costClass:'paid',
    outputPricePerMillionUsd:0,
  });
  assert.throws(() => normalizeAiRoutePool([inheritedRoute]), /plain data object/u);
});

test('economic numeric fields reject object coercion before caller code can execute', () => {
  let coercions = 0;
  const hostileNumber = {
    valueOf() {
      coercions += 1;
      return 0;
    },
    toString() {
      coercions += 1;
      return '0';
    },
  };

  assert.throws(
    () => normalizeAiRoutePool([{
      routeId:'hostile-price',
      provider:'openai',
      model:'paid',
      costClass:'paid',
      inputPriceKnown:true,
      outputPriceKnown:true,
      inputPricePerMillionUsd:hostileNumber,
      outputPricePerMillionUsd:1,
    }]),
    /input price is invalid/u,
  );
  assert.equal(coercions, 0, 'price normalization must reject objects before numeric coercion');

  assert.throws(
    () => normalizeAiRoutePool([{
      routeId:'hostile-priority',
      provider:'ollama',
      model:'local',
      priority:hostileNumber,
    }]),
    /priority is invalid/u,
  );
  assert.equal(coercions, 0, 'integer normalization must reject objects before numeric coercion');

  assert.throws(
    () => normalizeAiRoutePool([{
      schemaVersion:hostileNumber,
      routeId:'hostile-version',
      provider:'ollama',
      model:'local',
    }]),
    /schemaVersion is invalid/u,
  );
  assert.equal(coercions, 0, 'schemaVersion normalization must reject objects before numeric coercion');

  assert.throws(
    () => normalizeAiRoutePolicy({ maxInputPricePerMillionUsd:hostileNumber }),
    /maximum input price is invalid/u,
  );
  assert.equal(coercions, 0, 'owner price-cap normalization must reject objects before numeric coercion');
});

test('economic route and policy arrays must be dense own data arrays', () => {
  let reads = 0;
  const accessorPool = [];
  accessorPool.length = 1;
  Object.defineProperty(accessorPool, '0', {
    enumerable:true,
    configurable:true,
    get() {
      reads += 1;
      return { routeId:'a', provider:'ollama', model:'a' };
    },
  });
  assert.throws(() => normalizeAiRoutePool(accessorPool), /dense data-only array/u);
  assert.equal(reads, 0, 'route-array getter must never execute');

  const sparsePool = new Array(1);
  assert.throws(() => normalizeAiRoutePool(sparsePool), /dense data-only array/u);

  const ordered = ['free-local'];
  Object.defineProperty(ordered, '0', {
    enumerable:true,
    configurable:true,
    get() {
      reads += 1;
      return 'free-local';
    },
  });
  assert.throws(() => normalizeAiRoutePolicy({ orderedRouteIds:ordered }), /dense data-only array/u);
  assert.equal(reads, 0, 'policy route-id getter must never execute');

  const symbolIds = ['free-local'];
  symbolIds[Symbol('hidden')] = 'paid-remote';
  assert.throws(() => normalizeAiRoutePolicy({ allowRouteIds:symbolIds }), /dense data-only array/u);
});

test('economic route and policy arrays snapshot length without ordinary Proxy reads', () => {
  let reads = 0;
  const roles = new Proxy(['planner'], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const pool = new Proxy([
    {
      routeId:'proxy-safe',
      provider:'ollama',
      model:'qwen3:8b',
      roles,
      priority:1,
    },
  ], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const normalized = normalizeAiRoutePool(pool);
  assert.equal(normalized[0].routeId, 'proxy-safe');
  assert.deepEqual(normalized[0].roles, ['planner']);
  assert.equal(reads, 0, 'route pool and nested authority arrays must not perform ordinary caller reads');

  const ordered = new Proxy(['proxy-safe'], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const policy = normalizeAiRoutePolicy({ orderedRouteIds:ordered });
  assert.deepEqual(policy.orderedRouteIds, ['proxy-safe']);
  assert.equal(reads, 0, 'policy authority arrays must not perform ordinary caller reads');
});

test('worker allocation policy snapshots outer and per-route authority without getters', () => {
  let reads = 0;
  const manualTarget = { 'free-local': 1 };
  const manual = new Proxy(manualTarget, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const policyTarget = {
    allocationMode:'manual',
    maxParallelWorkers:2,
    manualRouteWorkers:manual,
  };
  const policy = new Proxy(policyTarget, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const normalized = normalizeAiWorkerPolicy(policy, routes());
  assert.equal(normalized.allocationMode, 'manual');
  assert.equal(normalized.manualRouteWorkers['free-local'], 1);
  assert.equal(reads, 0, 'worker allocation authority must use descriptor snapshots only');

  const hidden = { 'free-local': 1 };
  Object.defineProperty(hidden, 'paid-remote', { value:1, enumerable:false });
  assert.throws(
    () => normalizeAiWorkerPolicy({ allocationMode:'manual', manualRouteWorkers:hidden }, routes()),
    /enumerable own data property/u,
  );

  const accessor = {};
  Object.defineProperty(accessor, 'free-local', {
    enumerable:true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.throws(
    () => normalizeAiWorkerPolicy({ allocationMode:'manual', manualRouteWorkers:accessor }, routes()),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0, 'manual allocation getters must never execute');
});

test('route final tie-break uses locale-independent code-unit order', () => {
  const sameRank = normalizeAiRoutePool([
    { routeId:'alpha', provider:'ollama', model:'a', roles:['planner'], priority:1 },
    { routeId:'Zulu', provider:'ollama', model:'z', roles:['planner'], priority:1 },
  ]);
  assert.deepEqual(
    selectAiRouteCandidates({ routes:sameRank, policy:{}, role:'planner', now:1000 })
      .candidates.map(route => route.routeId),
    ['Zulu', 'alpha'],
  );
});

test('durable route state is descriptor-snapshotted and malformed authority fails closed', () => {
  const route = normalizeAiRoutePool([{ routeId:'a', provider:'ollama', model:'a', roles:[], priority:1 }]);
  let reads = 0;
  let coercions = 0;
  const nested = new Proxy({
    consecutiveFailures:1,
    failures:1,
    successes:0,
    backoffUntil:160_000,
    circuitOpenUntil:0,
    lastErrorCode:'HTTP_429',
    lastErrorCategory:'quota-or-rate',
    lastErrorAt:100_000,
    lastSuccessAt:0,
    lastLatencyMs:10,
  }, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const outer = new Proxy({ a:nested }, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const normalized = normalizeAiRouteStates(outer, route);
  assert.equal(normalized.a.backoffUntil, 160_000);
  assert.equal(reads, 0, 'durable route state must not perform ordinary caller property reads');

  const hostileNumber = {
    valueOf() {
      coercions += 1;
      return 0;
    },
    toString() {
      coercions += 1;
      return '0';
    },
  };
  assert.throws(
    () => normalizeAiRouteStates({ a:{ backoffUntil:hostileNumber } }, route),
    /backoffUntil is invalid/u,
  );
  assert.equal(coercions, 0, 'durable route state must reject objects before numeric coercion');

  const accessor = {};
  Object.defineProperty(accessor, 'backoffUntil', {
    enumerable:true,
    get() {
      reads += 1;
      return 0;
    },
  });
  assert.throws(
    () => normalizeAiRouteStates({ a:accessor }, route),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0, 'durable route state getters must never execute');

  const hiddenOuter = {};
  Object.defineProperty(hiddenOuter, 'a', {
    value:{ backoffUntil:160_000 },
    enumerable:false,
  });
  assert.throws(
    () => normalizeAiRouteStates(hiddenOuter, route),
    /enumerable own data property/u,
  );

  assert.throws(
    () => normalizeAiRouteStates({ a:{ backoffUntil:'not-a-number' } }, route),
    /backoffUntil is invalid/u,
  );
});

test('route failures create bounded backoff and open a circuit at the configured threshold', () => {
  const [route] = normalizeAiRoutePool([{ routeId:'a', provider:'ollama', model:'a', roles:[], priority:1 }]);
  const policy = normalizeAiRoutePolicy({ retryBackoffSeconds:30, circuitBreakerFailures:2, circuitBreakerSeconds:300 });
  const classified = classifyAiRouteError(Object.assign(new Error('secondary throttling'), { status:429 }));
  const first = recordAiRouteOutcome({}, route, policy, { ok:false, classification:classified, at:1000 });
  assert.equal(first.backoffUntil, 31_000);
  assert.equal(first.circuitOpenUntil, 0);
  const second = recordAiRouteOutcome({ a:first }, route, policy, { ok:false, classification:classified, at:32_000 });
  assert.equal(second.circuitOpenUntil, 332_000);
  const blocked = selectAiRouteCandidates({ routes:[route], policy, routeStates:{ a:second }, role:'planner', now:40_000 });
  assert.deepEqual(blocked.candidates, []);
  assert.equal(blocked.retryAt, 332_000);
});

test('policy and safety failures are never classified as blind-failover candidates', () => {
  assert.equal(classifyAiRouteError(Object.assign(new Error('policy denied'), { code:'AI_POLICY_DENIED' })).retryable, false);
  assert.equal(classifyAiRouteError(Object.assign(new Error('quota exhausted'), { code:'AI_PROVIDER_QUOTA_EXHAUSTED' })).retryable, true);
  assert.equal(classifyAiRouteError(Object.assign(new Error('upstream unavailable'), { status:503 })).retryable, true);
});
