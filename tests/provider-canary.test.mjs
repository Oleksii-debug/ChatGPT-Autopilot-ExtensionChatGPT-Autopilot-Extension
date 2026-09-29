import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderCanaryObservationStatus,
  ProviderCanaryProbeKind,
  buildProviderCanaryProbePlanV1,
  evaluateProviderCanariesV1,
  normalizeProviderCanaryDefinitionV1,
  normalizeProviderCanaryObservationV1,
} from '../src/core/provider-canary.js';
import {
  CapabilityPathKind,
  ProviderHealthStatus,
} from '../src/core/capability-discovery.js';

function definition(canaryId, capabilityId, overrides = {}) {
  return {
    schemaVersion:1,
    definitionRevisionId:'def-1',
    definitionSha256:'a'.repeat(64),
    canaryId,
    providerId:'github/main',
    capabilityId,
    probeKind:ProviderCanaryProbeKind.GITHUB_READ,
    critical:true,
    maxLatencyMs:1000,
    maxObservationAgeMs:60_000,
    requiredPasses:2,
    failureThreshold:2,
    ...overrides,
  };
}

function observation(observationId, canaryId, capabilityId, status = 'PASS', overrides = {}) {
  return {
    schemaVersion:1,
    definitionRevisionId:'def-1',
    definitionSha256:'a'.repeat(64),
    observationId,
    canaryId,
    providerId:'github/main',
    capabilityId,
    status,
    latencyMs:100,
    observedAt:'2026-09-25T05:55:00.000Z',
    evidenceId:`evidence.${observationId}`,
    ...overrides,
  };
}

function currentReadiness(overrides = {}) {
  return {
    schemaVersion:1,
    providerId:'github/main',
    toolId:'github.fetch',
    health:ProviderHealthStatus.READY,
    installationRequired:false,
    installed:true,
    authenticationRequired:true,
    authenticated:true,
    pathKind:CapabilityPathKind.API,
    latencyMs:25,
    reasonCode:'CURRENT_READY',
    ...overrides,
  };
}

function evaluate(definitions, observations, overrides = {}) {
  return evaluateProviderCanariesV1({
    schemaVersion:1,
    asOf:'2026-09-25T05:55:30.000Z',
    currentReadiness:currentReadiness(),
    definitions,
    observations,
    ...overrides,
  });
}

test('probe plan is closed-kind, read-only and never authorizes destructive or economic action', () => {
  const defs = [
    definition('github.read', 'github.read'),
    definition('native.health', 'native.health', {
      probeKind:ProviderCanaryProbeKind.NATIVE_HEALTH,
      critical:false,
    }),
  ];
  const plan = buildProviderCanaryProbePlanV1({
    schemaVersion:1,
    asOf:'2026-09-25T05:55:30.000Z',
    definitions:defs,
  });
  assert.equal(plan.executionAuthorized, false);
  assert.deepEqual(plan.probes.map(item => item.canaryId), ['github.read', 'native.health']);
  assert.equal(plan.probes[0].definitionRevisionId, 'def-1');
  assert.equal(plan.probes[0].definitionSha256, 'a'.repeat(64));
  for (const probe of plan.probes) {
    assert.equal(probe.readOnly, true);
    assert.equal(probe.destructiveAllowed, false);
    assert.equal(probe.economicallyConsequentialAllowed, false);
    assert.equal(probe.executionAuthorized, false);
    assert.equal(probe.requiresPolicyDecision, true);
  }
});

test('enough fresh successful observations produce READY and preserve canonical install/auth/tool/path facts', () => {
  const def = definition('github.read', 'github.read');
  const result = evaluate([def], [
    observation('pass.1', 'github.read', 'github.read', 'PASS', {
      observedAt:'2026-09-25T05:54:50.000Z',
      latencyMs:120,
    }),
    observation('pass.2', 'github.read', 'github.read', 'PASS', {
      observedAt:'2026-09-25T05:55:00.000Z',
      latencyMs:80,
    }),
  ]);
  assert.equal(result.health, ProviderHealthStatus.READY);
  assert.equal(result.recommendedProviderReadiness.health, ProviderHealthStatus.READY);
  assert.equal(result.recommendedProviderReadiness.toolId, 'github.fetch');
  assert.equal(result.recommendedProviderReadiness.authenticationRequired, true);
  assert.equal(result.recommendedProviderReadiness.authenticated, true);
  assert.equal(result.recommendedProviderReadiness.pathKind, CapabilityPathKind.API);
  assert.equal(result.recommendations.actionAuthorized, false);
  assert.equal(result.readinessUpdateAuthorized, false);
});

