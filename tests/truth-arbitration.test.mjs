import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TruthResolutionStatus,
  arbitrateTruthFactV1,
  normalizeTruthRuleV1,
  normalizeTruthSourceStateV1,
} from '../src/core/truth-arbitration.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

function rule(overrides = {}) {
  return {
    schemaVersion:1,
    ruleId:'truth.rule.source',
    factClass:'source.current-revision',
    authorityOrder:['git.canonical', 'memory.summary'],
    maxAgeMs:60_000,
    ...overrides,
  };
}

function source(sourceId, authorityClass, overrides = {}) {
  return {
    schemaVersion:1,
    sourceId,
    authorityClass,
    available:true,
    refreshable:true,
    revisionId:'rev-1',
    contentSha256:H1,
    observedAt:'2026-09-25T05:30:00.000Z',
    validUntil:'2026-09-25T05:31:00.000Z',
    ...overrides,
  };
}

function request(sourceStates, overrides = {}) {
  return {
    schemaVersion:1,
    factId:'project.alpha.source',
    factClass:'source.current-revision',
    asOf:'2026-09-25T05:30:30.000Z',
    rule:rule(),
    sourceStates,
    ...overrides,
  };
}

test('highest-authority fresh evidence resolves canonical truth even when lower evidence is newer', () => {
  const result = arbitrateTruthFactV1(request([
    source('memory', 'memory.summary', {
      revisionId:'summary-9',
      contentSha256:H2,
      observedAt:'2026-09-25T05:30:20.000Z',
      validUntil:'2026-09-25T05:31:20.000Z',
    }),
    source('git-main', 'git.canonical'),
  ]));

  assert.equal(result.status, TruthResolutionStatus.RESOLVED);
  assert.equal(result.canonical.sourceId, 'git-main');
  assert.equal(result.canonical.authorityRank, 0);
  assert.deepEqual(result.overriddenDisagreements.map(item => item.sourceId), ['memory']);
  assert.equal(result.overriddenDisagreements[0].overriddenByAuthority, true);
  assert.equal(result.attention, null);
});

test('stale higher authority blocks lower canonization and emits only non-authorizing refresh work', () => {
  const result = arbitrateTruthFactV1(request([
    source('git-main', 'git.canonical', {
      observedAt:'2026-09-25T05:28:00.000Z',
      validUntil:'2026-09-25T05:29:00.000Z',
    }),
    source('memory', 'memory.summary', {
      revisionId:'summary-9',
      contentSha256:H2,
    }),
  ]));

  assert.equal(result.status, TruthResolutionStatus.REFRESH_REQUIRED);
  assert.equal(result.canonical, null);
  assert.deepEqual(result.refreshRequests, [{
    sourceId:'git-main',
    authorityClass:'git.canonical',
    reasonCode:'HIGHER_AUTHORITY_STALE_OR_MISSING',
    executionAuthorized:false,
  }]);
  assert.equal(result.attention, null);
});

test('higher available source that cannot refresh produces one bounded attention candidate', () => {
  const result = arbitrateTruthFactV1(request([
    source('git-main', 'git.canonical', {
      refreshable:false,
      observedAt:'2026-09-25T05:28:00.000Z',
      validUntil:'2026-09-25T05:29:00.000Z',
    }),
    source('memory', 'memory.summary', { contentSha256:H2 }),
  ]));

  assert.equal(result.status, TruthResolutionStatus.UNAVAILABLE);
  assert.equal(result.canonical, null);
  assert.equal(result.attention.dedupeKey, 'truth:project.alpha.source');
  assert.equal(result.attention.kind, 'TRUTH_UNAVAILABLE');
  assert.equal(result.attention.attentionItemAuthorized, false);
  assert.equal(result.attention.decisionAuthorized, false);
});

test('unavailable higher authority may fall back to fresh lower evidence without pretending availability', () => {
  const result = arbitrateTruthFactV1(request([
    source('git-main', 'git.canonical', {
      available:false,
      refreshable:false,
      revisionId:'',
      contentSha256:'',
      observedAt:'',
      validUntil:'',
    }),
    source('memory', 'memory.summary', {
      revisionId:'summary-9',
      contentSha256:H2,
    }),
  ]));

  assert.equal(result.status, TruthResolutionStatus.RESOLVED);
  assert.equal(result.canonical.sourceId, 'memory');
  assert.deepEqual(result.unavailableHigherAuthoritySourceIds, ['git-main']);
});

