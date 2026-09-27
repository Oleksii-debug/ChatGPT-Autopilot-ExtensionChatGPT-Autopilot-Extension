import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_ROUTE_QUALITY_EVIDENCE_RESOLVER_AUTHORITY,
  createAiRouteQualityEvidenceResolverV1,
  normalizeAiRouteQualityEvidenceLookupV1,
} from '../src/core/ai-route-quality-evidence-resolver.js';

function binding(routeId, suffix = routeId) {
  return {
    routeId,
    evaluationRequest:{ trusted:'opaque-' + suffix },
    maxAgeMs:60_000,
  };
}

test('lookup normalization is exact, bounded, immutable and portable', () => {
  const lookup = normalizeAiRouteQualityEvidenceLookupV1({
    routeIds:['route-a', 'route-b'],
    role:'planner',
    requiresVision:false,
  });
  assert.deepEqual(lookup, {
    routeIds:['route-a', 'route-b'],
    role:'planner',
    requiresVision:false,
  });
  assert.equal(Object.isFrozen(lookup), true);
  assert.equal(Object.isFrozen(lookup.routeIds), true);

  const nullProto = Object.create(null);
  nullProto.routeIds = ['route-a'];
  nullProto.role = 'verifier';
  nullProto.requiresVision = true;
  assert.equal(normalizeAiRouteQualityEvidenceLookupV1(nullProto).role, 'verifier');

  assert.throws(
    () => normalizeAiRouteQualityEvidenceLookupV1({
      routeIds:['route-a'],
      role:'planner',
      requiresVision:false,
      policy:{},
    }),
    /unknown field/u,
  );
  assert.throws(
    () => normalizeAiRouteQualityEvidenceLookupV1({
      routeIds:['route-a', 'route-a'],
      role:'planner',
      requiresVision:false,
    }),
    /duplicates/u,
  );
});

test('resolver gives the reader only immutable route IDs and returns requested evidence', async () => {
  let readerRequest = null;
  const resolver = createAiRouteQualityEvidenceResolverV1({
    readBenchmarkRequests:async request => {
      readerRequest = request;
      return [binding('route-b'), binding('route-a')];
    },
  });

  const result = await resolver({
    routeIds:['route-a', 'route-b'],
    role:'planner',
    requiresVision:false,
  });

  assert.deepEqual(Object.keys(readerRequest), ['routeIds']);
  assert.deepEqual(readerRequest.routeIds, ['route-a', 'route-b']);
  assert.equal(Object.isFrozen(readerRequest), true);
  assert.equal(Object.isFrozen(readerRequest.routeIds), true);
  assert.deepEqual(result.map(item => item.routeId), ['route-b', 'route-a']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
});

test('missing benchmark evidence is valid and does not invent records', async () => {
  const resolver = createAiRouteQualityEvidenceResolverV1({
    readBenchmarkRequests:async () => [],
  });
  assert.deepEqual(
    await resolver({ routeIds:['route-a'], role:'planner', requiresVision:false }),
    [],
  );
});

test('reader cannot widen route scope or duplicate evidence identities', async () => {
  const extra = createAiRouteQualityEvidenceResolverV1({
    readBenchmarkRequests:async () => [binding('route-b')],
  });
  await assert.rejects(
    extra({ routeIds:['route-a'], role:'planner', requiresVision:false }),
    /unrequested routeId: route-b/u,
  );

  const duplicate = createAiRouteQualityEvidenceResolverV1({
    readBenchmarkRequests:async () => [binding('route-a', 'one'), binding('route-a', 'two')],
  });
  await assert.rejects(
    duplicate({ routeIds:['route-a'], role:'planner', requiresVision:false }),
    /duplicate routeId: route-a/u,
  );
});

test('lookup and reader-result accessors fail closed without getter execution', async () => {
  let reads = 0;
  const lookup = {
    role:'planner',
    requiresVision:false,
  };
  Object.defineProperty(lookup, 'routeIds', {
    enumerable:true,
    get() {
      reads += 1;
      return ['route-a'];
    },
  });
  assert.throws(
    () => normalizeAiRouteQualityEvidenceLookupV1(lookup),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0);

  const hostileBinding = {
    evaluationRequest:{},
    maxAgeMs:1000,
  };
  Object.defineProperty(hostileBinding, 'routeId', {
    enumerable:true,
    get() {
      reads += 1;
      return 'route-a';
    },
  });
  const resolver = createAiRouteQualityEvidenceResolverV1({
    readBenchmarkRequests:async () => [hostileBinding],
  });
  await assert.rejects(
    resolver({ routeIds:['route-a'], role:'planner', requiresVision:false }),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0);
});

test('sparse and decorated arrays fail closed at both authority boundaries', async () => {
  const sparseLookup = new Array(1);
  assert.throws(
    () => normalizeAiRouteQualityEvidenceLookupV1({
      routeIds:sparseLookup,
      role:'planner',
      requiresVision:false,
    }),
    /enumerable own data property|dense/u,
  );

  const decorated = [binding('route-a')];
  decorated.extra = binding('route-a');
  const resolver = createAiRouteQualityEvidenceResolverV1({
    readBenchmarkRequests:async () => decorated,
  });
  await assert.rejects(
    resolver({ routeIds:['route-a'], role:'planner', requiresVision:false }),
    /dense and data-only/u,
  );
});

test('factory dependency boundary rejects accessors without executing them', () => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'readBenchmarkRequests', {
    enumerable:true,
    get() {
      reads += 1;
      return async () => [];
    },
  });
  assert.throws(
    () => createAiRouteQualityEvidenceResolverV1(options),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0);
  assert.throws(
    () => createAiRouteQualityEvidenceResolverV1({ readBenchmarkRequests:{} }),
    /must be a function/u,
  );
});

test('reader failure propagates so the canonical Router can apply its advisory fallback', async () => {
  const resolver = createAiRouteQualityEvidenceResolverV1({
    readBenchmarkRequests:async () => {
      throw new Error('benchmark reader unavailable');
    },
  });
  await assert.rejects(
    resolver({ routeIds:['route-a'], role:'planner', requiresVision:false }),
    /benchmark reader unavailable/u,
  );
});

test('resolver exposes an explicit read-only zero-execution authority projection', () => {
  const resolver = createAiRouteQualityEvidenceResolverV1({
    readBenchmarkRequests:async () => [],
  });
  assert.equal(resolver.authority, AI_ROUTE_QUALITY_EVIDENCE_RESOLVER_AUTHORITY);
  assert.equal(resolver.authority.readOnly, true);
  assert.equal(resolver.authority.evidenceLookupAuthorized, true);
  for (const key of [
    'benchmarkExecutionAuthorized',
    'qualityStoreAuthorized',
    'routeSelectionAuthorized',
    'dispatchAuthorized',
    'policyAuthorized',
    'providerAuthorized',
    'budgetAuthorized',
    'schedulerAuthorized',
    'recoveryAuthorized',
  ]) {
    assert.equal(resolver.authority[key], false, key);
  }
  assert.equal(Object.isFrozen(resolver), true);
  assert.equal(Object.isFrozen(resolver.authority), true);
});
