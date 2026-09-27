import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AiRouteQualityClass,
  deriveAiRouteQualitySubjectRevisionIdV1,
  rankAiRouteCandidatesByEvidenceV1,
} from '../src/core/ai-route-quality-governor.js';
import {
  BenchmarkAssertionOperator,
  BenchmarkCaseOutcome,
} from '../src/core/benchmark-evaluation.js';

const NOW = Date.parse('2026-09-27T12:00:02.000Z');
const START = '2026-09-27T12:00:00.000Z';
const END = '2026-09-27T12:00:01.000Z';

function route(routeId, overrides = {}) {
  return {
    schemaVersion: 1,
    routeId,
    provider: 'ollama',
    model: 'model-' + routeId,
    roles: ['planner'],
    capabilityIds: [],
    priority: 0,
    enabled: true,
    locality: 'local',
    costClass: 'free',
    supportsVision: false,
    maxWorkers: 0,
    ...overrides,
  };
}

function paid(routeId, inputPrice, outputPrice, overrides = {}) {
  return route(routeId, {
    provider: 'openai',
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: inputPrice,
    outputPricePerMillionUsd: outputPrice,
    inputPriceKnown: true,
    outputPriceKnown: true,
    ...overrides,
  });
}

async function benchmarkBinding(routeValue, { pass = true, suffix = 'a', maxAgeMs = 60_000 } = {}) {
  const routeId = routeValue.routeId;
  const suiteId = 'route-quality-' + suffix;
  const suiteRevisionId = 'suite-' + suffix;
  const runId = 'run-' + routeId + '-' + suffix;
  const subjectRevisionId = await deriveAiRouteQualitySubjectRevisionIdV1(routeValue);
  const invocationId = 'benchmark-' + routeId + '-' + suffix;
  const artifactId = 'evidence-' + routeId + '-' + suffix;
  const result = {
    caseId: 'quality',
    outcome: BenchmarkCaseOutcome.MEASURED,
    metrics: { score: pass ? 1 : 0 },
    evidenceArtifactIds: [artifactId],
  };
  const run = {
    schemaVersion: 1,
    runId,
    suiteId,
    suiteRevisionId,
    subjectId: routeId,
    subjectRevisionId,
    startedAt: START,
    completedAt: END,
    results: [structuredClone(result)],
  };
  return {
    routeId,
    maxAgeMs,
    evaluationRequest: {
      suite: {
        schemaVersion: 1,
        suiteId,
        suiteRevisionId,
        title: 'Route quality benchmark ' + suffix,
        cases: [{
          caseId: 'quality',
          title: 'Quality threshold',
          assertions: [{
            metricId: 'score',
            operator: BenchmarkAssertionOperator.AT_LEAST,
            threshold: 1,
          }],
        }],
      },
      run,
      expectedSubject: {
        subjectId: routeId,
        subjectRevisionId,
      },
      trustedExecution: {
        runId,
        suiteId,
        suiteRevisionId,
        subjectId: routeId,
        subjectRevisionId,
        producerInvocationId: invocationId,
        startedAt: START,
        completedAt: END,
        results: [structuredClone(result)],
      },
      trustedEvidenceArtifacts: [{
        schemaVersion: 1,
        artifactId,
        kind: 'benchmark-evidence',
        uri: 'artifact://benchmark/' + artifactId,
        mediaType: 'application/json',
        sha256: (pass ? '1' : '2').repeat(64),
        sizeBytes: 1,
        createdAt: END,
        producerInvocationId: invocationId,
        sensitive: false,
      }],
    },
  };
}

function rank(overrides = {}) {
  return rankAiRouteCandidatesByEvidenceV1({
    routes: [route('route-a'), route('route-b')],
    policy: {},
    routeStates: {},
    role: 'planner',
    capabilityIds: [],
    requiresVision: false,
    now: NOW,
    benchmarkRequests: [],
    ...overrides,
  });
}

test('is advisory only and cannot widen canonical Router eligibility', async () => {
  const routes = [route('route-a'), route('route-b'), route('route-blocked')];
  const report = await rank({
    routes,
    policy: { allowRouteIds: ['route-a', 'route-b'] },
    benchmarkRequests: [await benchmarkBinding(routes[1])],
  });

  assert.equal(report.advisoryOnly, true);
  assert.equal(report.selectionAuthorized, false);
  assert.equal(report.dispatchAuthorized, false);
  assert.equal(report.policyAuthorized, false);
  assert.equal(report.budgetAuthorized, false);
  assert.equal(report.routeStateMutationAuthorized, false);
  assert.equal(report.qualityStoreAuthorized, false);
  assert.equal(report.requiresCanonicalRouterSelectionAtDispatch, true);
  assert.equal(report.requiresFreshPolicyAtDispatch, true);
  assert.equal(report.qualityEvidenceDoesNotGrantExecution, true);
  assert.deepEqual(report.eligibleRouteIds, ['route-a', 'route-b']);
  assert.deepEqual(report.rankedRouteIds, ['route-b', 'route-a']);
  assert.equal(report.recommendedRouteId, 'route-b');
  assert.equal(report.candidates.some((item) => item.routeId === 'route-blocked'), false);
});