test('fresh equal-authority disagreement fails closed as one conflict and requests recheck', () => {
  const result = arbitrateTruthFactV1(request([
    source('git-primary', 'git.canonical', { contentSha256:H1 }),
    source('git-mirror', 'git.canonical', {
      revisionId:'rev-2',
      contentSha256:H2,
      observedAt:'2026-09-25T05:30:10.000Z',
      validUntil:'2026-09-25T05:31:10.000Z',
    }),
    source('memory', 'memory.summary', { contentSha256:H3 }),
  ]));

  assert.equal(result.status, TruthResolutionStatus.CONFLICT);
  assert.equal(result.canonical, null);
  assert.deepEqual(result.conflicts.map(item => item.sourceId), ['git-mirror', 'git-primary']);
  assert.equal(result.attention.dedupeKey, 'truth:project.alpha.source');
  assert.equal(result.attention.reasonCode, 'EQUAL_AUTHORITY_CONFLICT');
  assert.equal(result.attention.attentionItemAuthorized, false);
  assert.deepEqual(result.refreshRequests.map(item => item.sourceId), ['git-mirror', 'git-primary']);
  assert.equal(result.refreshRequests.every(item => item.executionAuthorized === false), true);
});

test('same exact top-authority claim from multiple sources chooses newest observation deterministically', () => {
  const result = arbitrateTruthFactV1(request([
    source('git-primary', 'git.canonical', {
      observedAt:'2026-09-25T05:30:00.000Z',
    }),
    source('git-mirror', 'git.canonical', {
      observedAt:'2026-09-25T05:30:10.000Z',
      validUntil:'2026-09-25T05:31:10.000Z',
    }),
  ]));
  assert.equal(result.status, TruthResolutionStatus.RESOLVED);
  assert.equal(result.canonical.sourceId, 'git-mirror');
});

test('same digest with a different equal-authority revision is still a truth conflict', () => {
  const result = arbitrateTruthFactV1(request([
    source('git-primary', 'git.canonical', { revisionId:'rev-1', contentSha256:H1 }),
    source('git-mirror', 'git.canonical', { revisionId:'rev-2', contentSha256:H1 }),
  ]));
  assert.equal(result.status, TruthResolutionStatus.CONFLICT);
  assert.equal(result.canonical, null);
  assert.deepEqual(result.conflicts.map(item => item.revisionId), ['rev-2', 'rev-1']);
});

test('a stale available peer at the selected authority rank must refresh before canonization', () => {
  const result = arbitrateTruthFactV1(request([
    source('git-primary', 'git.canonical'),
    source('git-mirror', 'git.canonical', {
      revisionId:'rev-old',
      contentSha256:H2,
      observedAt:'2026-09-25T05:28:00.000Z',
      validUntil:'2026-09-25T05:29:00.000Z',
    }),
  ]));
  assert.equal(result.status, TruthResolutionStatus.REFRESH_REQUIRED);
  assert.equal(result.canonical, null);
  assert.deepEqual(result.refreshRequests, [{
    sourceId:'git-mirror',
    authorityClass:'git.canonical',
    reasonCode:'EQUAL_AUTHORITY_STALE_OR_MISSING',
    executionAuthorized:false,
  }]);
});

test('input ordering cannot change a resolution or conflict projection', () => {
  const states = [
    source('memory', 'memory.summary', { contentSha256:H2 }),
    source('git-main', 'git.canonical'),
  ];
  const forward = arbitrateTruthFactV1(request(states));
  const reverse = arbitrateTruthFactV1(request([...states].reverse()));
  assert.deepEqual(reverse, forward);
});

test('maxAgeMs is causal and rejects stale evidence even without validUntil', () => {
  const result = arbitrateTruthFactV1(request([
    source('git-main', 'git.canonical', {
      observedAt:'2026-09-25T05:28:00.000Z',
      validUntil:'',
    }),
  ], {
    rule:rule({ maxAgeMs:60_000 }),
  }));
  assert.equal(result.status, TruthResolutionStatus.REFRESH_REQUIRED);
});

test('future evidence, impossible validity windows and partial evidence fail closed', () => {
  assert.throws(() => arbitrateTruthFactV1(request([
    source('git-main', 'git.canonical', {
      observedAt:'2026-09-25T05:30:31.000Z',
      validUntil:'2026-09-25T05:31:31.000Z',
    }),
  ])), /from the future/);

  assert.throws(() => normalizeTruthSourceStateV1(source('git-main', 'git.canonical', {
    validUntil:'2026-09-25T05:29:59.999Z',
  })), /cannot predate observedAt/);

  assert.throws(() => normalizeTruthSourceStateV1(source('git-main', 'git.canonical', {
    contentSha256:'',
  })), /must be provided together/);
});

