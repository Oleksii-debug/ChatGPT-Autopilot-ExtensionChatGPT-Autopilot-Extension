import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeAgentDefinitionV1 } from '../src/core/agent-definition-registry.js';
import {
  buildAgentDefinitionFromFormV1,
  buildAgentDefinitionModelRoutePolicyFromFormV1,
} from '../src/ui/agent-definition-form.js';

function baseForm(overrides = {}) {
  return {
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: 'Evidence-bound research worker',
    instructions: 'Research the owner task and preserve source evidence.',
    capabilityIdsText: 'project.context\nresearch.read',
    toolIdsText: 'browser.read\nfiles.read',
    tagsText: 'research\nverified',
    acceptanceCriteriaText: 'Every material claim has evidence.',
    enabled: true,
    ...overrides,
  };
}

function configuredPolicyForm(overrides = {}) {
  return {
    modelRoutePolicyConfigured: true,
    modelRouteAutoSwitch: true,
    modelRoutePinnedRouteId: '',
    modelRouteOrderedRouteIdsText: 'route.fast\nroute.strong',
    modelRouteAllowRouteIdsText: 'route.fast\nroute.strong',
    modelRouteDenyRouteIdsText: '',
    modelRouteFreeOnly: false,
    modelRouteLocality: 'any',
    modelRouteMaxInputPriceText: '3.5',
    modelRouteMaxOutputPriceText: '9',
    modelRouteRetryBackoffSeconds: '45',
    modelRouteCircuitBreakerFailures: '3',
    modelRouteCircuitBreakerSeconds: '240',
    ...overrides,
  };
}

test('Agent definition owner form builds the full canonical Router policy without execution authority', () => {
  const policy = buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm());
  assert.deepEqual(policy, {
    autoSwitch: true,
    pinnedRouteId: '',
    orderedRouteIds: ['route.fast', 'route.strong'],
    allowRouteIds: ['route.fast', 'route.strong'],
    denyRouteIds: [],
    freeOnly: false,
    locality: 'any',
    maxInputPricePerMillionUsd: 3.5,
    maxOutputPricePerMillionUsd: 9,
    retryBackoffSeconds: 45,
    circuitBreakerFailures: 3,
    circuitBreakerSeconds: 240,
  });

  const definition = buildAgentDefinitionFromFormV1({
    ...baseForm(),
    ...configuredPolicyForm(),
  });
  assert.deepEqual(definition.modelRoutePolicy, policy);
  const canonical = normalizeAgentDefinitionV1(definition);
  assert.deepEqual(canonical.modelRoutePolicy, policy);
});

test('Agent definition model policy supports explicit inherit/null and preserves policy when UI fields are absent', () => {
  const persisted = {
    autoSwitch: false,
    pinnedRouteId: 'route.saved',
    orderedRouteIds: ['route.saved'],
    allowRouteIds: ['route.saved'],
    denyRouteIds: [],
    freeOnly: true,
    locality: 'local',
    maxInputPricePerMillionUsd: 0,
    maxOutputPricePerMillionUsd: 0,
    retryBackoffSeconds: 30,
    circuitBreakerFailures: 2,
    circuitBreakerSeconds: 120,
  };

  const preserved = buildAgentDefinitionFromFormV1(baseForm(), {
    modelRoutePolicy: persisted,
  });
  assert.deepEqual(preserved.modelRoutePolicy, persisted);
  assert.notEqual(preserved.modelRoutePolicy, persisted);

  const cleared = buildAgentDefinitionFromFormV1(baseForm({
    modelRoutePolicyConfigured: false,
  }), {
    modelRoutePolicy: persisted,
  });
  assert.equal(cleared.modelRoutePolicy, null);
});

