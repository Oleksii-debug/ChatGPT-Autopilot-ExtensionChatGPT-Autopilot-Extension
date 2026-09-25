import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProjectContextV1 } from '../src/core/project-context-search.js';

const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
function source(overrides = {}) {
  return {
    schemaVersion: 1, sourceId: 'src-1', projectId: 'proj-1', kind: 'github',
    uri: 'https://example.invalid/repo', revisionId: 'rev-1', contentSha256: H,
    observedAt: '2026-09-23T15:00:00.000Z', authority: 'CANONICAL', metadata: { branch: 'main' },
    ...overrides,
  };
}
function candidate(overrides = {}) {
  const s = source(overrides.source || {});
  return {
    snapshot: {
      schemaVersion: 1, projectId: 'proj-1', revisionId: 'project-rev-1', title: 'Autopilot runtime',
      sourceRefs: [s], artifactRefs: [], createdAt: '2026-09-23T15:00:00.000Z',
    },
    capsule: {
      schemaVersion: 1, capsuleId: overrides.capsuleId || 'cap-1', projectId: 'proj-1',
      projectRevisionId: 'project-rev-1', summary: overrides.summary || 'Deterministic runtime recovery context',
      sourceBindings: overrides.sourceBindings || [{ sourceId: 'src-1', revisionId: 'rev-1', contentSha256: H }],
      artifactRefs: [], createdAt: '2026-09-23T15:00:00.000Z',
    },
  };
}
function search(query, candidates, options = {}) {
  const { current, ...requestOptions } = options;
  return searchProjectContextV1({
    query,
    candidates,
    currentSourceRefs: requestOptions.currentSourceRefs || [source(current || {})],
    allowedSourceIds: requestOptions.allowedSourceIds || ['src-1'],
    ...requestOptions,
  });
}

test('returns only fresh permission-authorized provenance-bound capsule identities', () => {
  const out = search('runtime', [candidate()]);
  assert.equal(out.resultCount, 1);
  assert.equal(out.results[0].capsuleId, 'cap-1');
  assert.equal(out.results[0].advisoryOnly, true);
  assert.equal(Object.hasOwn(out.results[0], 'summary'), false);
  assert.equal(Object.isFrozen(out.results[0]), true);
});

test('stale revision/hash is excluded rather than surfaced as current context', () => {
  const out = search('runtime', [candidate()], { current: { revisionId: 'rev-2', contentSha256: H2 } });
  assert.equal(out.resultCount, 0);
});

test('source authority/uri/kind substitution is fail-closed even with same source id and revision', () => {
  for (const current of [
    { authority: 'ADVISORY' },
    { uri: 'https://example.invalid/other' },
    { kind: 'drive' },
  ]) {
    assert.equal(search('runtime', [candidate()], { current }).resultCount, 0);
  }
});

test('permission scope is explicit and denies unlisted source and disallowed authority', () => {
  assert.throws(() => searchProjectContextV1({ query: 'runtime', candidates: [candidate()], currentSourceRefs: [source()] }), /allowedSourceIds must be a bounded plain array/);
  assert.equal(search('runtime', [candidate()], { allowedSourceIds: ['other'] }).resultCount, 0);
  assert.equal(search('runtime', [candidate()], { allowedAuthorities: ['DERIVED'] }).resultCount, 0);
});

test('permission identities and authorities are exact and never string-coerced', () => {
  assert.throws(
    () => searchProjectContextV1({
      query: 'runtime',
      candidates: [candidate()],
      currentSourceRefs: [source()],
      allowedSourceIds: [1],
    }),
    /exact canonical ids/,
  );

  let coercions = 0;
  const hostileId = {
    toString() {
      coercions += 1;
      return 'src-1';
    },
  };
  assert.throws(
    () => searchProjectContextV1({
      query: 'runtime',
      candidates: [candidate()],
      currentSourceRefs: [source()],
      allowedSourceIds: [hostileId],
    }),
    /exact canonical ids/,
  );
  assert.equal(coercions, 0);

  assert.throws(
    () => search('runtime', [candidate()], { allowedAuthorities: ['canonical'] }),
    /exact SourceAuthorityKind/,
  );
  assert.throws(
    () => search('runtime', [candidate()], { allowedAuthorities: ['CANONICAL', 'CANONICAL'] }),
    /must not contain duplicates/,
  );
});

