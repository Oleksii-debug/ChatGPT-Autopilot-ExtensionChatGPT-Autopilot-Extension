import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAiRouteError,
  normalizeAiRoutePolicy,
  normalizeAiRoutePool,
  recordAiRouteOutcome,
  selectAiRouteCandidates,
} from '../src/core/ai-route-pool.js';

const routes = () => normalizeAiRoutePool([
  { routeId:'paid-remote', provider:'openai', model:'strong', roles:['planner'], priority:30, locality:'remote', costClass:'paid', inputPricePerMillionUsd:10, outputPricePerMillionUsd:30 },
  { routeId:'free-local', provider:'ollama', model:'local', roles:['planner'], priority:20, locality:'local', costClass:'free' },
  { routeId:'compatible', provider:'openai-compatible', endpointId:'team-a', model:'worker', roles:['planner','coder'], capabilityIds:['code'], priority:10, locality:'remote', costClass:'paid' },
]);

test('route pool applies owner allow/deny, cost, locality, capability and deterministic order', () => {
  const policy = normalizeAiRoutePolicy({ freeOnly:true, locality:'local', orderedRouteIds:['free-local','paid-remote'] });
  const selected = selectAiRouteCandidates({ routes:routes(), policy, role:'planner', now:1000 });
  assert.deepEqual(selected.candidates.map(route => route.routeId), ['free-local']);
  const coder = selectAiRouteCandidates({ routes:routes(), policy:{ allowRouteIds:['compatible'] }, role:'coder', capabilityIds:['code'], now:1000 });
  assert.deepEqual(coder.candidates.map(route => route.routeId), ['compatible']);
  const deniedCapability = selectAiRouteCandidates({ routes:routes(), policy:{ allowRouteIds:['compatible'] }, role:'coder', capabilityIds:['filesystem.write'], now:1000 });
  assert.deepEqual(deniedCapability.candidates, []);
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