test('legacy partial Agent policy upgrades to the existing Router failover defaults without changing eligibility intent', () => {
  const legacy = normalizeAgentDefinitionV1(buildAgentDefinitionFromFormV1(baseForm(), {
    modelRoutePolicy: {
      autoSwitch: false,
      allowRouteIds: ['route.saved'],
      denyRouteIds: [],
      freeOnly: true,
      locality: 'local',
      maxInputPricePerMillionUsd: 0,
      maxOutputPricePerMillionUsd: 0,
    },
  }));
  assert.equal(legacy.modelRoutePolicy.autoSwitch, false);
  assert.deepEqual(legacy.modelRoutePolicy.allowRouteIds, ['route.saved']);
  assert.equal(legacy.modelRoutePolicy.retryBackoffSeconds, 60);
  assert.equal(legacy.modelRoutePolicy.circuitBreakerFailures, 2);
  assert.equal(legacy.modelRoutePolicy.circuitBreakerSeconds, 300);
});

test('explicit global-inherit model policy does not read disabled subordinate fields', () => {
  let reads = 0;
  const input = { modelRoutePolicyConfigured: false };
  Object.defineProperty(input, 'modelRoutePinnedRouteId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'route.hidden';
    },
  });
  const policy = buildAgentDefinitionModelRoutePolicyFromFormV1(input, {
    persistedPolicy: { autoSwitch: false },
  });
  assert.equal(policy, null);
  assert.equal(reads, 0);
});

test('Agent definition model policy rejects aliases, duplicate route IDs and invalid Router bounds before mutation', () => {
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteOrderedRouteIdsText: 'route.fast\nroute.fast',
    })),
    /дублікат/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRoutePinnedRouteId: ' route.fast',
    })),
    /Pinned model route ID/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteRetryBackoffSeconds: '060',
    })),
    /канонічному форматі/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteCircuitBreakerFailures: '101',
    })),
    /діапазоном/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteMaxInputPriceText: '1e2',
    })),
    /канонічним невід’ємним числом/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteLocality: 'LOCAL',
    })),
    /locality is invalid/u,
  );
});

test('Agent definition model policy rejects relationships that canonical Agent binding would always deny', () => {
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteAllowRouteIdsText: 'route.fast',
      modelRouteOrderedRouteIdsText: 'route.strong',
    })),
    /Ordered model route ID поза allow scope: route\.strong/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteAllowRouteIdsText: 'route.fast',
      modelRouteDenyRouteIdsText: 'route.strong',
    })),
    /Denied model route ID поза allow scope: route\.strong/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteAllowRouteIdsText: 'route.fast',
      modelRoutePinnedRouteId: 'route.strong',
    })),
    /Pinned model route ID поза allow scope: route\.strong/u,
  );
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(configuredPolicyForm({
      modelRouteAllowRouteIdsText: '',
      modelRoutePinnedRouteId: 'route.strong',
      modelRouteDenyRouteIdsText: 'route.strong',
    })),
    /одночасно заборонений deny policy/u,
  );
});

test('Agent definition save rejects legacy pinned routes that durable model policy would deny', () => {
  assert.throws(
    () => buildAgentDefinitionFromFormV1({
      ...baseForm({ aiPinnedRouteId:'route.legacy' }),
      ...configuredPolicyForm({ modelRoutePinnedRouteId:'route.strong' }),
    }),
    /Legacy pinned route конфліктує/u,
  );
  assert.throws(
    () => buildAgentDefinitionFromFormV1({
      ...baseForm({ aiPinnedRouteId:'route.strong' }),
      ...configuredPolicyForm({
        modelRoutePinnedRouteId:'',
        modelRouteAllowRouteIdsText:'route.fast',
        modelRouteOrderedRouteIdsText:'route.fast',
      }),
    }),
    /Legacy pinned route поза Model Router policy allow scope/u,
  );
  assert.throws(
    () => buildAgentDefinitionFromFormV1({
      ...baseForm({ aiPinnedRouteId:'route.strong' }),
      ...configuredPolicyForm({
        modelRoutePinnedRouteId:'',
        modelRouteDenyRouteIdsText:'route.strong',
      }),
    }),
    /Legacy pinned route заборонений Model Router policy deny scope/u,
  );

  const compatible = buildAgentDefinitionFromFormV1({
    ...baseForm({ aiPinnedRouteId:'route.strong' }),
    ...configuredPolicyForm({ modelRoutePinnedRouteId:'route.strong' }),
  });
  assert.equal(compatible.configDefaults.aiPinnedRouteId, 'route.strong');
  assert.equal(compatible.modelRoutePolicy.pinnedRouteId, 'route.strong');
});

