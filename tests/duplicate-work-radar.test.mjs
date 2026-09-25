import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkIntentMode,
  WorkOverlapClassification,
  analyzeDuplicateWorkV1,
  normalizeDuplicateWorkRadarPolicyV1,
  normalizeWorkIntentV1,
} from '../src/core/duplicate-work-radar.js';

function policy(overrides = {}) {
  return {
    schemaVersion:1,
    policyId:'radar.default',
    highOverlapBasisPoints:6500,
    minHighOverlapDimensions:2,
    weights:{
      conflictKeys:1000,
      subsystems:800,
      files:1000,
      resources:800,
      outcomes:700,
      dependencies:300,
      acceptanceCriteria:600,
      semanticTags:700,
      sideEffects:400,
    },
    ...overrides,
  };
}

function work(workId, workerId, overrides = {}) {
  return {
    schemaVersion:1,
    workId,
    workerId,
    lifecycle:'ACTIVE',
    mode:'MUTATION',
    conflictKeys:[],
    subsystemIds:[],
    filePaths:[],
    resourceIds:[],
    outcomeTags:[],
    dependencyIds:[],
    acceptanceCriterionIds:[],
    semanticTags:[],
    sideEffectTags:[],
    variantGroupId:'',
    variantId:'',
    ...overrides,
  };
}

test('renamed mutation tasks with the same conflict key and semantic scope are a hard conflict', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:[
      work('task.alpha', 'worker.a', {
        conflictKeys:['canonical.scheduler'],
        subsystemIds:['scheduler'],
        filePaths:['src/core/scheduler.js'],
        outcomeTags:['durable.recurrence'],
        acceptanceCriterionIds:['restart.safe'],
        semanticTags:['dst.contract'],
        sideEffectTags:['schedule.effect'],
      }),
      work('completely.different.name', 'worker.b', {
        conflictKeys:['canonical.scheduler'],
        subsystemIds:['scheduler'],
        filePaths:['src/core/scheduler.js'],
        outcomeTags:['durable.recurrence'],
        acceptanceCriterionIds:['restart.safe'],
        semanticTags:['dst.contract'],
        sideEffectTags:['schedule.effect'],
      }),
    ],
  });
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].classification, WorkOverlapClassification.HARD_CONFLICT);
  assert.equal(result.pairs[0].recommendedDisposition, 'MERGE_OR_NARROW');
  assert.equal(result.pairs[0].decisionAuthorized, false);
  assert.equal(result.metrics.hardConflictPairCount, 1);
  assert.equal(result.metrics.conflictingWorkerRateBasisPoints, 10_000);
});

test('high semantic overlap without a shared conflict key is still detected', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy({ highOverlapBasisPoints:6000 }),
    workItems:[
      work('a', 'worker.a', {
        subsystemIds:['provider.github'],
        filePaths:['src/core/github-agent-provider.js'],
        outcomeTags:['github.read'],
        acceptanceCriterionIds:['exact.identity'],
        semanticTags:['provider.boundary'],
      }),
      work('b', 'worker.b', {
        subsystemIds:['provider.github'],
        filePaths:['src/core/github-agent-provider.js'],
        outcomeTags:['github.read'],
        acceptanceCriterionIds:['exact.identity'],
        semanticTags:['provider.boundary'],
      }),
    ],
  });
  assert.equal(result.pairs[0].classification, WorkOverlapClassification.HIGH_OVERLAP);
  assert.equal(result.pairs[0].recommendedDisposition, 'MERGE_OR_REDIRECT_REVIEW');
});

test('disjoint work produces no overlap pair and zero conflicting worker rate', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:[
      work('scheduler', 'worker.a', {
        subsystemIds:['scheduler'],
        filePaths:['src/core/scheduler.js'],
        semanticTags:['dst'],
      }),
      work('docs', 'worker.b', {
        subsystemIds:['docs'],
        filePaths:['docs/README.md'],
        semanticTags:['copy.edit'],
      }),
    ],
  });
  assert.deepEqual(result.pairs, []);
  assert.equal(result.comparedPairCount, 1);
  assert.equal(result.metrics.conflictingWorkerRateBasisPoints, 0);
});

