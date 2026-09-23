import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProjectContextV1 } from '../src/core/project-context-search.js';

const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
function source(overrides = {}) {
  return {
    schemaVersion: 1, sourceId: 'src-1', projectId: 'proj-1', kind: 'github',
    uri: 'https://example.invalid/repo', revisionId: 'rev-1', contentSha256: H,
    observedAt: '2026-09-23T15:00:00Z', authority: 'CANONICAL', metadata: { branch: 'main' },
    ...overrides,
  };
}
function candidate(overrides = {}) {
  const s = source(overrides.source || {});
  return {
    snapshot: {
      schemaVersion: 1, projectId: 'proj-1', revisionId: 'project-rev-1', title: 'Autopilot runtime',
      sourceRefs: [s], artifactRefs: [], createdAt: '2026-09-23T15:00:00Z',
    },
    capsule: {
      schemaVersion: 1, capsuleId: overrides.capsuleId || 'cap-1', projectId: 'proj-1',
      projectRevisionId: 'project-rev-1', summary: overrides.summary || 'Deterministic runtime recovery context',
      sourceBindings: overrides.sourceBindings || [{ sourceId: 'src-1', revisionId: 'rev-1', contentSha256: H }],
      artifactRefs: [], createdAt: '2026-09-23T15:00:00Z',
    },
  };
}
function search(query, candidates, options = {}) {
  return searchProjectContextV1({
    query,
    candidates,
    currentSourceRefs: options.currentSourceRefs || [source(options.current || {})],
    allowedSourceIds: options.allowedSourceIds || ['src-1'],
    ...options,
  });
}

test('returns only fresh permission-authorized provenance-bound capsules', () => {
  const out = search('runtime recovery', [candidate()]);
  assert.equal(out.resultCount, 1);
  assert.equal(out.results[0].capsuleId, 'cap-1');
  assert.equal(out.results[0].advisoryOnly, true);
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
  assert.throws(() => searchProjectContextV1({ query: 'runtime', candidates: [candidate()], currentSourceRefs: [source()] }), /allowedSourceIds must be an explicit/);
  assert.equal(search('runtime', [candidate()], { allowedSourceIds: ['other'] }).resultCount, 0);
  assert.equal(search('runtime', [candidate()], { allowedAuthorities: ['DERIVED'] }).resultCount, 0);
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

test('mixed permission capsule cannot launder summary through one authorized binding', () => {
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
    query: 'needle', candidates: [mixed], currentSourceRefs: [source(), second], allowedSourceIds: ['src-1'],
  });
  assert.equal(out.resultCount, 0);
});

test('ranking prefers stronger authority before lexical score and remains deterministic', () => {
  const canonical = candidate({ capsuleId: 'canonical', summary: 'runtime recovery' });
  const derived = candidate({ capsuleId: 'derived', summary: 'runtime runtime recovery', source: { authority: 'DERIVED' } });
  const currentDerived = source({ authority: 'DERIVED' });
  const out = searchProjectContextV1({
    query: 'runtime', candidates: [derived, canonical], currentSourceRefs: [source()], allowedSourceIds: ['src-1'],
  });
  // Derived candidate cannot substitute the canonical trusted current source and is excluded.
  assert.deepEqual(out.results.map(x => x.capsuleId), ['canonical']);
  const derivedOnly = searchProjectContextV1({
    query: 'runtime', candidates: [derived], currentSourceRefs: [currentDerived], allowedSourceIds: ['src-1'],
  });
  assert.deepEqual(derivedOnly.results.map(x => x.capsuleId), ['derived']);
});

test('bounded query/candidates/current-state/result limit fail closed', () => {
  assert.throws(() => searchProjectContextV1({ query: '', candidates: [], currentSourceRefs: [], allowedSourceIds: [] }), /query is invalid/);
  assert.throws(() => searchProjectContextV1({ query: 'x'.repeat(513), candidates: [], currentSourceRefs: [], allowedSourceIds: [] }), /query is invalid/);
  assert.throws(() => searchProjectContextV1({ query: 'x', candidates: Array(129).fill(candidate()), currentSourceRefs: [], allowedSourceIds: [] }), /bounded array/);
  assert.throws(() => searchProjectContextV1({ query: 'x', candidates: [], currentSourceRefs: Array(513).fill(source()), allowedSourceIds: [] }), /trusted-current-state/);
  assert.throws(() => searchProjectContextV1({ query: 'x', candidates: [], currentSourceRefs: [], allowedSourceIds: [], limit: 33 }), /limit is invalid/);
});

test('result cap is explicit and reports truncation', () => {
  const candidates = [1, 2, 3].map(i => candidate({ capsuleId: `cap-${i}`, summary: 'runtime' }));
  const out = search('runtime', candidates, { limit: 2 });
  assert.equal(out.resultCount, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.results.length, 2);
});