test('Agent definition model-policy form does not execute accessors', () => {
  let reads = 0;
  const hostile = configuredPolicyForm();
  Object.defineProperty(hostile, 'modelRoutePinnedRouteId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'route.fast';
    },
  });
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(hostile),
    /enumerable data property/u,
  );
  assert.equal(reads, 0);

  const hostileConfigured = {};
  Object.defineProperty(hostileConfigured, 'modelRoutePolicyConfigured', {
    enumerable: true,
    get() {
      reads += 1;
      return true;
    },
  });
  assert.throws(
    () => buildAgentDefinitionModelRoutePolicyFromFormV1(hostileConfigured),
    /enumerable data property/u,
  );
  assert.equal(reads, 0);
});

test('full Agent model policy preserves Router failover fields across durable normalization', () => {
  const definition = normalizeAgentDefinitionV1(buildAgentDefinitionFromFormV1({
    ...baseForm(),
    ...configuredPolicyForm({
      modelRouteAutoSwitch: false,
      modelRoutePinnedRouteId: 'route.strong',
      modelRouteFreeOnly: true,
      modelRouteLocality: 'local',
      modelRouteMaxInputPriceText: '0',
      modelRouteMaxOutputPriceText: '0',
      modelRouteRetryBackoffSeconds: '90',
      modelRouteCircuitBreakerFailures: '4',
      modelRouteCircuitBreakerSeconds: '600',
    }),
  }));
  assert.equal(definition.modelRoutePolicy.autoSwitch, false);
  assert.equal(definition.modelRoutePolicy.pinnedRouteId, 'route.strong');
  assert.equal(definition.modelRoutePolicy.freeOnly, true);
  assert.equal(definition.modelRoutePolicy.locality, 'local');
  assert.equal(definition.modelRoutePolicy.retryBackoffSeconds, 90);
  assert.equal(definition.modelRoutePolicy.circuitBreakerFailures, 4);
  assert.equal(definition.modelRoutePolicy.circuitBreakerSeconds, 600);
});

test('Agent model-policy UI uses persistent native labels and removes inactive subordinate controls from tab flow', async () => {
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
  for (const id of ids) {
    assert.match(
      html,
      new RegExp('(?:for="' + id + '"|<label><input id="' + id + '")', 'u'),
      id + ' needs an explicit native label',
    );
  }
  assert.match(html, /Збереження policy не вибирає модель, не запускає provider і не запускає Agent/u);
  assert.match(
    source,
    /function syncAgentDefinitionModelRoutePolicyControls\(\)[\s\S]*?\$\(id\)\.disabled = !configured/u,
  );
  assert.match(
    source,
    /agent-definition-model-route-policy-configured'\)\.addEventListener\('change', syncAgentDefinitionModelRoutePolicyControls\)/u,
  );
});

test('definition save persists model policy only through existing registry mutation authority', async () => {
  const source = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function saveAgentDefinition()');
  const end = source.indexOf('\nasync function toggleAgentDefinitionEnabled', start);
  assert.ok(start >= 0 && end > start);
  const save = source.slice(start, end);
  assert.match(save, /buildAgentDefinitionFromFormV1\(agentDefinitionFormValue\(\),/u);
  assert.match(save, /MUTATE_BROWSER_AGENT_DEFINITION_REGISTRY/u);
  assert.doesNotMatch(
    save,
    /RUN_AI_ROUTED_PROMPT|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT_BURST|provider|fetch\(/u,
  );
});
