import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_AUTHORITY,
  MAX_AI_ROUTE_QUALITY_RECORDS,
  MAX_AI_ROUTE_QUALITY_RECORDS_PER_ROUTE,
  createAiRouteQualityEvidenceRegistryV1,
  normalizeAiRouteQualityEvidenceRegistryV1,
  putAiRouteQualityEvidenceRecordV1,
  readLatestAiRouteQualityBenchmarkRequestsV1,
} from '../src/core/ai-route-quality-evidence-registry.js';
import {
  deriveAiRouteQualitySubjectRevisionIdV1,
  rankAiRouteCandidatesByEvidenceV1,
} from '../src/core/ai-route-quality-governor.js';
import {
  BenchmarkAssertionOperator,
  BenchmarkCaseOutcome,
} from '../src/core/benchmark-evaluation.js';

const START = '2026-09-27T12:00:00.000Z';
const END = '2026-09-27T12:00:01.000Z';
const REGISTERED = '2026-09-27T12:00:02.000Z';
const NOW = Date.parse('2026-09-27T12:00:03.000Z');

function route(routeId, overrides = {}) {
  return {
    schemaVersion:1,
    routeId,
    provider:'ollama',
    model:'model-' + routeId,
    roles:['planner'],
    capabilityIds:[],
    priority:0,
    enabled:true,
    locality:'local',
    costClass:'free',
    supportsVision:false,
    maxWorkers:0,
    ...overrides,
  };
}

async function benchmarkBinding(routeValue, suffix = 'a', { pass = true, maxAgeMs = 60_000 } = {}) {
  const routeId = routeValue.routeId;
  const suiteId = 'route-quality-' + suffix;
  const suiteRevisionId = 'suite-' + suffix;
  const runId = 'run-' + routeId + '-' + suffix;
  const subjectRevisionId = await deriveAiRouteQualitySubjectRevisionIdV1(routeValue);
  const invocationId = 'benchmark-' + routeId + '-' + suffix;
  const artifactId = 'evidence-' + routeId + '-' + suffix;
  const result = {
    caseId:'quality',
    outcome:BenchmarkCaseOutcome.MEASURED,
    metrics:{ score:pass ? 1 : 0 },
    evidenceArtifactIds:[artifactId],
  };
  return {
    routeId,
    maxAgeMs,
    evaluationRequest:{
      suite:{
        schemaVersion:1,
        suiteId,
        suiteRevisionId,
        title:'Route quality benchmark ' + suffix,
        cases:[{
          caseId:'quality',
          title:'Quality threshold',
          assertions:[{
            metricId:'score',
            operator:BenchmarkAssertionOperator.AT_LEAST,
            threshold:1,
          }],
        }],
      },
      run:{
        schemaVersion:1,
        runId,
        suiteId,
        suiteRevisionId,
        subjectId:routeId,
        subjectRevisionId,
        startedAt:START,
        completedAt:END,
        results:[structuredClone(result)],
      },
      expectedSubject:{ subjectId:routeId, subjectRevisionId },
      trustedExecution:{
        runId,
        suiteId,
        suiteRevisionId,
        subjectId:routeId,
        subjectRevisionId,
        producerInvocationId:invocationId,
        startedAt:START,
        completedAt:END,
        results:[structuredClone(result)],
      },
      trustedEvidenceArtifacts:[{
        schemaVersion:1,
        artifactId,
        kind:'benchmark-evidence',
        uri:'artifact://benchmark/' + artifactId,
        mediaType:'application/json',
        sha256:(pass ? '1' : '2').repeat(64),
        sizeBytes:1,
        createdAt:END,
        producerInvocationId:invocationId,
        sensitive:false,
      }],
    },
  };
}

async function append(registry, routeValue, suffix, options = {}) {
  return putAiRouteQualityEvidenceRecordV1(registry, {
    route:routeValue,
    benchmarkRequest:await benchmarkBinding(routeValue, suffix, options),
    registeredAt:REGISTERED,
  });
}

