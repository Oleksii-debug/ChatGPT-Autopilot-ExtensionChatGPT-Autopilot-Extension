import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiRouteRole,
  AiWorkerAllocationMode,
  allocateAiRouteWorkers,
  normalizeAiRoutePool,
  normalizeAiWorkerPolicy,
} from '../src/core/ai-route-pool.js';

const routes = [
  { routeId:'mistral-code', provider:'openai-compatible', endpointId:'mistral', model:'codestral-latest', roles:['fast-worker','coder'], priority:100, maxWorkers:3, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
  { routeId:'local-fast', provider:'ollama', model:'qwen3:8b', roles:['fast-worker'], priority:80, maxWorkers:2 },
  { routeId:'review', provider:'openai', model:'gpt-5.6-sol', roles:['verifier'], priority:120, maxWorkers:1, costClass:'paid', inputPricePerMillionUsd:2, outputPricePerMillionUsd:8 },
];

test('route pool persists a bounded per-model worker cap', () => {
  const pool = normalizeAiRoutePool(routes);
  assert.equal(pool[0].maxWorkers, 3);
  assert.throws(() => normalizeAiRoutePool([{ ...routes[0], maxWorkers:201 }]), /maxWorkers/);
});

test('automatic allocation spreads workers deterministically across eligible models and respects caps', () => {
  const result = allocateAiRouteWorkers({
    routes,
    routePolicy:{ orderedRouteIds:['mistral-code','local-fast','review'] },
    workerPolicy:{ allocationMode:AiWorkerAllocationMode.AUTO, maxParallelWorkers:10, manualRouteWorkers:{} },
    role:AiRouteRole.FAST_WORKER,
    desiredWorkers:7,
    now:1000,
  });
  assert.deepEqual(result.allocations, { 'mistral-code':3, 'local-fast':2, review:0 });
  assert.equal(result.assignedWorkers, 5);
  assert.equal(result.unassignedWorkers, 2);
});

test('manual allocation gives the owner exact per-model worker counts within the global ceiling', () => {
  const policy = normalizeAiWorkerPolicy({
    allocationMode:'manual',
    maxParallelWorkers:6,
    manualRouteWorkers:{ 'mistral-code':3, 'local-fast':2, review:1 },
  }, routes);
  assert.deepEqual(policy.manualRouteWorkers, { 'mistral-code':3, 'local-fast':2, review:1 });
  const result = allocateAiRouteWorkers({
    routes,
    workerPolicy:policy,
    role:AiRouteRole.FAST_WORKER,
    desiredWorkers:6,
  });
  assert.deepEqual(result.allocations, { 'mistral-code':3, 'local-fast':2, review:0 });
  assert.equal(result.assignedWorkers, 5);
  assert.equal(result.unassignedWorkers, 1);
});

test('manual allocation fails closed for unknown routes, over-cap routes and global over-allocation', () => {
  assert.throws(() => normalizeAiWorkerPolicy({ allocationMode:'manual', maxParallelWorkers:4, manualRouteWorkers:{ missing:1 } }, routes), /unknown/);
  assert.throws(() => normalizeAiWorkerPolicy({ allocationMode:'manual', maxParallelWorkers:6, manualRouteWorkers:{ 'mistral-code':4 } }, routes), /maxWorkers/);
  assert.throws(() => normalizeAiWorkerPolicy({ allocationMode:'manual', maxParallelWorkers:4, manualRouteWorkers:{ 'mistral-code':3, 'local-fast':2 } }, routes), /maxParallelWorkers/);
});

test('worker-count authority rejects numeric strings, booleans and coercing objects', () => {
  for (const maxWorkers of ['3', true, { valueOf: () => 3 }]) {
    assert.throws(() => normalizeAiRoutePool([{ ...routes[0], maxWorkers }]), /maxWorkers/);
  }
  for (const maxParallelWorkers of ['4', true, { valueOf: () => 4 }]) {
    assert.throws(() => normalizeAiWorkerPolicy({
      allocationMode:'auto',
      maxParallelWorkers,
      manualRouteWorkers:{},
    }, routes), /maxParallelWorkers/);
  }
  for (const count of ['2', true, { valueOf: () => 2 }]) {
    assert.throws(() => normalizeAiWorkerPolicy({
      allocationMode:'manual',
      maxParallelWorkers:4,
      manualRouteWorkers:{ 'mistral-code':count },
    }, routes), /manualRouteWorkers/);
  }
  for (const desiredWorkers of ['2', true, { valueOf: () => 2 }]) {
    assert.throws(() => allocateAiRouteWorkers({
      routes,
      workerPolicy:{ allocationMode:'auto', maxParallelWorkers:4, manualRouteWorkers:{} },
      role:AiRouteRole.FAST_WORKER,
      desiredWorkers,
    }), /desiredWorkers/);
  }
});


test('schema-valid inherited Object.prototype route IDs remain exact worker-policy keys', () => {
  const inheritedRoutes = [
    { routeId:'constructor', provider:'ollama', model:'qwen3:8b', roles:['fast-worker'], priority:20, maxWorkers:2 },
    { routeId:'toString', provider:'ollama', model:'qwen3:8b', roles:['fast-worker'], priority:10, maxWorkers:2 },
  ];

  const emptyManual = normalizeAiWorkerPolicy({
    allocationMode:'manual',
    maxParallelWorkers:2,
    manualRouteWorkers:{},
  }, inheritedRoutes);
  assert.equal(Object.hasOwn(emptyManual.manualRouteWorkers, 'constructor'), false);
  assert.equal(Object.hasOwn(emptyManual.manualRouteWorkers, 'toString'), false);

  const noneAssigned = allocateAiRouteWorkers({
    routes:inheritedRoutes,
    workerPolicy:emptyManual,
    role:AiRouteRole.FAST_WORKER,
    desiredWorkers:2,
  });
  assert.deepEqual(noneAssigned.allocations, { constructor:0, toString:0 });
  assert.equal(noneAssigned.assignedWorkers, 0);
  assert.equal(noneAssigned.unassignedWorkers, 2);

  const explicit = normalizeAiWorkerPolicy({
    allocationMode:'manual',
    maxParallelWorkers:2,
    manualRouteWorkers:{ constructor:1, toString:1 },
  }, inheritedRoutes);
  assert.equal(Object.hasOwn(explicit.manualRouteWorkers, 'constructor'), true);
  assert.equal(Object.hasOwn(explicit.manualRouteWorkers, 'toString'), true);
  assert.equal(explicit.manualRouteWorkers.constructor, 1);
  assert.equal(explicit.manualRouteWorkers.toString, 1);

  const assigned = allocateAiRouteWorkers({
    routes:inheritedRoutes,
    workerPolicy:explicit,
    routeStates:{},
    role:AiRouteRole.FAST_WORKER,
    desiredWorkers:2,
  });
  assert.deepEqual(assigned.allocations, { constructor:1, toString:1 });
  assert.equal(assigned.assignedWorkers, 2);
  assert.equal(assigned.unassignedWorkers, 0);
});

test('backoff and route owner policy are respected before allocating workers', () => {
  const result = allocateAiRouteWorkers({
    routes,
    routePolicy:{ denyRouteIds:['local-fast'] },
    workerPolicy:{ allocationMode:'auto', maxParallelWorkers:4, manualRouteWorkers:{} },
    routeStates:{ 'mistral-code':{ backoffUntil:5000 } },
    role:AiRouteRole.FAST_WORKER,
    desiredWorkers:4,
    now:1000,
  });
  assert.equal(result.assignedWorkers, 0);
  assert.equal(result.unassignedWorkers, 4);
  assert.equal(result.retryAt, 5000);
});