test('owner orderedRouteIds remain stronger than adaptive evidence', async () => {
  const routes = [route('route-a'), route('route-b')];
  const report = await rank({
    routes,
    policy: { orderedRouteIds: ['route-a', 'route-b'] },
    benchmarkRequests: [await benchmarkBinding(routes[1])],
  });
  assert.deepEqual(report.rankedRouteIds, ['route-a', 'route-b']);
  assert.equal(report.candidates[0].ownerOrderIndex, 0);
  assert.equal(report.candidates[1].ownerOrderIndex, 1);
});

test('owner route priority remains stronger than adaptive evidence', async () => {
  const routes = [
    route('route-a', { priority: 100 }),
    route('route-b', { priority: 1 }),
  ];
  const report = await rank({
    routes,
    benchmarkRequests: [await benchmarkBinding(routes[1])],
  });
  assert.deepEqual(report.rankedRouteIds, ['route-a', 'route-b']);
  assert.equal(report.candidates[0].ownerPriority, 100);
});

test('quality evidence ranks PASS before missing evidence and known FAIL last', async () => {
  const routes = [route('route-pass'), route('route-missing'), route('route-fail')];
  const report = await rank({
    routes,
    benchmarkRequests: [
      await benchmarkBinding(routes[0], { pass: true, suffix: 'pass' }),
      await benchmarkBinding(routes[2], { pass: false, suffix: 'fail' }),
    ],
  });

  assert.deepEqual(report.rankedRouteIds, ['route-pass', 'route-missing', 'route-fail']);
  assert.deepEqual(
    report.candidates.map((item) => item.quality.class),
    [AiRouteQualityClass.PASS, AiRouteQualityClass.MISSING, AiRouteQualityClass.FAIL],
  );
  assert.equal(report.candidates[0].quality.passedCaseCount, 1);
  assert.equal(report.candidates[2].quality.failedCaseCount, 1);
});

test('stale quality evidence is explicit and does not retain PASS ranking authority', async () => {
  const routes = [route('route-stale'), route('route-missing')];
  const report = await rank({
    routes,
    now: NOW + 60_000,
    benchmarkRequests: [
      await benchmarkBinding(routes[0], { pass: true, suffix: 'stale', maxAgeMs: 1_000 }),
    ],
  });

  const stale = report.candidates.find((item) => item.routeId === 'route-stale');
  assert.equal(stale.quality.class, AiRouteQualityClass.STALE);
  assert.equal(stale.quality.stale, true);
  assert.equal(stale.quality.maxAgeMs, 1_000);
  assert.equal(stale.quality.completedAt, END);
});

test('future-dated benchmark evidence fails closed', async () => {
  const routeA = route('route-a');
  const binding = await benchmarkBinding(routeA);
  await assert.rejects(
    rank({
      routes: [routeA, route('route-b')],
      now: Date.parse('2026-09-27T11:59:59.000Z'),
      benchmarkRequests: [binding],
    }),
    /completion time is in the future/,
  );
});

test('cost is deterministic after equal owner and quality evidence, then latency breaks remaining ties', async () => {
  const routes = [
    route('free-slow'),
    paid('paid-cheap', 1, 2),
    paid('paid-expensive', 2, 2),
    route('free-fast'),
    route('free-unknown'),
  ];
  const benchmarkRequests = await Promise.all(routes.map((item, index) => benchmarkBinding(
    item,
    { pass: true, suffix: String(index + 1) },
  )));
  const routeStates = {
    'free-slow': { successes: 1, lastLatencyMs: 500 },
    'free-fast': { successes: 1, lastLatencyMs: 50 },
    'paid-cheap': { successes: 1, lastLatencyMs: 1 },
    'paid-expensive': { successes: 1, lastLatencyMs: 1 },
  };

  const report = await rank({ routes, benchmarkRequests, routeStates });
  assert.deepEqual(report.rankedRouteIds, [
    'free-fast',
    'free-slow',
    'free-unknown',
    'paid-cheap',
    'paid-expensive',
  ]);
  assert.deepEqual(report.candidates[0].latency, { observed: true, lastLatencyMs: 50 });
  assert.deepEqual(report.candidates[2].latency, { observed: false, lastLatencyMs: 0 });
});