test('a mutation plus an explicit review of the same scope is complementary rather than duplicate mutation', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:[
      work('mutate', 'worker.a', {
        conflictKeys:['policy.engine'],
        subsystemIds:['policy'],
        filePaths:['src/core/policy-engine.js'],
        semanticTags:['array.boundary'],
      }),
      work('review', 'worker.b', {
        mode:WorkIntentMode.REVIEW,
        conflictKeys:['policy.engine'],
        subsystemIds:['policy'],
        filePaths:['src/core/policy-engine.js'],
        semanticTags:['array.boundary'],
      }),
    ],
  });
  assert.equal(result.pairs[0].classification, WorkOverlapClassification.COMPLEMENTARY_REVIEW);
  assert.equal(result.pairs[0].recommendedDisposition, 'KEEP_REVIEW');
  assert.equal(result.metrics.complementaryReviewPairCount, 1);
  assert.equal(result.metrics.potentialAvoidableDuplicatePairCount, 0);
});

test('explicit parallel variants with different variant IDs are retained as variants', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:[
      work('variant.a', 'worker.a', {
        conflictKeys:['model.route.experiment'],
        subsystemIds:['ai.router'],
        semanticTags:['routing.policy'],
        variantGroupId:'route.lab',
        variantId:'variant-a',
      }),
      work('variant.b', 'worker.b', {
        conflictKeys:['model.route.experiment'],
        subsystemIds:['ai.router'],
        semanticTags:['routing.policy'],
        variantGroupId:'route.lab',
        variantId:'variant-b',
      }),
    ],
  });
  assert.equal(result.pairs[0].classification, WorkOverlapClassification.INTENTIONAL_VARIANT);
  assert.equal(result.pairs[0].explicitParallelVariant, true);
  assert.equal(result.pairs[0].recommendedDisposition, 'KEEP_EXPLICIT_VARIANT');
  assert.equal(result.metrics.intentionalVariantPairCount, 1);
});

test('matching variant IDs do not excuse duplicate mutation', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:[
      work('variant.a', 'worker.a', {
        conflictKeys:['model.route.experiment'],
        variantGroupId:'route.lab',
        variantId:'same',
      }),
      work('variant.b', 'worker.b', {
        conflictKeys:['model.route.experiment'],
        variantGroupId:'route.lab',
        variantId:'same',
      }),
    ],
  });
  assert.equal(result.pairs[0].classification, WorkOverlapClassification.HARD_CONFLICT);
});

test('input and set ordering do not change pair identity, scoring or metrics', () => {
  const a = work('a', 'worker.a', {
    subsystemIds:['scheduler', 'runtime'],
    semanticTags:['restart', 'exact.effect'],
    filePaths:['src/core/scheduler.js', 'src/core/runtime-execution.js'],
  });
  const b = work('b', 'worker.b', {
    subsystemIds:['runtime', 'scheduler'],
    semanticTags:['exact.effect', 'restart'],
    filePaths:['src/core/runtime-execution.js', 'src/core/scheduler.js'],
  });
  const forward = analyzeDuplicateWorkV1({ schemaVersion:1, policy:policy(), workItems:[a, b] });
  const reverse = analyzeDuplicateWorkV1({ schemaVersion:1, policy:policy(), workItems:[b, a] });
  assert.deepEqual(reverse, forward);
  assert.equal(forward.pairs[0].pairId, 'pair:1:a:1:b');
});