test('top-level search request is snapshotted before any caller getter can run', () => {
  let reads = 0;
  const request = {
    candidates: [candidate()],
    currentSourceRefs: [source()],
    allowedSourceIds: ['src-1'],
  };
  Object.defineProperty(request, 'query', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'runtime';
    },
  });
  assert.throws(
    () => searchProjectContextV1(request),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  assert.throws(
    () => searchProjectContextV1({
      query: 'runtime',
      candidates: [candidate()],
      currentSourceRefs: [source()],
      allowedSourceIds: ['src-1'],
      hiddenAuthority: 'CANONICAL',
    }),
    /unknown field/,
  );
});

test('search list and candidate boundaries reject accessors before reading caller values', () => {
  let reads = 0;
  const allowedSourceIds = [];
  Object.defineProperty(allowedSourceIds, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'src-1';
    },
  });
  assert.throws(
    () => searchProjectContextV1({
      query: 'runtime',
      candidates: [candidate()],
      currentSourceRefs: [source()],
      allowedSourceIds,
    }),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);

  const candidates = [];
  Object.defineProperty(candidates, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return candidate();
    },
  });
  assert.throws(
    () => searchProjectContextV1({
      query: 'runtime',
      candidates,
      currentSourceRefs: [source()],
      allowedSourceIds: ['src-1'],
    }),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);

  const wrapped = candidate();
  Object.defineProperty(wrapped, 'snapshot', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return candidate().snapshot;
    },
  });
  assert.throws(
    () => search('runtime', [wrapped]),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);

  const decorated = ['src-1'];
  decorated.authority = 'CANONICAL';
  assert.throws(
    () => searchProjectContextV1({
      query: 'runtime',
      candidates: [candidate()],
      currentSourceRefs: [source()],
      allowedSourceIds: decorated,
    }),
    /non-index array data/,
  );
});

test('equal-score result tie-break uses locale-independent code-unit order', () => {
  const upper = candidate({ capsuleId: 'Z-cap' });
  const lower = candidate({ capsuleId: 'a-cap' });
  const out = search('runtime', [lower, upper]);
  assert.deepEqual(out.results.map(item => item.capsuleId), ['Z-cap', 'a-cap']);
});

test('candidate cannot inject its own freshness authority', () => {
  const forged = { ...candidate(), currentSourceRefs: [source({ metadata: { secret: 'needle' } })] };
  assert.throws(() => search('runtime', [forged]), /must not inject currentSourceRefs/);
});

test('unbound current source cannot create a query match or alter ranking', () => {
  const unbound = source({
    sourceId: 'src-unbound', revisionId: 'rev-u', contentSha256: H2,
    uri: 'https://example.invalid/needle', metadata: { secret: 'needle needle needle' },
  });
  const out = searchProjectContextV1({
    query: 'needle', candidates: [candidate()], currentSourceRefs: [source(), unbound],
    allowedSourceIds: ['src-1', 'src-unbound'],
  });
  assert.equal(out.resultCount, 0);
});

test('arbitrary source metadata is never indexed', () => {
  const current = source({ metadata: { branch: 'main', credential: 'needle-secret' } });
  const out = searchProjectContextV1({
    query: 'needle-secret', candidates: [candidate()], currentSourceRefs: [current], allowedSourceIds: ['src-1'],
  });
  assert.equal(out.resultCount, 0);
});

test('capsule summary is neither indexed nor returned without separate content visibility authority', () => {
  const secret = candidate({ summary: 'needle-private-summary' });
  const secretQuery = search('needle-private-summary', [secret]);
  assert.equal(secretQuery.resultCount, 0);
  const identityQuery = search('runtime', [secret]);
  assert.equal(identityQuery.resultCount, 1);
  assert.equal(Object.hasOwn(identityQuery.results[0], 'summary'), false);
  assert.equal(JSON.stringify(identityQuery).includes('needle-private-summary'), false);
});