test('empty registry is canonical append-only state', () => {
  const registry = createAiRouteQualityEvidenceRegistryV1();
  assert.deepEqual(registry, { schemaVersion:1, revision:0, records:[] });
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.records), true);
  assert.deepEqual(normalizeAiRouteQualityEvidenceRegistryV1(registry), registry);
});

test('validated benchmark append produces immutable history and latest-reader binding', async () => {
  const routeA = route('route-a');
  const registry = await append(createAiRouteQualityEvidenceRegistryV1(), routeA, 'first');
  assert.equal(registry.revision, 1);
  assert.equal(registry.records.length, 1);
  assert.equal(registry.records[0].routeId, 'route-a');
  assert.equal(registry.records[0].status, 'PASS');
  assert.equal(registry.records[0].caseCount, 1);
  assert.equal(registry.records[0].passedCaseCount, 1);
  assert.equal(registry.records[0].failedCaseCount, 0);
  assert.equal(Object.isFrozen(registry.records[0]), true);
  assert.equal(Object.isFrozen(registry.records[0].evaluationRequest), true);

  const bindings = readLatestAiRouteQualityBenchmarkRequestsV1(registry, {
    routeIds:['route-a', 'missing-route'],
  });
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].routeId, 'route-a');
  assert.equal(bindings[0].maxAgeMs, 60_000);

  const ranked = await rankAiRouteCandidatesByEvidenceV1({
    routes:[routeA, route('route-b')],
    policy:{},
    routeStates:{},
    role:'planner',
    capabilityIds:[],
    requiresVision:false,
    now:NOW,
    benchmarkRequests:bindings,
  });
  assert.equal(ranked.recommendedRouteId, 'route-a');
});

test('append is idempotent for the exact same run and rejects divergent runId collision', async () => {
  const routeA = route('route-a');
  const binding = await benchmarkBinding(routeA, 'same');
  const request = {
    route:routeA,
    benchmarkRequest:binding,
    registeredAt:REGISTERED,
  };
  const once = await putAiRouteQualityEvidenceRecordV1(createAiRouteQualityEvidenceRegistryV1(), request);
  const replay = await putAiRouteQualityEvidenceRecordV1(once, {
    ...request,
    registeredAt:'2026-09-27T12:00:10.000Z',
  });
  assert.equal(replay.revision, 1);
  assert.equal(replay.records.length, 1);
  assert.equal(replay.records[0].registeredAt, REGISTERED);

  const divergent = structuredClone(binding);
  divergent.maxAgeMs = 30_000;
  await assert.rejects(
    putAiRouteQualityEvidenceRecordV1(once, {
      route:routeA,
      benchmarkRequest:divergent,
      registeredAt:REGISTERED,
    }),
    /Divergent route-quality benchmark runId collision/u,
  );
});

test('benchmark subject revision is bound to the exact current route configuration', async () => {
  const original = route('route-a');
  const changed = route('route-a', { model:'different-model' });
  const evidence = await benchmarkBinding(original, 'revision');
  await assert.rejects(
    putAiRouteQualityEvidenceRecordV1(createAiRouteQualityEvidenceRegistryV1(), {
      route:changed,
      benchmarkRequest:evidence,
      registeredAt:REGISTERED,
    }),
    /subjectRevisionId does not match current route configuration/u,
  );
});

test('latest history record is returned and an old/current route rollback cannot resurrect mismatched quality', async () => {
  const oldRoute = route('route-a', { model:'model-old' });
  const newRoute = route('route-a', { model:'model-new' });
  let registry = await append(createAiRouteQualityEvidenceRegistryV1(), oldRoute, 'old');
  registry = await append(registry, newRoute, 'new');

  const latest = readLatestAiRouteQualityBenchmarkRequestsV1(registry, { routeIds:['route-a'] });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].evaluationRequest.run.runId, 'run-route-a-new');

  await assert.rejects(
    rankAiRouteCandidatesByEvidenceV1({
      routes:[oldRoute],
      policy:{},
      routeStates:{},
      role:'planner',
      capabilityIds:[],
      requiresVision:false,
      now:NOW,
      benchmarkRequests:latest,
    }),
    /subject revision does not match current route configuration/u,
  );
});