test('pair identity is injective for legal colon-bearing work IDs and stable under input reordering', () => {
  const items = [
    work('a', 'worker.a', { conflictKeys:['shared'] }),
    work('b:c', 'worker.bc', { conflictKeys:['shared'] }),
    work('a:b', 'worker.ab', { conflictKeys:['shared'] }),
    work('c', 'worker.c', { conflictKeys:['shared'] }),
  ];
  const forward = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:items,
  });
  const reverse = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:[...items].reverse(),
  });

  assert.deepEqual(reverse, forward);
  assert.equal(new Set(forward.pairs.map(pair => pair.pairId)).size, forward.pairs.length);

  const first = forward.pairs.find(pair => pair.workIdA === 'a' && pair.workIdB === 'b:c');
  const second = forward.pairs.find(pair => pair.workIdA === 'a:b' && pair.workIdB === 'c');
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.pairId, 'pair:1:a:3:b:c');
  assert.equal(second.pairId, 'pair:3:a:b:1:c');
  assert.notEqual(first.pairId, second.pairId);
});

test('overlap metrics count only conflicting mutation workers, not complementary review or variants', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:[
      work('a', 'worker.a', { conflictKeys:['shared'] }),
      work('b', 'worker.b', { conflictKeys:['shared'] }),
      work('review', 'worker.c', { mode:'REVIEW', conflictKeys:['shared'] }),
      work('v1', 'worker.d', {
        conflictKeys:['variant'],
        variantGroupId:'g',
        variantId:'1',
      }),
      work('v2', 'worker.e', {
        conflictKeys:['variant'],
        variantGroupId:'g',
        variantId:'2',
      }),
    ],
  });
  assert.equal(result.metrics.hardConflictPairCount >= 1, true);
  assert.equal(result.metrics.complementaryReviewPairCount >= 1, true);
  assert.equal(result.metrics.intentionalVariantPairCount, 1);
  assert.equal(result.metrics.conflictingWorkerIds.includes('worker.c'), false);
  assert.equal(result.metrics.conflictingWorkerIds.includes('worker.d'), false);
  assert.equal(result.metrics.conflictingWorkerIds.includes('worker.e'), false);
});

test('repository paths are exact relative paths and preserve internal spaces/unicode', () => {
  const normalized = normalizeWorkIntentV1(work('paths', 'worker.a', {
    filePaths:['docs/Опис продукту.md', 'src/core/file with space.js'],
  }));
  assert.deepEqual(normalized.filePaths, ['docs/Опис продукту.md', 'src/core/file with space.js']);

  for (const bad of [
    '/absolute.js',
    '../escape.js',
    'src/../escape.js',
    'src\\windows.js',
    'src//empty.js',
    ' trailing.js ',
  ]) {
    assert.throws(() => normalizeWorkIntentV1(work('bad', 'worker.a', {
      filePaths:[bad],
    })), /safe repository-relative path/);
  }
});

test('policy weights and threshold are strict, bounded and nonzero', () => {
  const normalized = normalizeDuplicateWorkRadarPolicyV1(policy());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.weights), true);

  assert.throws(() => normalizeDuplicateWorkRadarPolicyV1(policy({
    highOverlapBasisPoints:0,
  })), /highOverlapBasisPoints is invalid/);

  assert.throws(() => normalizeDuplicateWorkRadarPolicyV1(policy({
    weights:{
      conflictKeys:0,
      subsystems:0,
      files:0,
      resources:0,
      outcomes:0,
      dependencies:0,
      acceptanceCriteria:0,
      semanticTags:0,
      sideEffects:0,
    },
  })), /at least one positive/);
});

test('lifecycle, mode and variants reject coercive aliases', () => {
  assert.throws(() => normalizeWorkIntentV1(work('x', 'worker.a', {
    mode:'mutation',
  })), /exact canonical enum/);
  assert.throws(() => normalizeWorkIntentV1(work('x', 'worker.a', {
    lifecycle:' ACTIVE',
  })), /exact canonical enum/);
  assert.throws(() => normalizeWorkIntentV1(work('x', 'worker.a', {
    variantGroupId:'group',
    variantId:'',
  })), /provided together/);
});

