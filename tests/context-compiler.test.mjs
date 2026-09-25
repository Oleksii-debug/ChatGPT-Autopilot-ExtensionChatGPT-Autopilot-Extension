import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileDeltaContextPlanV1,
  ContextFragmentFreshness,
} from '../src/core/context-compiler.js';
import { createSha256FingerprintV1 } from '../src/core/fingerprint.js';

const T1 = '2026-09-25T00:00:01.000Z';
const T2 = '2026-09-25T00:00:02.000Z';
const T3 = '2026-09-25T00:00:03.000Z';
const T4 = '2026-09-25T00:00:04.000Z';

function source({
  sourceId,
  revisionId = 'r1',
  sha = 'a'.repeat(64),
  authority = 'CANONICAL',
  observedAt = T1,
} = {}) {
  return {
    schemaVersion: 1,
    sourceId,
    projectId: 'project-a',
    kind: 'document',
    uri: `private://root/${sourceId}`,
    revisionId,
    contentSha256: sha,
    observedAt,
    authority,
    metadata: {},
  };
}

function snapshot(sourceRefs, { revisionId = 'project-r2', createdAt = T2 } = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId,
    title: 'Project A',
    sourceRefs,
    artifactRefs: [],
    createdAt,
  };
}

function capsule(sourceBindings, { capsuleId = 'capsule-r1', projectRevisionId = 'project-r1' } = {}) {
  return {
    schemaVersion: 1,
    capsuleId,
    projectId: 'project-a',
    projectRevisionId,
    summary: 'Prior bounded project capsule',
    sourceBindings,
    artifactRefs: [],
    createdAt: T2,
  };
}

async function fragment({
  fragmentId,
  sourceBindings,
  dependencyFragmentIds = [],
  summary = `summary:${fragmentId}`,
  createdAt = T3,
} = {}) {
  return {
    fragmentId,
    sourceBindings,
    dependencyFragmentIds,
    summary,
    summarySha256: await createSha256FingerprintV1(summary),
    createdAt,
  };
}

function binding({ sourceId, revisionId = 'r1', sha = 'a'.repeat(64), authority = 'CANONICAL' }) {
  return { sourceId, revisionId, contentSha256: sha, authority };
}

function priorBinding({ sourceId, revisionId = 'r1', sha = 'a'.repeat(64) }) {
  return { sourceId, revisionId, contentSha256: sha };
}

async function request({ projectSnapshot, priorCapsule = null, fragments = [], compiledAt = T4 } = {}) {
  return {
    schemaVersion: 1,
    compilerId: 'context-compiler-main',
    projectSnapshot,
    priorCapsule,
    fragments,
    compiledAt,
  };
}

