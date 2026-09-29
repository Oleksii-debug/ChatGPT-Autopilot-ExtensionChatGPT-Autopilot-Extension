import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildAgentDefinitionFromFormV1,
  buildAgentDefinitionModelRoutePolicyFromFormV1,
} from '../src/ui/agent-definition-form.js';

function baseForm(overrides = {}) {
  return {
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: '',
    instructions: 'Research with explicit evidence.',
    capabilityIdsText: '',
    toolIdsText: '',
    tagsText: 'research',
    acceptanceCriteriaText: '',
    enabled: true,
    ...overrides,
  };
}

function configuredPolicy(overrides = {}) {
  return {
    modelRoutePolicyConfigured: true,
    modelRouteAutoSwitch: false,
    modelRoutePinnedRouteId: 'route.fast',
    modelRouteOrderedRouteIdsText: 'route.fast\nroute.strong',
    modelRouteAllowRouteIdsText: 'route.fast\nroute.strong',
    modelRouteDenyRouteIdsText: '',
    modelRouteFreeOnly: true,
    modelRouteLocality: 'local',
    modelRouteMaxInputPriceText: '0',
    modelRouteMaxOutputPriceText: '0',
    modelRouteRetryBackoffSeconds: '120',
    modelRouteCircuitBreakerFailures: '1',
    modelRouteCircuitBreakerSeconds: '600',
    ...overrides,
  };
}

test('per-Agent model policy round-trips canonical route order and resilience controls', () => {
  const policy = buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicy());
  assert.equal(policy.autoSwitch, false);
  assert.equal(policy.pinnedRouteId, 'route.fast');
  assert.deepEqual(policy.orderedRouteIds, ['route.fast','route.strong']);
  assert.deepEqual(policy.allowRouteIds, ['route.fast','route.strong']);
  assert.equal(policy.freeOnly, true);
  assert.equal(policy.locality, 'local');
  assert.equal(policy.retryBackoffSeconds, 120);
  assert.equal(policy.circuitBreakerFailures, 1);
  assert.equal(policy.circuitBreakerSeconds, 600);
});

test('ordered model routes preserve owner priority instead of sorting identities', () => {
  const policy = buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicy({
    modelRoutePinnedRouteId: '',
    modelRouteOrderedRouteIdsText: 'route.z\nroute.a',
    modelRouteAllowRouteIdsText: 'route.a\nroute.z',
  }));
  assert.deepEqual(policy.orderedRouteIds, ['route.z','route.a']);
  assert.deepEqual(policy.allowRouteIds, ['route.a','route.z']);
});

test('inherit clears policy while omitted form controls preserve persisted policy', () => {
  const persisted = buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicy());
  assert.equal(buildAgentDefinitionModelRoutePolicyFromFormV1(
    { modelRoutePolicyConfigured:false },
    { persistedPolicy:persisted },
  ), null);
  const preserved = buildAgentDefinitionModelRoutePolicyFromFormV1({}, { persistedPolicy:persisted });
  assert.deepEqual(preserved, persisted);
  assert.notEqual(preserved, persisted);
});

test('model policy rejects duplicate, coercive and contradictory form aliases', () => {
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicy({
      modelRouteOrderedRouteIdsText:'route.fast\nroute.fast',
    })),
    /дублікат/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicy({
      modelRouteRetryBackoffSeconds:120,
    })),
    /канонічному форматі/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicy({
      modelRouteAllowRouteIdsText:'route.fast',
      modelRouteOrderedRouteIdsText:'route.strong',
      modelRoutePinnedRouteId:'',
    })),
    /поза allow scope/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicy({
      modelRoutePinnedRouteId:'route.fast',
      modelRouteDenyRouteIdsText:'route.fast',
    })),
    /заборонений/u,
  );
});

test('model policy form rejects accessors without executing them', () => {
  let reads = 0;
  const hostile = configuredPolicy();
  Object.defineProperty(hostile, 'modelRoutePinnedRouteId', {
    enumerable:true,
    configurable:true,
    get() {
      reads += 1;
      return 'route.fast';
    },
  });
  assert.throws(() => buildAgentDefinitionModelRoutePolicyFromFormV1(hostile), /enumerable data property/u);
  assert.equal(reads, 0);
});

test('definition save rejects legacy route pin conflicts with explicit durable policy', () => {
  assert.throws(() => buildAgentDefinitionFromFormV1({
    ...baseForm(),
    ...configuredPolicy({ modelRoutePinnedRouteId:'route.strong' }),
  }, {
    configDefaults:{ aiPinnedRouteId:'route.fast' },
  }), /Legacy pinned route конфліктує/u);

  assert.throws(() => buildAgentDefinitionFromFormV1({
    ...baseForm(),
    ...configuredPolicy({
      modelRoutePinnedRouteId:'',
      modelRouteAllowRouteIdsText:'route.strong',
      modelRouteOrderedRouteIdsText:'route.strong',
    }),
  }, {
    configDefaults:{ aiPinnedRouteId:'route.fast' },
  }), /поза Model Router policy allow scope/u);
});

test('Agent model-policy UI is native, labeled and removes inactive controls from tab flow', async () => {
  const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  const ids = [
    'agent-definition-model-route-policy-configured',
    'agent-definition-model-route-auto-switch',
    'agent-definition-model-route-pinned-id',
    'agent-definition-model-route-ordered-ids',
    'agent-definition-model-route-allow-ids',
    'agent-definition-model-route-deny-ids',
    'agent-definition-model-route-free-only',
    'agent-definition-model-route-locality',
    'agent-definition-model-route-max-input-price',
    'agent-definition-model-route-max-output-price',
    'agent-definition-model-route-backoff-seconds',
    'agent-definition-model-route-circuit-failures',
    'agent-definition-model-route-circuit-seconds',
  ];
  for (const id of ids) assert.match(html, new RegExp('id=["\\']' + id + '["\\']', 'u'));
  assert.match(html, /Збереження policy не вибирає модель, не запускає provider і не запускає Agent/u);
  assert.match(source, /function syncAgentDefinitionModelRoutePolicyControls\(\)[\s\S]*?\$\(id\)\.disabled = !configured/u);
  assert.match(source, /agent-definition-model-route-policy-configured'\)\.addEventListener\('change', syncAgentDefinitionModelRoutePolicyControls\)/u);

  const start = source.indexOf('async function saveAgentDefinition()');
  const end = source.indexOf('\nasync function toggleAgentDefinitionEnabled', start);
  const save = source.slice(start, end);
  assert.match(save, /MUTATE_BROWSER_AGENT_DEFINITION_REGISTRY/u);
  assert.doesNotMatch(save, /RUN_AI_ROUTED_PROMPT|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT_BURST|fetch\(/u);
});