test('record and array boundaries execute zero caller getters', () => {
  let recordReads = 0;
  const proxied = new Proxy(work('safe', 'worker.a'), {
    get(target, key, receiver) {
      recordReads += 1;
      if (key === 'mode') return 'AUDIT';
      return Reflect.get(target, key, receiver);
    },
  });
  const normalized = normalizeWorkIntentV1(proxied);
  assert.equal(recordReads, 0);
  assert.equal(normalized.mode, 'MUTATION');

  let arrayReads = 0;
  const workItems = new Proxy([work('safe', 'worker.a')], {
    get(target, key, receiver) {
      arrayReads += 1;
      if (key === 'length') return 999999;
      return Reflect.get(target, key, receiver);
    },
  });
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems,
  });
  assert.equal(arrayReads, 0);
  assert.equal(result.workItemCount, 1);

  let itemReads = 0;
  const conflictKeys = [];
  Object.defineProperty(conflictKeys, 0, {
    enumerable:true,
    configurable:true,
    get() {
      itemReads += 1;
      return 'forged';
    },
  });
  assert.throws(() => normalizeWorkIntentV1(work('bad', 'worker.a', {
    conflictKeys,
  })), /enumerable own data properties/);
  assert.equal(itemReads, 0);
});

test('hidden, symbol, sparse and exotic collection authority is rejected', () => {
  const hidden = work('hidden', 'worker.a');
  Object.defineProperty(hidden, 'mode', {
    enumerable:false,
    configurable:true,
    value:'MUTATION',
  });
  assert.throws(() => normalizeWorkIntentV1(hidden), /enumerable own data property/);

  const symbolic = work('symbolic', 'worker.a');
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeWorkIntentV1(symbolic), /symbol field/);

  const sparse = new Array(1);
  assert.throws(() => analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:sparse,
  }), /dense data-only array/);

  const exotic = [work('exotic', 'worker.a')];
  Object.setPrototypeOf(exotic, null);
  assert.throws(() => analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:exotic,
  }), /bounded plain array/);
});

test('duplicate work analysis never grants claim, cancellation, reassignment, decision or mutation authority', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy(),
    workItems:[
      work('a', 'worker.a', { conflictKeys:['shared'] }),
      work('b', 'worker.b', { conflictKeys:['shared'] }),
    ],
  });
  assert.equal(result.decisionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.pairs[0].decisionAuthorized, false);
  assert.equal(result.pairs[0].mutationAuthorized, false);
  assert.equal('cancelWorkId' in result.pairs[0], false);
  assert.equal('assignWorkerId' in result.pairs[0], false);
  assert.equal('lease' in result, false);
});


test('one matching sparse semantic tag cannot alone trigger HIGH_OVERLAP when policy requires multiple evidence dimensions', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy({ highOverlapBasisPoints:5000, minHighOverlapDimensions:2 }),
    workItems:[
      work('a', 'worker.a', { semanticTags:['same.tag'] }),
      work('b', 'worker.b', { semanticTags:['same.tag'] }),
    ],
  });
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].scoreBasisPoints, 10_000);
  assert.equal(result.pairs[0].matchedDimensionCount, 1);
  assert.equal(result.pairs[0].classification, WorkOverlapClassification.RELATED);
});

test('shared conflict key remains a strong mutation/review convergence signal even with one matched dimension', () => {
  const result = analyzeDuplicateWorkV1({
    schemaVersion:1,
    policy:policy({ minHighOverlapDimensions:5 }),
    workItems:[
      work('mutate', 'worker.a', { conflictKeys:['authority.key'] }),
      work('review', 'worker.b', { mode:'REVIEW', conflictKeys:['authority.key'] }),
    ],
  });
  assert.equal(result.pairs[0].classification, WorkOverlapClassification.COMPLEMENTARY_REVIEW);
});