test('reader preserves requested route order while omitting routes without evidence', async () => {
  const routeA = route('route-a');
  const routeB = route('route-b');
  let registry = await append(createAiRouteQualityEvidenceRegistryV1(), routeA, 'a');
  registry = await append(registry, routeB, 'b');
  const result = readLatestAiRouteQualityBenchmarkRequestsV1(registry, {
    routeIds:['route-b', 'route-missing', 'route-a'],
  });
  assert.deepEqual(result.map(item => item.routeId), ['route-b', 'route-a']);
});

test('stored evaluation summary cannot be forged independently of canonical evaluator', async () => {
  const registry = await append(
    createAiRouteQualityEvidenceRegistryV1(),
    route('route-a'),
    'summary',
    { pass:false },
  );
  const tampered = structuredClone(registry);
  tampered.records[0].status = 'PASS';
  tampered.records[0].passedCaseCount = 1;
  tampered.records[0].failedCaseCount = 0;
  assert.throws(
    () => normalizeAiRouteQualityEvidenceRegistryV1(tampered),
    /does not match evaluated benchmark|counts do not match/u,
  );
});

test('durable JSON snapshot rejects signed zero, accessors, sparse arrays and exotic prototypes', async () => {
  const routeA = route('route-a');
  const baseline = await benchmarkBinding(routeA, 'hostile');

  const signedZero = structuredClone(baseline);
  signedZero.evaluationRequest.suite.cases[0].assertions[0].threshold = -0;
  await assert.rejects(
    putAiRouteQualityEvidenceRecordV1(createAiRouteQualityEvidenceRegistryV1(), {
      route:routeA,
      benchmarkRequest:signedZero,
      registeredAt:REGISTERED,
    }),
    /finite non-negative-zero JSON number representation/u,
  );

  let reads = 0;
  const accessor = structuredClone(baseline);
  Object.defineProperty(accessor.evaluationRequest.suite, 'title', {
    enumerable:true,
    get() {
      reads += 1;
      return 'must not execute';
    },
  });
  await assert.rejects(
    putAiRouteQualityEvidenceRecordV1(createAiRouteQualityEvidenceRegistryV1(), {
      route:routeA,
      benchmarkRequest:accessor,
      registeredAt:REGISTERED,
    }),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0);

  const sparse = structuredClone(baseline);
  sparse.evaluationRequest.suite.cases = new Array(1);
  await assert.rejects(
    putAiRouteQualityEvidenceRecordV1(createAiRouteQualityEvidenceRegistryV1(), {
      route:routeA,
      benchmarkRequest:sparse,
      registeredAt:REGISTERED,
    }),
    /dense and data-only|enumerable own data property/u,
  );

  const exotic = structuredClone(baseline);
  exotic.evaluationRequest.suite = Object.assign(Object.create({ inherited:true }), exotic.evaluationRequest.suite);
  await assert.rejects(
    putAiRouteQualityEvidenceRecordV1(createAiRouteQualityEvidenceRegistryV1(), {
      route:routeA,
      benchmarkRequest:exotic,
      registeredAt:REGISTERED,
    }),
    /plain JSON objects only/u,
  );
});

test('registration chronology is exact and cannot predate benchmark completion or regress', async () => {
  const routeA = route('route-a');
  const firstBinding = await benchmarkBinding(routeA, 'chrono-a');
  await assert.rejects(
    putAiRouteQualityEvidenceRecordV1(createAiRouteQualityEvidenceRegistryV1(), {
      route:routeA,
      benchmarkRequest:firstBinding,
      registeredAt:'2026-09-27T11:59:59.000Z',
    }),
    /cannot predate benchmark completion/u,
  );

  let registry = await putAiRouteQualityEvidenceRecordV1(
    createAiRouteQualityEvidenceRegistryV1(),
    { route:routeA, benchmarkRequest:firstBinding, registeredAt:REGISTERED },
  );
  const secondBinding = await benchmarkBinding(routeA, 'chrono-b');
  await assert.rejects(
    putAiRouteQualityEvidenceRecordV1(registry, {
      route:routeA,
      benchmarkRequest:secondBinding,
      registeredAt:'2026-09-27T12:00:01.500Z',
    }),
    /chronology cannot regress/u,
  );
});