test('a source permission cannot disclose unapproved artifact locations', () => {
  const record = candidate();
  record.capsule.artifactRefs = [{
    schemaVersion: 1, artifactId: 'private-report', kind: 'report',
    uri: 'artifact://private/needle-secret-location', mediaType: 'application/json',
    sha256: H2, sizeBytes: 17, createdAt: '2026-09-23T15:00:00.000Z',
    producerInvocationId: 'invoke-1', sensitive: true,
  }];
  record.snapshot.artifactRefs = structuredClone(record.capsule.artifactRefs);
  assert.equal(search('needle-secret-location', [record]).resultCount, 0);
  const out = search('runtime', [record]);
  assert.equal(out.resultCount, 1);
  assert.equal(Object.hasOwn(out.results[0], 'artifactRefs'), false);
  assert.equal(JSON.stringify(out).includes('needle-secret-location'), false);
});

test('mixed permission capsule cannot launder content through one authorized binding', () => {
  const second = source({ sourceId: 'src-2', revisionId: 'rev-2', contentSha256: H2, uri: 'https://example.invalid/private' });
  const mixed = candidate({
    summary: 'needle private context',
    sourceBindings: [
      { sourceId: 'src-1', revisionId: 'rev-1', contentSha256: H },
      { sourceId: 'src-2', revisionId: 'rev-2', contentSha256: H2 },
    ],
  });
  mixed.snapshot.sourceRefs.push(second);
  const out = searchProjectContextV1({
    query: 'runtime', candidates: [mixed], currentSourceRefs: [source(), second], allowedSourceIds: ['src-1'],
  });
  assert.equal(out.resultCount, 0);
});

test('authority ranking remains deterministic', () => {
  const canonical = candidate({ capsuleId: 'canonical' });
  const derived = candidate({ capsuleId: 'derived', source: { authority: 'DERIVED' } });
  const currentDerived = source({ authority: 'DERIVED' });
  const out = searchProjectContextV1({
    query: 'runtime', candidates: [derived, canonical], currentSourceRefs: [source()], allowedSourceIds: ['src-1'],
  });
  assert.deepEqual(out.results.map(x => x.capsuleId), ['canonical']);
  const derivedOnly = searchProjectContextV1({
    query: 'runtime', candidates: [derived], currentSourceRefs: [currentDerived], allowedSourceIds: ['src-1'],
  });
  assert.deepEqual(derivedOnly.results.map(x => x.capsuleId), ['derived']);
});

test('bounded query/candidates/current-state/result limit fail closed', () => {
  assert.throws(() => searchProjectContextV1({ query: '', candidates: [], currentSourceRefs: [], allowedSourceIds: [] }), /query is invalid/);
  assert.throws(() => searchProjectContextV1({ query: 'x'.repeat(513), candidates: [], currentSourceRefs: [], allowedSourceIds: [] }), /query is invalid/);
  assert.throws(() => searchProjectContextV1({ query: 'x', candidates: Array(129).fill(candidate()), currentSourceRefs: [], allowedSourceIds: [] }), /bounded plain array/);
  assert.throws(() => searchProjectContextV1({ query: 'x', candidates: [], currentSourceRefs: Array(513).fill(source()), allowedSourceIds: [] }), /currentSourceRefs must be a bounded plain array/);
  assert.throws(() => searchProjectContextV1({ query: 'x', candidates: [], currentSourceRefs: [], allowedSourceIds: [], limit: 33 }), /limit is invalid/);
});

test('result cap is explicit and reports truncation', () => {
  const candidates = [1, 2, 3].map(i => candidate({ capsuleId: `cap-${i}` }));
  const out = search('runtime', candidates, { limit: 2 });
  assert.equal(out.resultCount, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.results.length, 2);
});