test('unknown authority classes and duplicate source identities fail closed', () => {
  assert.throws(() => arbitrateTruthFactV1(request([
    source('unknown', 'other.authority'),
  ])), /outside TruthRuleV1/);

  assert.throws(() => arbitrateTruthFactV1(request([
    source('git-main', 'git.canonical'),
    source('git-main', 'memory.summary'),
  ])), /duplicate sourceId/);
});

test('rule authority order is exact, bounded, unique and immutable', () => {
  const normalized = normalizeTruthRuleV1(rule());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.authorityOrder), true);

  assert.throws(() => normalizeTruthRuleV1(rule({
    authorityOrder:['git.canonical', 'git.canonical'],
  })), /duplicates/);

  assert.throws(() => normalizeTruthRuleV1(rule({
    authorityOrder:[' git.canonical'],
  })), /exact canonical identity/);

  assert.throws(() => normalizeTruthRuleV1(rule({
    authorityOrder:[],
  })), /must not be empty/);
});

test('identity, digest and timestamps reject canonical-looking aliases', () => {
  assert.throws(() => normalizeTruthSourceStateV1(source(' git-main', 'git.canonical')), /exact canonical identity/);
  assert.throws(() => normalizeTruthSourceStateV1(source('git-main', 'git.canonical', {
    contentSha256:H1.toUpperCase().replaceAll('1', 'A'),
  })), /lowercase SHA-256/);
  assert.throws(() => normalizeTruthSourceStateV1(source('git-main', 'git.canonical', {
    observedAt:'2026-09-25T05:30:00Z',
  })), /canonical ISO-8601/);
});

test('record and array boundaries never execute caller getters', () => {
  let recordReads = 0;
  const proxiedState = new Proxy(source('git-main', 'git.canonical'), {
    get(target, key, receiver) {
      recordReads += 1;
      if (key === 'contentSha256') return H2;
      return Reflect.get(target, key, receiver);
    },
  });
  const normalized = normalizeTruthSourceStateV1(proxiedState);
  assert.equal(recordReads, 0);
  assert.equal(normalized.contentSha256, H1);

  let itemReads = 0;
  const states = [];
  Object.defineProperty(states, 0, {
    enumerable:true,
    configurable:true,
    get() {
      itemReads += 1;
      return source('git-main', 'git.canonical');
    },
  });
  assert.throws(() => arbitrateTruthFactV1(request(states)), /enumerable own data properties/);
  assert.equal(itemReads, 0);

  let requestReads = 0;
  const proxiedRequest = new Proxy(request([source('git-main', 'git.canonical')]), {
    get(target, key, receiver) {
      requestReads += 1;
      if (key === 'sourceStates') return [];
      return Reflect.get(target, key, receiver);
    },
  });
  const projected = arbitrateTruthFactV1(proxiedRequest);
  assert.equal(requestReads, 0);
  assert.equal(projected.canonical.sourceId, 'git-main');
});

test('hidden, symbol, sparse and exotic collection authority is rejected', () => {
  const hidden = source('git-main', 'git.canonical');
  Object.defineProperty(hidden, 'available', {
    enumerable:false,
    configurable:true,
    value:true,
  });
  assert.throws(() => normalizeTruthSourceStateV1(hidden), /enumerable own data property/);

  const symbolic = source('git-main', 'git.canonical');
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeTruthSourceStateV1(symbolic), /symbol field/);

  const sparse = new Array(1);
  assert.throws(() => arbitrateTruthFactV1(request(sparse)), /dense data-only array/);

  const exotic = [source('git-main', 'git.canonical')];
  Object.setPrototypeOf(exotic, null);
  assert.throws(() => arbitrateTruthFactV1(request(exotic)), /bounded plain array/);
});

test('no arbitration result grants refresh, attention, decision, policy or effect authority', () => {
  const refresh = arbitrateTruthFactV1(request([
    source('git-main', 'git.canonical', {
      observedAt:'2026-09-25T05:28:00.000Z',
      validUntil:'2026-09-25T05:29:00.000Z',
    }),
  ]));
  assert.equal(refresh.refreshRequests[0].executionAuthorized, false);
  assert.equal('policyDecision' in refresh, false);
  assert.equal('effectId' in refresh, false);

  const conflict = arbitrateTruthFactV1(request([
    source('a', 'git.canonical', { contentSha256:H1 }),
    source('b', 'git.canonical', { contentSha256:H2 }),
  ]));
  assert.equal(conflict.attention.attentionItemAuthorized, false);
  assert.equal(conflict.attention.decisionAuthorized, false);
});
