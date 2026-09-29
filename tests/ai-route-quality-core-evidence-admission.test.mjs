import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_ROUTE_QUALITY_CORE_EVIDENCE_ADMISSION_AUTHORITY,
  createAiRouteQualityCoreEvidenceAdmissionV1,
} from '../src/core/ai-route-quality-core-evidence-admission.js';
import { deriveAiRouteQualitySubjectRevisionIdV1 } from '../src/core/ai-route-quality-governor.js';
import {
  BenchmarkAssertionOperator,
  BenchmarkCaseOutcome,
} from '../src/core/benchmark-evaluation.js';
import { createEmptyState, STORAGE_KEY } from '../src/core/schema.js';
import { StorageRepository } from '../src/core/storage.js';

const START = '2026-09-27T12:00:00.000Z';
const END = '2026-09-27T12:00:01.000Z';

function route(routeId = 'route-a', overrides = {}) {
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

function memoryChrome() {
  const values = Object.create(null);
  return {
    storage: {
      local: {
        async get(key) {
          return Object.hasOwn(values, key)
            ? { [key]: structuredClone(values[key]) }
            : {};
        },
        async set(record) {
          for (const [key, value] of Object.entries(record)) {
            values[key] = structuredClone(value);
          }
        },
      },
    },
  };
}

async function repositoryWithRoute(routeValue = route()) {
  const repo = new StorageRepository(memoryChrome());
  const state = createEmptyState(Date.parse('2026-09-27T11:00:00.000Z'));
  state.profile.aiRouter.routes = [structuredClone(routeValue)];
  await repo.save(state);
  return repo;
}

async function trustedBinding(routeValue, suffix = 'a', { pass = true, maxAgeMs = 60_000 } = {}) {
  const routeId = routeValue.routeId;
  const suiteId = 'route-quality-' + suffix;
  const suiteRevisionId = 'suite-' + suffix;
  const runId = 'run-' + routeId + '-' + suffix;
  const subjectRevisionId = await deriveAiRouteQualitySubjectRevisionIdV1(routeValue);
  const producerInvocationId = 'benchmark-' + routeId + '-' + suffix;
  const artifactId = 'evidence-' + routeId + '-' + suffix;
  const result = {
    caseId: 'quality',
    outcome: BenchmarkCaseOutcome.MEASURED,
    metrics: { score: pass ? 1 : 0 },
    evidenceArtifactIds: [artifactId],
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
      run: {
        schemaVersion: 1,
        runId,
        suiteId,
        suiteRevisionId,
        subjectId: routeId,
        subjectRevisionId,
        startedAt: START,
        completedAt: END,
        results: [structuredClone(result)],
      },
      expectedSubject: { subjectId: routeId, subjectRevisionId },
      trustedExecution: {
        runId,
        suiteId,
        suiteRevisionId,
        subjectId: routeId,
        subjectRevisionId,
        producerInvocationId,
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
        producerInvocationId,
        sensitive: false,
      }],
    },
  };
}

test('owner-resolved benchmark evidence is revalidated against current route and persisted through Core repository', async () => {
  const routeValue = route();
  const repo = await repositoryWithRoute(routeValue);
  const binding = await trustedBinding(routeValue);
  const calls = [];
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async request => {
      calls.push(request);
      return structuredClone(binding);
    },
  });

  const receipt = await admit({ routeId: 'route-a', runId: 'run-route-a-a' });
  assert.deepEqual(calls, [{ routeId: 'route-a', runId: 'run-route-a-a' }]);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(receipt.routeId, 'route-a');
  assert.equal(receipt.runId, 'run-route-a-a');
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.registryRevision, 1);
  assert.equal(receipt.coreStateRevision, 1);
  assert.equal(Object.isFrozen(receipt), true);

  const saved = await repo.load();
  assert.equal(saved.profile.aiRouteQualityEvidenceRegistry.revision, 1);
  assert.equal(saved.profile.aiRouteQualityEvidenceRegistry.records.length, 1);
  assert.equal(saved.profile.aiRouteQualityEvidenceRegistry.records[0].runId, 'run-route-a-a');
});