test('compiler reuses exact fragments and emits bounded source delta without raw URIs', async () => {
  const current = snapshot([
    source({ sourceId: 'stable' }),
    source({ sourceId: 'changed', revisionId: 'r2', sha: 'b'.repeat(64) }),
    source({ sourceId: 'added', sha: 'c'.repeat(64) }),
  ]);
  const prior = capsule([
    priorBinding({ sourceId: 'stable' }),
    priorBinding({ sourceId: 'changed' }),
    priorBinding({ sourceId: 'removed', sha: 'd'.repeat(64) }),
  ]);
  const fragments = [
    await fragment({
      fragmentId: 'stable-summary',
      sourceBindings: [binding({ sourceId: 'stable' })],
      summary: 'cached stable summary',
    }),
    await fragment({
      fragmentId: 'old-summary',
      sourceBindings: [binding({ sourceId: 'changed' })],
      summary: 'cached old summary',
    }),
    await fragment({
      fragmentId: 'dependent-summary',
      sourceBindings: [binding({ sourceId: 'stable' })],
      dependencyFragmentIds: ['old-summary'],
      summary: 'depends on old summary',
    }),
    await fragment({
      fragmentId: 'new-summary',
      sourceBindings: [binding({ sourceId: 'added', sha: 'c'.repeat(64) })],
      summary: 'cached added-source summary',
    }),
  ];

  const plan = await compileDeltaContextPlanV1(await request({
    projectSnapshot: current,
    priorCapsule: prior,
    fragments,
  }));

  assert.deepEqual(plan.delta.addedSourceIds, ['added']);
  assert.deepEqual(plan.delta.changedSourceIds, ['changed']);
  assert.deepEqual(plan.delta.removedSourceIds, ['removed']);
  assert.deepEqual(plan.delta.refreshSourceIds, ['added', 'changed']);
  assert.deepEqual(
    plan.reusableFragments.map(item => item.fragmentId),
    ['new-summary', 'stable-summary'],
  );
  const old = plan.staleFragments.find(item => item.fragmentId === 'old-summary');
  assert.equal(old.freshness, ContextFragmentFreshness.STALE_SOURCE);
  assert.deepEqual(old.staleSourceIds, ['changed']);
  const dependent = plan.staleFragments.find(item => item.fragmentId === 'dependent-summary');
  assert.equal(dependent.freshness, ContextFragmentFreshness.STALE_DEPENDENCY);
  assert.deepEqual(dependent.staleDependencyFragmentIds, ['old-summary']);
  assert.equal(plan.metrics.reusableFragmentCount, 2);
  assert.equal(plan.advisoryOnly, true);
  assert.equal(plan.executionAuthorized, false);
  assert.equal(plan.mutationAuthorized, false);
  assert.equal(plan.requiresCanonicalSourceResolution, true);

  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes('private://root/'), false);
  assert.match(plan.reusableFragments[0].summarySha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(plan.reusableFragments[0].fragmentFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(plan.reusableFragments[0].retrievalPointers[0].requiresCanonicalResolution, true);
});

test('authority, revision, sha and observation chronology prevent stale fragment reuse', async () => {
  const current = snapshot([
    source({ sourceId: 'authority', authority: 'CANONICAL' }),
    source({ sourceId: 'revision', revisionId: 'r2' }),
    source({ sourceId: 'digest', sha: 'b'.repeat(64) }),
    source({ sourceId: 'later', observedAt: T3 }),
  ]);
  const fragments = [
    await fragment({
      fragmentId: 'authority-fragment',
      sourceBindings: [binding({ sourceId: 'authority', authority: 'ADVISORY' })],
    }),
    await fragment({
      fragmentId: 'revision-fragment',
      sourceBindings: [binding({ sourceId: 'revision', revisionId: 'r1' })],
    }),
    await fragment({
      fragmentId: 'digest-fragment',
      sourceBindings: [binding({ sourceId: 'digest', sha: 'a'.repeat(64) })],
    }),
    await fragment({
      fragmentId: 'too-early-fragment',
      sourceBindings: [binding({ sourceId: 'later' })],
      createdAt: T2,
    }),
  ];

  const plan = await compileDeltaContextPlanV1(await request({
    projectSnapshot: current,
    fragments,
  }));

  assert.equal(plan.reusableFragments.length, 0);
  assert.deepEqual(
    plan.staleFragments.map(item => item.fragmentId),
    ['authority-fragment', 'digest-fragment', 'revision-fragment', 'too-early-fragment'],
  );
  for (const item of plan.staleFragments) {
    assert.equal(item.freshness, ContextFragmentFreshness.STALE_SOURCE);
    assert.equal(item.contextReuseEligible, false);
  }
});

test('fragment dependency graph rejects dangling dependencies and cycles', async () => {
  const current = snapshot([source({ sourceId: 'stable' })]);
  const a = await fragment({
    fragmentId: 'a',
    sourceBindings: [binding({ sourceId: 'stable' })],
    dependencyFragmentIds: ['b'],
  });
  const b = await fragment({
    fragmentId: 'b',
    sourceBindings: [binding({ sourceId: 'stable' })],
    dependencyFragmentIds: ['a'],
  });
  await assert.rejects(
    compileDeltaContextPlanV1(await request({ projectSnapshot: current, fragments: [a, b] })),
    /dependency graph contains a cycle/,
  );

  const dangling = await fragment({
    fragmentId: 'dangling',
    sourceBindings: [binding({ sourceId: 'stable' })],
    dependencyFragmentIds: ['missing'],
  });
  await assert.rejects(
    compileDeltaContextPlanV1(await request({ projectSnapshot: current, fragments: [dangling] })),
    /dangling dependency/,
  );
});

test('cached summary bytes are cryptographically bound before reuse', async () => {
  const current = snapshot([source({ sourceId: 'stable' })]);
  const valid = await fragment({
    fragmentId: 'stable-summary',
    sourceBindings: [binding({ sourceId: 'stable' })],
    summary: 'verified cached summary',
  });
  const forged = { ...valid, summary: 'different bytes' };
  await assert.rejects(
    compileDeltaContextPlanV1(await request({ projectSnapshot: current, fragments: [forged] })),
    /summary hash mismatch/,
  );
});

test('public records and arrays are consumed through descriptors without ordinary getter reads', async () => {
  let ordinaryGets = 0;
  const trap = {
    get() {
      ordinaryGets += 1;
      throw new Error('ordinary get must not execute');
    },
  };
  const sourceBindings = new Proxy(
    [binding({ sourceId: 'stable' })],
    trap,
  );
  const dependencies = new Proxy([], trap);
  const item = await fragment({
    fragmentId: 'stable-summary',
    sourceBindings: [binding({ sourceId: 'stable' })],
  });
  item.sourceBindings = sourceBindings;
  item.dependencyFragmentIds = dependencies;

  const fragments = new Proxy([item], trap);
  const rawRequest = await request({
    projectSnapshot: snapshot([source({ sourceId: 'stable' })]),
    fragments,
  });
  const requestProxy = new Proxy(rawRequest, trap);

  const plan = await compileDeltaContextPlanV1(requestProxy);
  assert.equal(ordinaryGets, 0);
  assert.deepEqual(plan.reusableFragments.map(entry => entry.fragmentId), ['stable-summary']);
});

test('noncanonical time, summary hash representation and project mismatch fail closed', async () => {
  const current = snapshot([source({ sourceId: 'stable' })]);
  const good = await fragment({
    fragmentId: 'stable-summary',
    sourceBindings: [binding({ sourceId: 'stable' })],
  });

  await assert.rejects(
    compileDeltaContextPlanV1(await request({
      projectSnapshot: current,
      fragments: [{ ...good, createdAt: '2026-09-25T00:00:03Z' }],
    })),
    /canonical ISO-8601 UTC/,
  );

  await assert.rejects(
    compileDeltaContextPlanV1(await request({
      projectSnapshot: current,
      fragments: [{ ...good, summarySha256: good.summarySha256.toUpperCase() }],
    })),
    /summarySha256 is invalid/,
  );

  const wrongProjectCapsule = {
    ...capsule([priorBinding({ sourceId: 'stable' })]),
    projectId: 'project-other',
  };
  await assert.rejects(
    compileDeltaContextPlanV1(await request({
      projectSnapshot: current,
      priorCapsule: wrongProjectCapsule,
      fragments: [good],
    })),
    /priorCapsule projectId mismatch/,
  );
});

test('acyclic multi-level fragments remain reusable in dependency order independent of input order', async () => {
  const current = snapshot([source({ sourceId: 'stable' })]);
  const leaf = await fragment({
    fragmentId: 'leaf',
    sourceBindings: [binding({ sourceId: 'stable' })],
  });
  const middle = await fragment({
    fragmentId: 'middle',
    sourceBindings: [binding({ sourceId: 'stable' })],
    dependencyFragmentIds: ['leaf'],
  });
  const root = await fragment({
    fragmentId: 'root',
    sourceBindings: [binding({ sourceId: 'stable' })],
    dependencyFragmentIds: ['middle'],
  });
  const plan = await compileDeltaContextPlanV1(await request({
    projectSnapshot: current,
    fragments: [root, leaf, middle],
  }));
  assert.deepEqual(
    plan.reusableFragments.map(item => item.fragmentId),
    ['leaf', 'middle', 'root'],
  );
  assert.equal(plan.staleFragments.length, 0);
});


test('public compiler hashing authority is runtime-owned and ignores caller digest injection', async () => {
  const current = snapshot([source({ sourceId: 'stable' })]);
  const valid = await fragment({
    fragmentId: 'stable-summary-runtime-hash',
    sourceBindings: [binding({ sourceId: 'stable' })],
    summary: 'trusted cached summary bytes',
  });
  const forged = {
    ...valid,
    summary: 'tampered cached summary bytes',
    summarySha256: `sha256:${'0'.repeat(64)}`,
  };

  let optionReads = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'cryptoApi', {
    enumerable: true,
    get() {
      optionReads += 1;
      throw new Error('caller crypto getter must not execute');
    },
  });

  await assert.rejects(
    compileDeltaContextPlanV1(
      await request({ projectSnapshot: current, fragments: [forged] }),
      accessorOptions,
    ),
    /summary hash mismatch/,
  );
  assert.equal(optionReads, 0);

  let fakeDigests = 0;
  const fakeDigestOptions = {
    cryptoApi: {
      subtle: {
        async digest() {
          fakeDigests += 1;
          return new Uint8Array(32);
        },
      },
    },
  };

  await assert.rejects(
    compileDeltaContextPlanV1(
      await request({ projectSnapshot: current, fragments: [forged] }),
      fakeDigestOptions,
    ),
    /summary hash mismatch/,
  );
  assert.equal(fakeDigests, 0);
});