test('latency ceiling degrades an otherwise successful newest probe', () => {
  const def = definition('github.read', 'github.read', {
    requiredPasses:1,
    maxLatencyMs:50,
  });
  const result = evaluate([def], [
    observation('slow', 'github.read', 'github.read', 'PASS', { latencyMs:80 }),
  ]);
  assert.equal(result.health, ProviderHealthStatus.DEGRADED);
  assert.equal(result.evaluations[0].reasonCode, 'CANARY_LATENCY_DEGRADED');
  assert.equal(result.recommendations.activateFallbackSuggested, true);
  assert.equal(result.recommendations.blockConsequentialWorkSuggested, false);
});

test('consecutive effective failures reaching threshold produce UNAVAILABLE and conservative routing advice', () => {
  const def = definition('github.read', 'github.read', { requiredPasses:1, failureThreshold:2 });
  const result = evaluate([def], [
    observation('old.pass', 'github.read', 'github.read', 'PASS', {
      observedAt:'2026-09-25T05:54:40.000Z',
    }),
    observation('fail.1', 'github.read', 'github.read', ProviderCanaryObservationStatus.FAIL, {
      observedAt:'2026-09-25T05:54:50.000Z',
    }),
    observation('fail.2', 'github.read', 'github.read', ProviderCanaryObservationStatus.TIMEOUT, {
      observedAt:'2026-09-25T05:55:00.000Z',
    }),
  ]);
  assert.equal(result.health, ProviderHealthStatus.UNAVAILABLE);
  assert.equal(result.evaluations[0].consecutiveFailureCount, 2);
  assert.equal(result.recommendations.removeFromCriticalRoutingSuggested, true);
  assert.equal(result.recommendations.activateFallbackSuggested, true);
  assert.equal(result.recommendations.repairTaskSuggested, true);
  assert.equal(result.recommendations.blockConsequentialWorkSuggested, true);
  assert.equal(result.executionAuthorized, false);
});

test('stale-only evidence produces UNKNOWN and never silently preserves prior READY', () => {
  const def = definition('github.read', 'github.read', { maxObservationAgeMs:10_000 });
  const result = evaluate([def], [
    observation('stale', 'github.read', 'github.read', 'PASS', {
      observedAt:'2026-09-25T05:54:00.000Z',
    }),
  ]);
  assert.equal(result.health, ProviderHealthStatus.UNKNOWN);
  assert.equal(result.recommendedProviderReadiness.health, ProviderHealthStatus.UNKNOWN);
  assert.equal(result.recommendations.blockConsequentialWorkSuggested, true);
});

test('critical canaries control aggregate health while noncritical degradation remains visible in evaluations', () => {
  const result = evaluate([
    definition('critical.read', 'github.read', { requiredPasses:1, critical:true }),
    definition('optional.meta', 'github.metadata', {
      requiredPasses:1,
      critical:false,
      maxLatencyMs:10,
    }),
  ], [
    observation('critical.pass', 'critical.read', 'github.read', 'PASS'),
    observation('optional.slow', 'optional.meta', 'github.metadata', 'PASS', { latencyMs:20 }),
  ]);
  assert.equal(result.health, ProviderHealthStatus.READY);
  assert.equal(
    result.evaluations.find(item => item.canaryId === 'optional.meta').health,
    ProviderHealthStatus.DEGRADED,
  );
});

test('mismatched, unknown, future and duplicate evidence fails closed', () => {
  const def = definition('github.read', 'github.read', { requiredPasses:1 });

  assert.throws(() => evaluate([def], [
    observation('wrong.provider', 'github.read', 'github.read', 'PASS', {
      providerId:'github/other',
    }),
  ]), /identity does not match/);

  assert.throws(() => evaluate([def], [
    observation('unknown', 'other.canary', 'github.read'),
  ]), /unknown canaryId/);

  assert.throws(() => evaluate([def], [
    observation('future', 'github.read', 'github.read', 'PASS', {
      observedAt:'2026-09-25T05:55:30.001Z',
    }),
  ]), /from the future/);

  const duplicate = observation('same', 'github.read', 'github.read');
  assert.throws(() => evaluate([def], [duplicate, duplicate]), /duplicate observationId/);
});

test('old observations cannot satisfy a changed canary definition under the same canaryId', () => {
  const oldObservation = observation('old.pass', 'github.read', 'github.read', 'PASS');

  const changedProbe = definition('github.read', 'github.read', {
    requiredPasses:1,
    probeKind:ProviderCanaryProbeKind.NATIVE_HEALTH,
    definitionRevisionId:'def-2',
    definitionSha256:'b'.repeat(64),
  });
  assert.throws(() => evaluate([changedProbe], [oldObservation]), /definition identity does not match/);

  const changedThresholds = definition('github.read', 'github.read', {
    requiredPasses:1,
    failureThreshold:3,
    critical:false,
    definitionRevisionId:'def-3',
    definitionSha256:'c'.repeat(64),
  });
  assert.throws(() => evaluate([changedThresholds], [oldObservation]), /definition identity does not match/);
});

