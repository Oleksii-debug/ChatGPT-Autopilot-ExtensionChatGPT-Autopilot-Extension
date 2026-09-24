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
  { routeId:'mistral-code', provider:'openai-compatible', endpointId:'mistral', model:'codestral-latest', roles:['fast-worker','coder'], priority:100, maxWorkers:3 },
  { routeId:'local-fast', provider:'ollama', model:'qwen3:8b', roles:['fast-worker'], priority:80, maxWorkers:2 },
  { routeId:'review', provider:'openai', model:'gpt-5.6-sol', roles:['verifier'], priority:120, maxWorkers:1 },
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
