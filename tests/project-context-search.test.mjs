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
      sourceBindings: [{ sourceId: 'src-1', revisionId: 'rev-1', contentSha256: H }],
      artifactRefs: [], createdAt: '2026-09-23T15:00:00Z',
    },
    currentSourceRefs: [source(overrides.current || overrides.source || {})],
  };
}

test('returns only fresh permission-authorized provenance-bound capsules', () => {
  const out = searchProjectContextV1({ query: 'runtime recovery', candidates: [candidate()], allowedSourceIds: ['src-1'] });
  assert.equal(out.resultCount, 1);
  assert.equal(out.results[0].capsuleId, 'cap-1');
  assert.equal(out.results[0].advisoryOnly, true);
  assert.equal(Object.isFrozen(out.results[0]), true);
});

test('stale revision/hash is excluded rather than surfaced as current context', () => {
  const stale = candidate({ current: { revisionId: 'rev-2', contentSha256: H2 } });
  const out = searchProjectContextV1({ query: 'runtime', candidates: [stale] });
  assert.equal(out.resultCount, 0);
});

test('source authority/uri/kind substitution is fail-closed even with same source id and revision', () => {
  for (const current of [
    { authority: 'ADVISORY' },
    { uri: 'https://example.invalid/other' },
    { kind: 'drive' },
  ]) {
    const out = searchProjectContextV1({ query: 'runtime', candidates: [candidate({ current })] });
    assert.equal(out.resultCount, 0);
  }
});

test('permission scope denies unlisted source and disallowed authority', () => {
  assert.equal(searchProjectContextV1({ query: 'runtime', candidates: [candidate()], allowedSourceIds: ['other'] }).resultCount, 0);
  assert.equal(searchProjectContextV1({ query: 'runtime', candidates: [candidate()], allowedAuthorities: ['DERIVED'] }).resultCount, 0);
});

test('ranking prefers stronger authority before lexical score and remains deterministic', () => {
  const canonical = candidate({ capsuleId: 'canonical', summary: 'runtime recovery' });
  const derived = candidate({ capsuleId: 'derived', summary: 'runtime runtime recovery', source: { authority: 'DERIVED' } });
  const out = searchProjectContextV1({ query: 'runtime', candidates: [derived, canonical] });
  assert.deepEqual(out.results.map(x => x.capsuleId), ['canonical', 'derived']);
});

test('bounded query/candidates/result limit fail closed', () => {
  assert.throws(() => searchProjectContextV1({ query: '', candidates: [] }), /query is invalid/);
  assert.throws(() => searchProjectContextV1({ query: 'x'.repeat(513), candidates: [] }), /query is invalid/);
  assert.throws(() => searchProjectContextV1({ query: 'x', candidates: Array(129).fill(candidate()) }), /bounded array/);
  assert.throws(() => searchProjectContextV1({ query: 'x', candidates: [], limit: 33 }), /limit is invalid/);
});

test('result cap is explicit and reports truncation', () => {
  const candidates = [1, 2, 3].map(i => candidate({ capsuleId: `cap-${i}`, summary: 'runtime' }));
  const out = searchProjectContextV1({ query: 'runtime', candidates, limit: 2 });
  assert.equal(out.resultCount, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.results.length, 2);
});