test('per-route history is bounded without silent eviction', async () => {
  const routeA = route('route-a');
  let registry = createAiRouteQualityEvidenceRegistryV1();
  for (let index = 0; index < MAX_AI_ROUTE_QUALITY_RECORDS_PER_ROUTE; index += 1) {
    registry = await append(registry, routeA, 'cap-' + index);
  }
  assert.equal(registry.records.length, MAX_AI_ROUTE_QUALITY_RECORDS_PER_ROUTE);
  await assert.rejects(
    append(registry, routeA, 'cap-overflow'),
    /history limit exceeded/u,
  );
  assert.equal(registry.records[0].runId, 'run-route-a-cap-0');
});

test('global record array is bounded before record traversal', () => {
  assert.throws(
    () => normalizeAiRouteQualityEvidenceRegistryV1({
      schemaVersion:1,
      revision:MAX_AI_ROUTE_QUALITY_RECORDS + 1,
      records:new Array(MAX_AI_ROUTE_QUALITY_RECORDS + 1).fill(null),
    }),
    /invalid length/u,
  );
});

test('read boundary rejects duplicate, sparse and decorated route ID requests', async () => {
  const registry = await append(
    createAiRouteQualityEvidenceRegistryV1(),
    route('route-a'),
    'read',
  );
  assert.throws(
    () => readLatestAiRouteQualityBenchmarkRequestsV1(registry, {
      routeIds:['route-a', 'route-a'],
    }),
    /contains duplicates/u,
  );
  assert.throws(
    () => readLatestAiRouteQualityBenchmarkRequestsV1(registry, {
      routeIds:new Array(1),
    }),
    /dense and data-only|enumerable own data property/u,
  );
  const decorated = ['route-a'];
  decorated.extra = 'route-b';
  assert.throws(
    () => readLatestAiRouteQualityBenchmarkRequestsV1(registry, { routeIds:decorated }),
    /dense and data-only/u,
  );
});

test('registry normalization rejects revision, chronology and duplicate-run drift', async () => {
  const routeA = route('route-a');
  let registry = await append(createAiRouteQualityEvidenceRegistryV1(), routeA, 'one');
  registry = await append(registry, routeA, 'two');

  const revision = structuredClone(registry);
  revision.revision = 99;
  assert.throws(
    () => normalizeAiRouteQualityEvidenceRegistryV1(revision),
    /revision must equal append-only record count/u,
  );

  const chronology = structuredClone(registry);
  chronology.records[1].registeredAt = '2026-09-27T12:00:01.500Z';
  assert.throws(
    () => normalizeAiRouteQualityEvidenceRegistryV1(chronology),
    /chronology cannot regress/u,
  );

  const duplicate = structuredClone(registry);
  duplicate.records[1] = structuredClone(duplicate.records[0]);
  assert.throws(
    () => normalizeAiRouteQualityEvidenceRegistryV1(duplicate),
    /duplicate runId/u,
  );
});

test('registry authority is history-only and grants no execution or routing authority', () => {
  assert.equal(AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_AUTHORITY.appendOnlyEvidenceHistory, true);
  for (const key of [
    'benchmarkExecutionAuthorized',
    'artifactStoreAuthorized',
    'routeSelectionAuthorized',
    'dispatchAuthorized',
    'providerAuthorized',
    'policyAuthorized',
    'budgetAuthorized',
    'schedulerAuthorized',
    'recoveryAuthorized',
  ]) {
    assert.equal(AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_AUTHORITY[key], false, key);
  }
  assert.equal(Object.isFrozen(AI_ROUTE_QUALITY_EVIDENCE_REGISTRY_AUTHORITY), true);
});