test('caller can name only routeId and runId, never trusted execution, evidence, maxAge or registration time', async () => {
  const routeValue = route();
  const repo = await repositoryWithRoute(routeValue);
  const binding = await trustedBinding(routeValue);
  let resolverCalls = 0;
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => {
      resolverCalls += 1;
      return structuredClone(binding);
    },
  });

  for (const extra of [
    { evaluationRequest: binding.evaluationRequest },
    { trustedExecution: binding.evaluationRequest.trustedExecution },
    { trustedEvidenceArtifacts: binding.evaluationRequest.trustedEvidenceArtifacts },
    { maxAgeMs: 1 },
    { registeredAt: END },
  ]) {
    await assert.rejects(
      admit({ routeId: 'route-a', runId: 'run-route-a-a', ...extra }),
      /contains unknown field/u,
    );
  }
  assert.equal(resolverCalls, 0);
  assert.equal((await repo.load()).profile.aiRouteQualityEvidenceRegistry.revision, 0);
});

test('caller accessors fail before execution and getter code is never evaluated', async () => {
  const repo = await repositoryWithRoute();
  let resolverCalls = 0;
  let reads = 0;
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => {
      resolverCalls += 1;
      return null;
    },
  });
  const hostile = { runId: 'run-route-a-a' };
  Object.defineProperty(hostile, 'routeId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'route-a';
    },
  });

  await assert.rejects(admit(hostile), /must be an enumerable own data property/u);
  assert.equal(reads, 0);
  assert.equal(resolverCalls, 0);
});

test('trusted resolver output is descriptor-safe and cannot smuggle accessor code into admission', async () => {
  const repo = await repositoryWithRoute();
  let reads = 0;
  const hostile = {
    maxAgeMs: 60_000,
    evaluationRequest: {},
  };
  Object.defineProperty(hostile, 'routeId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'route-a';
    },
  });
  const before = await repo.load();
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => hostile,
  });

  await assert.rejects(
    admit({ routeId: 'route-a', runId: 'run-route-a-a' }),
    /must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);
  assert.deepEqual(await repo.load(), before);
});

test('trusted resolver must bind exact requested route and run identities before Core mutation', async () => {
  const routeValue = route();
  for (const [name, mutate, pattern] of [
    ['route', value => { value.routeId = 'route-other'; }, /routeId mismatch/u],
    [
      'run',
      value => {
        value.evaluationRequest.run.runId = 'run-other';
        value.evaluationRequest.trustedExecution.runId = 'run-other';
      },
      /runId mismatch/u,
    ],
  ]) {
    const repo = await repositoryWithRoute(routeValue);
    const binding = structuredClone(await trustedBinding(routeValue));
    mutate(binding);
    const before = await repo.load();
    const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
      repository: repo,
      resolveTrustedBenchmarkRequest: async () => binding,
    });
    await assert.rejects(
      admit({ routeId: 'route-a', runId: 'run-route-a-a' }),
      pattern,
      name,
    );
    assert.deepEqual(await repo.load(), before, name);
  }
});

test('current canonical route revision is re-read at serialized mutation time', async () => {
  const oldRoute = route('route-a', { model: 'model-old' });
  const currentRoute = route('route-a', { model: 'model-current' });
  const binding = await trustedBinding(oldRoute, 'stale');
  const repo = await repositoryWithRoute(currentRoute);
  const before = await repo.load();
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => structuredClone(binding),
  });

  await assert.rejects(
    admit({ routeId: 'route-a', runId: 'run-route-a-stale' }),
    /subjectRevisionId does not match current route configuration/u,
  );
  assert.deepEqual(await repo.load(), before);
});

test('removed route cannot receive evidence even when the trusted benchmark binding itself is valid', async () => {
  const removedRoute = route('route-a');
  const binding = await trustedBinding(removedRoute, 'removed');
  const repo = await repositoryWithRoute(route('route-b'));
  const before = await repo.load();
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => structuredClone(binding),
  });

  await assert.rejects(
    admit({ routeId: 'route-a', runId: 'run-route-a-removed' }),
    /Current canonical AI route does not exist/u,
  );
  assert.deepEqual(await repo.load(), before);
});

test('corrupt advisory history fails closed for writes and is never silently repaired or replaced', async () => {
  const routeValue = route();
  const binding = await trustedBinding(routeValue, 'corrupt');
  const repo = await repositoryWithRoute(routeValue);
  const corrupt = await repo.load();
  corrupt.profile.aiRouteQualityEvidenceRegistry = {
    schemaVersion: 1,
    revision: 1,
    records: [],
  };
  await repo.save(corrupt);
  const before = await repo.load();
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => structuredClone(binding),
  });

  await assert.rejects(
    admit({ routeId: 'route-a', runId: 'run-route-a-corrupt' }),
    /revision must equal append-only record count/u,
  );
  assert.deepEqual(await repo.load(), before);
});