test('durable backoff and autoSwitch=false remain canonical Router authority', async () => {
  const report = await rank({
    routes: [route('route-a'), route('route-b')],
    policy: { autoSwitch: false },
    routeStates: {
      'route-a': {
        successes: 1,
        backoffUntil: NOW + 10_000,
        lastLatencyMs: 10,
      },
      'route-b': {
        successes: 1,
        lastLatencyMs: 20,
      },
    },
  });

  assert.deepEqual(report.rankedRouteIds, ['route-b']);
  assert.equal(report.retryAt, 0);

  const bothBlocked = await rank({
    routes: [route('route-a'), route('route-b')],
    routeStates: {
      'route-a': { failures: 1, backoffUntil: NOW + 10_000, lastLatencyMs: 10 },
      'route-b': { failures: 1, circuitOpenUntil: NOW + 20_000, lastLatencyMs: 20 },
    },
  });
  assert.deepEqual(bothBlocked.rankedRouteIds, []);
  assert.equal(bothBlocked.retryAt, NOW + 10_000);
});

test('benchmark subject identity must match the route', async () => {
  const routeA = route('route-a');
  const binding = await benchmarkBinding(routeA);
  binding.evaluationRequest.expectedSubject.subjectId = 'route-b';
  binding.evaluationRequest.trustedExecution.subjectId = 'route-b';
  binding.evaluationRequest.run.subjectId = 'route-b';

  await assert.rejects(
    rank({ benchmarkRequests: [binding] }),
    /benchmark subject must match routeId/,
  );
});

test('benchmark subject revision is bound to the exact normalized route configuration', async () => {
  const originalRoute = route('route-a');
  const binding = await benchmarkBinding(originalRoute);
  const changedRoute = route('route-a', { model: 'different-model' });

  await assert.rejects(
    rank({
      routes: [changedRoute, route('route-b')],
      benchmarkRequests: [binding],
    }),
    /subject revision does not match current route configuration/,
  );

  const first = await deriveAiRouteQualitySubjectRevisionIdV1(originalRoute);
  const second = await deriveAiRouteQualitySubjectRevisionIdV1(structuredClone(originalRoute));
  assert.equal(first, second);
  assert.match(first, /^routev1-[0-9a-f]{64}$/u);
});

test('duplicate or unknown route benchmark bindings fail closed', async () => {
  const binding = await benchmarkBinding(route('route-a'));
  await assert.rejects(
    rank({ benchmarkRequests: [binding, structuredClone(binding)] }),
    /benchmark evidence is duplicated/,
  );
  await assert.rejects(
    rank({
      benchmarkRequests: [await benchmarkBinding(route('route-unknown'))],
    }),
    /references unknown route/,
  );
});

test('hostile request accessors and binding accessors are rejected without getter execution', async () => {
  let requestReads = 0;
  const hostileRequest = {};
  Object.defineProperty(hostileRequest, 'routes', {
    enumerable: true,
    get() {
      requestReads += 1;
      return [];
    },
  });
  await assert.rejects(
    rankAiRouteCandidatesByEvidenceV1(hostileRequest),
    /enumerable own data property/,
  );
  assert.equal(requestReads, 0);

  let bindingReads = 0;
  const hostileBinding = { routeId: 'route-a' };
  Object.defineProperty(hostileBinding, 'evaluationRequest', {
    enumerable: true,
    get() {
      bindingReads += 1;
      return {};
    },
  });
  await assert.rejects(
    rank({ benchmarkRequests: [hostileBinding] }),
    /enumerable own data property/,
  );
  assert.equal(bindingReads, 0);
});

test('result and nested projections are immutable deterministic evidence', async () => {
  const routeA = route('route-a');
  const report = await rank({
    routes: [routeA, route('route-b')],
    benchmarkRequests: [await benchmarkBinding(routeA)],
  });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.rankedRouteIds), true);
  assert.equal(Object.isFrozen(report.candidates), true);
  assert.equal(Object.isFrozen(report.candidates[0]), true);
  assert.equal(Object.isFrozen(report.candidates[0].quality), true);
  assert.equal(Object.isFrozen(report.candidates[0].cost), true);
  assert.equal(Object.isFrozen(report.candidates[0].latency), true);
});