test('definitions must match canonical current provider identity', () => {
  assert.throws(() => evaluate([
    definition('other', 'github.read', { providerId:'github/other' }),
  ], []), /providerId does not match currentReadiness/);
});

test('observation ordering does not change evaluation', () => {
  const def = definition('github.read', 'github.read', { requiredPasses:2 });
  const observations = [
    observation('p1', 'github.read', 'github.read', 'PASS', {
      observedAt:'2026-09-25T05:54:50.000Z',
    }),
    observation('p2', 'github.read', 'github.read', 'PASS', {
      observedAt:'2026-09-25T05:55:00.000Z',
    }),
  ];
  assert.deepEqual(evaluate([def], observations), evaluate([def], [...observations].reverse()));
});

test('closed probe/status enums and canonical identities reject coercive aliases', () => {
  assert.throws(() => normalizeProviderCanaryDefinitionV1(
    definition('x', 'github.read', { probeKind:'github_read' }),
  ), /exact canonical enum/);

  assert.throws(() => normalizeProviderCanaryDefinitionV1(
    definition(' x', 'github.read'),
  ), /exact canonical identity/);

  assert.throws(() => normalizeProviderCanaryDefinitionV1(
    definition('x', 'github.read', { definitionSha256:'A'.repeat(64) }),
  ), /exact lowercase SHA-256/);

  assert.throws(() => normalizeProviderCanaryObservationV1(
    observation('x', 'github.read', 'github.read', 'pass'),
  ), /exact canonical enum/);

  assert.throws(() => normalizeProviderCanaryObservationV1(
    observation('x', 'github.read', 'github.read', 'PASS', {
      observedAt:'2026-09-25T05:55:00Z',
    }),
  ), /canonical ISO-8601/);
});

test('record and array boundaries execute zero caller getters', () => {
  let definitionReads = 0;
  const proxiedDefinition = new Proxy(definition('safe', 'github.read'), {
    get(target, key, receiver) {
      definitionReads += 1;
      if (key === 'critical') return false;
      return Reflect.get(target, key, receiver);
    },
  });
  const normalized = normalizeProviderCanaryDefinitionV1(proxiedDefinition);
  assert.equal(definitionReads, 0);
  assert.equal(normalized.critical, true);

  let arrayReads = 0;
  const definitions = new Proxy([definition('safe', 'github.read')], {
    get(target, key, receiver) {
      arrayReads += 1;
      if (key === 'length') return 99999;
      return Reflect.get(target, key, receiver);
    },
  });
  const plan = buildProviderCanaryProbePlanV1({
    schemaVersion:1,
    asOf:'2026-09-25T05:55:30.000Z',
    definitions,
  });
  assert.equal(arrayReads, 0);
  assert.equal(plan.probes.length, 1);

  let itemReads = 0;
  const observations = [];
  Object.defineProperty(observations, 0, {
    enumerable:true,
    configurable:true,
    get() {
      itemReads += 1;
      return observation('forged', 'safe', 'github.read');
    },
  });
  assert.throws(() => evaluate([
    definition('safe', 'github.read', { requiredPasses:1 }),
  ], observations), /enumerable own data properties/);
  assert.equal(itemReads, 0);
});

test('hidden, symbol, sparse and exotic authority is rejected', () => {
  const hidden = definition('hidden', 'github.read');
  Object.defineProperty(hidden, 'critical', {
    enumerable:false,
    configurable:true,
    value:true,
  });
  assert.throws(() => normalizeProviderCanaryDefinitionV1(hidden), /enumerable own data property/);

  const symbolic = definition('symbolic', 'github.read');
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeProviderCanaryDefinitionV1(symbolic), /symbol field/);

  const sparse = new Array(1);
  assert.throws(() => buildProviderCanaryProbePlanV1({
    schemaVersion:1,
    asOf:'2026-09-25T05:55:30.000Z',
    definitions:sparse,
  }), /dense data-only array/);

  const exotic = [definition('exotic', 'github.read')];
  Object.setPrototypeOf(exotic, null);
  assert.throws(() => buildProviderCanaryProbePlanV1({
    schemaVersion:1,
    asOf:'2026-09-25T05:55:30.000Z',
    definitions:exotic,
  }), /bounded plain array/);
});

test('canary result never grants routing, repair, readiness-update, task, policy or effect authority', () => {
  const result = evaluate([
    definition('github.read', 'github.read', { requiredPasses:1, failureThreshold:1 }),
  ], [
    observation('fail', 'github.read', 'github.read', 'FAIL'),
  ]);
  assert.equal(result.recommendations.actionAuthorized, false);
  assert.equal(result.readinessUpdateAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal('taskId' in result, false);
  assert.equal('effectId' in result, false);
  assert.equal('policyDecision' in result, false);
});