test('trusted resolver failure performs no canonical Core update', async () => {
  const repo = await repositoryWithRoute();
  const before = await repo.load();
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => {
      throw new Error('trusted execution evidence unavailable');
    },
  });

  await assert.rejects(
    admit({ routeId: 'route-a', runId: 'run-route-a-a' }),
    /trusted execution evidence unavailable/u,
  );
  assert.deepEqual(await repo.load(), before);
});

test('exact replay is registry-idempotent and does not duplicate trusted benchmark history', async () => {
  const routeValue = route();
  const binding = await trustedBinding(routeValue, 'replay');
  const repo = await repositoryWithRoute(routeValue);
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => structuredClone(binding),
  });

  const first = await admit({ routeId: 'route-a', runId: 'run-route-a-replay' });
  const second = await admit({ routeId: 'route-a', runId: 'run-route-a-replay' });
  assert.equal(first.registryRevision, 1);
  assert.equal(second.registryRevision, 1);
  const saved = await repo.load();
  assert.equal(saved.profile.aiRouteQualityEvidenceRegistry.revision, 1);
  assert.equal(saved.profile.aiRouteQualityEvidenceRegistry.records.length, 1);
});

test('trusted resolver bytes are snapshotted before waiting behind the serialized Core update queue', async () => {
  const routeValue = route();
  const binding = await trustedBinding(routeValue, 'snapshot');
  const backing = await repositoryWithRoute(routeValue);
  const repository = {
    async update(mutator) {
      binding.evaluationRequest.run.results[0].metrics.score = 0;
      binding.evaluationRequest.trustedExecution.results[0].metrics.score = 0;
      return backing.update(mutator);
    },
  };
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository,
    resolveTrustedBenchmarkRequest: async () => binding,
  });

  const receipt = await admit({ routeId: 'route-a', runId: 'run-route-a-snapshot' });
  assert.equal(receipt.status, 'PASS');
  const saved = await backing.load();
  assert.equal(saved.profile.aiRouteQualityEvidenceRegistry.records[0].status, 'PASS');
  assert.equal(
    saved.profile.aiRouteQualityEvidenceRegistry.records[0]
      .evaluationRequest.run.results[0].metrics.score,
    1,
  );
});

test('concurrent trusted admissions reuse the canonical StorageRepository serialization queue', async () => {
  const routeValue = route();
  const repo = await repositoryWithRoute(routeValue);
  const bindings = new Map([
    ['run-route-a-one', await trustedBinding(routeValue, 'one')],
    ['run-route-a-two', await trustedBinding(routeValue, 'two')],
  ]);
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async ({ runId }) => structuredClone(bindings.get(runId)),
  });

  const receipts = await Promise.all([
    admit({ routeId: 'route-a', runId: 'run-route-a-one' }),
    admit({ routeId: 'route-a', runId: 'run-route-a-two' }),
  ]);
  assert.deepEqual(
    receipts.map(item => item.runId).sort(),
    ['run-route-a-one', 'run-route-a-two'],
  );
  const saved = await repo.load();
  assert.equal(saved.profile.aiRouteQualityEvidenceRegistry.revision, 2);
  assert.deepEqual(
    saved.profile.aiRouteQualityEvidenceRegistry.records.map(item => item.runId).sort(),
    ['run-route-a-one', 'run-route-a-two'],
  );
});

test('authority is explicit: one canonical append mutation, zero benchmark execution/router/provider/policy power', async () => {
  const repo = await repositoryWithRoute();
  const binding = await trustedBinding(route());
  const admit = createAiRouteQualityCoreEvidenceAdmissionV1({
    repository: repo,
    resolveTrustedBenchmarkRequest: async () => binding,
  });

  assert.equal(admit.authority, AI_ROUTE_QUALITY_CORE_EVIDENCE_ADMISSION_AUTHORITY);
  assert.equal(admit.authority.canonicalCoreStateMutationAuthorized, true);
  assert.equal(admit.authority.evidenceAppendAuthorized, true);
  assert.equal(admit.authority.trustedBenchmarkEvidenceResolveAuthorized, true);
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
    assert.equal(admit.authority[key], false, key);
  }
  assert.equal(Object.isFrozen(admit.authority), true);
});
